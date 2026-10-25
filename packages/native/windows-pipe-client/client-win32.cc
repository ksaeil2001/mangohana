#if defined(TRIO_PIPE_CLIENT_FAKE)
#error "가짜 실행물에는 Win32 bridge를 링크할 수 없습니다."
#endif
#if defined(NAPI_VERSION) && NAPI_VERSION != 8
#error "이 bridge의 Node-API 버전은 8로 고정합니다."
#endif
#ifndef NAPI_VERSION
#define NAPI_VERSION 8
#endif
#ifndef BUILDING_NODE_EXTENSION
#define BUILDING_NODE_EXTENSION
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif

#include "client-core.h"
#include <windows.h>
#include <bcrypt.h>
#include <node_api.h>

#include <atomic>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <initializer_list>
#include <limits>
#include <new>

namespace trio::pipe_client {
namespace {

struct NativeState;
struct Context;
enum class MethodKind : std::uint8_t { Read, Write, Close, Cancel };
struct Method { Context* owner{}; Lane lane{}; MethodKind kind{}; };
struct Context {
  napi_env env{};
  napi_ref helpers{};
  NativeState* state{};
  std::uint32_t function_owners{};
  Method methods[kLaneCount][4]{};
  bool closed{};
};
struct Pipe {
  HANDLE handle{}, host_query{}, token{};
  PTP_IO io{};
  bool auxiliary_unconfirmed{};
};
struct Io {
  OVERLAPPED overlapped{};
  Token token{};
  Context* owner{};
};
struct BufferSlot {
  napi_deferred deferred{};
  napi_ref buffer{}, backing{};
  Token token{};
  std::size_t bytes{}, offset{};
  bool native_done{};
};
struct LaneJs {
  napi_deferred ready{}, closed{};
  napi_ref ready_promise{}, closed_promise{}, channel{};
  bool ready_settled{}, closed_settled{};
};
struct ParseScratch { OpenRequest request{}; wchar_t wide_name[kNameBytes]{}; char text[kNameBytes]{}; };
struct Platform {
  SRWLOCK lock = SRWLOCK_INIT;
  Pipe pipes[kLaneCount]{};
  Io operations[kCellCount]{};
  BufferSlot buffers[kCellCount]{};
  LaneJs lanes[kLaneCount]{};
  ParseScratch parse{};
  napi_threadsafe_function tsfn{};
  napi_async_cleanup_hook_handle cleanup_hook{};
  PTP_WORK cleanup_work{};
  volatile LONG work_queued{};
  std::atomic<bool> cleanup{false}, released{false};
  bool finalized{true};
  std::atomic<bool> bridge_failed{false};
};

Sys make_sys(Context*) noexcept;
Runtime make_runtime(Context*) noexcept;
struct NativeState {
  Core core;
  Platform platform{};
  explicit NativeState(Context* context) noexcept : core(make_sys(context), make_runtime(context)) {}
};
// 공개 요청 사본, OVERLAPPED, JS 참조 표와 context까지 동일 16KiB 한도에 넣는다.
static_assert(sizeof(NativeState) + sizeof(Context) <= kLedgerBytes);
static_assert(sizeof(void*) == 8 && NAPI_VERSION == 8);
static_assert(kDesiredAccess == 0x12008b && kOpenFlags == 0x40110000);

Context& context(void* p) noexcept { return *static_cast<Context*>(p); }
Platform& platform(Context& c) noexcept { return c.state->platform; }
constexpr std::size_t lane_index(Lane lane) noexcept { return static_cast<std::size_t>(lane); }
HANDLE as_handle(Resource value) noexcept { return reinterpret_cast<HANDLE>(value); }
Resource as_resource(HANDLE value) noexcept { return reinterpret_cast<Resource>(value); }

bool inside(const std::byte* base, std::size_t size, const void* p, std::size_t bytes) noexcept {
  const auto start = reinterpret_cast<std::uintptr_t>(base);
  const auto value = reinterpret_cast<std::uintptr_t>(p);
  return value >= start && bytes <= size && value - start <= size - bytes;
}
bool sha(const void* data, std::size_t bytes, Digest& out) noexcept {
  if (!data || bytes > std::numeric_limits<ULONG>::max()) return false;
  return BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0,
      const_cast<PUCHAR>(static_cast<const UCHAR*>(data)), static_cast<ULONG>(bytes),
      out.bytes, static_cast<ULONG>(sizeof(out.bytes))) >= 0;
}
bool sid_digest(const std::byte* base, std::size_t bytes, const void* value, Digest& out) noexcept {
  if (!inside(base, bytes, value, 8)) return false;
  const auto* p = static_cast<const unsigned char*>(value);
  const auto size = std::size_t{8} + std::size_t{4} * p[1];
  if (p[0] != SID_REVISION || size > 68 || !inside(base, bytes, value, size) ||
      !IsValidSid(const_cast<void*>(value)) || GetLengthSid(const_cast<void*>(value)) != size) return false;
  return sha(value, size, out);
}
bool process_facts(HANDLE handle, DWORD pid, Process& out) noexcept {
  FILETIME creation{}, exit{}, kernel{}, user{};
  DWORD session = 0;
  if (GetProcessId(handle) != pid || !GetProcessTimes(handle, &creation, &exit, &kernel, &user) ||
      !ProcessIdToSessionId(pid, &session)) return false;
  out = {(static_cast<std::uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime, pid, session};
  return true;
}
bool token_query(HANDLE token, TOKEN_INFORMATION_CLASS type, Arena arena, DWORD& bytes, Facts& facts) noexcept {
  DWORD needed = 0;
  SetLastError(ERROR_SUCCESS);
  if (GetTokenInformation(token, type, nullptr, 0, &needed) || GetLastError() != ERROR_INSUFFICIENT_BUFFER ||
      needed == 0 || needed > arena.token_bytes) return false;
  DWORD returned = 0;
  if (!GetTokenInformation(token, type, arena.token, needed, &returned) || returned != needed) return false;
  bytes = returned;
  if (needed > facts.token_required) facts.token_required = needed;
  if (returned > facts.token_returned) facts.token_returned = returned;
  return true;
}
bool descriptor_facts(HANDLE handle, Arena arena, Facts& facts) noexcept {
  constexpr SECURITY_INFORMATION information = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
  DWORD needed = 0;
  SetLastError(ERROR_SUCCESS);
  if (GetKernelObjectSecurity(handle, information, nullptr, 0, &needed) ||
      GetLastError() != ERROR_INSUFFICIENT_BUFFER || needed < sizeof(SECURITY_DESCRIPTOR_RELATIVE) ||
      needed > arena.descriptor_bytes) return false;
  facts.descriptor_required = needed;
  DWORD returned = 0;
  if (!GetKernelObjectSecurity(handle, information, arena.descriptor, needed, &returned) || returned != needed) return false;
  facts.descriptor_returned = returned;
  SECURITY_DESCRIPTOR_RELATIVE header{};
  std::memcpy(&header, arena.descriptor, sizeof(header));
  if (header.Revision != SECURITY_DESCRIPTOR_REVISION || !(header.Control & SE_SELF_RELATIVE)) return false;
  facts.dacl_present = (header.Control & SE_DACL_PRESENT) != 0;
  facts.dacl_defaulted = (header.Control & SE_DACL_DEFAULTED) != 0;
  facts.dacl_protected = (header.Control & SE_DACL_PROTECTED) != 0;
  facts.dacl_nonnull = header.Dacl != 0;
  if (!facts.dacl_present || facts.dacl_defaulted || !facts.dacl_protected || !facts.dacl_nonnull ||
      header.Owner < sizeof(header) || header.Owner >= returned || header.Dacl < sizeof(header) || header.Dacl >= returned) return false;
  const auto* owner = arena.descriptor + header.Owner;
  const auto* acl_data = arena.descriptor + header.Dacl;
  if (!sid_digest(arena.descriptor, returned, owner, facts.owner_sid) ||
      !inside(arena.descriptor, returned, acl_data, sizeof(ACL))) return false;
  ACL acl{};
  std::memcpy(&acl, acl_data, sizeof(acl));
  facts.acl_bytes = acl.AclSize;
  if (acl.AclSize < sizeof(ACL) || !inside(arena.descriptor, returned, acl_data, acl.AclSize) ||
      !IsValidAcl(reinterpret_cast<PACL>(const_cast<std::byte*>(acl_data)))) return false;
  // 정렬이나 SDDL 변환 없이 header가 선언한 padding 포함 원 DACL bytes를 해시한다.
  return sha(acl_data, acl.AclSize, facts.pipe_acl);
}
bool controller_facts(Pipe& pipe, Arena arena, Facts& facts) noexcept {
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &pipe.token)) return false;
  DWORD bytes = 0;
  if (!token_query(pipe.token, TokenIsAppContainer, arena, bytes, facts) || bytes != sizeof(DWORD)) return false;
  DWORD app_container = 0;
  std::memcpy(&app_container, arena.token, sizeof(app_container));
  if (app_container > 1) return false;
  facts.controller_app_container = app_container != 0;
  if (!token_query(pipe.token, TokenSessionId, arena, bytes, facts) || bytes != sizeof(DWORD)) return false;
  DWORD session = 0;
  std::memcpy(&session, arena.token, sizeof(session));
  if (session != facts.controller.session) return false;
  if (!token_query(pipe.token, TokenGroups, arena, bytes, facts) || bytes < offsetof(TOKEN_GROUPS, Groups)) return false;
  const auto* groups = reinterpret_cast<const TOKEN_GROUPS*>(arena.token);
  if (groups->GroupCount > (bytes - offsetof(TOKEN_GROUPS, Groups)) / sizeof(SID_AND_ATTRIBUTES)) return false;
  unsigned logon_count = 0;
  for (DWORD i = 0; i < groups->GroupCount; ++i) {
    const auto& group = groups->Groups[i];
    if ((group.Attributes & SE_GROUP_LOGON_ID) != SE_GROUP_LOGON_ID) continue;
    if (++logon_count != 1 || !sid_digest(arena.token, bytes, group.Sid, facts.controller_logon_sid)) return false;
  }
  return logon_count == 1;
}
bool close_auxiliary(Pipe& pipe) noexcept {
  bool ok = !pipe.auxiliary_unconfirmed;
  for (HANDLE* h : {&pipe.host_query, &pipe.token}) {
    if (!*h) continue;
    if (CloseHandle(*h)) *h = nullptr;
    else { pipe.auxiliary_unconfirmed = true; ok = false; }
  }
  return ok;
}
Completion io_result(Kind kind, ULONG status, ULONG_PTR transferred) noexcept {
  Completion result{};
  result.system_error = status;
  if (transferred > std::numeric_limits<std::uint32_t>::max()) result.error = Error::Unconfirmed;
  else result.bytes = static_cast<std::uint32_t>(transferred);
  if (status == ERROR_SUCCESS) return result;
  if (kind == Kind::Read && (status == ERROR_BROKEN_PIPE || status == ERROR_HANDLE_EOF)) result.eof = true;
  else result.error = status == ERROR_OPERATION_ABORTED ? Error::Cancelled : Error::System;
  return result;
}
void CALLBACK io_callback(PTP_CALLBACK_INSTANCE, void*, void* overlapped, ULONG status,
                          ULONG_PTR bytes, PTP_IO) noexcept {
  auto* operation = CONTAINING_RECORD(overlapped, Io, overlapped);
  const auto token = operation->token;
  auto* owner = operation->owner;
  // 마지막 접근 뒤 원 완료를 게시한다. callback 합류는 handle close에서도 확인한다.
  static_cast<void>(owner->state->core.complete(token, io_result(token.kind, status, bytes)));
}
Submission sys_open(void* p, Token token, const OpenRequest& request, Arena arena, Facts& facts) noexcept {
  auto& c = context(p);
  auto& state = platform(c);
  auto& pipe = state.pipes[lane_index(token.lane)];
  std::size_t length = 0;
  while (length + 1 < kNameBytes && request.name[length]) {
    state.parse.wide_name[length] = static_cast<unsigned char>(request.name[length]);
    ++length;
  }
  state.parse.wide_name[length] = L'\0';
  pipe.handle = CreateFileW(state.parse.wide_name, kDesiredAccess, 0, nullptr, OPEN_EXISTING, kOpenFlags, nullptr);
  if (pipe.handle == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    pipe.handle = nullptr;
    return {false, {Error::System, error}};
  }
  const auto resource = as_resource(pipe.handle);
  DWORD flags = 0, read_mode = 0, pipe_mode = 0, server_pid = 0, client_pid = 0;
  facts.file_is_pipe = GetFileType(pipe.handle) == FILE_TYPE_PIPE;
  const bool scalar = GetHandleInformation(pipe.handle, &flags) &&
      GetNamedPipeHandleStateW(pipe.handle, &read_mode, nullptr, nullptr, nullptr, nullptr, 0) &&
      GetNamedPipeInfo(pipe.handle, &pipe_mode, nullptr, nullptr, nullptr) &&
      GetNamedPipeServerProcessId(pipe.handle, &server_pid) && GetNamedPipeClientProcessId(pipe.handle, &client_pid);
  facts.non_inheritable = (flags & HANDLE_FLAG_INHERIT) == 0;
  facts.byte_mode = (read_mode & (PIPE_READMODE_MESSAGE | PIPE_NOWAIT)) == 0 && (pipe_mode & PIPE_TYPE_MESSAGE) == 0;
  bool valid = scalar && server_pid == request.host.pid && client_pid == request.controller.pid &&
      GetCurrentProcessId() == request.controller.pid;
  if (valid) {
    pipe.host_query = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, request.host.pid);
    valid = pipe.host_query && process_facts(pipe.host_query, server_pid, facts.host) &&
        process_facts(GetCurrentProcess(), client_pid, facts.controller) &&
        descriptor_facts(pipe.handle, arena, facts) && controller_facts(pipe, arena, facts);
  }
  const DWORD query_error = valid ? ERROR_SUCCESS : GetLastError();
  if (!close_auxiliary(pipe)) return {false, {Error::Unconfirmed, GetLastError(), 0, false, resource}};
  if (!valid) return {false, {Error::Peer, query_error, 0, false, resource}};
  pipe.io = CreateThreadpoolIo(pipe.handle, io_callback, &c, nullptr);
  if (!pipe.io) return {false, {Error::System, GetLastError(), 0, false, resource}};
  return {false, {Error::None, 0, 0, false, resource}};
}
Submission issue(void* p, Token token, Resource resource, void* scratch, std::uint32_t n) noexcept {
  auto& c = context(p);
  auto& state = platform(c);
  auto& pipe = state.pipes[lane_index(token.lane)];
  if (pipe.handle != as_handle(resource) || !pipe.io) return {false, {Error::Unconfirmed}};
  auto& operation = state.operations[token.cell];
  operation.overlapped = {};
  operation.token = token;
  operation.owner = &c;
  StartThreadpoolIo(pipe.io);
  const BOOL returned = token.kind == Kind::Read ?
      ReadFile(pipe.handle, scratch, n, nullptr, &operation.overlapped) :
      WriteFile(pipe.handle, scratch, n, nullptr, &operation.overlapped);
  if (returned) return {true, {}};
  const DWORD error = GetLastError();
  if (error == ERROR_IO_PENDING) return {true, {}};
  CancelThreadpoolIo(pipe.io);
  return {false, io_result(token.kind, error, 0)};
}
Submission sys_read(void* p, Token token, Resource resource, std::byte* scratch, std::uint32_t n) noexcept {
  return issue(p, token, resource, scratch, n);
}
Submission sys_write(void* p, Token token, Resource resource, const std::byte* scratch, std::uint32_t n) noexcept {
  return issue(p, token, resource, const_cast<std::byte*>(scratch), n);
}
CancelResult sys_cancel(void* p, Token token, Resource resource) noexcept {
  auto& state = platform(context(p));
  auto& operation = state.operations[token.cell];
  if (!(operation.token == token)) return CancelResult::Unconfirmed;
  if (CancelIoEx(as_handle(resource), &operation.overlapped)) return CancelResult::Requested;
  return GetLastError() == ERROR_NOT_FOUND ? CancelResult::NotFound : CancelResult::Unconfirmed;
}
Submission sys_close(void* p, Token token, Resource resource) noexcept {
  auto& pipe = platform(context(p)).pipes[lane_index(token.lane)];
  if (pipe.handle && pipe.handle != as_handle(resource)) return {false, {Error::Unconfirmed}};
  if (pipe.io) {
    WaitForThreadpoolIoCallbacks(pipe.io, FALSE);
    CloseThreadpoolIo(pipe.io);
    pipe.io = nullptr;
  }
  bool confirmed = !pipe.auxiliary_unconfirmed;
  // 이미 미확정인 보조 handle은 재사용 가능성을 숨긴 재close로 판정하지 않는다.
  if (!pipe.auxiliary_unconfirmed) confirmed = close_auxiliary(pipe) && confirmed;
  if (pipe.handle) {
    if (CloseHandle(pipe.handle)) pipe.handle = nullptr;
    else confirmed = false;
  }
  return {false, {confirmed ? Error::None : Error::Unconfirmed, confirmed ? 0u : GetLastError()}};
}
Sys make_sys(Context* c) noexcept { return {c, sys_open, sys_read, sys_write, sys_cancel, sys_close}; }

constexpr char kHelpers[] = R"JS((() => {
  'use strict';
  const types = process.getBuiltinModule('node:util').types;
  const Buffer = process.getBuiltinModule('node:buffer').Buffer;
  const isProxy = types.isProxy, isShared = types.isSharedArrayBuffer;
  const isBuffer = Buffer.isBuffer, own = Reflect.ownKeys;
  const descriptor = Object.getOwnPropertyDescriptor, prototype = Object.getPrototypeOf;
  const create = Object.create, freeze = Object.freeze, apply = Reflect.apply;
  const hasOwn = Object.prototype.hasOwnProperty;
  const plain = Object.prototype, array = Array.prototype;
  const typed = prototype(Uint8Array.prototype);
  const backing = descriptor(typed, 'buffer').get;
  const bytes = descriptor(typed, 'byteLength').get;
  const offset = descriptor(typed, 'byteOffset').get;
  const resizable = descriptor(ArrayBuffer.prototype, 'resizable').get;
  function record(value, keys) {
    if (value === null || typeof value !== 'object' || isProxy(value)) throw Error('닫힌 객체가 필요합니다.');
    const p = prototype(value);
    if (p !== plain && p !== null) throw Error('일반 객체가 필요합니다.');
    const actual = own(value);
    if (actual.length !== keys.length) throw Error('객체 키 개수가 다릅니다.');
    const result = create(null);
    for (let i = 0; i < actual.length; ++i) {
      const key = actual[i];
      if (typeof key !== 'string') throw Error('문자열 키가 필요합니다.');
      let found = false;
      for (let j = 0; j < keys.length; ++j) if (key === keys[j]) found = true;
      if (!found) throw Error('허용하지 않은 키입니다.');
      const d = descriptor(value, key);
      if (!d || !d.enumerable || !apply(hasOwn, d, ['value'])) throw Error('데이터 속성이 필요합니다.');
      result[key] = d.value;
    }
    return result;
  }
  const keys = freeze(['name','lane','hostProcess','controllerProcess','hostSidDigest','controllerSidDigest',
    'pipeAclDigest','desiredAccess','shareMode','creationDisposition','flags','inheritHandle']);
  const processKeys = freeze(['pid','creationFileTime100ns','windowsSessionId']);
  return freeze({
    input(value) {
      const r = record(value, keys);
      r.hostProcess = record(r.hostProcess, processKeys);
      r.controllerProcess = record(r.controllerProcess, processKeys);
      return r;
    },
    buffer(value) {
      if (isProxy(value) || !isBuffer(value)) return null;
      const a = apply(backing, value, []);
      if (isShared(a) || apply(resizable, a, [])) return null;
      const result = [a, apply(offset, value, []), apply(bytes, value, [])];
      if (prototype(result) !== array) return null;
      return result;
    }
  });
})())JS";

bool pending_exception(napi_env env) noexcept {
  bool pending = false;
  return napi_is_exception_pending(env, &pending) == napi_ok && pending;
}
napi_value throw_error(napi_env env, const char* code) noexcept {
  if (!pending_exception(env)) static_cast<void>(napi_throw_error(env, code, "Windows pipe 작업을 확인하지 못했습니다. WAIT"));
  return nullptr;
}
bool helper(Context& c, const char* name, napi_value value, napi_value& out) noexcept {
  napi_value helpers{}, function{};
  return napi_get_reference_value(c.env, c.helpers, &helpers) == napi_ok &&
      napi_get_named_property(c.env, helpers, name, &function) == napi_ok &&
      napi_call_function(c.env, helpers, function, 1, &value, &out) == napi_ok;
}
bool text(napi_env env, napi_value value, char* dest, std::size_t capacity, std::size_t& length) noexcept {
  napi_valuetype type{};
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length >= capacity) return false;
  std::size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, dest, capacity, &copied) != napi_ok || copied != length) return false;
  for (std::size_t i = 0; i < copied; ++i) if (dest[i] < 0x20 || dest[i] > 0x7e) return false;
  return true;
}
bool property(napi_env env, napi_value value, const char* name, napi_value& out) noexcept {
  return napi_get_named_property(env, value, name, &out) == napi_ok;
}
bool integer(napi_env env, napi_value value, std::uint32_t& out) noexcept {
  napi_valuetype type{}; double number = 0;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number ||
      napi_get_value_double(env, value, &number) != napi_ok || !(number >= 0 && number <= 4294967295.0)) return false;
  out = static_cast<std::uint32_t>(number);
  return number == static_cast<double>(out) && !(number == 0 && std::signbit(number));
}
bool process_record(Context& c, napi_value value, Process& out) noexcept {
  napi_value member{}; std::size_t length = 0;
  auto* scratch = platform(c).parse.text;
  if (!property(c.env, value, "pid", member) || !integer(c.env, member, out.pid) || out.pid == 0 ||
      !property(c.env, value, "windowsSessionId", member) || !integer(c.env, member, out.session) ||
      !property(c.env, value, "creationFileTime100ns", member) || !text(c.env, member, scratch, 21, length) ||
      length == 0 || (length > 1 && scratch[0] == '0')) return false;
  std::uint64_t parsed = 0;
  for (std::size_t i = 0; i < length; ++i) {
    if (scratch[i] < '0' || scratch[i] > '9') return false;
    const auto digit = static_cast<std::uint64_t>(scratch[i] - '0');
    if (parsed > (std::numeric_limits<std::uint64_t>::max() - digit) / 10) return false;
    parsed = parsed * 10 + digit;
  }
  out.creation_file_time = parsed;
  return true;
}
bool digest_record(Context& c, napi_value value, Digest& out) noexcept {
  std::size_t length = 0;
  auto* scratch = platform(c).parse.text;
  if (!text(c.env, value, scratch, 65, length) || length != 64) return false;
  for (std::size_t i = 0; i < 32; ++i) {
    unsigned byte = 0;
    for (std::size_t j = 0; j < 2; ++j) {
      const char ch = scratch[i * 2 + j];
      if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) return false;
      byte = byte * 16 + static_cast<unsigned>(ch <= '9' ? ch - '0' : ch - 'a' + 10);
    }
    out.bytes[i] = static_cast<std::uint8_t>(byte);
  }
  return true;
}
bool parse_request(Context& c, napi_value input) noexcept {
  napi_value object{}, member{}; std::size_t length = 0;
  if (!helper(c, "input", input, object)) return false;
  auto& r = platform(c).parse.request;
  r = {};
  if (!property(c.env, object, "name", member) || !text(c.env, member, r.name, kNameBytes, length) ||
      !property(c.env, object, "lane", member) || !text(c.env, member, platform(c).parse.text, kNameBytes, length)) return false;
  const auto* lane = platform(c).parse.text;
  if (std::strcmp(lane, "CONTROL") == 0) r.lane = Lane::Control;
  else if (std::strcmp(lane, "IN") == 0) r.lane = Lane::In;
  else if (std::strcmp(lane, "OUT") == 0) r.lane = Lane::Out;
  else if (std::strcmp(lane, "ERR") == 0) r.lane = Lane::Err;
  else return false;
  if (!property(c.env, object, "hostProcess", member) || !process_record(c, member, r.host) ||
      !property(c.env, object, "controllerProcess", member) || !process_record(c, member, r.controller) ||
      !property(c.env, object, "hostSidDigest", member) || !digest_record(c, member, r.host_sid) ||
      !property(c.env, object, "controllerSidDigest", member) || !digest_record(c, member, r.controller_sid) ||
      !property(c.env, object, "pipeAclDigest", member) || !digest_record(c, member, r.pipe_acl) ||
      !property(c.env, object, "desiredAccess", member) || !integer(c.env, member, r.desired_access) ||
      !property(c.env, object, "shareMode", member) || !integer(c.env, member, r.share_mode) ||
      !property(c.env, object, "creationDisposition", member) || !integer(c.env, member, r.creation_disposition) ||
      !property(c.env, object, "flags", member) || !integer(c.env, member, r.flags) ||
      !property(c.env, object, "inheritHandle", member)) return false;
  napi_valuetype type{};
  return napi_typeof(c.env, member, &type) == napi_ok && type == napi_boolean &&
      napi_get_value_bool(c.env, member, &r.inherit_handle) == napi_ok && Core::validate(r) == Error::None;
}
struct BufferView { void* data{}; napi_value backing{}; std::size_t bytes{}, offset{}; };
bool buffer_view(Context& c, napi_value value, BufferView& view) noexcept {
  napi_value descriptor{}, element{}; napi_valuetype type{};
  bool is_buffer = false, detached = false;
  if (napi_is_buffer(c.env, value, &is_buffer) != napi_ok || !is_buffer || !helper(c, "buffer", value, descriptor) ||
      napi_typeof(c.env, descriptor, &type) != napi_ok || type != napi_object ||
      napi_get_element(c.env, descriptor, 0, &view.backing) != napi_ok ||
      napi_is_detached_arraybuffer(c.env, view.backing, &detached) != napi_ok || detached) return false;
  std::uint32_t n = 0, offset = 0;
  if (napi_get_element(c.env, descriptor, 1, &element) != napi_ok || !integer(c.env, element, offset) ||
      napi_get_element(c.env, descriptor, 2, &element) != napi_ok || !integer(c.env, element, n) ||
      n == 0 || n > kChunkBytes) return false;
  void* data = nullptr;
  std::size_t buffer_bytes = 0, backing_bytes = 0;
  void* backing_data = nullptr;
  if (napi_get_buffer_info(c.env, value, &data, &buffer_bytes) != napi_ok || buffer_bytes != n || !data ||
      napi_get_arraybuffer_info(c.env, view.backing, &backing_data, &backing_bytes) != napi_ok ||
      !backing_data || offset > backing_bytes || n > backing_bytes - offset ||
      static_cast<std::byte*>(backing_data) + offset != data) return false;
  view.data = data; view.bytes = n; view.offset = offset;
  return true;
}

const char* code(Error error) noexcept {
  switch (error) {
    case Error::Capacity: return "WINDOWS_PIPE_CLIENT_CAPACITY";
    case Error::Replay: return "WINDOWS_PIPE_CLIENT_REPLAY";
    case Error::Policy: return "WINDOWS_PIPE_CAPTURE_PIN";
    case Error::Peer: return "WINDOWS_PIPE_PEER_MISMATCH";
    case Error::System: return "WINDOWS_PIPE_SYSTEM_FAILURE";
    case Error::Cancelled: return "WINDOWS_PIPE_CLIENT_CANCELLED";
    case Error::ReverseBytes: return "WINDOWS_INPUT_REVERSE_BYTES";
    case Error::Buffer: return "WINDOWS_PIPE_BUFFER_CHANGED";
    case Error::Unconfirmed: return "WINDOWS_PIPE_CLEANUP_UNCONFIRMED";
    case Error::Environment: return "WINDOWS_PIPE_ENVIRONMENT_CLOSED";
    default: return "WINDOWS_PIPE_NATIVE_CONTRACT";
  }
}
bool reject(Context& c, napi_deferred deferred, Error error, const Event* event = nullptr) noexcept {
  napi_value reason{}, message{}, code_value{};
  if (pending_exception(c.env)) {
    if (napi_get_and_clear_last_exception(c.env, &reason) != napi_ok) return false;
  } else {
    if (napi_create_string_utf8(c.env, code(error), NAPI_AUTO_LENGTH, &code_value) != napi_ok ||
        napi_create_string_utf8(c.env, "Windows pipe 확인 대기: WAIT", NAPI_AUTO_LENGTH, &message) != napi_ok ||
        napi_create_error(c.env, code_value, message, &reason) != napi_ok) return false;
    if (event) {
      napi_value bytes{}, system_error{};
      if (napi_create_uint32(c.env, event->bytes, &bytes) != napi_ok ||
          napi_create_uint32(c.env, event->system_error, &system_error) != napi_ok ||
          napi_set_named_property(c.env, reason, "bytesTransferred", bytes) != napi_ok ||
          napi_set_named_property(c.env, reason, "systemError", system_error) != napi_ok) return false;
    }
  }
  return deferred && napi_reject_deferred(c.env, deferred, reason) == napi_ok;
}
void maybe_destroy(Context* c) noexcept {
  if (c->function_owners != 0 || (c->state && !platform(*c).finalized)) return;
  if (c->helpers && c->env && napi_delete_reference(c->env, c->helpers) != napi_ok) return;
  delete c->state;
  delete c;
}
void function_finalizer(napi_env env, void* data, void*) noexcept {
  auto* c = static_cast<Context*>(data);
  if (!env) c->env = nullptr;
  if (c->function_owners != 0) --c->function_owners;
  maybe_destroy(c);
}
napi_value method_callback(napi_env, napi_callback_info) noexcept;
bool method_function(Context& c, const char* name, Method& method, napi_value& out) noexcept {
  if (napi_create_function(c.env, name, NAPI_AUTO_LENGTH, method_callback, &method, &out) != napi_ok ||
      napi_add_finalizer(c.env, out, &c, function_finalizer, nullptr, nullptr) != napi_ok) return false;
  ++c.function_owners;
  return napi_object_freeze(c.env, out) == napi_ok;
}
bool field(napi_env env, napi_value object, const char* name, napi_value value) noexcept {
  const napi_property_descriptor descriptor{name, nullptr, nullptr, nullptr, nullptr, value, napi_enumerable, nullptr};
  return napi_define_properties(env, object, 1, &descriptor) == napi_ok;
}
bool channel(Context& c, Lane lane, napi_value& out) noexcept {
  auto& js = platform(c).lanes[lane_index(lane)];
  auto& methods = c.methods[lane_index(lane)];
  napi_value read{}, write{}, close{}, closed{};
  if (napi_create_object(c.env, &out) != napi_ok ||
      !method_function(c, "readInto", methods[0], read) || !method_function(c, "write", methods[1], write) ||
      !method_function(c, "close", methods[2], close) ||
      napi_get_reference_value(c.env, js.closed_promise, &closed) != napi_ok ||
      !field(c.env, out, "readInto", read) || !field(c.env, out, "write", write) ||
      !field(c.env, out, "close", close) || !field(c.env, out, "closed", closed) ||
      napi_object_freeze(c.env, out) != napi_ok || napi_create_reference(c.env, out, 1, &js.channel) != napi_ok) return false;
  return true;
}
void drop_ref(Context& c, napi_ref& reference, bool available) noexcept {
  if (!reference) return;
  if (available && c.env) {
    if (napi_delete_reference(c.env, reference) != napi_ok) { platform(c).bridge_failed = true; return; }
  }
  reference = nullptr;
}
Delivery deliver(void* p, const Event& event) noexcept {
  auto& c = context(p); auto& state = platform(c);
  if (!event.environment_available || state.cleanup.load(std::memory_order_acquire)) return Delivery::EnvironmentGone;
  // 정리 미확정은 뒤의 원 완료나 다른 lane으로 성공을 전달하지 않는다.
  if (state.bridge_failed) return Delivery::Failed;
  auto& js = state.lanes[lane_index(event.token.lane)];
  bool ok = false;
  if (event.token.kind == Kind::Open) {
    if (js.ready_settled) return Delivery::Failed;
    napi_value value{};
    if (event.error == Error::None && !channel(c, event.token.lane, value)) {
      state.bridge_failed = true; return Delivery::Failed;
    }
    ok = settle_after_references(
        [&]() noexcept { drop_ref(c, js.ready_promise, true); return !js.ready_promise; },
        [&]() noexcept {
          return event.error == Error::None ? napi_resolve_deferred(c.env, js.ready, value) == napi_ok :
              reject(c, js.ready, event.error, &event);
        });
    if (ok) { js.ready_settled = true; js.ready = nullptr; }
  } else if (event.token.kind == Kind::Close) {
    ok = settle_confirmed_close(event.error, js.closed_settled,
        [&]() noexcept {
          napi_value value{};
          if (napi_get_undefined(c.env, &value) != napi_ok || napi_resolve_deferred(c.env, js.closed, value) != napi_ok) return false;
          js.closed = nullptr;
          return true;
        },
        [&]() noexcept {
          for (const auto& b : state.buffers) {
            if (b.token.lane == event.token.lane && (b.buffer || b.backing || b.deferred)) return false;
          }
          drop_ref(c, js.ready_promise, true); drop_ref(c, js.closed_promise, true); drop_ref(c, js.channel, true);
          return !state.bridge_failed && !js.ready_promise && !js.closed_promise && !js.channel;
        });
  } else {
    if (event.reference == 0 || event.reference > kCellCount) return Delivery::Failed;
    auto& b = state.buffers[event.reference - 1];
    if (!(b.token == event.token) || !b.deferred) return Delivery::Failed;
    napi_value value{};
    Error error = event.error;
    bool prepared = true;
    if (error == Error::None && event.token.kind == Kind::Read) {
      napi_value original{}, backing{}, bytes{}, eof{}; BufferView current{}; bool same = false;
      if (napi_get_reference_value(c.env, b.buffer, &original) != napi_ok ||
          napi_get_reference_value(c.env, b.backing, &backing) != napi_ok || !buffer_view(c, original, current) ||
          napi_strict_equals(c.env, backing, current.backing, &same) != napi_ok || !same ||
          current.bytes != b.bytes || current.offset != b.offset || event.bytes > current.bytes ||
          (event.bytes != 0 && !event.data)) error = Error::Buffer;
      else {
        if (event.bytes != 0) std::memcpy(current.data, event.data, event.bytes);
        prepared = napi_create_object(c.env, &value) == napi_ok && napi_create_uint32(c.env, event.bytes, &bytes) == napi_ok &&
            napi_get_boolean(c.env, event.eof, &eof) == napi_ok && field(c.env, value, "bytesRead", bytes) &&
            field(c.env, value, "eof", eof) && napi_object_freeze(c.env, value) == napi_ok;
      }
    } else if (error == Error::None) prepared = napi_create_uint32(c.env, event.bytes, &value) == napi_ok;
    if (!prepared) { state.bridge_failed = true; return Delivery::Failed; }
    // N-API 참조 해제가 확인되기 전에는 L1 ticket을 완료하지 않는다.
    ok = settle_after_references(
        [&]() noexcept { drop_ref(c, b.buffer, true); drop_ref(c, b.backing, true); return !b.buffer && !b.backing; },
        [&]() noexcept { return error == Error::None ? napi_resolve_deferred(c.env, b.deferred, value) == napi_ok : reject(c, b.deferred, error, &event); });
    if (ok) b.deferred = nullptr;
  }
  if (!ok) state.bridge_failed = true;
  return ok ? Delivery::Delivered : Delivery::Failed;
}
void release_reference(void* p, Reference reference, bool available) noexcept {
  auto& c = context(p); auto& state = platform(c);
  if (reference == 0 || reference > kCellCount) { state.bridge_failed = true; return; }
  auto& b = state.buffers[reference - 1];
  b.native_done = true;
  // JS가 닫힌 경로에서는 참조 삭제도 TSFN finalizer의 원 JS thread로 넘긴다.
  if (!available || state.cleanup.load(std::memory_order_acquire)) return;
  drop_ref(c, b.buffer, true); drop_ref(c, b.backing, true);
  if (!b.buffer && !b.backing && !b.deferred) b = {};
}
void runtime_lock(void* p) noexcept { AcquireSRWLockExclusive(&platform(context(p)).lock); }
void runtime_unlock(void* p) noexcept { ReleaseSRWLockExclusive(&platform(context(p)).lock); }
void* allocate(void*, Allocation kind, std::size_t bytes) noexcept {
  if ((kind == Allocation::Metadata && bytes != kMetadataBytes) ||
      (kind == Allocation::Scratch && (bytes == 0 || bytes > kChunkBytes))) return nullptr;
  return std::malloc(bytes);
}
void release(void*, Allocation, void* p, std::size_t) noexcept { std::free(p); }
void schedule_cleanup(Context& c) noexcept {
  auto& state = platform(c);
  if (InterlockedCompareExchange(&state.work_queued, 1, 0) == 0) SubmitThreadpoolWork(state.cleanup_work);
}
Wake runtime_wake(void* p) noexcept {
  auto& c = context(p); auto& state = platform(c);
  if (state.cleanup.load(std::memory_order_acquire)) { schedule_cleanup(c); return Wake::Queued; }
  const auto status = napi_call_threadsafe_function(state.tsfn, nullptr, napi_tsfn_nonblocking);
  if (status == napi_ok) return Wake::Queued;
  if (status == napi_queue_full) return Wake::QueueFull;
  state.cleanup.store(true, std::memory_order_release);
  schedule_cleanup(c);
  return Wake::Closing;
}
Runtime make_runtime(Context* c) noexcept {
  return {c, runtime_lock, runtime_unlock, allocate, release, runtime_wake, deliver, release_reference};
}
void release_tsfn(Context& c, napi_threadsafe_function_release_mode mode) noexcept {
  auto& state = platform(c);
  if (!state.released.exchange(true, std::memory_order_acq_rel)) {
    if (napi_release_threadsafe_function(state.tsfn, mode) != napi_ok) state.bridge_failed = true;
  }
}
void CALLBACK cleanup_worker(PTP_CALLBACK_INSTANCE, void* data, PTP_WORK) noexcept {
  auto& c = context(data); auto& state = platform(c);
  c.state->core.environment_end();
  for (;;) {
    c.state->core.drain();
    InterlockedExchange(&state.work_queued, 0);
    const auto snapshot = c.state->core.snapshot();
    if (snapshot.idle) { release_tsfn(c, napi_tsfn_abort); return; }
    if (!snapshot.wake_pending || InterlockedCompareExchange(&state.work_queued, 1, 0) != 0) return;
  }
}
void begin_cleanup(Context& c) noexcept {
  // TSFN 게시와 같은 lock으로 closing 경계를 고정한다.
  runtime_lock(&c);
  platform(c).cleanup.store(true, std::memory_order_release);
  runtime_unlock(&c);
  c.state->core.environment_end();
  schedule_cleanup(c);
}
void cleanup_hook(napi_async_cleanup_hook_handle, void* data) noexcept {
  auto& c = context(data);
  begin_cleanup(c);
}
void call_js(napi_env env, napi_value, void* data, void*) noexcept {
  auto& c = context(data); auto& state = platform(c);
  if (!env || state.cleanup.load(std::memory_order_acquire)) {
    begin_cleanup(c);
    return;
  }
  c.state->core.drain();
  const auto snapshot = c.state->core.snapshot();
  if (snapshot.idle && snapshot.sealed) release_tsfn(c, napi_tsfn_release);
}
void tsfn_finalizer(napi_env env, void* data, void*) noexcept {
  auto* c = static_cast<Context*>(data); auto& state = platform(*c);
  if (!c->state->core.snapshot().idle) {
    state.bridge_failed = true;
    state.released.store(true, std::memory_order_release);
    begin_cleanup(*c);
    return;
  }
  if (state.cleanup_work) {
    WaitForThreadpoolWorkCallbacks(state.cleanup_work, FALSE);
    CloseThreadpoolWork(state.cleanup_work); state.cleanup_work = nullptr;
  }
  // 여기까지 왔을 때만 모든 원 IO가 회수됐다. JS 값 생성과 resolve는 하지 않는다.
  for (auto& b : state.buffers) {
    drop_ref(*c, b.buffer, env != nullptr); drop_ref(*c, b.backing, env != nullptr);
    if (b.buffer || b.backing) return;
    if (!env) b.deferred = nullptr;
    if (!reset_released_reference_slot(b)) return;
  }
  for (auto& lane : state.lanes) {
    drop_ref(*c, lane.ready_promise, env != nullptr); drop_ref(*c, lane.closed_promise, env != nullptr);
    drop_ref(*c, lane.channel, env != nullptr);
    if (lane.ready_promise || lane.closed_promise || lane.channel) return;
    lane.ready = lane.closed = nullptr;
  }
  if (state.cleanup_hook) {
    if (napi_remove_async_cleanup_hook(state.cleanup_hook) != napi_ok) { state.bridge_failed = true; return; }
    state.cleanup_hook = nullptr;
  }
  state.finalized = true;
  if (!env) c->env = nullptr;
  // 닫힌 JS 함수에는 작은 context만 남기고 원 ledger는 여기서 회수한다.
  c->closed = true;
  auto* retired = c->state;
  c->state = nullptr;
  delete retired;
  maybe_destroy(c);
}
bool ensure_state(Context& c) noexcept {
  if (c.closed) return false;
  if (c.state) return true;
  c.state = new (std::nothrow) NativeState(&c);
  if (!c.state) return false;
  for (std::size_t i = 0; i < kLaneCount; ++i) {
    auto& methods = c.methods[i];
    for (std::size_t j = 0; j < 4; ++j) methods[j] = {&c, static_cast<Lane>(i), static_cast<MethodKind>(j)};
  }
  return true;
}
bool initialize(Context& c) noexcept {
  if (!ensure_state(c)) return false;
  auto& state = platform(c);
  if (state.tsfn) return !state.released.load(std::memory_order_acquire) && !state.cleanup.load(std::memory_order_acquire);
  state.cleanup_work = CreateThreadpoolWork(cleanup_worker, &c, nullptr);
  if (!state.cleanup_work) { delete c.state; c.state = nullptr; return false; }
  napi_value resource{};
  if (napi_create_string_utf8(c.env, "trio-windows-pipe-client", NAPI_AUTO_LENGTH, &resource) != napi_ok ||
      napi_create_threadsafe_function(c.env, nullptr, nullptr, resource, 1, 1, &c, tsfn_finalizer,
                                      &c, call_js, &state.tsfn) != napi_ok) {
    CloseThreadpoolWork(state.cleanup_work); delete c.state; c.state = nullptr; return false;
  }
  state.finalized = false;
  if (napi_add_async_cleanup_hook(c.env, cleanup_hook, &c, &state.cleanup_hook) != napi_ok ||
      napi_unref_threadsafe_function(c.env, state.tsfn) != napi_ok) {
    state.cleanup.store(true, std::memory_order_release);
    release_tsfn(c, napi_tsfn_abort);
    return false;
  }
  return true;
}

napi_value method_callback(napi_env env, napi_callback_info info) noexcept {
  napi_value args[2]{}, receiver{}; std::size_t argc = 2; void* data = nullptr;
  if (napi_get_cb_info(env, info, &argc, args, &receiver, &data) != napi_ok || argc != 1 || !data)
    return throw_error(env, "WINDOWS_PIPE_NATIVE_CONTRACT");
  auto& method = *static_cast<Method*>(data); auto& c = *method.owner;
  if (method.kind == MethodKind::Close || method.kind == MethodKind::Cancel) {
    napi_valuetype type{};
    if (napi_typeof(env, args[0], &type) != napi_ok || type != napi_string) return throw_error(env, "WINDOWS_PIPE_NATIVE_CONTRACT");
  }
  if (!c.state || platform(c).released.load(std::memory_order_acquire)) {
    if (method.kind == MethodKind::Close || method.kind == MethodKind::Cancel) {
      napi_value value{};
      return napi_get_undefined(env, &value) == napi_ok ? value : nullptr;
    }
    return throw_error(env, "WINDOWS_PIPE_ENVIRONMENT_CLOSED");
  }
  if (method.kind == MethodKind::Close || method.kind == MethodKind::Cancel) {
    CloseReason reason = CloseReason::Cancel;
    std::size_t length = 0;
    if (method.kind == MethodKind::Close && napi_get_value_string_utf8(env, args[0], nullptr, 0, &length) == napi_ok && length == 9) {
      char small[10]{}; std::size_t copied = 0;
      if (napi_get_value_string_utf8(env, args[0], small, sizeof(small), &copied) != napi_ok) return nullptr;
      if (copied == 9 && std::memcmp(small, "INPUT_END", 9) == 0) reason = CloseReason::InputEnd;
    }
    const auto error = c.state->core.close(method.lane, reason);
    if (error != Error::None) return throw_error(env, code(error));
    napi_value value{};
    return napi_get_undefined(env, &value) == napi_ok ? value : nullptr;
  }
  if (platform(c).bridge_failed) return throw_error(env, "WINDOWS_PIPE_REFERENCE_FAILURE");
  BufferView view{};
  if (!buffer_view(c, args[0], view)) return throw_error(env, "WINDOWS_PIPE_BUFFER_INVALID");
  auto& state = platform(c); std::size_t selected = kCellCount;
  for (std::size_t i = 0; i < kCellCount; ++i) if (reference_slot_available(state.buffers[i])) { selected = i; break; }
  if (selected == kCellCount) return throw_error(env, "WINDOWS_PIPE_CLIENT_CAPACITY");
  auto& b = state.buffers[selected]; napi_value promise{};
  if (napi_create_promise(env, &b.deferred, &promise) != napi_ok ||
      napi_create_reference(env, args[0], 1, &b.buffer) != napi_ok ||
      napi_create_reference(env, view.backing, 1, &b.backing) != napi_ok) {
    drop_ref(c, b.buffer, true); drop_ref(c, b.backing, true); static_cast<void>(reset_released_reference_slot(b));
    return throw_error(env, "WINDOWS_PIPE_REFERENCE_FAILURE");
  }
  b.bytes = view.bytes; b.offset = view.offset;
  const auto reference = static_cast<Reference>(selected + 1);
  const auto accepted = method.kind == MethodKind::Read ?
      c.state->core.read(method.lane, static_cast<std::uint32_t>(view.bytes), reference) :
      c.state->core.write(method.lane, static_cast<const std::byte*>(view.data), static_cast<std::uint32_t>(view.bytes), reference);
  if (accepted.error != Error::None) {
    const bool rejected = settle_after_references(
        [&]() noexcept { drop_ref(c, b.buffer, true); drop_ref(c, b.backing, true); return !b.buffer && !b.backing; },
        [&]() noexcept { return reject(c, b.deferred, accepted.error); });
    if (rejected) { b.deferred = nullptr; static_cast<void>(reset_released_reference_slot(b)); }
    else state.bridge_failed = true;
    return promise;
  }
  b.token = accepted.token;
  return promise;
}
napi_value open_callback(napi_env env, napi_callback_info info) noexcept {
  napi_value args[2]{}, receiver{}; std::size_t argc = 2; void* data = nullptr;
  if (napi_get_cb_info(env, info, &argc, args, &receiver, &data) != napi_ok || argc != 1 || !data)
    return throw_error(env, "WINDOWS_PIPE_NATIVE_CONTRACT");
  auto& c = context(data);
  if (!ensure_state(c)) return throw_error(env, "WINDOWS_PIPE_NATIVE_CONTRACT");
  if (platform(c).bridge_failed) return throw_error(env, "WINDOWS_PIPE_REFERENCE_FAILURE");
  if (!parse_request(c, args[0]) || !initialize(c)) return throw_error(env, "WINDOWS_PIPE_NATIVE_CONTRACT");
  auto& state = platform(c); const Lane lane = state.parse.request.lane;
  auto& js = state.lanes[lane_index(lane)];
  if (js.ready_promise || js.closed_promise || js.ready_settled || js.closed_settled) return throw_error(env, "WINDOWS_PIPE_CLIENT_REPLAY");
  napi_value ready{}, closed{}, cancel{}, result{};
  if (napi_create_promise(env, &js.ready, &ready) != napi_ok || napi_create_promise(env, &js.closed, &closed) != napi_ok ||
      napi_create_reference(env, ready, 1, &js.ready_promise) != napi_ok ||
      napi_create_reference(env, closed, 1, &js.closed_promise) != napi_ok ||
      !method_function(c, "cancel", c.methods[lane_index(lane)][3], cancel) || napi_create_object(env, &result) != napi_ok ||
      !field(env, result, "ready", ready) || !field(env, result, "cancel", cancel) ||
      !field(env, result, "closed", closed) || napi_object_freeze(env, result) != napi_ok) {
    drop_ref(c, js.ready_promise, true); drop_ref(c, js.closed_promise, true);
    if (!js.ready_promise && !js.closed_promise) js.ready = js.closed = nullptr;
    state.bridge_failed = true;
    return throw_error(env, "WINDOWS_PIPE_REFERENCE_FAILURE");
  }
  const auto accepted = c.state->core.open(state.parse.request);
  if (accepted.error != Error::None) {
    // OS 요청 전 거부도 원 N-API 참조 해제 뒤에만 완료한다.
    const bool rejected = settle_after_references(
        [&]() noexcept { drop_ref(c, js.ready_promise, true); drop_ref(c, js.closed_promise, true); return !js.ready_promise && !js.closed_promise; },
        [&]() noexcept {
          if (!reject(c, js.ready, accepted.error)) return false;
          js.ready_settled = true; js.ready = nullptr;
          napi_value value{};
          if (napi_get_undefined(env, &value) != napi_ok || napi_resolve_deferred(env, js.closed, value) != napi_ok) return false;
          js.closed_settled = true; js.closed = nullptr;
          return true;
        });
    if (!rejected) state.bridge_failed = true;
  }
  return result;
}
napi_value create_binding(napi_env env, napi_callback_info info) noexcept {
  std::size_t argc = 1; napi_value argument{};
  if (napi_get_cb_info(env, info, &argc, &argument, nullptr, nullptr) != napi_ok || argc != 0)
    return throw_error(env, "WINDOWS_PIPE_NATIVE_CONTRACT");
  auto* c = new (std::nothrow) Context{};
  if (!c) return throw_error(env, "WINDOWS_PIPE_CLIENT_CAPACITY");
  c->env = env;
  napi_value script{}, helpers{}, open{}, binding{};
  if (napi_create_string_utf8(env, kHelpers, sizeof(kHelpers) - 1, &script) != napi_ok ||
      napi_run_script(env, script, &helpers) != napi_ok || napi_create_reference(env, helpers, 1, &c->helpers) != napi_ok ||
      napi_create_function(env, "open", NAPI_AUTO_LENGTH, open_callback, c, &open) != napi_ok ||
      napi_add_finalizer(env, open, c, function_finalizer, nullptr, nullptr) != napi_ok) {
    if (c->helpers) static_cast<void>(napi_delete_reference(env, c->helpers));
    delete c; return throw_error(env, "WINDOWS_PIPE_NATIVE_CONTRACT");
  }
  ++c->function_owners;
  if (napi_object_freeze(env, open) != napi_ok || napi_create_object(env, &binding) != napi_ok ||
      !field(env, binding, "open", open) || napi_object_freeze(env, binding) != napi_ok)
    return throw_error(env, "WINDOWS_PIPE_NATIVE_CONTRACT");
  return binding;
}

}  // 익명 이름 공간
}  // trio::pipe_client 이름 공간

NAPI_MODULE_INIT() {
  static_cast<void>(exports);
  napi_value result{}, create{};
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_function(env, "createBinding", NAPI_AUTO_LENGTH, trio::pipe_client::create_binding, nullptr, &create) != napi_ok ||
      napi_object_freeze(env, create) != napi_ok || !trio::pipe_client::field(env, result, "createBinding", create) ||
      napi_object_freeze(env, result) != napi_ok)
    return trio::pipe_client::throw_error(env, "WINDOWS_PIPE_NATIVE_CONTRACT");
  return result;
}
