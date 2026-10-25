#ifndef TRIO_WINDOWS_PIPE_CLIENT_CORE_H
#define TRIO_WINDOWS_PIPE_CLIENT_CORE_H

#include <cstddef>
#include <cstdint>

namespace trio::pipe_client {

inline constexpr std::size_t kLaneCount = 4;
inline constexpr std::size_t kCellCount = 16;
inline constexpr std::size_t kLedgerBytes = 16 * 1024;
inline constexpr std::size_t kDescriptorBytes = 128 * 1024;
inline constexpr std::size_t kTokenBytes = 64 * 1024;
inline constexpr std::size_t kMetadataBytes = kDescriptorBytes + kTokenBytes;
inline constexpr std::size_t kControlReservationBytes = 64 * 1024;
inline constexpr std::uint32_t kChunkBytes = 65536;
inline constexpr std::uint32_t kDesiredAccess = 0x12008b;
inline constexpr std::uint32_t kOpenFlags = 0x40110000;
inline constexpr std::size_t kNameBytes = 261;

enum class Lane : std::uint8_t { Control, In, Out, Err };
enum class Kind : std::uint8_t { Open, Read, Write, Close };
enum class Error : std::uint8_t {
  None, Invalid, Capacity, Replay, Policy, Peer, System, Cancelled,
  ReverseBytes, Buffer, Unconfirmed, Environment, Delivery
};
enum class State : std::uint8_t {
  Free, Queued, Pending, Done, Delivering, Anchor, Waiting
};
enum class CloseReason : std::uint8_t { Cancel, InputEnd, StreamEnd, Failure, Environment };
enum class Wake : std::uint8_t { Queued, QueueFull, Closing };
enum class Delivery : std::uint8_t { Delivered, Failed, EnvironmentGone };
enum class CancelResult : std::uint8_t { Requested, NotFound, Unconfirmed };
enum class Allocation : std::uint8_t { Metadata, Scratch };
using Resource = std::uintptr_t;
using Reference = std::uint64_t;

struct Token {
  std::uint64_t id{};
  std::uint8_t cell{};
  Lane lane{};
  Kind kind{};
};
constexpr bool operator==(Token a, Token b) noexcept {
  return a.id == b.id && a.cell == b.cell && a.lane == b.lane && a.kind == b.kind;
}
struct Process {
  std::uint64_t creation_file_time{};
  std::uint32_t pid{};
  std::uint32_t session{};
};
struct Digest { std::uint8_t bytes[32]{}; };
struct OpenRequest {
  char name[kNameBytes]{};
  Lane lane{};
  Process host{}, controller{};
  Digest host_sid{}, controller_sid{}, pipe_acl{};
  std::uint32_t desired_access{kDesiredAccess};
  std::uint32_t share_mode{};
  std::uint32_t creation_disposition{3};
  std::uint32_t flags{kOpenFlags};
  bool inherit_handle{};
};
struct Arena {
  std::byte* descriptor{};
  std::size_t descriptor_bytes{};
  std::byte* token{};
  std::size_t token_bytes{};
};
struct Facts {
  Process host{}, controller{};
  Digest owner_sid{}, controller_logon_sid{}, pipe_acl{};
  std::uint32_t descriptor_required{}, descriptor_returned{};
  std::uint32_t token_required{}, token_returned{}, acl_bytes{};
  bool file_is_pipe{}, byte_mode{}, non_inheritable{};
  bool dacl_present{}, dacl_defaulted{}, dacl_nonnull{}, dacl_protected{};
  bool controller_app_container{};
};
struct Completion {
  Error error{Error::None};
  std::uint32_t system_error{};
  std::uint32_t bytes{};
  bool eof{};
  Resource resource{};
};
struct Submission {
  bool pending{};
  Completion completion{};
};
struct Event {
  Token token{};
  Error error{};
  std::uint32_t system_error{}, bytes{};
  bool eof{}, environment_available{};
  const std::byte* data{};
  Reference reference{};
};

// 함수표 외에는 core에서 운영체제나 JS 런타임으로 진입할 수 없다.
struct Sys {
  void* context{};
  Submission (*open)(void*, Token, const OpenRequest&, Arena, Facts&) noexcept{};
  Submission (*read)(void*, Token, Resource, std::byte*, std::uint32_t) noexcept{};
  Submission (*write)(void*, Token, Resource, const std::byte*, std::uint32_t) noexcept{};
  CancelResult (*cancel)(void*, Token, Resource) noexcept{};
  Submission (*close)(void*, Token, Resource) noexcept{};
};
struct Runtime {
  void* context{};
  void (*lock)(void*) noexcept{};
  void (*unlock)(void*) noexcept{};
  void* (*allocate)(void*, Allocation, std::size_t) noexcept{};
  void (*release)(void*, Allocation, void*, std::size_t) noexcept{};
  Wake (*wake)(void*) noexcept{};
  Delivery (*deliver)(void*, const Event&) noexcept{};
  void (*release_reference)(void*, Reference, bool) noexcept{};
};
struct Accepted { Error error{Error::None}; Token token{}; };
// bridge와 독립 검사에서 같은 결정을 쓴다. WAIT는 promise와 참조를 모두 유지한다.
//  참조 정리가 확인된 뒤에만 상위 promise와 credit의 원 완료를 전달한다.
template <typename Release, typename Settle>
bool settle_after_references(Release&& release, Settle&& settle) noexcept {
  if (!release()) return false;
  return settle();
}
template <typename Resolve, typename Release>
bool settle_confirmed_close(Error error, bool& settled, Resolve&& resolve, Release&& release) noexcept {
  if (error != Error::None || settled) return true;
  if (!settle_after_references(release, resolve)) return false;
  settled = true;
  return true;
}
// 참조 삭제 실패로 남은 원 슬롯은 정리 정보와 재사용 금지를 함께 유지한다.
template <typename Slot>
bool reference_slot_available(const Slot& slot) noexcept {
  return !slot.buffer && !slot.backing && !slot.deferred;
}
template <typename Slot>
bool reset_released_reference_slot(Slot& slot) noexcept {
  if (!reference_slot_available(slot)) return false;
  slot = {};
  return true;
}
struct Snapshot {
  std::size_t metadata_bytes{}, scratch_bytes{}, live_cells{}, pending_io{};
  std::size_t control_backing_bytes{};
  bool metadata_busy{}, wake_pending{}, environment_available{}, idle{}, sealed{};
};

class Core final {
 public:
  Core(Sys sys, Runtime runtime) noexcept;
  Core(const Core&) = delete;
  Core& operator=(const Core&) = delete;
  Accepted open(const OpenRequest& request) noexcept;
  Accepted read(Lane lane, std::uint32_t bytes, Reference reference) noexcept;
  Accepted write(Lane lane, const std::byte* source, std::uint32_t bytes,
                 Reference reference) noexcept;
  Error close(Lane lane, CloseReason reason) noexcept;
  bool complete(Token token, Completion result) noexcept;
  void drain() noexcept;
  void environment_end() noexcept;
  Snapshot snapshot() noexcept;
  static Error validate(const OpenRequest& request) noexcept;
  static bool verify(const OpenRequest& request, const Facts& facts) noexcept;

 private:
  struct Cell {
    Token token{};
    State state{State::Free};
    Completion result{};
    std::byte* scratch{};
    Reference reference{};
    std::uint32_t requested{};
    bool cancelled{};
  };
  struct Channel {
    OpenRequest request{};
    Resource resource{};
    std::uint8_t open_cell{}, close_cell{};
    bool used{}, ready{}, ready_delivered{}, closing{}, closed{};
    bool read_active{}, write_active{}, close_started{};
    CloseReason close_reason{CloseReason::Cancel};
  };
  struct Guard {
    Runtime& runtime;
    explicit Guard(Runtime& value) noexcept;
    ~Guard();
  };
  Accepted reserve(Lane lane, Kind kind) noexcept;
  Accepted io(Lane lane, Kind kind, const std::byte* source,
              std::uint32_t bytes, Reference reference) noexcept;
  Error close_locked(Lane lane, CloseReason reason) noexcept;
  void complete_locked(Cell& cell, Completion result) noexcept;
  void drive() noexcept;
  void notify() noexcept;
  bool policy_matches(const OpenRequest& request) const noexcept;
  bool idle_locked() const noexcept;
  void release_arena_if_idle() noexcept;
  Sys sys_{};
  Runtime runtime_{};
  Channel channels_[kLaneCount]{};
  Cell cells_[kCellCount]{};
  Facts facts_{};
  std::byte* metadata_{};
  std::uint64_t next_id_{1};
  std::size_t scratch_bytes_{};
  std::uint8_t metadata_cell_{}, pinned_lane_{};
  char data_tuple_[91]{};
  bool metadata_busy_{}, wake_pending_{}, draining_{};
  bool environment_available_{true}, pinned_{}, tuple_pinned_{}, sealed_{};
};

static_assert(kCellCount == 16 && kLaneCount == 4);
static_assert(kMetadataBytes == 196608 && kControlReservationBytes == 65536);
static_assert(sizeof(Core) <= kLedgerBytes);

}  // trio::pipe_client 이름 공간
#endif
