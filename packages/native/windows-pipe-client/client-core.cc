#include "client-core.h"

#include <cstring>
#include <limits>

namespace trio::pipe_client {
namespace {

constexpr char kPrefix[] = "\\\\.\\pipe\\trio-w5a-";
constexpr std::size_t kBaseLength = sizeof(kPrefix) - 1 + 36 + 1 + 36;
constexpr std::size_t index(Lane lane) noexcept { return static_cast<std::size_t>(lane); }
bool valid_lane(Lane lane) noexcept { return index(lane) < kLaneCount; }
bool equal(Process a, Process b) noexcept {
  return a.pid == b.pid && a.creation_file_time == b.creation_file_time && a.session == b.session;
}
bool equal(const Digest& a, const Digest& b) noexcept {
  unsigned difference = 0;
  for (std::size_t i = 0; i < sizeof(a.bytes); ++i) difference |= a.bytes[i] ^ b.bytes[i];
  return difference == 0;
}
bool hex(char c) noexcept { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }
bool uuid(const char* p) noexcept {
  for (std::size_t i = 0; i < 36; ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (p[i] != '-') return false; }
    else if (!hex(p[i])) return false;
  }
  return p[14] >= '1' && p[14] <= '8' && p[19] >= '8' && p[19] <= 'b';
}
bool tables(const Sys& s, const Runtime& r) noexcept {
  return s.open && s.read && s.write && s.cancel && s.close && r.lock && r.unlock &&
      r.allocate && r.release && r.wake && r.deliver && r.release_reference;
}

}  // 익명 이름 공간

Core::Guard::Guard(Runtime& value) noexcept : runtime(value) { if (runtime.lock) runtime.lock(runtime.context); }
Core::Guard::~Guard() { if (runtime.unlock) runtime.unlock(runtime.context); }
Core::Core(Sys sys, Runtime runtime) noexcept : sys_(sys), runtime_(runtime) {}

Error Core::validate(const OpenRequest& r) noexcept {
  if (!valid_lane(r.lane) || r.desired_access != kDesiredAccess || r.flags != kOpenFlags ||
      r.share_mode != 0 || r.creation_disposition != 3 || r.inherit_handle ||
      r.host.pid == 0 || r.controller.pid == 0) return Error::Invalid;
  std::size_t length = 0;
  while (length < kNameBytes && r.name[length] != '\0') ++length;
  if (length == kNameBytes || length < kBaseLength + 4 ||
      std::memcmp(r.name, kPrefix, sizeof(kPrefix) - 1) != 0) return Error::Invalid;
  constexpr auto start = sizeof(kPrefix) - 1;
  if (!uuid(r.name + start) || r.name[start + 36] != '-' || !uuid(r.name + start + 37)) return Error::Invalid;
  const char* p = r.name + kBaseLength;
  if (r.lane == Lane::Control) return std::strcmp(p, "-ctl") == 0 ? Error::None : Error::Invalid;
  const char* suffix = r.lane == Lane::In ? "-in" : r.lane == Lane::Out ? "-out" : "-err";
  const auto suffix_length = std::strlen(suffix);
  if (length != kBaseLength + 1 + 90 + suffix_length || p[0] != '-' ||
      !uuid(p + 1) || p[37] != '-' || !uuid(p + 38) || p[74] != '-') return Error::Invalid;
  for (std::size_t i = 75; i < 91; ++i) if (!hex(p[i])) return Error::Invalid;
  return std::strcmp(p + 91, suffix) == 0 ? Error::None : Error::Invalid;
}

bool Core::verify(const OpenRequest& r, const Facts& f) noexcept {
  return equal(r.host, f.host) && equal(r.controller, f.controller) &&
      equal(r.host_sid, f.owner_sid) && equal(r.controller_sid, f.controller_logon_sid) &&
      equal(r.pipe_acl, f.pipe_acl) && f.file_is_pipe && f.byte_mode && f.non_inheritable &&
      f.dacl_present && !f.dacl_defaulted && f.dacl_nonnull && f.dacl_protected &&
      !f.controller_app_container && f.acl_bytes >= 8 && f.acl_bytes <= 65535 &&
      f.descriptor_required > 0 && f.descriptor_required <= kDescriptorBytes &&
      f.descriptor_required == f.descriptor_returned &&
      f.token_required > 0 && f.token_required <= kTokenBytes && f.token_required == f.token_returned;
}

bool Core::policy_matches(const OpenRequest& r) const noexcept {
  if (!pinned_) return true;
  const auto& first = channels_[pinned_lane_].request;
  if (!equal(first.host, r.host) || !equal(first.controller, r.controller) ||
      !equal(first.host_sid, r.host_sid) || !equal(first.controller_sid, r.controller_sid) ||
      !equal(first.pipe_acl, r.pipe_acl) || std::memcmp(first.name, r.name, kBaseLength) != 0) return false;
  return r.lane == Lane::Control || !tuple_pinned_ ||
      std::memcmp(data_tuple_, r.name + kBaseLength + 1, 90) == 0;
}

Accepted Core::reserve(Lane lane, Kind kind) noexcept {
  if (next_id_ == std::numeric_limits<std::uint64_t>::max()) return {Error::Capacity, {}};
  for (std::size_t i = 0; i < kCellCount; ++i) {
    auto& cell = cells_[i];
    if (cell.state != State::Free) continue;
    cell = {};
    cell.token = {next_id_++, static_cast<std::uint8_t>(i), lane, kind};
    cell.state = State::Queued;
    return {Error::None, cell.token};
  }
  return {Error::Capacity, {}};
}

Accepted Core::open(const OpenRequest& request) noexcept {
  Guard guard(runtime_);
  if (!tables(sys_, runtime_) || validate(request) != Error::None) return {Error::Invalid, {}};
  if (!environment_available_ || sealed_) return {Error::Environment, {}};
  auto& ch = channels_[index(request.lane)];
  if (ch.used) return {Error::Replay, {}};
  if (!policy_matches(request)) return {Error::Policy, {}};
  if (!metadata_) {
    metadata_ = static_cast<std::byte*>(runtime_.allocate(runtime_.context, Allocation::Metadata, kMetadataBytes));
    if (!metadata_) return {Error::Capacity, {}};
  }
  auto accepted = reserve(request.lane, Kind::Open);
  if (accepted.error != Error::None) return accepted;
  ch.request = request;
  ch.used = true;
  ch.open_cell = accepted.token.cell;
  if (!pinned_) { pinned_ = true; pinned_lane_ = static_cast<std::uint8_t>(index(request.lane)); }
  if (request.lane != Lane::Control && !tuple_pinned_) {
    std::memcpy(data_tuple_, request.name + kBaseLength + 1, 90);
    tuple_pinned_ = true;
  }
  drive();
  return accepted;
}

Accepted Core::read(Lane lane, std::uint32_t bytes, Reference reference) noexcept {
  return io(lane, Kind::Read, nullptr, bytes, reference);
}
Accepted Core::write(Lane lane, const std::byte* source, std::uint32_t bytes, Reference reference) noexcept {
  return io(lane, Kind::Write, source, bytes, reference);
}
Accepted Core::io(Lane lane, Kind kind, const std::byte* source, std::uint32_t bytes, Reference reference) noexcept {
  Guard guard(runtime_);
  if (!valid_lane(lane) || bytes == 0 || bytes > kChunkBytes || reference == 0 ||
      (kind == Kind::Write && !source) || !tables(sys_, runtime_)) return {Error::Invalid, {}};
  auto& ch = channels_[index(lane)];
  if (!environment_available_ || !ch.used || !ch.ready || !ch.ready_delivered || ch.closing || ch.closed) return {Error::Cancelled, {}};
  if (kind == Kind::Read ? ch.read_active : ch.write_active) return {Error::Capacity, {}};
  auto accepted = reserve(lane, kind);
  if (accepted.error != Error::None) return accepted;
  auto& cell = cells_[accepted.token.cell];
  cell.scratch = static_cast<std::byte*>(runtime_.allocate(runtime_.context, Allocation::Scratch, bytes));
  if (!cell.scratch) { cell = {}; return {Error::Capacity, {}}; }
  cell.reference = reference;
  cell.requested = bytes;
  scratch_bytes_ += bytes;
  if (kind == Kind::Write) std::memcpy(cell.scratch, source, bytes);
  if (kind == Kind::Read) ch.read_active = true; else ch.write_active = true;
  cell.state = State::Pending;
  const auto submitted = kind == Kind::Read ?
      sys_.read(sys_.context, cell.token, ch.resource, cell.scratch, bytes) :
      sys_.write(sys_.context, cell.token, ch.resource, cell.scratch, bytes);
  if (!submitted.pending) complete_locked(cell, submitted.completion);
  return accepted;
}

Error Core::close(Lane lane, CloseReason reason) noexcept {
  Guard guard(runtime_);
  const auto error = close_locked(lane, reason);
  drive();
  return error;
}
Error Core::close_locked(Lane lane, CloseReason reason) noexcept {
  if (!valid_lane(lane) || !tables(sys_, runtime_)) return Error::Invalid;
  auto& ch = channels_[index(lane)];
  if (!ch.used) return Error::Invalid;
  if (ch.closed || ch.closing) return Error::None;
  if (reason == CloseReason::InputEnd && lane != Lane::In) return Error::Invalid;
  const auto accepted = reserve(lane, Kind::Close);
  if (accepted.error != Error::None) return accepted.error;
  ch.close_cell = accepted.token.cell;
  ch.closing = true;
  ch.close_reason = reason;
  // 취소 반환값은 원 완료를 대신하지 않는다. 실패도 동일 cell과 scratch를 보존한다.
  for (auto& cell : cells_) {
    if (cell.token.lane != lane || cell.state != State::Pending ||
        (cell.token.kind != Kind::Read && cell.token.kind != Kind::Write) || cell.cancelled) continue;
    cell.cancelled = true;
    static_cast<void>(sys_.cancel(sys_.context, cell.token, ch.resource));
  }
  return Error::None;
}

void Core::notify() noexcept {
  if (wake_pending_) return;
  wake_pending_ = true;
  const auto result = runtime_.wake(runtime_.context);
  // QueueFull에는 이미 예약된 wake가 있다. 동일 완료 cell은 그대로 남는다.
  if (result == Wake::Closing) wake_pending_ = false;
}
void Core::complete_locked(Cell& cell, Completion result) noexcept {
  auto& ch = channels_[index(cell.token.lane)];
  if (cell.token.kind == Kind::Open) {
    ch.resource = result.resource;
    if (result.error == Error::None && (result.resource == 0 || !verify(ch.request, facts_))) result.error = Error::Peer;
    if (ch.closing && result.error == Error::None) result.error = Error::Cancelled;
    ch.ready = result.error == Error::None;
    metadata_busy_ = false;
  } else if (cell.token.kind == Kind::Read || cell.token.kind == Kind::Write) {
    if (result.bytes > cell.requested || (cell.token.kind == Kind::Write && result.eof)) result.error = Error::Invalid;
    if (cell.token.kind == Kind::Read && ch.closing && ch.close_reason == CloseReason::InputEnd) {
      if (result.bytes != 0) result.error = Error::ReverseBytes;
      else if (result.error == Error::Cancelled) { result.error = Error::None; result.eof = false; }
    }
  } else if (result.error != Error::None) {
    result.error = Error::Unconfirmed;
  }
  cell.result = result;
  cell.state = State::Done;
  notify();
}
bool Core::complete(Token token, Completion result) noexcept {
  Guard guard(runtime_);
  if (token.cell >= kCellCount || !valid_lane(token.lane) || token.id == 0 || !tables(sys_, runtime_)) return false;
  auto& cell = cells_[token.cell];
  const bool original_close_confirmation = token.kind == Kind::Close &&
      cell.state == State::Waiting && result.error == Error::None;
  if (!(cell.token == token) || (cell.state != State::Pending && !original_close_confirmation)) return false;
  if (token.kind == Kind::Open && (!metadata_busy_ || metadata_cell_ != token.cell)) return false;
  complete_locked(cell, result);
  return true;
}

void Core::drive() noexcept {
  if (!metadata_busy_) {
    for (auto& cell : cells_) {
      if (cell.state != State::Queued || cell.token.kind != Kind::Open) continue;
      auto& ch = channels_[index(cell.token.lane)];
      facts_ = {};
      metadata_busy_ = true;
      metadata_cell_ = cell.token.cell;
      cell.state = State::Pending;
      const auto submitted = ch.closing ? Submission{false, {Error::Cancelled}} :
          sys_.open(sys_.context, cell.token, ch.request,
                    {metadata_, kDescriptorBytes, metadata_ + kDescriptorBytes, kTokenBytes}, facts_);
      if (submitted.pending) break;
      complete_locked(cell, submitted.completion);
    }
  }
  for (auto& ch : channels_) {
    if (!ch.used || !ch.closing || ch.closed || ch.close_started ||
        !ch.ready_delivered || ch.read_active || ch.write_active) continue;
    ch.close_started = true;
    auto& cell = cells_[ch.close_cell];
    cell.state = State::Pending;
    const auto submitted = ch.resource ? sys_.close(sys_.context, cell.token, ch.resource) : Submission{false, {}};
    if (!submitted.pending) complete_locked(cell, submitted.completion);
  }
}

bool Core::idle_locked() const noexcept {
  if (metadata_busy_ || scratch_bytes_ != 0) return false;
  for (const auto& cell : cells_) if (cell.state != State::Free) return false;
  for (const auto& ch : channels_) if (ch.resource != 0 || (ch.used && !ch.closed)) return false;
  return true;
}
void Core::release_arena_if_idle() noexcept {
  if (!idle_locked() || !metadata_) return;
  runtime_.release(runtime_.context, Allocation::Metadata, metadata_, kMetadataBytes);
  metadata_ = nullptr;
  sealed_ = true;
}

void Core::drain() noexcept {
  if (!tables(sys_, runtime_)) return;
  runtime_.lock(runtime_.context);
  if (draining_) { runtime_.unlock(runtime_.context); return; }
  draining_ = true;
  for (;;) {
    drive();
    Cell* selected = nullptr;
    for (auto& cell : cells_) if (cell.state == State::Done) { selected = &cell; break; }
    if (!selected) {
      // 완료 게시와 같은 lock 안에서 clear한다. 이후 게시자는 반드시 새 wake를 잡는다.
      wake_pending_ = false;
      draining_ = false;
      release_arena_if_idle();
      runtime_.unlock(runtime_.context);
      return;
    }
    auto& cell = *selected;
    cell.state = State::Delivering;
    const auto token = cell.token;
    auto result = cell.result;
    const auto& current = channels_[index(token.lane)];
    // 원 완료 뒤 JS 전달 전의 취소도 늦은 ready와 IN 역방향 bytes에 반영한다.
    if (token.kind == Kind::Open && current.closing && result.error == Error::None) result.error = Error::Cancelled;
    if (token.kind == Kind::Read && current.closing && current.close_reason == CloseReason::InputEnd) {
      if (result.bytes != 0) result.error = Error::ReverseBytes;
      else if (result.error == Error::Cancelled) { result.error = Error::None; result.eof = false; }
    }
    const auto reference = cell.reference;
    auto* scratch = cell.scratch;
    const auto requested = cell.requested;
    const bool available = environment_available_;
    const Event event{token, result.error, result.system_error, result.bytes, result.eof, available,
                      token.kind == Kind::Read && result.bytes <= requested ? scratch : nullptr, reference};
    runtime_.unlock(runtime_.context);
    const auto delivered = runtime_.deliver(runtime_.context, event);
    if (reference != 0) runtime_.release_reference(runtime_.context, reference, available);
    if (scratch) runtime_.release(runtime_.context, Allocation::Scratch, scratch, requested);
    runtime_.lock(runtime_.context);
    auto& ch = channels_[index(token.lane)];
    if (scratch) scratch_bytes_ -= requested;
    if (token.kind == Kind::Open) {
      cell.state = State::Anchor;
      ch.ready_delivered = true;
      if (result.error != Error::None || delivered != Delivery::Delivered)
        static_cast<void>(close_locked(token.lane, available ? CloseReason::Failure : CloseReason::Environment));
    } else if (token.kind == Kind::Close) {
      if (result.error == Error::None) {
        ch.resource = 0;
        ch.closed = true;
        cells_[ch.open_cell] = {};
        cell = {};
      } else cell.state = State::Waiting;
    } else {
      if (token.kind == Kind::Read) ch.read_active = false; else ch.write_active = false;
      cell = {};
      if (result.error != Error::None || delivered != Delivery::Delivered)
        static_cast<void>(close_locked(token.lane, available ? CloseReason::Failure : CloseReason::Environment));
    }
  }
}

void Core::environment_end() noexcept {
  Guard guard(runtime_);
  if (!tables(sys_, runtime_)) return;
  environment_available_ = false;
  for (std::size_t i = 0; i < kLaneCount; ++i)
    if (channels_[i].used && !channels_[i].closed) static_cast<void>(close_locked(static_cast<Lane>(i), CloseReason::Environment));
  drive();
  notify();
}
Snapshot Core::snapshot() noexcept {
  Guard guard(runtime_);
  Snapshot result{};
  result.metadata_bytes = metadata_ ? kMetadataBytes : 0;
  result.scratch_bytes = scratch_bytes_;
  for (const auto& cell : cells_) {
    if (cell.state != State::Free) ++result.live_cells;
    if (cell.state == State::Pending && (cell.token.kind == Kind::Read || cell.token.kind == Kind::Write)) ++result.pending_io;
  }
  result.control_backing_bytes = 0;
  result.metadata_busy = metadata_busy_;
  result.wake_pending = wake_pending_;
  result.environment_available = environment_available_;
  result.idle = idle_locked();
  result.sealed = sealed_;
  return result;
}

}  // trio::pipe_client 이름 공간
