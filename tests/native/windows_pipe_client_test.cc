#include "../../packages/native/windows-pipe-client/client-core.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <initializer_list>

using namespace trio::pipe_client;

namespace {

// 이 실행물의 링크 입력은 core와 이 파일뿐이다. SDK와 addon은 넣지 않는다.
std::size_t passed{}, failed{}, retained{};
Core* live_cores[8]{};
[[noreturn]] void fail(const char* expression, int line);
void track(Core& core) {
  for (auto* value : live_cores) if (value == &core) return;
  for (auto*& value : live_cores) if (!value) { value = &core; return; }
  fail("고정 core 추적 상한", __LINE__);
}
std::size_t actual_retained() {
  auto count = retained;
  for (auto* core : live_cores) if (core) count += core->snapshot().live_cells;
  return count;
}
[[noreturn]] void fail(const char* expression, int line) {
  ++failed;
  std::fprintf(stderr, "검사 실패: %s, 줄 %d\n", expression, line);
  std::printf("{\"version\":1,\"passed\":%zu,\"failed\":%zu,\"retained\":%zu}\n", passed, failed, actual_retained());
  std::exit(1);
}
#define CHECK(value) ((value) ? static_cast<void>(++passed) : fail(#value, __LINE__))
void account(Core& core) {
  retained += core.snapshot().live_cells;
  for (auto*& value : live_cores) if (value == &core) value = nullptr;
}

OpenRequest request(Lane lane = Lane::Control) {
  OpenRequest r{};
  r.lane = lane;
  constexpr char base[] = "\\\\.\\pipe\\trio-w5a-00000000-0000-4000-8000-000000000001-00000000-0000-4000-8000-000000000002";
  const char* suffix = lane == Lane::Control ? "-ctl" :
      lane == Lane::In ? "-00000000-0000-4000-8000-000000000003-00000000-0000-4000-8000-000000000004-aaaaaaaaaaaaaaaa-in" :
      lane == Lane::Out ? "-00000000-0000-4000-8000-000000000003-00000000-0000-4000-8000-000000000004-aaaaaaaaaaaaaaaa-out" :
      "-00000000-0000-4000-8000-000000000003-00000000-0000-4000-8000-000000000004-aaaaaaaaaaaaaaaa-err";
  CHECK(std::strlen(base) + std::strlen(suffix) < kNameBytes);
  const auto base_bytes = std::strlen(base);
  std::memcpy(r.name, base, base_bytes);
  std::memcpy(r.name + base_bytes, suffix, std::strlen(suffix) + 1);
  r.host = {1000, 100, 1};
  r.controller = {2000, 200, 1};
  std::memset(r.host_sid.bytes, 0x11, sizeof(r.host_sid.bytes));
  std::memset(r.controller_sid.bytes, 0x22, sizeof(r.controller_sid.bytes));
  std::memset(r.pipe_acl.bytes, 0xab, sizeof(r.pipe_acl.bytes));
  return r;
}
Facts facts(const OpenRequest& r) {
  Facts f{};
  f.host = r.host;
  f.controller = r.controller;
  f.owner_sid = r.host_sid;
  f.controller_logon_sid = r.controller_sid;
  f.pipe_acl = r.pipe_acl;
  f.descriptor_required = f.descriptor_returned = 128;
  f.token_required = f.token_returned = 96;
  f.acl_bytes = 56;
  f.file_is_pipe = f.byte_mode = f.non_inheritable = true;
  f.dacl_present = f.dacl_nonnull = f.dacl_protected = true;
  return f;
}

struct Fake {
  struct Call { Token token{}; std::byte* scratch{}; std::uint32_t size{}; };
  alignas(std::max_align_t) std::byte arena[kMetadataBytes]{};
  Call calls[kCellCount]{};
  Event events[96]{};
  std::byte copied[96][16]{};
  std::size_t event_count{}, opened{}, read_count{}, write_count{}, close_count{};
  std::size_t metadata_allocations{}, metadata_releases{}, scratch_held{}, references_released{};
  std::size_t wakes{}, queued_wakes{}, cancel_count{};
  bool delay_open{}, delay_close{}, close_unknown{}, allocation_fail{}, js_calls{};
  bool open_failure{}, immediate_io_failure{}, delivery_failure{};
  bool environment_gone{}, queue_full{}, inject_on_clear{}, checking_clear{};
  Token delayed_open{}, delayed_close{}, inject_token{};
  Facts* delayed_facts{};
  OpenRequest delayed_request{};
  CancelResult cancellation{CancelResult::NotFound};
  Core* core{};

  static Fake& get(void* p) noexcept { return *static_cast<Fake*>(p); }
  static void lock(void*) noexcept {}
  static void unlock(void* p) noexcept {
    auto& f = get(p);
    if (f.inject_on_clear && f.core && !f.checking_clear) {
      f.checking_clear = true;
      const bool pending = f.core->snapshot().wake_pending;
      f.checking_clear = false;
      if (!pending) {
        f.inject_on_clear = false;
        CHECK(f.core->complete(f.inject_token, {Error::None, 0, 1, false, 0}));
      }
    }
  }
  static void* allocate(void* p, Allocation kind, std::size_t n) noexcept {
    auto& f = get(p);
    if (f.allocation_fail) return nullptr;
    if (kind == Allocation::Metadata) {
      CHECK(n == kMetadataBytes && f.metadata_allocations == 0);
      ++f.metadata_allocations;
      return f.arena;
    }
    CHECK(n > 0 && n <= kChunkBytes);
    auto* result = std::malloc(n);
    if (result) f.scratch_held += n;
    return result;
  }
  static void release(void* p, Allocation kind, void* value, std::size_t n) noexcept {
    auto& f = get(p);
    if (kind == Allocation::Metadata) {
      CHECK(value == f.arena && n == kMetadataBytes);
      ++f.metadata_releases;
    } else {
      CHECK(f.scratch_held >= n);
      f.scratch_held -= n;
      std::free(value);
    }
  }
  static Wake wake(void* p) noexcept {
    auto& f = get(p);
    ++f.wakes;
    if (f.environment_gone) return Wake::Closing;
    if (f.queue_full) {
      CHECK(f.queued_wakes == 1);
      return Wake::QueueFull;
    }
    CHECK(f.queued_wakes == 0);
    f.queued_wakes = 1;
    return Wake::Queued;
  }
  static Delivery deliver(void* p, const Event& event) noexcept {
    auto& f = get(p);
    CHECK(f.event_count < 96);
    const auto i = f.event_count++;
    f.events[i] = event;
    if (event.data) std::memcpy(f.copied[i], event.data, event.bytes < 16 ? event.bytes : 16);
    if (event.environment_available) f.js_calls = true;
    else CHECK(f.environment_gone);
    if (f.delivery_failure && event.token.kind == Kind::Read) return Delivery::Failed;
    return event.environment_available ? Delivery::Delivered : Delivery::EnvironmentGone;
  }
  static void release_reference(void* p, Reference ref, bool available) noexcept {
    auto& f = get(p);
    CHECK(ref != 0);
    CHECK(available != f.environment_gone);
    ++f.references_released;
  }
  static Submission open(void* p, Token token, const OpenRequest& r, Arena a, Facts& out) noexcept {
    auto& f = get(p);
    track(*f.core);
    CHECK(a.descriptor == f.arena && a.descriptor_bytes == kDescriptorBytes);
    CHECK(a.token == f.arena + kDescriptorBytes && a.token_bytes == kTokenBytes);
    CHECK(r.desired_access == 0x12008b && r.flags == 0x40110000);
    CHECK(r.share_mode == 0 && r.creation_disposition == 3 && !r.inherit_handle);
    ++f.opened;
    if (f.open_failure) return {false, {Error::System, 231}};
    if (f.delay_open) {
      f.delayed_open = token;
      f.delayed_facts = &out;
      f.delayed_request = r;
      return {true, {}};
    }
    out = facts(r);
    return {false, {Error::None, 0, 0, false, 10 + static_cast<Resource>(r.lane)}};
  }
  static Submission read(void* p, Token token, Resource handle, std::byte* scratch, std::uint32_t n) noexcept {
    auto& f = get(p);
    CHECK(handle == 10 + static_cast<Resource>(token.lane));
    ++f.read_count;
    f.calls[token.cell] = {token, scratch, n};
    std::memset(scratch, 0, n);
    if (f.immediate_io_failure) return {false, {Error::System, 5}};
    return {true, {}};
  }
  static Submission write(void* p, Token token, Resource handle, const std::byte* scratch, std::uint32_t n) noexcept {
    auto& f = get(p);
    CHECK(handle == 10 + static_cast<Resource>(token.lane));
    ++f.write_count;
    f.calls[token.cell] = {token, const_cast<std::byte*>(scratch), n};
    return {true, {}};
  }
  static CancelResult cancel(void* p, Token token, Resource) noexcept {
    auto& f = get(p);
    CHECK(f.calls[token.cell].token == token);
    ++f.cancel_count;
    return f.cancellation;
  }
  static Submission close(void* p, Token token, Resource handle) noexcept {
    auto& f = get(p);
    CHECK(handle != 0);
    ++f.close_count;
    f.delayed_close = token;
    if (f.delay_close) return {true, {}};
    return {false, {f.close_unknown ? Error::Unconfirmed : Error::None}};
  }
  Sys sys() noexcept { return {this, open, read, write, cancel, close}; }
  Runtime runtime() noexcept { return {this, lock, unlock, allocate, release, wake, deliver, release_reference}; }
  void drain(Core& c) {
    core = &c;
    queued_wakes = 0;
    c.drain();
  }
  Token ready(Core& c, Lane lane = Lane::Control) {
    core = &c;
    auto accepted = c.open(request(lane));
    CHECK(accepted.error == Error::None);
    drain(c);
    CHECK(events[event_count - 1].token.kind == Kind::Open);
    CHECK(events[event_count - 1].error == Error::None);
    return accepted.token;
  }
  void finish(Core& c, Lane lane = Lane::Control) {
    CHECK(c.close(lane, CloseReason::Cancel) == Error::None);
    drain(c);
    CHECK(c.snapshot().idle);
    CHECK(scratch_held == 0 && metadata_releases == metadata_allocations);
  }
};

void fixed_contract_and_security() {
  CHECK(sizeof(Core) <= kLedgerBytes);
  auto r = request();
  CHECK(Core::validate(r) == Error::None);
  auto f = facts(r);
  CHECK(Core::verify(r, f));
  for (int change = 0; change < 17; ++change) {
    auto wrong = f;
    switch (change) {
      case 0: ++wrong.host.pid; break;
      case 1: ++wrong.host.creation_file_time; break;
      case 2: ++wrong.host.session; break;
      case 3: ++wrong.controller.pid; break;
      case 4: ++wrong.controller.creation_file_time; break;
      case 5: ++wrong.controller.session; break;
      case 6: wrong.owner_sid.bytes[0] ^= 1; break;
      case 7: wrong.controller_logon_sid.bytes[0] ^= 1; break;
      case 8: wrong.pipe_acl.bytes[0] ^= 1; break;
      case 9: wrong.dacl_present = false; break;
      case 10: wrong.dacl_defaulted = true; break;
      case 11: wrong.dacl_nonnull = false; break;
      case 12: wrong.dacl_protected = false; break;
      case 13: wrong.file_is_pipe = false; break;
      case 14: wrong.byte_mode = false; break;
      case 15: wrong.non_inheritable = false; break;
      case 16: wrong.controller_app_container = true; break;
    }
    CHECK(!Core::verify(r, wrong));
  }
  for (auto n : {kDescriptorBytes - 1, kDescriptorBytes, kDescriptorBytes + 1}) {
    f = facts(r);
    f.descriptor_required = f.descriptor_returned = static_cast<std::uint32_t>(n);
    CHECK(Core::verify(r, f) == (n <= kDescriptorBytes));
  }
  for (auto n : {kTokenBytes - 1, kTokenBytes, kTokenBytes + 1}) {
    f = facts(r);
    f.token_required = f.token_returned = static_cast<std::uint32_t>(n);
    CHECK(Core::verify(r, f) == (n <= kTokenBytes));
  }
  f = facts(r); ++f.descriptor_returned; CHECK(!Core::verify(r, f));
  f = facts(r); ++f.token_returned; CHECK(!Core::verify(r, f));
  for (std::uint32_t bit = 1; bit != 0; bit <<= 1) {
    auto bad = r; bad.desired_access ^= bit; CHECK(Core::validate(bad) != Error::None);
    bad = r; bad.flags ^= bit; CHECK(Core::validate(bad) != Error::None);
  }
  auto bad = r; std::memset(bad.name, 'x', sizeof(bad.name)); CHECK(Core::validate(bad) != Error::None);
  bad = r; bad.name[2] = 'x'; CHECK(Core::validate(bad) != Error::None);
}

void lazy_fixed_resources_and_policy() {
  Fake f{}; Core c(f.sys(), f.runtime()); f.core = &c;
  CHECK(f.metadata_allocations == 0 && f.opened == 0);
  for (Lane lane : {Lane::Control, Lane::In, Lane::Out, Lane::Err}) f.ready(c, lane);
  CHECK(f.metadata_allocations == 1 && f.opened == 4);
  CHECK(c.snapshot().control_backing_bytes == 0);
  CHECK(c.open(request()).error == Error::Replay);
  for (Lane lane : {Lane::Control, Lane::In, Lane::Out, Lane::Err}) CHECK(c.close(lane, CloseReason::Cancel) == Error::None);
  f.drain(c);
  CHECK(c.snapshot().idle && f.metadata_releases == 1);
  account(c);
  Fake other{}; Core d(other.sys(), other.runtime()); other.core = &d;
  other.ready(d);
  auto changed = request(Lane::In); changed.controller.creation_file_time++;
  CHECK(d.open(changed).error == Error::Policy && other.opened == 1);
  changed = request(Lane::In); changed.name[20] = '1';
  CHECK(d.open(changed).error != Error::None && other.opened == 1);
  other.finish(d);
  account(d);
}

void serialized_metadata_and_late_open() {
  Fake f{}; f.delay_open = true; Core c(f.sys(), f.runtime()); f.core = &c;
  const auto a = c.open(request()); const auto b = c.open(request(Lane::In));
  CHECK(a.error == Error::None && b.error == Error::None);
  CHECK(f.opened == 1 && c.snapshot().metadata_busy);
  CHECK(c.close(Lane::Control, CloseReason::Cancel) == Error::None);
  CHECK(!c.snapshot().idle && f.close_count == 0);
  *f.delayed_facts = facts(f.delayed_request);
  CHECK(c.complete(a.token, {Error::None, 0, 0, false, 10}));
  f.drain(c);
  CHECK(f.events[0].error == Error::Cancelled && f.close_count == 1 && f.opened == 2);
  *f.delayed_facts = facts(f.delayed_request);
  CHECK(c.complete(b.token, {Error::None, 0, 0, false, 11}));
  f.drain(c); f.finish(c, Lane::In);
  account(c);
}

void scratch_partial_bytes_and_original_id() {
  Fake f{}; Core c(f.sys(), f.runtime()); f.ready(c);
  std::byte source[6]{std::byte{'a'}, std::byte{'b'}, std::byte{'c'}, std::byte{'d'}, std::byte{'e'}, std::byte{'f'}};
  auto w = c.write(Lane::Control, source, 6, 11);
  CHECK(w.error == Error::None && f.scratch_held == 6);
  source[0] = std::byte{'x'};
  CHECK(f.calls[w.token.cell].scratch[0] == std::byte{'a'});
  CHECK(c.write(Lane::Control, source, 1, 12).error != Error::None);
  CHECK(c.complete(w.token, {Error::None, 0, 2, false, 0}));
  CHECK(!c.complete(w.token, {Error::None, 0, 2, false, 0}));
  auto wrong = w.token; ++wrong.id; CHECK(!c.complete(wrong, {}));
  CHECK(f.scratch_held == 6 && f.references_released == 0);
  f.drain(c);
  CHECK(f.events[f.event_count - 1].bytes == 2 && f.references_released == 1);
  CHECK(f.scratch_held == 0);
  auto r = c.read(Lane::Control, 8, 13);
  CHECK(r.error == Error::None && r.token.id != w.token.id);
  f.calls[r.token.cell].scratch[0] = std::byte{'q'};
  CHECK(c.complete(r.token, {Error::None, 0, 1, true, 0}));
  f.drain(c);
  CHECK(f.events[f.event_count - 1].eof && f.copied[f.event_count - 1][0] == std::byte{'q'});
  CHECK(f.references_released == 2); f.finish(c);
  account(c);
}

void cancellation_close_and_local_end() {
  for (CancelResult cancellation : {CancelResult::Requested, CancelResult::NotFound, CancelResult::Unconfirmed}) {
    Fake f{}; f.cancellation = cancellation; f.delay_close = true;
    Core c(f.sys(), f.runtime()); f.ready(c, Lane::In);
    auto r = c.read(Lane::In, 64, 1);
    CHECK(c.close(Lane::In, CloseReason::InputEnd) == Error::None);
    f.drain(c);
    CHECK(f.cancel_count == 1 && f.close_count == 0 && f.scratch_held == 64);
    CHECK(!c.snapshot().idle && f.references_released == 0);
    CHECK(c.complete(r.token, {Error::Cancelled, 995, 0, false, 0}));
    f.drain(c);
    const auto& e = f.events[f.event_count - 1];
    CHECK(e.token.kind == Kind::Read && e.error == Error::None && e.bytes == 0 && !e.eof);
    CHECK(f.scratch_held == 0 && f.close_count == 1 && !c.snapshot().idle);
    CHECK(c.complete(f.delayed_close, {})); f.drain(c); CHECK(c.snapshot().idle);
    account(c);
  }
  Fake f{}; Core c(f.sys(), f.runtime()); f.ready(c, Lane::In);
  auto r = c.read(Lane::In, 1, 5);
  CHECK(c.close(Lane::In, CloseReason::InputEnd) == Error::None);
  CHECK(c.complete(r.token, {Error::None, 0, 1, false, 0})); f.drain(c);
  CHECK(f.events[1].error == Error::ReverseBytes && f.events[1].bytes == 1 && !f.events[1].eof);
  CHECK(c.snapshot().idle);
  account(c);
}

void full_cells_wake_and_environment() {
  Fake f{}; Core c(f.sys(), f.runtime());
  for (Lane lane : {Lane::Control, Lane::In, Lane::Out, Lane::Err}) f.ready(c, lane);
  Token tokens[8]{}; std::byte b{std::byte{'a'}}; std::size_t i = 0;
  for (Lane lane : {Lane::Control, Lane::In, Lane::Out, Lane::Err}) {
    const auto r = c.read(lane, 1, i + 1); CHECK(r.error == Error::None); tokens[i++] = r.token;
    const auto w = c.write(lane, &b, 1, i + 1); CHECK(w.error == Error::None); tokens[i++] = w.token;
  }
  for (Lane lane : {Lane::Control, Lane::In, Lane::Out, Lane::Err}) CHECK(c.close(lane, CloseReason::Cancel) == Error::None);
  CHECK(c.snapshot().live_cells == 16);
  CHECK(c.read(Lane::Control, 1, 99).error != Error::None);
  CHECK(c.close(Lane::Control, CloseReason::Cancel) == Error::None);
  CHECK(c.snapshot().live_cells == 16);
  const auto before = f.wakes;
  for (Token t : tokens) CHECK(c.complete(t, {Error::Cancelled, 995, 0, false, 0}));
  CHECK(f.wakes == before + 1);
  f.drain(c);
  CHECK(c.snapshot().idle && f.scratch_held == 0 && f.references_released == 8);
  account(c);

  Fake g{}; Core d(g.sys(), g.runtime()); g.ready(d);
  auto r = d.read(Lane::Control, 1, 1); auto w = d.write(Lane::Control, &b, 1, 2);
  CHECK(d.complete(r.token, {Error::None, 0, 1, false, 0}));
  g.inject_token = w.token; g.inject_on_clear = true; g.drain(d);
  if (g.queued_wakes) g.drain(d);
  CHECK(g.references_released == 2 && !d.snapshot().wake_pending); g.finish(d);
  account(d);

  Fake h{}; Core e(h.sys(), h.runtime()); h.ready(e);
  auto pending = e.read(Lane::Control, 8, 9);
  h.environment_gone = true; h.js_calls = false; e.environment_end(); h.drain(e);
  CHECK(!e.snapshot().idle && h.scratch_held == 8 && !h.js_calls);
  CHECK(e.complete(pending.token, {Error::Cancelled, 995, 0, false, 0})); h.drain(e);
  CHECK(e.snapshot().idle && h.scratch_held == 0 && !h.js_calls);
  account(e);
}

void unknown_close_and_admission() {
  Fake f{}; Core c(f.sys(), f.runtime()); f.ready(c);
  CHECK(c.read(Lane::Control, kChunkBytes + 1, 1).error == Error::Invalid);
  CHECK(c.read(Lane::Control, 0, 1).error == Error::Invalid);
  f.allocation_fail = true;
  CHECK(c.read(Lane::Control, 1, 1).error == Error::Capacity);
  CHECK(f.read_count == 0 && f.references_released == 0);
  f.allocation_fail = false; f.close_unknown = true;
  CHECK(c.close(Lane::Control, CloseReason::Cancel) == Error::None); f.drain(c);
  CHECK(!c.snapshot().idle && f.metadata_releases == 0);
  CHECK(f.events[f.event_count - 1].error == Error::Unconfirmed);
  CHECK(c.snapshot().live_cells != 0);
  // WAIT 중에는 보유량이 남고, 같은 close ID의 별도 확정 관측 뒤에만 사라진다.
  CHECK(c.complete(f.delayed_close, {})); f.drain(c);
  CHECK(c.snapshot().idle && f.metadata_releases == 1);
  account(c);
}

void queue_full_zero_read_and_delivery_failure() {
  Fake f{}; Core c(f.sys(), f.runtime()); f.ready(c);
  auto r = c.read(Lane::Control, 8, 1);
  // 이미 예약된 TSFN wake 하나가 있는 queue_full도 추가 외부 사건 없이 소비한다.
  f.queue_full = true; f.queued_wakes = 1;
  CHECK(c.complete(r.token, {Error::None, 0, 0, false, 0})); f.drain(c);
  CHECK(f.events[f.event_count - 1].bytes == 0 && !f.events[f.event_count - 1].eof);
  CHECK(f.events[f.event_count - 1].error == Error::None && f.references_released == 1);
  f.queue_full = false; f.finish(c); account(c);

  Fake g{}; Core d(g.sys(), g.runtime()); g.ready(d);
  g.delivery_failure = true;
  auto changed = d.read(Lane::Control, 8, 1);
  CHECK(g.scratch_held == 8 && g.references_released == 0);
  CHECK(d.complete(changed.token, {Error::None, 0, 1, false, 0})); g.drain(d);
  CHECK(d.snapshot().idle && g.references_released == 1 && g.scratch_held == 0); account(d);

  Fake h{}; Core e(h.sys(), h.runtime()); h.ready(e); h.immediate_io_failure = true;
  CHECK(e.read(Lane::Control, 1, 1).error == Error::None);
  CHECK(h.scratch_held == 1 && h.references_released == 0); h.drain(e);
  CHECK(h.events[1].error == Error::System && h.events[1].system_error == 5 && !h.events[1].eof);
  CHECK(e.snapshot().idle && h.references_released == 1); account(e);

  Fake busy{}; busy.open_failure = true; Core unopened(busy.sys(), busy.runtime()); busy.core = &unopened;
  CHECK(unopened.open(request()).error == Error::None); busy.drain(unopened);
  CHECK(busy.opened == 1 && busy.close_count == 0 && unopened.snapshot().idle);
  CHECK(busy.events[0].error == Error::System && busy.events[0].system_error == 231);
  CHECK(busy.metadata_releases == 1); account(unopened);
}

void bridge_close_wait_preserves_promise_and_refs() {
  bool settled = false;
  std::size_t resolved = 0, released = 0, retained_refs = 2;
  auto resolve = [&]() noexcept { ++resolved; return true; };
  auto release = [&]() noexcept { if (retained_refs != 0) { ++released; retained_refs = 0; } return true; };
  for (Error error : {Error::Unconfirmed, Error::System, Error::Cancelled, Error::Environment}) {
    CHECK(settle_confirmed_close(error, settled, resolve, release));
    CHECK(!settled && resolved == 0 && released == 0 && retained_refs == 2);
  }
  auto failed_resolve = [&]() noexcept { ++resolved; return false; };
  CHECK(!settle_confirmed_close(Error::None, settled, failed_resolve, release));
  CHECK(!settled && released == 1 && retained_refs == 0);
  CHECK(settle_confirmed_close(Error::None, settled, resolve, release));
  CHECK(settled && resolved == 2 && released == 1 && retained_refs == 0);
  CHECK(settle_confirmed_close(Error::None, settled, resolve, release));
  CHECK(resolved == 2 && released == 1);
}

void rejected_reference_slots_remain_owned() {
  struct Slot { std::uintptr_t buffer{}, backing{}; std::size_t original{}; std::uintptr_t deferred{}; };
  for (bool has_backing : {false, true}) {
    Slot failed{41, has_backing ? 42u : 0u, 7};
    std::size_t deleted = 0;
    // 첫 참조 삭제 실패, 다른 참조 삭제 성공을 구분한다.
    if (failed.backing != 0) { failed.backing = 0; ++deleted; }
    CHECK(!reset_released_reference_slot(failed));
    CHECK(failed.buffer == 41 && failed.backing == 0 && failed.original == 7);
    CHECK(!(failed.buffer == 0 && failed.backing == 0));
    CHECK(deleted == (has_backing ? 1u : 0u));
    if (has_backing) {
      Slot second_failed{0, 42, 8};
      CHECK(!reset_released_reference_slot(second_failed));
      CHECK(second_failed.backing == 42 && second_failed.original == 8);
    }
    Slot released{0, 0, 9};
    CHECK(reset_released_reference_slot(released));
    CHECK(released.buffer == 0 && released.backing == 0 && released.original == 0);
  }
}

void reference_cleanup_precedes_upper_settlement() {
  for (bool two_refs : {false, true}) for (bool fail_backing : {false, true}) {
    if (!two_refs && fail_backing) continue;
    struct Slot { std::uintptr_t buffer{}, backing{}; std::size_t original{}; std::uintptr_t deferred{}; } slot{41, two_refs ? 42u : 0u, 7};
    const auto original_buffer = slot.buffer, original_backing = slot.backing;
    std::size_t io_success = 0, close_success = 0, held = 278540;
    bool closed = false;
    auto release = [&]() noexcept {
      if (fail_backing) slot.buffer = 0;
      else slot.backing = 0;
      return !slot.buffer && !slot.backing;
    };
    auto io = [&]() noexcept { ++io_success; held -= 12; return true; };
    CHECK(!settle_after_references(release, io));
    CHECK(io_success == 0 && held == 278540 && !reset_released_reference_slot(slot));
    CHECK(fail_backing ? slot.backing == original_backing : slot.buffer == original_buffer);
    CHECK(!settle_confirmed_close(Error::None, closed,
        [&]() noexcept { ++close_success; held -= 278528; return true; },
        [&]() noexcept { return !slot.buffer && !slot.backing; }));
    CHECK(!closed && close_success == 0 && held == 278540 && slot.original == 7);
  }
  std::size_t refs = 2, held = 278540, io_success = 0, close_success = 0;
  bool closed = false;
  CHECK(settle_after_references([&]() noexcept { refs = 0; return true; },
      [&]() noexcept { ++io_success; held -= 12; return true; }));
  CHECK(refs == 0 && io_success == 1 && held == 278528);
  CHECK(settle_confirmed_close(Error::None, closed,
      [&]() noexcept { ++close_success; held -= 278528; return true; },
      [&]() noexcept { return refs == 0; }));
  CHECK(closed && close_success == 1 && held == 0);
}

void synchronous_rejection_preserves_pending_owner() {
  for (bool open : {false, true}) {
    std::size_t refs = 2, rejected = 0, closed = 0, held = open ? 278528 : 278540;
    auto reject_original = [&]() noexcept { ++rejected; return true; };
    CHECK(!settle_after_references([&]() noexcept { refs = 1; return false; }, reject_original));
    CHECK(refs == 1 && rejected == 0 && closed == 0 && held == (open ? 278528u : 278540u));
    // 참조는 해제했어도 원 reject 실패 시 다음 closed 완료는 호출하지 않는다.
    const bool failed = settle_after_references([&]() noexcept { refs = 0; return true; }, []() noexcept { return false; });
    CHECK(!failed && refs == 0 && rejected == 0 && closed == 0);
    struct Slot { std::uintptr_t buffer{}, backing{}, deferred{}; std::size_t original{}; } slot{0, 0, 73, 9};
    CHECK(!reference_slot_available(slot) && !reset_released_reference_slot(slot));
    CHECK(slot.deferred == 73 && slot.original == 9);
    // 정상 종료 대조만 원 deferred를 비우고 슬롯과 상위 credit을 반환한다.
    CHECK(settle_after_references([&]() noexcept { return refs == 0; }, reject_original));
    slot.deferred = 0;
    CHECK(reference_slot_available(slot) && reset_released_reference_slot(slot));
    if (open) { ++closed; held = 0; } else held -= 12;
    CHECK(rejected == 1 && closed == (open ? 1u : 0u) && held == (open ? 0u : 278528u));
  }
}

void cancel_after_completion_before_delivery() {
  Fake f{}; Core c(f.sys(), f.runtime()); f.core = &c;
  CHECK(c.open(request()).error == Error::None);
  CHECK(c.close(Lane::Control, CloseReason::Cancel) == Error::None);
  CHECK(f.close_count == 0 && !c.snapshot().idle);
  f.drain(c);
  CHECK(f.events[0].error == Error::Cancelled && f.close_count == 1 && c.snapshot().idle); account(c);

  Fake g{}; Core d(g.sys(), g.runtime()); g.ready(d, Lane::In);
  auto r = d.read(Lane::In, 1, 1);
  CHECK(d.complete(r.token, {Error::None, 0, 1, false, 0}));
  CHECK(d.close(Lane::In, CloseReason::InputEnd) == Error::None); g.drain(d);
  CHECK(g.events[1].error == Error::ReverseBytes && g.events[1].bytes == 1 && d.snapshot().idle); account(d);
}

}  // 익명 이름 공간

int main() {
  fixed_contract_and_security();
  lazy_fixed_resources_and_policy();
  serialized_metadata_and_late_open();
  scratch_partial_bytes_and_original_id();
  cancellation_close_and_local_end();
  full_cells_wake_and_environment();
  unknown_close_and_admission();
  queue_full_zero_read_and_delivery_failure();
  bridge_close_wait_preserves_promise_and_refs();
  rejected_reference_slots_remain_owned();
  reference_cleanup_precedes_upper_settlement();
  synchronous_rejection_preserves_pending_owner();
  cancel_after_completion_before_delivery();
  const auto remaining = actual_retained();
  CHECK(remaining == 0);
  std::printf("{\"version\":1,\"passed\":%zu,\"failed\":%zu,\"retained\":%zu}\n", passed, failed, remaining);
  return failed == 0 && remaining == 0 ? 0 : 1;
}
