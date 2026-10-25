"""승인된 W5-A 로컬 host 조립. import와 기본 factory에는 실제 I/O가 없다."""
import hashlib
import hmac
import json
import re
import struct
import types
import inspect

CORE_SHA256 = "1d6bdb8df12aa1f8668b418ae562df146ca9dca2ab408eedc34b6bb227d92868"
DOMAIN = "trio-windows-broker-v1"
LANES = ("CONTROL", "IN", "OUT", "ERR")
KINDS = ("OPEN", "CHALLENGE", "AUTH", "ACCEPT", "ATTACH", "ATTACHED")
BOOT_KEYS = ("version", "hostEpochId", "environmentDigest", "controllerInstanceId", "endpointId",
             "hostProcess", "controllerProcess", "hostSidDigest", "controllerSidDigest", "key")
BODY_KEYS = ("hostEpochId", "environmentDigest", "originDigest", "attemptId", "sessionId", "launchId",
             "launchRef", "controllerInstanceId", "clientNonce", "serverNonce", "hostProcess",
             "controllerProcess", "hostSidDigest", "controllerSidDigest")
BOUND_KEYS = ("maxControlBytes", "maxChunkBytes", "streamHighWaterMarkBytes", "maxQueuedBytes",
              "maxInFlightBytes", "maxRetainedRecords", "handshakeMilliseconds", "closeMilliseconds",
              "maxPendingOperations")
UID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
HEX = re.compile(r"^[0-9a-f]{64}$")
EMPTY_HASH = hashlib.sha256(b"").hexdigest()


class HostError(ValueError):
    def __init__(self, code="WINDOWS_RUNTIME_INVALID"):
        self.code, self.next_action = code, "WAIT"
        super().__init__(code)


def _need(value, code="WINDOWS_RUNTIME_INVALID"):
    if not value:
        raise HostError(code)


def _keys(value, keys):
    _need(type(value) is dict and all(type(k) is str for k in value) and set(value) == set(keys))
    return value


def _uint(value, low=0, high=(1 << 53) - 1):
    _need(type(value) is int and low <= value <= high)
    return value


def _uuid(value):
    _need(type(value) is str and UID.fullmatch(value) is not None)


def _hex(value):
    _need(type(value) is str and HEX.fullmatch(value) is not None)


def _decimal(value, positive=False):
    _need(type(value) is str and re.fullmatch(r"0|[1-9][0-9]{0,19}", value) is not None)
    n = int(value)
    _need(n < 1 << 64 and (not positive or n > 0))
    return n


def _scan(value, cap=131072):
    count, size, ancestors = 0, 0, set()
    def visit(v, depth):
        nonlocal count, size
        count += 1
        _need(count <= 8192 and depth <= 20, "WINDOWS_BUFFER_LIMIT")
        if v is None or type(v) is bool:
            size += 5
        elif type(v) is int:
            _uint(v, -(1 << 53) + 1)
            size += len(str(v))
        elif type(v) is str:
            _need(v.isascii())
            size += 2
            for char in v:
                size += 6 if ord(char) < 32 else 2 if char in '\\"' else 1
                _need(size <= cap, "WINDOWS_BUFFER_LIMIT")
        else:
            _need(type(v) in (dict, list) and id(v) not in ancestors)
            _need(len(v) <= 8192 - count, "WINDOWS_BUFFER_LIMIT")
            size += 2 + max(0, len(v) - 1)
            ancestors.add(id(v))
            if type(v) is dict:
                for k, item in v.items():
                    _need(type(k) is str)
                    visit(k, depth + 1)
                    size += 1
                    visit(item, depth + 1)
            else:
                for item in v:
                    visit(item, depth + 1)
            ancestors.remove(id(v))
        _need(size <= cap, "WINDOWS_BUFFER_LIMIT")
    visit(value, 0)
    return size


def _copy(value):
    if type(value) is dict:
        return {k: _copy(v) for k, v in value.items()}
    if type(value) is list:
        return [_copy(v) for v in value]
    return value


def _canonical(value):
    _scan(value)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def canonical_unsigned(envelope):
    _need(type(envelope) is dict)
    _need(set(envelope) in (set(("version", "domain", "kind", "endpointId", "lane", "body")),
                           set(("version", "domain", "kind", "endpointId", "lane", "body", "mac"))))
    value = {k: v for k, v in envelope.items() if k != "mac"}
    _need(type(value["version"]) is int and value["version"] == 1 and value["domain"] == DOMAIN)
    _need(value["kind"] in KINDS and value["lane"] in LANES)
    _uuid(value["endpointId"])
    if value["kind"] == "OPEN":
        _need(value["lane"] == "CONTROL")
        _keys(value["body"], ("capture", "controllerInstanceId", "clientNonce"))
        _uuid(value["body"]["controllerInstanceId"])
        _hex(value["body"]["clientNonce"])
    else:
        b = _keys(value["body"], BODY_KEYS)
        _need((value["kind"] in ("CHALLENGE", "AUTH", "ACCEPT")) == (value["lane"] == "CONTROL"))
        for k in ("hostEpochId", "attemptId", "sessionId", "launchId", "launchRef", "controllerInstanceId"):
            _uuid(b[k])
        for k in ("environmentDigest", "originDigest", "clientNonce", "serverNonce", "hostSidDigest", "controllerSidDigest"):
            _hex(b[k])
        _process(b["hostProcess"])
        _process(b["controllerProcess"])
    return _canonical(value)


def private_mac(key, envelope):
    _need(type(key) is bytes and len(key) == 32)
    return hmac.new(key, canonical_unsigned(envelope), hashlib.sha256).hexdigest()


def pipe_name(bootstrap, capture, lane):
    _need(lane in LANES)
    _uuid(bootstrap["endpointId"])
    _uuid(bootstrap["hostEpochId"])
    base = "\\\\.\\pipe\\trio-w5a-" + bootstrap["endpointId"] + "-" + bootstrap["hostEpochId"]
    if lane == "CONTROL":
        return base + "-ctl"
    _need(type(capture) is dict)
    a = capture["origin"]["authority"]
    _uuid(a["sessionId"])
    _uuid(a["launchId"])
    _hex(capture["originDigest"])
    return base + "-" + a["sessionId"] + "-" + a["launchId"] + "-" + capture["originDigest"][:16] + "-" + lane.lower()


def _process(value):
    _keys(value, ("pid", "creationFileTime100ns", "windowsSessionId"))
    _uint(value["pid"], 1, 0xffffffff)
    _decimal(value["creationFileTime100ns"], True)
    _uint(value["windowsSessionId"], 0, 0xffffffff)


def _methods(port, names):
    if type(port) is dict:
        _keys(port, names)
        values = [port[n] for n in names]
    else:
        values = []
        for name in names:
            item = inspect.getattr_static(port, name, None)
            if type(item) is types.FunctionType and inspect.getattr_static(type(port), name, None) is item:
                item = types.MethodType(item, port)
            elif type(item) not in (types.FunctionType, types.MethodType, types.BuiltinFunctionType):
                raise HostError("WINDOWS_PORT_MISSING")
            values.append(item)
    _need(all(callable(v) for v in values), "WINDOWS_PORT_MISSING")
    return types.SimpleNamespace(**dict(zip(names, values)))

def _registration(value):
    _keys(value, ("bootstrap", "launch", "bounds"))
    b = _keys(value["bootstrap"], BOOT_KEYS)
    _need(type(b["version"]) is int and b["version"] == 1)
    for key in ("hostEpochId", "controllerInstanceId", "endpointId"):
        _uuid(b[key])
    for key in ("environmentDigest", "hostSidDigest", "controllerSidDigest"):
        _hex(b[key])
    _process(b["hostProcess"])
    _process(b["controllerProcess"])
    _need(b["hostProcess"]["windowsSessionId"] == b["controllerProcess"]["windowsSessionId"])
    _need(type(b["key"]) is bytes and len(b["key"]) == 32)
    bounds = _keys(value["bounds"], BOUND_KEYS)
    for n in bounds.values():
        _uint(n, 1)
    _need(bounds["maxControlBytes"] == 131072 and bounds["maxPendingOperations"] == 32)
    _need(bounds["maxChunkBytes"] <= 65536 and bounds["streamHighWaterMarkBytes"] <= bounds["maxChunkBytes"])
    _need(bounds["maxRetainedRecords"] <= 64)
    _need(bounds["handshakeMilliseconds"] <= 2147483647 and bounds["closeMilliseconds"] <= 2147483647)
    l = _keys(value["launch"], ("files", "executableId", "argv", "cwd", "environment", "token",
                              "appContainerSid", "expectedToken", "allowedPolicy"))
    descriptor = {k: v for k, v in l.items() if k not in ("token", "appContainerSid")}
    _scan({"bootstrap": {k: v for k, v in b.items() if k != "key"}, "launch": descriptor, "bounds": bounds})
    _need(type(l["files"]) is list and len(l["files"]) <= 64)
    seen = set()
    for f in l["files"]:
        _keys(f, ("id", "path", "bytes", "sha256", "role"))
        _need(type(f["id"]) is str and f["id"] and f["id"] not in seen)
        seen.add(f["id"])
        _need(type(f["path"]) is str and re.match(r"^[A-Za-z]:\\", f["path"]) is not None and "\0" not in f["path"])
        _uint(f["bytes"], 1)
        _hex(f["sha256"])
        _need(type(f["role"]) is str and f["role"])
    _need(type(l["executableId"]) is str and l["executableId"])
    _need(type(l["argv"]) is list and 0 < len(l["argv"]) <= 64 and all(type(s) is str and s and "\0" not in s for s in l["argv"]))
    _need(type(l["cwd"]) is str and re.match(r"^[A-Za-z]:\\", l["cwd"]) is not None and "\0" not in l["cwd"])
    _need(type(l["environment"]) is dict and all(re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", k) and
        type(v) is str and "\0" not in v for k, v in l["environment"].items()))
    t = _keys(l["expectedToken"], ("childSidDigest", "appContainerSidDigest", "integritySidDigest", "capabilityCount", "windowsSessionId"))
    for key in ("childSidDigest", "appContainerSidDigest", "integritySidDigest"):
        _hex(t[key])
    _uint(t["capabilityCount"], 0, 0)
    _uint(t["windowsSessionId"], 0, 0xffffffff)
    _need(t["windowsSessionId"] == b["hostProcess"]["windowsSessionId"])
    result = {"bootstrap": _copy({k: v for k, v in b.items() if k != "key"}) | {"key": bytes(b["key"])},
              "launch": _copy(descriptor) | {"token": l["token"], "appContainerSid": l["appContainerSid"]},
              "bounds": _copy(bounds)}
    return result


def create_windows_host_runtime(registration, ports):
    """사전에 load한 같은 core와 신뢰 포트를 고정한다. 생성 시 파일을 읽지 않는다."""
    _keys(ports, ("core", "makeDriver", "sys", "validation", "clock", "ids", "memory"))
    core = ports["core"]
    _need(type(core) is types.ModuleType and core is _PINNED_CORE and _core_pin(core) == _CORE_PIN, "WINDOWS_CORE_INVALID")
    _need(callable(ports["makeDriver"]))
    frozen = _registration(registration)
    core._requested_policy(frozen["launch"]["allowedPolicy"])
    return _Runtime(core, frozen, ports)


def create_real_windows_host_runtime(registration, validation, *, enable_real=False):
    """실제 권한 공급이 없으면 DLL과 파일을 열기 전에 거부한다."""
    _need(enable_real is True, "WINDOWS_REAL_RUNTIME_DISABLED")
    import sys
    _need(sys.platform == "win32" and sys.maxsize > 0xffffffff, "WINDOWS_X64_REQUIRED")
    frozen = _registration(registration)
    checked = _methods(validation, ("verify_registration", "authorize_capture", "validate_current", "is_registration_current"))
    _need(frozen["launch"]["files"] and frozen["launch"]["token"] is not None and frozen["launch"]["appContainerSid"] is not None,
          "WINDOWS_BOOTSTRAP_MISSING")
    return _LazyRealRuntime(frozen, checked)

class _Budget:
    def __init__(self, bounds, memory):
        self.bounds, self.memory = bounds, memory
        self.held = 0
        self.reserve = min(bounds["maxInFlightBytes"] // 2, 4 * bounds["maxControlBytes"] + 2048)
        self._pool_size = self._pool_used = self._loans = 0
        self._pool_release = None

    def start(self):
        _need(self._pool_release is None and self.held == 0 and self._loans == 0, "WINDOWS_BUFFER_ACCOUNTING")
        _need(self.reserve <= self.memory.available(), "WINDOWS_BUFFER_LIMIT")
        release = self.memory.hold(self.reserve)
        _need(callable(release), "WINDOWS_MEMORY_INVALID")
        self._pool_release, self._pool_size = release, self.reserve
        self.held += self.reserve

    def finish(self):
        if self._loans or self._pool_used or self.held != self._pool_size:
            return False
        if self._pool_release is not None:
            self._pool_release()
            self.held -= self._pool_size
            self._pool_release, self._pool_size = None, 0
        return True

    def hold(self, count, control=False):
        _uint(count)
        pooled = min(count, self._pool_size - self._pool_used) if control else 0
        extra = count - pooled
        cap = self.bounds["maxInFlightBytes"] - (0 if control else self.reserve - self._pool_size)
        _need(self.held + extra <= cap and extra <= self.memory.available(), "WINDOWS_BUFFER_LIMIT")
        release = self.memory.hold(extra) if extra else None
        _need(extra == 0 or callable(release), "WINDOWS_MEMORY_INVALID")
        self.held += extra
        self._pool_used += pooled
        self._loans += 1
        live = True
        def done():
            nonlocal live
            _need(live, "WINDOWS_BUFFER_ACCOUNTING")
            live = False
            if release is not None:
                release()
            self.held -= extra
            self._pool_used -= pooled
            self._loans -= 1
        return done


class _Operation:
    def __init__(self, runtime, kind, handle, lane, size, start, *, reserved=None):
        self.runtime, self.kind, self.handle, self.lane = runtime, kind, handle, lane
        self.op = self.result = None
        self.cancelled = self.unknown = False
        _need(len(runtime._ops) < runtime.bounds["maxPendingOperations"], "WINDOWS_OPERATION_LIMIT")
        self.release = reserved or runtime._budget.hold(size + 256, lane == "CONTROL" or kind == "close")
        runtime._ops.append(self)
        try:
            self.op = start()
            _need(self.op is not None, "WINDOWS_OPERATION_INVALID")
        except Exception:
            self.unknown = True
            runtime._fail("WINDOWS_OPERATION_RETURN_LOST")
            raise

    def poll(self):
        if self.result is not None:
            return self.result
        if self.unknown or self.lane in self.runtime._completed:
            return None
        try:
            value = self.runtime.sys.poll(self.op)
        except Exception:
            self.unknown = True
            self.runtime._fail("WINDOWS_COMPLETION_RETURN_LOST")
            return None
        if value is None:
            return None
        _need(type(value) is dict and value.get("state") in ("RETURNED", "FAILED", "UNCONFIRMED"), "WINDOWS_COMPLETION_INVALID")
        self.runtime._completed.add(self.lane)
        if value["state"] == "UNCONFIRMED":
            _keys(value, ("state", "code"))
            self.unknown = True
            self.runtime._fail(value["code"])
            return None
        _keys(value, ("state", "value") if value["state"] == "RETURNED" else ("state", "code"))
        self.ticks = str(self.runtime._now())
        self.result = value
        return value

    def retire(self):
        _need(self.result is not None and self in self.runtime._ops, "WINDOWS_COMPLETION_INVALID")
        self.runtime._ops.remove(self)
        self.release()
        self.op = None

    def cancel(self):
        if self.cancelled or self.result is not None:
            return
        self.cancelled = True
        if self.op is not None:
            try:
                self.runtime.sys.cancel(self.op)
            except Exception:
                self.runtime._fail("WINDOWS_CANCEL_UNCONFIRMED")


class _Write:
    def __init__(self, runtime, handle, lane, data, *, reserved=None):
        _need(type(data) is bytes and len(data) > 0)
        self.runtime, self.handle, self.lane, self.data = runtime, handle, lane, data
        self.release = reserved or runtime._budget.hold(len(data), lane == "CONTROL")
        self.offset, self.operation, self.done, self.failed = 0, None, False, False

    def poll(self):
        if self.done:
            return True
        if self.failed:
            return None
        if self.operation is None:
            self.operation = _Operation(self.runtime, "write", self.handle, self.lane, 2 * (len(self.data) - self.offset),
                lambda: self.runtime.sys.write(self.handle, self.data, self.offset))
        value = self.operation.poll()
        if value is None:
            return None
        if value["state"] != "RETURNED":
            self.ticks = self.operation.ticks
            self.operation.retire()
            self.operation = None
            self.failed = True
            self.release()
            self.data = b""
            self.runtime._fail(value["code"])
            return None
        _keys(value["value"], ("transferred",))
        count = _uint(value["value"]["transferred"], 1, len(self.data) - self.offset)
        self.operation_ticks = self.operation.ticks
        self.operation.retire()
        self.operation = None
        self.ticks = self.operation_ticks
        self.offset += count
        if self.offset == len(self.data):
            self.done = True
            self.release()
            self.data = b""
            return True
        return None

    def cancel(self):
        if self.operation:
            self.operation.cancel()
        elif not self.done and not self.failed:
            self.failed = True
            self.release()
            self.data = b""

    def drain(self):
        if self.operation is None:
            return self.done or self.failed
        value = self.operation.poll()
        if value is None:
            return False
        self.operation.retire()
        self.operation = None
        self.failed = True
        self.release()
        self.data = b""
        return True


class _Frame:
    def __init__(self, runtime, handle, lane):
        self.runtime, self.handle, self.lane = runtime, handle, lane
        self.prefix, self.body, self.size = bytearray(), bytearray(), None
        self.operation = None
        self.release = None
        self.eof = False

    def read(self):
        if self.eof:
            return None
        desired = 4 - len(self.prefix) if self.size is None else self.size - len(self.body)
        if self.operation is None:
            n = min(desired, self.runtime.bounds["maxChunkBytes"])
            self.operation = _Operation(self.runtime, "read", self.handle, self.lane, n,
                lambda: self.runtime.sys.read(self.handle, n))
        result = self.operation.poll()
        if result is None:
            return None
        if result["state"] != "RETURNED":
            self.operation.retire()
            self.operation = None
            self.eof = True
            self.runtime._fail(result["code"])
            return None
        packet = _keys(result["value"], ("data", "eof"))
        data, eof = packet["data"], packet["eof"]
        _need(type(data) is bytes and type(eof) is bool and (not eof or not data) and len(data) <= desired,
              "WINDOWS_READ_INVALID")
        _need(data or eof, "WINDOWS_READ_INVALID")
        if eof:
            self.eof = True
            self.operation.retire()
            self.operation = None
            self.runtime._fail("WINDOWS_TRUNCATED_FRAME" if self.prefix or self.body else "WINDOWS_CONTROL_LOST")
            return None
        if self.size is None:
            self.prefix.extend(data)
        else:
            self.body.extend(data)
        self.operation.retire()
        self.operation = None
        if self.size is None and len(self.prefix) == 4:
            self.size = int.from_bytes(self.prefix, "big")
            _uint(self.size, 1, self.runtime.bounds["maxControlBytes"])
            self.release = self.runtime._budget.hold(self.size * 4 + 4, self.lane == "CONTROL")
        if self.size is not None and len(self.body) == self.size:
            value = bytes(self.prefix) + bytes(self.body)
            self.prefix.clear()
            self.body.clear()
            self.size = None
            release, self.release = self.release, None
            return value, release
        return None

    def cancel(self):
        if self.operation:
            self.operation.cancel()

    def drain(self):
        if self.operation:
            value = self.operation.poll()
            if value is None:
                return False
            self.operation.retire()
            self.operation = None
        if self.release:
            self.release()
            self.release = None
        self.prefix.clear()
        self.body.clear()
        return True


class _Runtime:
    def __init__(self, core, registration, ports):
        self.core, self.registration = core, registration
        self.bootstrap, self.bounds = registration["bootstrap"], registration["bounds"]
        self._make_driver = ports["makeDriver"]
        self.sys = _methods(ports["sys"], ("listen", "accept", "read", "write", "close", "cancel", "poll", "peer", "open_stdio"))
        self.validation = _methods(ports["validation"], ("verify_registration", "authorize_capture", "validate_current", "is_registration_current"))
        self.clock = _methods(ports["clock"], ("qpc", "frequency"))
        self.ids = _methods(ports["ids"], ("nextId", "nonce"))
        memory = ports["memory"]
        if type(memory) is dict:
            _keys(memory, ("maxBytes", "available", "hold"))
            self.memory = _methods({k: memory[k] for k in ("available", "hold")}, ("available", "hold"))
            self.memory.maxBytes = memory["maxBytes"]
        else:
            self.memory = _methods(memory, ("available", "hold"))
            self.memory.maxBytes = inspect.getattr_static(memory, "maxBytes", None)
        _uint(self.memory.maxBytes, 1)
        self._budget = _Budget(self.bounds, self.memory)
        self._started = self._accepting = self._closing = self._lost = False
        self._claims_stopped = False
        self._ops, self._records, self._nonces, self._ids = [], [], set(), set()
        self._listeners, self._accepts, self._handles, self._frames = {}, {}, {}, {}
        self._queues = {lane: [] for lane in LANES}
        self._attached = set()
        self._attached_sent = set()
        self._closing_handles, self._closed = {}, set()
        self._unconfirmed_handles = set()
        self._completed = set()
        self._actor = self._io = self._driver = self._facade = None
        self._capture = self._capability = self._body = None
        self._reg_digest = self._state = self._code = self._joined = None
        self._last_qpc, self._start_ticks, self._close_ticks = 0, None, None
        self._capture_release = self._actor_release = None
        self._record_releases, self._consumed = [], set()
        self._final_written = False
        self._epoch_nonces = set()

    def _now(self):
        value = _decimal(self.clock.qpc())
        _need(value >= self._last_qpc, "WINDOWS_QPC_REVERSED")
        self._last_qpc = value
        return value

    def _id(self):
        value = self.ids.nextId()
        _uuid(value)
        _need(value not in self._ids and len(self._ids) < 8192, "WINDOWS_ID_REUSED")
        self._ids.add(value)
        return value

    def _current(self):
        return self.validation.is_registration_current(self._reg_digest) is True

    def _peer(self, handle):
        value = self.sys.peer(handle)
        _keys(value, ("pid", "creationFileTime100ns", "windowsSessionId", "sidDigest"))
        _process({k: value[k] for k in ("pid", "creationFileTime100ns", "windowsSessionId")})
        _hex(value["sidDigest"])
        _need(value == self.bootstrap["controllerProcess"] | {"sidDigest": self.bootstrap["controllerSidDigest"]}, "WINDOWS_PEER_INVALID")
        _need(self._current(), "WINDOWS_REGISTRATION_REVOKED")
        return value

    def start(self):
        _need(not self._started and not self._closing, "WINDOWS_RUNTIME_STARTED")
        _need(not self._claims_stopped, "WINDOWS_ADMISSION_CLOSED")
        digest = self.validation.verify_registration(self.registration)
        _hex(digest)
        _need(digest == _registration_digest(self.registration), "WINDOWS_REGISTRATION_MISMATCH")
        _need(self.core is _PINNED_CORE and _core_pin(self.core) == _CORE_PIN, "WINDOWS_CORE_DRIFT")
        self._reg_digest = digest
        _need(self._current(), "WINDOWS_REGISTRATION_REVOKED")
        self._start_ticks = self._now()
        _decimal(self.clock.frequency(), True)
        self._started, self._accepting = True, True
        try:
            self._budget.start()
            self._listen("CONTROL")
            self._state = "OPEN"
        except Exception:
            self._fail("WINDOWS_LISTENER_FAILED")
            self.close()
            raise
        return None

    def _listen(self, lane):
        _need(lane not in self._listeners)
        lease = self._budget.hold(512)
        try:
            acl = {"hostSidDigest": self.bootstrap["hostSidDigest"], "controllerSidDigest": self.bootstrap["controllerSidDigest"],
                   "localOnly": True, "clientCreateInstance": False, "denyAppContainer": True}
            handle = self.sys.listen(pipe_name(self.bootstrap, self._capture, lane), "DUPLEX" if lane == "CONTROL" else lane, acl)
            _need(handle is not None and all(handle is not h for h, _ in self._listeners.values()), "WINDOWS_LISTENER_INVALID")
        except Exception as exc:
            handle = getattr(exc, "listener", None)
            if handle is None:
                lease()
            else:
                self._listeners[lane] = handle, lease
                if getattr(exc, "closed", False) is True:
                    self._closed.add(id(handle))
                else:
                    self._unconfirmed_handles.add(id(handle))
            raise
        self._listeners[lane] = handle, lease
        self._accepts[lane] = _Operation(self, "accept", handle, lane, 0, lambda: self.sys.accept(handle))

    def _fail(self, code):
        _need(type(code) is str and re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", code) is not None)
        if self._code is None:
            self._code = code
        self._lost = True
        self._accepting = False
        if self._io:
            self._io.abort_input()

    def stopClaims(self):
        self._claims_stopped = True
        self._accepting = False
        return None

    def close(self):
        self._accepting = False
        if not self._closing:
            self._closing = True
            self._close_ticks = self._now() if self._started else None
            if self._capture is not None and (self._actor is None or not self._actor.view()["finalized"]):
                self._fail("WINDOWS_CONTROL_LOST")
            if self._io:
                self._io.abort_input()
        for op in list(self._accepts.values()):
            op.cancel()
        if not self._actor or self._actor.view()["finalized"]:
            for frame in self._frames.values():
                frame.cancel()
            for queue in self._queues.values():
                for ticket, _ in queue:
                    ticket.cancel()
        return None

    def _decode_private(self, wire, kind, lane):
        value = self.core._decode(wire)
        _keys(value, ("version", "domain", "kind", "endpointId", "lane", "body", "mac"))
        _hex(value["mac"])
        unsigned = canonical_unsigned(value)
        _need(value["kind"] == kind and value["lane"] == lane and value["endpointId"] == self.bootstrap["endpointId"], "WINDOWS_PRIVATE_PHASE")
        expected = hmac.new(self.bootstrap["key"], unsigned, hashlib.sha256).hexdigest()
        _need(hmac.compare_digest(expected, value["mac"]), "WINDOWS_PRIVATE_MAC")
        return value["body"]

    def _private(self, kind, lane):
        value = {"version": 1, "domain": DOMAIN, "kind": kind, "endpointId": self.bootstrap["endpointId"],
                 "lane": lane, "body": self._body}
        self._send(value | {"mac": private_mac(self.bootstrap["key"], value)}, lane, private=True)

    def _send(self, value, lane="CONTROL", private=False):
        n = _scan(value)
        _need(n <= self.bounds["maxControlBytes"] and len(self._queues[lane]) < 32, "WINDOWS_BUFFER_LIMIT")
        queued = sum(len(t.data) for q in self._queues.values() for t, _ in q)
        _need(queued + n + 4 <= self.bounds["maxQueuedBytes"], "WINDOWS_BUFFER_LIMIT")
        release = self._budget.hold(n * 4 + 4, lane == "CONTROL")
        try:
            if private:
                body = _canonical(value)
                wire = struct.pack(">I", len(body)) + body
            else:
                wire = self.core.encode_host_message(value)
            ticket = _Write(self, self._handles[lane], lane, wire, reserved=release)
        except Exception:
            release()
            raise
        self._queues[lane].append((ticket, value["kind"] if private else value["message"]))

    def _open(self, wire):
        _need(self._accepting and not self._closing and self._capture is None and len(self._records) < self.bounds["maxRetainedRecords"], "WINDOWS_ADMISSION_CLOSED")
        body = self._decode_private(wire, "OPEN", "CONTROL")
        _need(body["controllerInstanceId"] == self.bootstrap["controllerInstanceId"], "WINDOWS_ORIGINAL_MISMATCH")
        nonce = body["clientNonce"]
        _need(nonce not in self._nonces and nonce != self.bootstrap["key"].hex(), "WINDOWS_NONCE_REUSED")
        capture = body["capture"]
        _scan(capture)
        _keys(capture, ("origin", "originDigest", "frameInputDigest", "launchRef"))
        self.core._origin(capture["origin"])
        a = capture["origin"]["authority"]
        for key in ("hostEpochId", "environmentDigest", "controllerInstanceId", "controllerSidDigest"):
            _need(a[key] == self.bootstrap[key], "WINDOWS_ORIGINAL_MISMATCH")
        expected = {k: capture["origin"][k] for k in ("identity", "authority", "pins", "policy")}
        expected.update(nativeLimitsDigest=self.core.digest(capture["origin"]["limits"]), frameInputDigest=capture["frameInputDigest"])
        _need(capture["originDigest"] == self.core.digest(expected) and capture["frameInputDigest"] == capture["origin"]["identity"]["binding"]["inputDigest"], "WINDOWS_ORIGINAL_MISMATCH")
        _need(not any(d == capture["originDigest"] or ref == capture["launchRef"] for d, ref in self._consumed), "WINDOWS_CAPTURE_REUSED")
        for key, maximum in self.registration["launch"]["allowedPolicy"].items():
            actual = capture["origin"]["policy"][key]
            _need((int(actual) if type(actual) is str else actual) <= (int(maximum) if type(maximum) is str else maximum), "WINDOWS_POLICY_MISMATCH")
        target = self.registration["launch"]["expectedToken"]
        _need(a["childSidDigest"] == target["childSidDigest"] and a["appContainerSidDigest"] == target["appContainerSidDigest"], "WINDOWS_TOKEN_MISMATCH")
        release = self._budget.hold(_scan(capture) * 4)
        try:
            frozen = _copy(capture)
            capability = self.validation.authorize_capture(_copy(frozen), self._reg_digest)
            _check_capability(self, capability)
            _need(type(capability) is self.core.LaunchCapability and capability.launch_ref == capture["launchRef"] and capability.origin_digest == capture["originDigest"], "WINDOWS_LAUNCH_UNCONFIRMED")
            _need(self.validation.validate_current(_copy(frozen), self._reg_digest) == capture["originDigest"] and self._current(), "WINDOWS_LAUNCH_UNCONFIRMED")
            server = self.ids.nonce()
            _need(type(server) is bytes and len(server) == 32 and server != self.bootstrap["key"] and server.hex() != nonce and server.hex() not in self._epoch_nonces, "WINDOWS_NONCE_REUSED")
        except Exception:
            release()
            raise
        self._capture, self._capability, self._capture_release = frozen, capability, release
        self._nonces.add(nonce)
        self._epoch_nonces.add(server.hex())
        self._record_releases.append(self._budget.hold(512))
        self._consumed.add((frozen["originDigest"], frozen["launchRef"]))
        self._records.append({"originDigest": frozen["originDigest"], "phase": "NEW", "finalized": None})
        self._body = {k: self.bootstrap[k] for k in ("hostEpochId", "environmentDigest", "controllerInstanceId", "hostProcess", "controllerProcess", "hostSidDigest", "controllerSidDigest")}
        self._body.update(originDigest=frozen["originDigest"], launchRef=frozen["launchRef"], clientNonce=nonce, serverNonce=server.hex(),
            **{k: a[k] for k in ("attemptId", "sessionId", "launchId")})
        self._private("CHALLENGE", "CONTROL")
        self._state = "AUTH"

    def _resolver(self, launch_ref, origin):
        _need(self._capture is not None and launch_ref == self._capture["launchRef"] and origin == self._capture["origin"], "WINDOWS_LAUNCH_UNCONFIRMED")
        _need(self._current() and self.validation.validate_current(_copy(self._capture), self._reg_digest) == self._capture["originDigest"], "WINDOWS_LAUNCH_UNCONFIRMED")
        _need(self.core is _PINNED_CORE and _core_pin(self.core) == _CORE_PIN, "WINDOWS_CORE_DRIFT")
        _check_capability(self, self._capability)
        _need(self._capability.validate_current() == self._capture["originDigest"], "WINDOWS_LAUNCH_UNCONFIRMED")
        return self._capability

    def _construct(self):
        _need(self._actor is None and self._attached_sent == {"IN", "OUT", "ERR"})
        for handle in self._handles.values():
            self._peer(handle)
        self._resolver(self._capture["launchRef"], self._capture["origin"])
        _need(self.core is _PINNED_CORE and _core_pin(self.core) == _CORE_PIN, "WINDOWS_CORE_DRIFT")
        self._actor_release = self._budget.hold(self._capture["origin"]["limits"]["parentInFlightBytes"])
        driver = self._make_driver(self.core, self._resolver, self.clock, self.ids)
        _need(type(driver) is self.core._CtypesWin32, "WINDOWS_DRIVER_MISMATCH")
        _need(driver.clock is self.clock and driver.ids is self.ids, "WINDOWS_DRIVER_MISMATCH")
        self._driver = driver
        self._facade = _Facade(self, driver)
        self._io = _HostIo(self, driver, self._facade)
        peer_context = object()
        self._peer_context = peer_context
        def current(p, digest):
            return p is peer_context and digest == self._capture["originDigest"]
        self._actor = self.core.WindowsJobHost(self._capture, self._facade, self._io, self.clock, self.ids,
                                              types.SimpleNamespace(requireCurrent=current))
        self._state = "ACTIVE"

    def _observe(self, messages):
        _need(type(messages) is list and len(messages) <= 32)
        for value in messages:
            if value["message"] == "EVENT":
                kind = value["payload"]["event"]["kind"]
                if kind == "GO_WRITE" and value["payload"]["event"]["payload"]["result"] == "RETURNED":
                    self._io._marker = 9
                if kind in ("CREATE_NOT_ATTEMPTED", "CREATE_FAILED"):
                    self._io._noncreate = True
                    self._io.abort_input()
            if value["message"] == "PROGRESS":
                if value["payload"]["bootstrap"] == "READY":
                    self._io._ready = True
                if value["payload"]["phase"] in ("DRAINING", "UNCONFIRMED"):
                    self._io.abort_input()
            self._send(value)
        if self._actor and self._records:
            self._records[-1].update(self._actor.view())

    def _poll_accepts(self):
        for lane, op in list(self._accepts.items()):
            value = op.poll()
            if value is None:
                continue
            op.retire()
            del self._accepts[lane]
            if value["state"] == "RETURNED":
                handle = value["value"]
                _need(handle is not None and all(handle is not h for h in self._handles.values()))
                self._handles[lane] = handle
                if self._closing or self._lost:
                    self._close_handle(handle, lane)
                    continue
                self._peer(handle)
                self._frames[lane] = _Frame(self, handle, lane)
            elif not self._closing:
                self._fail(value["code"])

    def _poll_frames(self):
        if self._final_written or (self._actor is not None and self._actor.view()["finalized"] is not None):
            return
        control_seen = False
        for lane, frame in list(self._frames.items()):
            if lane != "CONTROL" and lane in self._attached:
                continue
            if self._closing and (not self._actor or self._actor.view()["finalized"]):
                continue
            packet = frame.read()
            if packet is None:
                continue
            wire, release = packet
            try:
                self._peer(frame.handle)
                if lane == "CONTROL":
                    _need(not control_seen)
                    control_seen = True
                    if self._state == "OPEN":
                        self._open(wire)
                    elif self._state == "AUTH":
                        body = self._decode_private(wire, "AUTH", lane)
                        _need(body == self._body, "WINDOWS_PRIVATE_TUPLE")
                        for native in ("IN", "OUT", "ERR"):
                            self._listen(native)
                        self._private("ACCEPT", lane)
                        self._state = "ATTACH"
                    else:
                        _need(self._state == "ACTIVE" and self._actor is not None, "WINDOWS_PRIVATE_PHASE")
                        control = self.core.decode_control(wire)
                        if control["command"] == "STOP":
                            self._io.abort_input()
                        self._observe(self._actor.advance(control, self._peer_context))
                else:
                    _need(self._state == "ATTACH" and lane not in self._attached, "WINDOWS_PRIVATE_PHASE")
                    _need(self._decode_private(wire, "ATTACH", lane) == self._body, "WINDOWS_PRIVATE_TUPLE")
                    self._attached.add(lane)
                    self._private("ATTACHED", lane)
            finally:
                release()

    def _poll_queues(self):
        for lane, queue in self._queues.items():
            if not queue:
                continue
            ticket, kind = queue[0]
            if self._closing and (not self._actor or self._actor.view()["finalized"]) and kind != "FINALIZED":
                ticket.cancel()
                if ticket.drain():
                    queue.pop(0)
                continue
            if ticket.poll() is True:
                queue.pop(0)
                if kind == "ATTACHED":
                    self._attached_sent.add(lane)
                if kind == "FINALIZED":
                    self._final_written = True
        if self._state == "ATTACH" and self._attached_sent == {"IN", "OUT", "ERR"} and not self._closing and not self._lost:
            self._construct()

    def _close_handle(self, handle, lane):
        key = id(handle)
        if key not in self._closed and key not in self._closing_handles and key not in self._unconfirmed_handles:
            self._closing_handles[key] = handle, _Operation(self, "close", handle, lane, 0, lambda: self.sys.close(handle))

    def _drain_transport(self):
        terminal = self._closing or self._final_written or (self._lost and not self._actor)
        if terminal:
            for op in self._accepts.values():
                op.cancel()
            for lane, frame in self._frames.items():
                frame.cancel()
                if frame.drain() and not self._queues[lane]:
                    self._close_handle(frame.handle, lane)
            for lane, (handle, lease) in self._listeners.items():
                if lane not in self._accepts:
                    self._close_handle(handle, lane)
            for lane, queue in self._queues.items():
                for ticket, kind in list(queue):
                    if kind == "FINALIZED" and not self._final_written:
                        continue
                    ticket.cancel()
                    if ticket.drain():
                        queue.remove((ticket, kind))
        if self._io:
            self._io.service()
        for key, (handle, op) in list(self._closing_handles.items()):
            value = op.poll()
            if value is None:
                continue
            if value["state"] == "RETURNED" and _keys(value["value"], ("closed",))["closed"] is True:
                op.retire()
                del self._closing_handles[key]
                self._closed.add(key)
            else:
                op.unknown = True
                self._fail("WINDOWS_CLOSE_UNCONFIRMED")

    def poll(self):
        self._completed = set()
        if not self._started:
            return self.view()
        try:
            now = self._now()
            frequency = _decimal(self.clock.frequency(), True)
            if not self._current():
                self._fail("WINDOWS_REGISTRATION_REVOKED")
            if self._closing and self._close_ticks is not None and self._ops and (now - self._close_ticks) * 1000 >= self.bounds["closeMilliseconds"] * frequency:
                self._fail("WINDOWS_CLOSE_TIMEOUT")
            if not self._closing and self._state in ("OPEN", "AUTH", "ATTACH") and self._start_ticks is not None and (now - self._start_ticks) * 1000 >= self.bounds["handshakeMilliseconds"] * frequency:
                self._fail("WINDOWS_HANDSHAKE_TIMEOUT")
            if not self._lost:
                self._poll_accepts()
                self._poll_frames()
                self._poll_queues()
            else:
                self._poll_accepts()
            if self._actor and self._actor.view()["finalized"] is None:
                self._observe(self._actor.poll())
                if self._io._abort:
                    self._io.abort_input()
            if self._actor and self._actor.view()["finalized"] is not None:
                self._poll_queues()
            self._drain_transport()
        except Exception as exc:
            self._fail(exc.code if isinstance(exc, (HostError, self.core.HostError)) else "WINDOWS_RUNTIME_PORT_FAILED")
            try:
                self._drain_transport()
            except Exception:
                self._lost = True
        self._finish_runtime()
        return self.view()

    def _finish_runtime(self):
        final = self._actor.view()["finalized"] if self._actor else None
        if final is not None and final["handles"] != "CLOSED":
            self._fail("WINDOWS_CLOSE_UNCONFIRMED")
            return
        if self._io and final is not None and not self._io.pending():
            self._io.release_completed()
        terminal = self._closing or self._final_written or (self._lost and not self._actor)
        handles = list(self._handles.values()) + [h for h, lease in self._listeners.values()]
        actor_done = self._actor is None or (final is not None and not self._io.pending())
        if not (terminal and actor_done and not self._ops and not any(self._queues.values()) and all(id(h) in self._closed for h in handles)):
            return
        for h, lease in self._listeners.values():
            lease()
        self._listeners.clear()
        for name in ("_capture_release", "_actor_release"):
            release = getattr(self, name)
            if release:
                release()
                setattr(self, name, None)
        self._driver = self._facade = self._io = self._actor = self._capability = None
        self._capture = self._body = None
        self._frames.clear()
        self._handles.clear()
        self._accepts.clear()
        self._closing_handles.clear()
        self._closed.clear()
        self._attached.clear()
        self._attached_sent.clear()
        if self._closing or self._lost:
            for release in self._record_releases:
                release()
            self._record_releases.clear()
            if not self._budget.finish():
                return
            self._state = "CLOSED"
            if self._joined is None:
                self._joined = {"end": "LOST" if self._lost else "EXPECTED", "records": _copy(self._records), "closeCode": self._code}
            return
        self._final_written = False
        self._accepting = self._accepting and len(self._records) < self.bounds["maxRetainedRecords"]
        self._state = "IDLE"
        if self._accepting:
            try:
                self._start_ticks = self._now()
                self._listen("CONTROL")
                self._state = "OPEN"
            except Exception:
                self._fail("WINDOWS_LISTENER_FAILED")
    def join(self):
        if self._joined is not None:
            return _copy(self._joined)
        if not self._started and self._closing:
            self._joined = {"end": "EXPECTED", "records": [], "closeCode": None}
            return _copy(self._joined)
        return None

    def view(self):
        return {"accepting": self._accepting and not self._closing and not self._lost,
            "activeSessions": 1 if self._capture is not None and self._joined is None else 0,
            "retainedRecords": len(self._records), "heldBytes": self._budget.held, "pendingOperations": len(self._ops),
            "unconfirmed": self._lost or any(op.unknown for op in self._ops)}

class _Facade:
    def __init__(self, runtime, driver):
        self.runtime, self.driver = runtime, driver
        self.closes = {}
        for name in ("createJob", "setLimits", "queryLimits", "inspectRoot", "queryActive", "terminateJob", "queryAccounting"):
            setattr(self, name, getattr(driver, name))

    def preflight(self, launch_ref, origin):
        result = self.driver.preflight(launch_ref, origin)
        expected = self.runtime.registration["launch"]["expectedToken"]
        token = next((f["value"]["values"]["sidDigest"] for f in result["facts"]
            if f["api"] == "GetTokenInformation" and f["status"] == "RETURNED" and
            f["value"]["informationClass"] == "TOKEN_INTEGRITY_LEVEL"), None)
        _need(token == expected["integritySidDigest"], "WINDOWS_TOKEN_MISMATCH")
        return result

    def createSuspended(self, job, launch_ref, stdio, call_id):
        self.runtime._resolver(launch_ref, self.runtime._capture["origin"])
        return self.driver.createSuspended(job, launch_ref, stdio, call_id)

    def resume(self, thread):
        self.runtime._resolver(self.runtime._capture["launchRef"], self.runtime._capture["origin"])
        return self.driver.resume(thread)

    def waitRoot(self, process):
        result = self.driver.waitRoot(process)
        if any(f["api"] == "WaitForSingleObject" and f["status"] == "RETURNED" and
               f["value"]["waitResult"] == "SIGNALED" for f in result["facts"]):
            self.runtime._io.abort_input()
        return result

    def closeOwned(self, handle):
        key = id(handle)
        if key in self.closes:
            record = self.closes[key]
            _need(record["handle"] is handle, "WINDOWS_HANDLE_UNCONFIRMED")
            if record["result"] is None:
                raise self.runtime.core.HostError("WINDOWS_CLOSE_UNCONFIRMED")
            return self.runtime.core._copy(record["result"])
        self.driver._handle(handle)
        record = {"handle": handle, "result": None}
        self.closes[key] = record
        result = self.driver.closeOwned(handle)
        facts = self.runtime.core._copy(result)
        _need(type(facts) is dict and set(facts) == {"facts"} and type(facts["facts"]) is list and len(facts["facts"]) == 1, "WINDOWS_SOURCE_MISMATCH")
        fact = facts["facts"][0]
        self.runtime.core._fact(fact)
        _need(fact["kind"] == "WIN32" and fact["api"] == "CloseHandle", "WINDOWS_SOURCE_MISMATCH")
        record["result"] = facts
        return self.runtime.core._copy(facts)


class _Read:
    def __init__(self, runtime, handle, lane, goal, marker=False):
        self.runtime, self.handle, self.lane = runtime, handle, lane
        self.goal, self.marker = goal, marker
        self.release = runtime._budget.hold(goal)
        self.data = bytearray()
        self.call_id = runtime._id()
        self.operation = None
        self.packet = self.extra_eof = None
        self.cancelled = False

    def poll(self, maximum):
        if self.goal > maximum:
            return None
        if self.packet is not None:
            return self.packet
        if self.operation is None:
            n = self.goal - len(self.data)
            self.operation = _Operation(self.runtime, "read", self.handle, self.lane, n,
                lambda: self.runtime.sys.read(self.handle, n))
        value = self.operation.poll()
        if value is None:
            return None
        ticks = self.operation.ticks
        if value["state"] != "RETURNED":
            self.operation.retire()
            self.operation = None
            self.runtime._fail(value["code"])
            raise self.runtime.core.HostError("WINDOWS_READ_FAILED")
        result = _keys(value["value"], ("data", "eof"))
        raw, eof = result["data"], result["eof"]
        _need(type(raw) is bytes and type(eof) is bool and (not eof or not raw) and
            len(raw) <= self.goal - len(self.data) and (raw or eof), "WINDOWS_READ_INVALID")
        self.data.extend(raw)
        self.operation.retire()
        self.operation = None
        if eof and self.data:
            self.extra_eof = {"data": b"", "eof": True,
                "fact": self.fact(self.runtime._id(), ticks, b"")}
        if eof or not self.marker or len(self.data) == self.goal:
            data = bytes(self.data)
            self.packet = {"data": data, "eof": eof and not data,
                           "fact": self.fact(self.call_id, ticks, data)}
            return self.packet
        return None

    def fact(self, call_id, ticks, data):
        return {"kind": "IO", "callId": call_id, "lane": self.lane, "operation": "READ",
            "qpcTicks": ticks, "status": "RETURNED", "bytesLength": str(len(data)), "sha256": hashlib.sha256(data).hexdigest()}

    def discard(self):
        self.cancelled = True
        if self.operation:
            self.operation.cancel()

    def drain(self):
        if self.operation:
            value = self.operation.poll()
            if value is None:
                return False
            self.operation.retire()
            self.operation = None
        self.release()
        self.release = None
        self.data.clear()
        self.packet = self.extra_eof = None
        return True

    def take(self):
        packet = self.packet
        self.release()
        self.release = None
        self.data.clear()
        return packet


class _IoWrite:
    def __init__(self, io, data, lane, handle, forward=False):
        self.io, self.lane, self.forward = io, lane, forward
        self.call_id = io.runtime._id()
        self.bootstrap = not forward and lane == "IN" and data == io.runtime.core.GO
        self.length, self.sha = len(data), hashlib.sha256(data).hexdigest()
        self.writer = _Write(io.runtime, handle, lane, data)
        self.fact = None

    def poll(self):
        if self.fact is not None:
            return True if self.forward else _copy(self.fact)
        value = self.writer.poll()
        if self.writer.failed:
            self.io._tickets.discard(self)
            if self.forward:
                raise self.io.runtime.core.HostError("WINDOWS_FORWARD_FAILED")
            self.fact = {"kind": "IO", "callId": self.call_id, "lane": self.lane, "operation": "WRITE",
                "qpcTicks": self.writer.ticks, "status": "UNCONFIRMED", "bytesLength": None, "sha256": None}
            return _copy(self.fact)
        if value is not True:
            return None
        self.fact = {"kind": "IO", "callId": self.call_id, "lane": self.lane, "operation": "WRITE",
            "qpcTicks": self.writer.ticks, "status": "RETURNED", "bytesLength": str(self.length), "sha256": self.sha}
        if self.bootstrap:
            self.io._marker = 9
        self.io._tickets.discard(self)
        return True if self.forward else _copy(self.fact)


class _HostIo:
    def __init__(self, runtime, driver, facade):
        self.runtime, self.driver, self.facade = runtime, driver, facade
        self._stdio = self._input = self._input_close = None
        self._reads, self._eof_packets, self._tickets = {}, {}, set()
        self._eof, self._forward = set(), {}
        self._marker, self._ready, self._abort, self._noncreate = 8, False, False, False
        self._input_eof = False
        self._partial, self._partial_ops = [], []
        self._stdio_release = None

    def openStdio(self):
        if self._stdio is not None:
            return {k: list(v) for k, v in self._stdio.items()}
        _need(len(self.runtime._ops) + 3 <= self.runtime.bounds["maxPendingOperations"], "WINDOWS_OPERATION_LIMIT")
        self._stdio_release = self.runtime._budget.hold(3 * (self.runtime.bounds["maxChunkBytes"] + 256))
        raw = None
        try:
            raw = self.runtime.sys.open_stdio()
            _keys(raw, ("childHandles", "owned"))
            _need(all(type(raw[k]) is list and len(raw[k]) == 3 for k in ("childHandles", "owned")), "WINDOWS_STDIO_INVALID")
            all_raw = raw["childHandles"] + raw["owned"]
            _need(all(type(v) is int and v > 0 for v in all_raw) and len(set(all_raw)) == 6,
                  "WINDOWS_STDIO_INVALID")
            _need(not any(v == h.value for v in all_raw for h in self.driver.owned), "WINDOWS_STDIO_INVALID")
            self._stdio = {k: [self.driver._own(v, "PIPE") for v in raw[k]] for k in ("childHandles", "owned")}
            self._stdio_release()
            self._stdio_release = None
            return {k: list(v) for k, v in self._stdio.items()}
        except Exception as exc:
            owned = getattr(exc, "owned", []) if raw is None else sum([v for v in raw.values() if type(v) is list], [])
            _need(type(owned) is list and len(owned) <= 6, "WINDOWS_STDIO_UNCONFIRMED")
            unique = set()
            for value in owned:
                if type(value) is int and value > 0 and value not in unique and not any(value == h.value for h in self.driver.owned):
                    unique.add(value)
                    self._partial.append(self.driver._own(value, "PIPE"))
            pending = getattr(exc, "pending", [])
            _need(type(pending) is list and len(pending) <= 3, "WINDOWS_STDIO_UNCONFIRMED")
            # 부분 stdio 작업은 원 sys 호출 전에 예약한 세 작업의 credit을 공유한다.
            for op in pending:
                tracked = _Operation(self.runtime, "stdio", None, "IN", self.runtime.bounds["maxChunkBytes"],
                    lambda op=op: op, reserved=lambda: None)
                self._partial_ops.append(tracked)
                tracked.cancel()
            if not self._partial_ops:
                self._close_partial()
            raise

    def _close_partial(self):
        for handle in self._partial:
            try:
                self.facade.closeOwned(handle)
            except Exception:
                self.runtime._fail("WINDOWS_STDIO_CLOSE_UNCONFIRMED")
        if self._stdio_release and not self._partial_ops and all(h.closed for h in self._partial):
            self._stdio_release()
            self._stdio_release = None
    def _raw(self, lane):
        _need(self._stdio is not None, "WINDOWS_STDIO_INVALID")
        index = {"IN": 0, "OUT": 1, "ERR": 2}[lane]
        return self.driver._handle(self._stdio["owned"][index], "PIPE")

    def read(self, lane, maxBytes):
        _need(lane in ("OUT", "ERR"))
        _uint(maxBytes, 1, 65536)
        if lane in self._forward and self._forward[lane] in self._tickets:
            return None
        if lane in self._eof_packets:
            packet, release = self._eof_packets.pop(lane)
            release()
            self._eof.add(lane)
            return _copy(packet)
        _need(lane not in self._eof, "WINDOWS_DOUBLE_CONSUMER")
        if lane not in self._reads:
            goal = self._marker if lane == "OUT" and self._marker and not self._abort else min(maxBytes, self.runtime.bounds["maxChunkBytes"])
            _need(goal <= maxBytes, "WINDOWS_READ_CREDIT_CHANGED")
            self._reads[lane] = _Read(self.runtime, self._raw(lane), lane, goal, bool(lane == "OUT" and self._marker and not self._abort))
        state = self._reads[lane]
        if self._abort:
            state.marker = False
        packet = state.poll(maxBytes)
        if packet is None:
            return None
        if state.extra_eof is not None:
            release = self.runtime._budget.hold(256)
            self._eof_packets[lane] = state.extra_eof, release
        del self._reads[lane]
        if packet["eof"]:
            self._eof.add(lane)
        if lane == "OUT" and state.marker:
            self._marker = None
        return state.take()

    def write(self, lane, data):
        _need(lane == "IN" and type(data) is bytes and data and not self._abort, "WINDOWS_INPUT_CLOSED")
        _need(len(data) <= self.runtime.bounds["maxChunkBytes"] or data == self.runtime.core.GO, "WINDOWS_BUFFER_LIMIT")
        _need(not any(not t.forward for t in self._tickets), "WINDOWS_DOUBLE_CONSUMER")
        self.runtime._resolver(self.runtime._capture["launchRef"], self.runtime._capture["origin"])
        ticket = _IoWrite(self, data, lane, self._raw(lane))
        self._tickets.add(ticket)
        return ticket

    def pollWrite(self, ticket):
        _need(type(ticket) is _IoWrite and ticket.io is self and not ticket.forward, "WINDOWS_TICKET_INVALID")
        return ticket.poll()

    def readInput(self, maxBytes):
        _uint(maxBytes, 1, 65536)
        if not self._ready or self._abort or self._input_eof:
            return None
        if self._input is None:
            self._input = _Read(self.runtime, self.runtime._handles["IN"], "IN", min(maxBytes, self.runtime.bounds["maxChunkBytes"]))
        packet = self._input.poll(maxBytes)
        if packet is None:
            return None
        packet = self._input.take()
        self._input = None
        self._input_eof = packet["eof"]
        return {"data": packet["data"], "eof": packet["eof"]}

    def forward(self, lane, data):
        _need(lane in ("OUT", "ERR") and type(data) is bytes and 0 < len(data) <= self.runtime.bounds["maxChunkBytes"])
        _need(lane not in self._forward or self._forward[lane] not in self._tickets, "WINDOWS_DOUBLE_CONSUMER")
        ticket = _IoWrite(self, data, lane, self.runtime._handles[lane], True)
        self._tickets.add(ticket)
        self._forward[lane] = ticket
        return ticket

    def pollForward(self, ticket):
        _need(type(ticket) is _IoWrite and ticket.io is self and ticket.forward, "WINDOWS_TICKET_INVALID")
        return ticket.poll()

    def closeInput(self):
        if self._input_close is not None:
            return self._input_close
        _need(self._stdio is not None)
        self.abort_input()
        handle = self._stdio["owned"][0]
        ticket = types.SimpleNamespace(owner=self, handle=handle, call_id=self.runtime._id(), fact=None, failed=False)
        self._input_close = ticket
        try:
            result = self.facade.closeOwned(handle)
            fact = self.runtime.core._one(result["facts"], "CloseHandle")
            _need(fact["status"] == "RETURNED" and fact["value"]["returned"] is True, "WINDOWS_CLOSE_UNCONFIRMED")
            ticket.fact = {"kind": "IO", "callId": ticket.call_id, "lane": "IN", "operation": "CLOSE",
                "qpcTicks": fact["qpcTicks"], "status": "RETURNED", "bytesLength": "0", "sha256": EMPTY_HASH}
        except Exception:
            ticket.failed = True
            raise
        return ticket

    def pollClose(self, ticket):
        _need(ticket is self._input_close and ticket.owner is self, "WINDOWS_TICKET_INVALID")
        if ticket.failed:
            return None
        return _copy(ticket.fact)

    def controlLost(self):
        return self.runtime._lost

    def abort_input(self):
        self._abort = True
        self._marker = None
        if self._input is not None:
            self._input.discard()

    def service(self):
        for op in list(self._partial_ops):
            op.cancel()
            value = op.poll()
            if value is not None:
                op.retire()
                self._partial_ops.remove(op)
        if not self._partial_ops:
            self._close_partial()
        if self.runtime._actor and self.runtime._actor.view()["phase"] in ("DRAINING", "UNCONFIRMED"):
            self.abort_input()
        if self._abort and self._input:
            self._input.discard()
            if self._input.drain():
                self._input = None
        for lane in ("IN", "OUT", "ERR"):
            close_lane = self._noncreate or (lane == "IN" and self._abort and self._input is None) or (lane in self._eof and
                (lane not in self._forward or self._forward[lane] not in self._tickets))
            if close_lane and lane in self.runtime._handles:
                self.runtime._close_handle(self.runtime._handles[lane], lane)
        if self._noncreate:
            for lane, read in list(self._reads.items()):
                read.discard()
                if read.drain():
                    del self._reads[lane]

    def pending(self):
        native_close = any(op.lane != "CONTROL" for handle, op in self.runtime._closing_handles.values())
        partial_unknown = bool(self._partial_ops) or any(not h.closed for h in self._partial)
        return bool(self._reads or self._input or self._tickets or self._eof_packets or native_close or partial_unknown or self._stdio_release or
            (self._input_close is not None and self._input_close.failed))

    def release_completed(self):
        _need(not self.pending(), "WINDOWS_IO_UNCONFIRMED")
        self._stdio = None
        self._forward.clear()
        self._partial.clear()

class _LazyRealRuntime:
    def __init__(self, registration, validation):
        self._registration, self._validation = registration, validation
        self._runtime = None
        self._closed = False

    def start(self):
        _need(self._runtime is None and not self._closed, "WINDOWS_RUNTIME_STARTED")
        digest = self._validation.verify_registration(self._registration)
        _hex(digest)
        _need(digest == _registration_digest(self._registration), "WINDOWS_REGISTRATION_MISMATCH")
        _need(self._validation.is_registration_current(digest) is True, "WINDOWS_REGISTRATION_REVOKED")
        import os
        import secrets
        import uuid
        root = os.path.dirname(os.path.abspath(__file__))
        core_path, runtime_path = os.path.join(root, "windows-job-host.py"), os.path.abspath(__file__)
        files = self._registration["launch"]["files"]
        paths = {os.path.normcase(os.path.abspath(f["path"])): f for f in files}
        _need(len(paths) == len(files) and os.path.normcase(core_path) in paths and os.path.normcase(runtime_path) in paths,
              "WINDOWS_PINNED_LOADER_MISSING")
        _need(self._registration["launch"]["executableId"] in {f["id"] for f in files}, "WINDOWS_LAUNCH_UNCONFIRMED")
        source = None
        for f in files:
            size, sha = 0, hashlib.sha256()
            keep = os.path.normcase(os.path.abspath(f["path"])) == os.path.normcase(core_path)
            chunks = []
            with open(f["path"], "rb") as stream:
                while True:
                    data = stream.read(min(65536, f["bytes"] + 1 - size))
                    if not data:
                        break
                    size += len(data)
                    _need(size <= f["bytes"], "WINDOWS_PIN_MISMATCH")
                    sha.update(data)
                    if keep:
                        _need(size <= 262144, "WINDOWS_PIN_MISMATCH")
                        chunks.append(data)
            _need(size == f["bytes"] and sha.hexdigest() == f["sha256"], "WINDOWS_PIN_MISMATCH")
            if keep:
                _need(sha.hexdigest() == CORE_SHA256, "WINDOWS_CORE_DRIFT")
                source = b"".join(chunks)
        _need(source is not None and self._validation.is_registration_current(digest) is True, "WINDOWS_REGISTRATION_REVOKED")
        core = load_windows_host_core(source)
        system = _WindowsSys(self._registration["bootstrap"], self._registration["launch"], self._registration["bounds"])
        clock = types.SimpleNamespace(qpc=system.qpc, frequency=system.frequency)
        ids = types.SimpleNamespace(nextId=lambda: str(uuid.uuid4()), nonce=lambda: secrets.token_bytes(32))
        memory = _Memory(self._registration["bounds"]["maxInFlightBytes"])
        runtime = create_windows_host_runtime(self._registration, {"core": core,
            "makeDriver": lambda c, resolver, clk, identities: c.create_ctypes_driver(resolver, clk, identities, enable_real=True),
            "sys": system, "validation": self._validation, "clock": clock, "ids": ids, "memory": memory})
        self._runtime = runtime
        return runtime.start()

    def poll(self):
        return self._runtime.poll() if self._runtime else self.view()

    def stopClaims(self):
        if self._runtime:
            return self._runtime.stopClaims()
        self._closed = True
        return None

    def close(self):
        self._closed = True
        return self._runtime.close() if self._runtime else None

    def join(self):
        if self._runtime:
            return self._runtime.join()
        return {"end": "EXPECTED", "records": [], "closeCode": None} if self._closed else None

    def view(self):
        return self._runtime.view() if self._runtime else {"accepting": False, "activeSessions": 0,
            "retainedRecords": 0, "heldBytes": 0, "pendingOperations": 0, "unconfirmed": False}


class _Memory:
    def __init__(self, maximum):
        self.maxBytes, self._held = maximum, 0

    def available(self):
        return self.maxBytes - self._held

    def hold(self, count):
        _uint(count)
        _need(count <= self.available(), "WINDOWS_BUFFER_LIMIT")
        self._held += count
        live = True
        def release():
            nonlocal live
            _need(live, "WINDOWS_BUFFER_ACCOUNTING")
            live = False
            self._held -= count
        return release


class _WindowsSys:
    """명시 기동 뒤 사용하는 SDK adapter. 불명 완료와 취소는 그대로 보유한다."""
    def __init__(self, bootstrap, launch, bounds):
        self.bootstrap, self.launch, self.bounds = bootstrap, launch, bounds
        self.c = self.k = self.a = self.t = None
        self._live = []

    def _load(self):
        if self.c is not None:
            return
        import ctypes as c
        import sys
        _need(sys.platform == "win32" and c.sizeof(c.c_void_p) == 8, "WINDOWS_X64_REQUIRED")
        k, a = c.WinDLL("kernel32", use_last_error=True), c.WinDLL("advapi32", use_last_error=True)
        self.c, self.k, self.a = c, k, a
        self.t = _windows_types(c)
        p, d, b = c.c_void_p, c.c_uint32, c.c_int32
        bindings = ((k, "CreateNamedPipeW", [c.c_wchar_p, d, d, d, d, d, d, p], p),
            (k, "CreateFileW", [c.c_wchar_p, d, d, p, d, d, p], p),
            (k, "CreateEventW", [p, b, b, c.c_wchar_p], p),
            (k, "ConnectNamedPipe", [p, p], b), (k, "ReadFile", [p, p, d, p, p], b),
            (k, "WriteFile", [p, p, d, p, p], b), (k, "GetOverlappedResult", [p, p, p, b], b),
            (k, "CancelIoEx", [p, p], b), (k, "CloseHandle", [p], b),
            (k, "SetHandleInformation", [p, d, d], b),
            (k, "GetNamedPipeClientProcessId", [p, p], b),
            (k, "GetProcessTimes", [p, p, p, p, p], b), (k, "ProcessIdToSessionId", [d, p], b),
            (k, "OpenProcess", [d, b, d], p), (k, "GetCurrentProcessId", [], d),
            (k, "QueryPerformanceCounter", [p], b), (k, "QueryPerformanceFrequency", [p], b),
            (k, "LocalFree", [p], p), (a, "OpenProcessToken", [p, d, p], b),
            (a, "GetTokenInformation", [p, c.c_int, p, d, p], b),
            (a, "IsValidSid", [p], b), (a, "GetLengthSid", [p], d),
            (a, "ConvertSidToStringSidW", [p, p], b),
            (a, "ConvertStringSecurityDescriptorToSecurityDescriptorW", [c.c_wchar_p, d, p, p], b),
            (a, "GetSecurityInfo", [p, d, d, p, p, p, p, p], d),
            (a, "GetSecurityDescriptorDacl", [p, p, p, p], b),
            (a, "GetSecurityDescriptorOwner", [p, p, p], b),
            (a, "GetSecurityDescriptorControl", [p, p, p], b))
        for owner, name, args, result in bindings:
            fn = getattr(owner, name)
            fn.argtypes, fn.restype = args, result

    def _ok(self, value, code):
        _need(bool(value), code)
        return value

    def qpc(self):
        self._load()
        value = self.c.c_int64()
        self._ok(self.k.QueryPerformanceCounter(self.c.byref(value)), "WINDOWS_QPC_FAILED")
        return str(_decimal(str(value.value)))

    def frequency(self):
        self._load()
        value = self.c.c_int64()
        self._ok(self.k.QueryPerformanceFrequency(self.c.byref(value)), "WINDOWS_QPC_FAILED")
        return str(_decimal(str(value.value), True))

    def _sid(self, pointer):
        c = self.c
        self._ok(pointer and self.a.IsValidSid(pointer), "WINDOWS_SID_INVALID")
        length = int(self.a.GetLengthSid(pointer))
        _need(8 <= length <= 68, "WINDOWS_SID_INVALID")
        raw = c.string_at(pointer, length)
        value = c.c_void_p()
        self._ok(self.a.ConvertSidToStringSidW(pointer, c.byref(value)), "WINDOWS_SID_INVALID")
        try:
            text = c.wstring_at(value)
        finally:
            self._ok(self.k.LocalFree(value) is None, "WINDOWS_SECURITY_FREE_UNCONFIRMED")
        _need(re.fullmatch(r"S-1-[0-9-]+", text) is not None, "WINDOWS_SID_INVALID")
        return hashlib.sha256(raw).hexdigest(), text

    def _token_info(self, token, number):
        c = self.c
        needed = c.c_uint32()
        c.set_last_error(0)
        first = self.a.GetTokenInformation(token, number, None, 0, c.byref(needed))
        _need(not first and c.get_last_error() == 122 and 0 < needed.value <= 65536, "WINDOWS_TOKEN_INVALID")
        data = c.create_string_buffer(needed.value)
        self._ok(self.a.GetTokenInformation(token, number, data, needed.value, c.byref(needed)), "WINDOWS_TOKEN_INVALID")
        return data

    def _observe_process(self, pid, logon=False):
        c = self.c
        process = self._ok(self.k.OpenProcess(0x1000, False, pid), "WINDOWS_PEER_INVALID")
        token = c.c_void_p()
        try:
            created, exited, kernel, user = (c.c_uint64() for _ in range(4))
            self._ok(self.k.GetProcessTimes(process, c.byref(created), c.byref(exited), c.byref(kernel), c.byref(user)), "WINDOWS_PEER_INVALID")
            session = c.c_uint32()
            self._ok(self.k.ProcessIdToSessionId(pid, c.byref(session)), "WINDOWS_PEER_INVALID")
            self._ok(self.a.OpenProcessToken(process, 8, c.byref(token)), "WINDOWS_PEER_INVALID")
            app = self._token_info(token, 29)
            _need(c.cast(app, c.POINTER(c.c_uint32)).contents.value == 0, "WINDOWS_PEER_INVALID")
            info = self._token_info(token, 28 if logon else 1)
            if logon:
                groups = c.cast(info, c.POINTER(self.t["ONE_GROUP"])).contents
                _need(groups.count == 1 and groups.attributes & 0xc0000000 == 0xc0000000, "WINDOWS_PEER_INVALID")
                sid = groups.sid
            else:
                sid = c.cast(info, c.POINTER(c.c_void_p)).contents.value
            digest, text = self._sid(sid)
            return {"pid": int(pid), "creationFileTime100ns": str(created.value), "windowsSessionId": int(session.value), "sidDigest": digest}, text
        finally:
            if token.value:
                self._ok(self.k.CloseHandle(token), "WINDOWS_TOKEN_CLOSE_UNCONFIRMED")
            self._ok(self.k.CloseHandle(process), "WINDOWS_PEER_CLOSE_UNCONFIRMED")

    def _sid_hash(self, pointer):
        self._ok(pointer and self.a.IsValidSid(pointer), "WINDOWS_SID_INVALID")
        size = int(self.a.GetLengthSid(pointer))
        _need(8 <= size <= 68, "WINDOWS_SID_INVALID")
        return hashlib.sha256(self.c.string_at(pointer, size)).hexdigest()

    def _verify_target_token(self):
        self._load()
        c, expected, token = self.c, self.launch["expectedToken"], self.launch["token"]
        _need(token is not None and self.launch["appContainerSid"] is not None, "WINDOWS_BOOTSTRAP_MISSING")
        for number, key in ((1, "childSidDigest"), (31, "appContainerSidDigest"), (25, "integritySidDigest")):
            data = self._token_info(token, number)
            _need(len(data) >= c.sizeof(c.c_void_p), "WINDOWS_TOKEN_INVALID")
            pointer = c.cast(data, c.POINTER(c.c_void_p)).contents.value
            _need(self._sid_hash(pointer) == expected[key], "WINDOWS_TOKEN_MISMATCH")
        for number, wanted in ((29, 1), (30, expected["capabilityCount"]), (12, expected["windowsSessionId"]), (20, 0)):
            data = self._token_info(token, number)
            _need(len(data) >= 4 and c.cast(data, c.POINTER(c.c_uint32)).contents.value == wanted, "WINDOWS_TOKEN_MISMATCH")
        _need(self._sid_hash(self.launch["appContainerSid"]) == expected["appContainerSidDigest"], "WINDOWS_TOKEN_MISMATCH")
        return None

    def _security(self, target=False):
        self._verify_target_token()
        c = self.c
        host, host_sid = self._observe_process(self.bootstrap["hostProcess"]["pid"])
        controller, controller_sid = self._observe_process(self.bootstrap["controllerProcess"]["pid"], True)
        _need(host == self.bootstrap["hostProcess"] | {"sidDigest": self.bootstrap["hostSidDigest"]} and
            controller == self.bootstrap["controllerProcess"] | {"sidDigest": self.bootstrap["controllerSidDigest"]} and
            self.k.GetCurrentProcessId() == host["pid"], "WINDOWS_PEER_INVALID")
        child_digest, child_sid = self._sid(self.launch["appContainerSid"])
        _need(child_digest == self.launch["expectedToken"]["appContainerSidDigest"], "WINDOWS_TOKEN_MISMATCH")
        if target:
            sddl = "O:" + host_sid + "D:P(A;;GA;;;" + host_sid + ")(A;;0x12019b;;;" + child_sid + ")"
        else:
            sddl = "O:" + host_sid + "D:P(D;;GA;;;NU)(D;;GA;;;AN)(D;;GA;;;AC)(D;;GA;;;" + child_sid + ")(A;;GA;;;" + host_sid + ")(A;;0x12019b;;;" + controller_sid + ")"
        descriptor, length = c.c_void_p(), c.c_uint32()
        self._ok(self.a.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, c.byref(descriptor), c.byref(length)), "WINDOWS_ACL_UNSUPPORTED")
        sa = self.t["SECURITY_ATTRIBUTES"](c.sizeof(self.t["SECURITY_ATTRIBUTES"]), descriptor, False)
        return sa, descriptor

    def _acl_bytes(self, descriptor):
        c = self.c
        present, defaulted, acl = c.c_int32(), c.c_int32(), c.c_void_p()
        self._ok(self.a.GetSecurityDescriptorDacl(descriptor, c.byref(present), c.byref(acl), c.byref(defaulted)), "WINDOWS_ACL_UNCONFIRMED")
        _need(present.value == 1 and acl.value and defaulted.value == 0, "WINDOWS_ACL_UNCONFIRMED")
        header = c.string_at(acl, 8)
        size = int.from_bytes(header[2:4], "little")
        _need(8 <= size <= 65535, "WINDOWS_ACL_UNCONFIRMED")
        control, revision = c.c_uint16(), c.c_uint32()
        self._ok(self.a.GetSecurityDescriptorControl(descriptor, c.byref(control), c.byref(revision)), "WINDOWS_ACL_UNCONFIRMED")
        _need(control.value & 0x1000 == 0x1000, "WINDOWS_ACL_UNCONFIRMED")
        return c.string_at(acl, size)

    def _verify_acl(self, handle, expected):
        c = self.c
        observed, owner = c.c_void_p(), c.c_void_p()
        result = self.a.GetSecurityInfo(handle, 6, 5, c.byref(owner), None, None, None, c.byref(observed))
        _need(result == 0 and observed.value, "WINDOWS_ACL_UNCONFIRMED")
        try:
            _need(self._acl_bytes(expected) == self._acl_bytes(observed), "WINDOWS_ACL_UNCONFIRMED")
            digest, _ = self._sid(owner)
            _need(digest == self.bootstrap["hostSidDigest"], "WINDOWS_ACL_UNCONFIRMED")
        finally:
            self._ok(self.k.LocalFree(observed) is None, "WINDOWS_SECURITY_FREE_UNCONFIRMED")

    def listen(self, name, mode, acl):
        self._load()
        _need(type(name) is str and name.startswith("\\\\.\\pipe\\trio-w5a-") and mode in ("DUPLEX", "IN", "OUT", "ERR"))
        _need(acl == {"hostSidDigest": self.bootstrap["hostSidDigest"], "controllerSidDigest": self.bootstrap["controllerSidDigest"],
            "localOnly": True, "clientCreateInstance": False, "denyAppContainer": True}, "WINDOWS_ACL_UNSUPPORTED")
        sa, descriptor = self._security()
        pipe, error = None, None
        try:
            handle = self.k.CreateNamedPipeW(name, 3 | 0x40000000 | 0x80000, 8, 1,
                self.bounds["streamHighWaterMarkBytes"], self.bounds["streamHighWaterMarkBytes"], 0, self.c.byref(sa))
            _need(handle and handle != self.c.c_void_p(-1).value, "WINDOWS_PIPE_FAILED")
            pipe = _Pipe(handle)
            self._live.append(pipe)
            self._verify_acl(handle, descriptor)
            self._ok(self.k.SetHandleInformation(handle, 1, 0), "WINDOWS_HANDLE_INHERIT_UNCONFIRMED")
        except Exception as exc:
            error = exc if isinstance(exc, HostError) else HostError("WINDOWS_PIPE_FAILED")
        try:
            self._ok(self.k.LocalFree(descriptor) is None, "WINDOWS_SECURITY_FREE_UNCONFIRMED")
        except Exception as exc:
            if error is None:
                error = exc if isinstance(exc, HostError) else HostError("WINDOWS_SECURITY_FREE_UNCONFIRMED")
            else:
                error.security_free_code = "WINDOWS_SECURITY_FREE_UNCONFIRMED"
        if error is not None:
            if pipe is not None:
                error.listener = pipe
                try:
                    self._ok(self.k.CloseHandle(pipe.raw), "WINDOWS_CLOSE_UNCONFIRMED")
                    pipe.closed = True
                except Exception:
                    error.close_code = "WINDOWS_CLOSE_UNCONFIRMED"
                error.closed = pipe.closed
            raise error
        return pipe

    def _raw(self, handle):
        if type(handle) is _Pipe:
            _need(handle in self._live and not handle.closed, "WINDOWS_HANDLE_UNCONFIRMED")
            return handle.raw
        _need(type(handle) is int and handle > 0, "WINDOWS_HANDLE_UNCONFIRMED")
        return handle

    def _begin(self, kind, handle, size=0, data=None, offset=0):
        self._load()
        c = self.c
        raw = self._raw(handle)
        event = self._ok(self.k.CreateEventW(None, True, False, None), "WINDOWS_EVENT_FAILED")
        overlapped = self.t["OVERLAPPED"]()
        overlapped.event = event
        buffer = c.create_string_buffer(size) if kind == "read" else c.create_string_buffer(data[offset:]) if kind == "write" else None
        op = _WinOp(kind, handle, raw, overlapped, event, buffer)
        self._live.append(op)
        try:
            c.set_last_error(0)
            count = c.c_uint32()
            if kind == "accept":
                ok = self.k.ConnectNamedPipe(raw, c.byref(overlapped))
            else:
                ok = (self.k.ReadFile if kind == "read" else self.k.WriteFile)(raw, buffer,
                    size if kind == "read" else len(data) - offset, c.byref(count), c.byref(overlapped))
            error = c.get_last_error()
            if ok:
                op.immediate = count.value
            elif kind == "accept" and error == 535:
                op.immediate = 0
            elif kind == "read" and error == 109:
                op.eof, op.immediate = True, 0
            elif error != 997:
                op.failure = error
            return op
        except Exception as exc:
            op.unknown = True
            error = exc if isinstance(exc, HostError) else HostError("WINDOWS_RETURN_LOST")
            error.operation = op
            raise error from exc

    def accept(self, listener):
        return self._begin("accept", listener)

    def read(self, handle, n):
        _uint(n, 1, 65536)
        return self._begin("read", handle, n)

    def write(self, handle, data, offset):
        _need(type(data) is bytes and data)
        _uint(offset, 0, len(data) - 1)
        return self._begin("write", handle, data=data, offset=offset)

    def cancel(self, op):
        _need(type(op) is _WinOp and not op.done, "WINDOWS_OPERATION_INVALID")
        self.c.set_last_error(0)
        ok = self.k.CancelIoEx(op.raw, self.c.byref(op.overlapped))
        error = self.c.get_last_error()
        _need(ok or error == 1168, "WINDOWS_CANCEL_UNCONFIRMED")

    def poll(self, op):
        if type(op) is _Immediate:
            _need(not op.done, "WINDOWS_OPERATION_INVALID")
            op.done = True
            return op.value
        _need(type(op) is _WinOp and not op.done, "WINDOWS_OPERATION_INVALID")
        if op.unknown:
            return {"state": "UNCONFIRMED", "code": "WINDOWS_RETURN_LOST"}
        count = self.c.c_uint32()
        if op.immediate is not None:
            count.value = op.immediate
            ok, error = True, 0
        elif op.failure is not None:
            ok, error = False, op.failure
        else:
            self.c.set_last_error(0)
            ok = self.k.GetOverlappedResult(op.raw, self.c.byref(op.overlapped), self.c.byref(count), False)
            error = self.c.get_last_error()
            if not ok and error == 996:
                return None
        if not ok and op.kind == "read" and error == 109:
            op.eof, ok = True, True
        if not self.k.CloseHandle(op.event):
            op.unknown = True
            return {"state": "UNCONFIRMED", "code": "WINDOWS_EVENT_CLOSE_UNCONFIRMED"}
        op.done = True
        if op in self._live:
            self._live.remove(op)
        if not ok:
            op.buffer = None
            return {"state": "FAILED", "code": "WINDOWS_IO_CANCELLED" if error == 995 else "WINDOWS_IO_FAILED"}
        if op.kind == "accept":
            value = op.handle
        elif op.kind == "read":
            value = {"data": bytes(op.buffer.raw[:count.value]), "eof": op.eof}
        else:
            value = {"transferred": int(count.value)}
        op.buffer = None
        return {"state": "RETURNED", "value": value}

    def close(self, handle):
        raw = self._raw(handle)
        self.c.set_last_error(0)
        ok = self.k.CloseHandle(raw)
        if not ok:
            return _Immediate({"state": "UNCONFIRMED", "code": "WINDOWS_CLOSE_UNCONFIRMED"})
        handle.closed = True
        return _Immediate({"state": "RETURNED", "value": {"closed": True}})

    def peer(self, handle):
        pid = self.c.c_uint32()
        self._ok(self.k.GetNamedPipeClientProcessId(self._raw(handle), self.c.byref(pid)), "WINDOWS_PEER_INVALID")
        facts, _ = self._observe_process(pid.value, True)
        return facts

    def open_stdio(self):
        self._load()
        import uuid
        raw, pending = [], []
        error = None
        sa, descriptor = self._security(target=True)
        try:
            for index in range(3):
                name = "\\\\.\\pipe\\trio-w5a-stdio-" + str(uuid.uuid4())
                server = self.k.CreateNamedPipeW(name, (2 if index == 0 else 1) | 0x40000000 | 0x80000,
                    8, 1, self.bounds["maxChunkBytes"], self.bounds["maxChunkBytes"], 0, self.c.byref(sa))
                _need(server and server != self.c.c_void_p(-1).value, "WINDOWS_STDIO_FAILED")
                raw.append(server)
                self._verify_acl(server, descriptor)
                child_sa = self.t["SECURITY_ATTRIBUTES"](self.c.sizeof(self.t["SECURITY_ATTRIBUTES"]), None, True)
                child = self.k.CreateFileW(name, 0x80000000 if index == 0 else 0x40000000, 0,
                    self.c.byref(child_sa), 3, 0, None)
                _need(child and child != self.c.c_void_p(-1).value, "WINDOWS_STDIO_FAILED")
                raw.append(child)
                self._ok(self.k.SetHandleInformation(server, 1, 0), "WINDOWS_HANDLE_INHERIT_UNCONFIRMED")
                self._ok(self.k.SetHandleInformation(child, 1, 1), "WINDOWS_HANDLE_INHERIT_UNCONFIRMED")
                op = self._begin("accept", server)
                pending.append(op)
                try:
                    completion = self.poll(op)
                except Exception:
                    op.unknown = True
                    raise
                if completion is not None and completion["state"] in ("RETURNED", "FAILED"):
                    pending.remove(op)
                _need(completion is not None and completion["state"] == "RETURNED", "WINDOWS_STDIO_CONNECT_UNCONFIRMED")
        except Exception as exc:
            operation = getattr(exc, "operation", None)
            if operation is not None and operation not in pending:
                pending.append(operation)
            error = exc if isinstance(exc, HostError) else HostError("WINDOWS_STDIO_FAILED")
        try:
            self._ok(self.k.LocalFree(descriptor) is None, "WINDOWS_SECURITY_FREE_UNCONFIRMED")
        except Exception as exc:
            if error is None:
                error = exc if isinstance(exc, HostError) else HostError("WINDOWS_SECURITY_FREE_UNCONFIRMED")
            else:
                error.security_free_code = "WINDOWS_SECURITY_FREE_UNCONFIRMED"
        if error is not None:
            error.owned, error.pending = raw, pending
            raise error
        return {"childHandles": raw[1::2], "owned": raw[0::2]}


class _Pipe:
    def __init__(self, raw):
        self.raw, self.closed = raw, False


class _WinOp:
    def __init__(self, kind, handle, raw, overlapped, event, buffer):
        self.kind, self.handle, self.raw = kind, handle, raw
        self.overlapped, self.event, self.buffer = overlapped, event, buffer
        self.immediate = self.failure = None
        self.eof = self.unknown = self.done = False


class _Immediate:
    def __init__(self, value):
        self.value, self.done = value, False


def _windows_types(c):
    class Overlapped(c.Structure):
        _fields_ = (("internal", c.c_size_t), ("internal_high", c.c_size_t),
                    ("offset", c.c_uint32), ("offset_high", c.c_uint32), ("event", c.c_void_p))
    class SecurityAttributes(c.Structure):
        _fields_ = (("length", c.c_uint32), ("descriptor", c.c_void_p), ("inherit", c.c_int32))
    class OneGroup(c.Structure):
        _fields_ = (("count", c.c_uint32), ("sid", c.c_void_p), ("attributes", c.c_uint32))
    return {"OVERLAPPED": Overlapped, "SECURITY_ATTRIBUTES": SecurityAttributes, "ONE_GROUP": OneGroup}

_PINNED_CORE = None
_CORE_PIN = None


def _core_value(value, module_name):
    kind = type(value)
    if kind in (str, int, bool, bytes, type(None)):
        return kind.__name__, value
    if kind in (list, tuple):
        return kind.__name__, tuple(_core_value(v, module_name) for v in value)
    if kind is dict:
        return "dict", tuple((k, _core_value(v, module_name)) for k, v in value.items())
    if kind is types.FunctionType:
        return ("function", id(value), id(value.__code__), id(value.__globals__),
            _core_value(value.__defaults__, module_name), _core_value(value.__kwdefaults__, module_name))
    if kind is type and value.__module__ == module_name:
        return "class", id(value), tuple((k, _core_value(v, module_name)) for k, v in vars(value).items())
    return "identity", id(value)


def _core_pin(core):
    return tuple((key, ("identity", id(value)) if key == "__builtins__" else _core_value(value, core.__name__))
                 for key, value in vars(core).items())


def load_windows_host_core(source):
    """신뢰 loader의 고정 source bytes를 검증해 같은 class를 한 번만 조립한다."""
    global _PINNED_CORE, _CORE_PIN
    _need(type(source) is bytes and len(source) <= 262144 and hashlib.sha256(source).hexdigest() == CORE_SHA256,
          "WINDOWS_CORE_DRIFT")
    if _PINNED_CORE is None:
        core = types.ModuleType("trio_windows_job_pinned_core")
        core.__file__ = __file__.replace("\\", "/").rsplit("/", 1)[0] + "/windows-job-host.py"
        exec(compile(source.decode("utf-8-sig"), core.__file__, "exec"), core.__dict__)
        _PINNED_CORE, _CORE_PIN = core, _core_pin(core)
    _need(_core_pin(_PINNED_CORE) == _CORE_PIN, "WINDOWS_CORE_DRIFT")
    return _PINNED_CORE


def _registration_digest(registration):
    descriptor = {"version": 1,
        "bootstrap": {k: v for k, v in registration["bootstrap"].items() if k != "key"},
        "launch": {k: v for k, v in registration["launch"].items() if k not in ("token", "appContainerSid")},
        "bounds": registration["bounds"]}
    return hashlib.sha256(_canonical(descriptor)).hexdigest()

def _command_line(argv):
    out = []
    for argument in argv:
        quote = not argument or " " in argument or "\t" in argument
        part, slashes = ('"' if quote else ''), 0
        for char in argument:
            if char == "\\":
                slashes += 1
                continue
            if char == '"':
                part += "\\" * (2 * slashes + 1) + '"'
            else:
                part += "\\" * slashes + char
            slashes = 0
        part += "\\" * (slashes * (2 if quote else 1))
        if quote:
            part += '"'
        out.append(part)
    return " ".join(out)


def _pointer_equal(left, right):
    return left == right if type(left) is int and type(right) is int else left is right


def _check_capability(runtime, capability):
    _need(type(capability) is runtime.core.LaunchCapability, "WINDOWS_LAUNCH_UNCONFIRMED")
    launch = runtime.registration["launch"]
    executable = next((f["path"] for f in launch["files"] if f["id"] == launch["executableId"]), None)
    environment = "\0".join(k + "=" + launch["environment"][k] for k in sorted(launch["environment"])) + "\0\0"
    _need(executable is not None and capability.executable == executable and capability.command_line == _command_line(launch["argv"])
        and capability.directory == launch["cwd"] and capability.environment == environment
        and capability.windows_session_id == launch["expectedToken"]["windowsSessionId"]
        and _pointer_equal(capability.token, launch["token"]) and _pointer_equal(capability.appcontainer_sid, launch["appContainerSid"])
        and type(capability.validate_current) in (types.FunctionType, types.MethodType), "WINDOWS_LAUNCH_MISMATCH")
