"""원 Windows 작업 actor. 기본 CLI, DLL 로더, 프로세스 생성 경로는 없다.

Win32/IO/clock은 필수 주입 포트다. 반환 None은 아직 끝나지 않은 I/O이며
시간 초과가 해당 작업의 완료나 수량 0을 뜻하지 않는다.
"""
import hashlib
import json
import re
import struct

MAX_CONTROL = 131072
MAX_RECORD = 65536
MAX_CHUNK = 65536
U64 = (1 << 64) - 1
SAFE = (1 << 53) - 1
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
HEX = re.compile(r"^[0-9a-f]{64}$")
CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,127}$")
TOKEN = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
WAIT = b"WAIT_V1\n"
GO = b"GO_V1\n"
READY = b"READY_V1\n"
PHASES = ("NEW", "PREPARING", "PREPARED", "GO_GRANTED", "DRAINING", "JOINED", "UNCONFIRMED")
REASONS = ("CALLER_ABORT", "DEADLINE", "CONTROL_LOST", "INPUT_LIMIT", "OUTPUT_LIMIT", "JOURNAL_UNCONFIRMED", "HOST_FAILED")
POLICY_KEYS = ("maxProcesses", "jobCommitLimitBytes", "processCommitLimitBytes", "cpuRatePer10000", "wallTimeoutMs", "joinTimeoutMs", "stdoutMaxBytes", "stderrMaxBytes")
LIMIT_KEYS = ("maxMetadataBytes", "maxInputBytes", "maxOutputBytes", "maxItems", "childMemoryBytes", "maxProcesses", "timeoutMs", "terminationWaitMs", "parentInFlightBytes")
BASIC_KEYS = ("TotalUserTime", "TotalKernelTime", "ThisPeriodTotalUserTime", "ThisPeriodTotalKernelTime", "TotalPageFaultCount", "TotalProcesses", "ActiveProcesses", "TotalTerminatedProcesses")
IO_KEYS = ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")
EXT_BASIC_KEYS = ("PerProcessUserTimeLimit", "PerJobUserTimeLimit", "LimitFlags", "MinimumWorkingSetSize", "MaximumWorkingSetSize", "ActiveProcessLimit", "Affinity", "PriorityClass", "SchedulingClass")
TOKEN_CLASSES = ("TOKEN_USER", "TOKEN_APPCONTAINER_SID", "TOKEN_IS_APPCONTAINER", "TOKEN_INTEGRITY_LEVEL", "TOKEN_SESSION_ID")
EVENT_KEYS = {
    "PRE_CREATE": ("bindingDigest", "policyDigest", "pinsDigest"),
    "CREATE_ARMED": ("callId",), "CREATE_NOT_ATTEMPTED": ("code",),
    "CREATE_FAILED": ("win32Error", "creationConfirmedAbsent"),
    "CREATED_SUSPENDED": ("pid", "creationFileTime100ns", "assignedBy"),
    "PREPARED": ("membershipConfirmed", "tokenDigest", "osReadbackDigest", "brokerAppliedDigest"),
    "BOOTSTRAP_RESUMED": ("resumeReturned",), "GO_AUTHORIZED": ("goGrantRef",),
    "GO_WRITE_ARMED": ("bytesLength",), "GO_WRITE": ("result", "bytesLength"),
    "ROOT_EXIT": ("exitCode",), "TREE_EMPTY": ("activeProcesses", "totalProcesses"),
    "IO_JOINED": ("stdinClosed", "stdoutEof", "stderrEof", "parentIoJoined"),
    "FINAL_ACCOUNTING": ("accounting",), "FAILED": ("code", "phase"),
}


class HostError(ValueError):
    def __init__(self, code="WINDOWS_HOST_INVALID"):
        self.code = code
        self.next_action = "WAIT"
        super().__init__(code)


def require(value, code="WINDOWS_HOST_INVALID"):
    if not value:
        raise HostError(code)


def obj(value, keys):
    require(type(value) is dict and set(value) == set(keys))
    return value


def integer(value, low=0, high=0xffffffff):
    require(type(value) is int and low <= value <= high)
    return value


def decimal(value, positive=False):
    require(type(value) is str and re.fullmatch(r"0|[1-9][0-9]{0,19}", value) is not None)
    n = int(value)
    require(n <= U64 and (not positive or n > 0))
    return n


def uid(value):
    require(type(value) is str and UUID.fullmatch(value) is not None)


def hashed(value):
    require(type(value) is str and HEX.fullmatch(value) is not None)


def error_code(value):
    require(type(value) is str and CODE.fullmatch(value) is not None)


def _measure(value, cap=MAX_CONTROL, depth_cap=20, node_cap=8192):
    """순수 built-in 자료만 먼저 순회한다. alias도 각 확장 비용으로 계산한다."""
    nodes, size = 0, 0
    ancestors = set()

    def add(n):
        nonlocal size
        size += n
        require(size <= cap, "WINDOWS_BUFFER_LIMIT")

    def string(s):
        require(type(s) is str and s.isascii())
        add(2)
        for ch in s:
            add(2 if ch in '"\\\b\t\n\f\r' else 6 if ord(ch) < 32 else 1)

    def visit(v, depth):
        nonlocal nodes
        nodes += 1
        require(nodes <= node_cap and depth <= depth_cap, "WINDOWS_BUFFER_LIMIT")
        t = type(v)
        if v is None:
            add(4)
        elif t is bool:
            add(4 if v else 5)
        elif t is int:
            integer(v, -SAFE, SAFE)
            add(len(str(v)))
        elif t is str:
            string(v)
        else:
            require(t in (dict, list) and id(v) not in ancestors)
            require(len(v) <= node_cap - nodes, "WINDOWS_BUFFER_LIMIT")
            ancestors.add(id(v))
            add(2 + max(0, len(v) - 1))
            if t is dict:
                for k, item in v.items():
                    string(k)
                    add(1)
                    visit(item, depth + 1)
            else:
                for item in v:
                    visit(item, depth + 1)
            ancestors.remove(id(v))
    visit(value, 0)
    return size


def canonical_bytes(value):
    _measure(value)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("ascii")


def digest(value):
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def _copy(value):
    # 사전 예산 검사는 호출자가 먼저 수행한다.
    if type(value) is dict:
        return {k: _copy(v) for k, v in value.items()}
    if type(value) is list:
        return [_copy(v) for v in value]
    return value


def _go(value):
    obj(value, ("jobId", "rowDigest"))
    uid(value["jobId"])
    hashed(value["rowDigest"])


def _parent(value):
    obj(value, ("joinId", "originDigest", "digest"))
    uid(value["joinId"])
    hashed(value["originDigest"])
    hashed(value["digest"])


def _ref(value):
    obj(value, ("recordId", "digest"))
    uid(value["recordId"])
    hashed(value["digest"])


def _ack(value):
    obj(value, ("eventId", "payloadDigest", "sourceDigest"))
    uid(value["eventId"])
    hashed(value["payloadDigest"])
    hashed(value["sourceDigest"])


def _identity_fields(value):
    ident = obj(value["identity"], ("binding", "intentDigest", "sourceInput", "inputEvidenceDigest", "inputFingerprint", "basisRef"))
    binding = obj(ident["binding"], ("accountId", "capacityReservationId", "jobId", "parentInstanceId", "inputDigest", "profileDigest", "kernelDigest"))
    for k in ("accountId", "capacityReservationId", "jobId", "parentInstanceId"):
        uid(binding[k])
    for k in ("inputDigest", "profileDigest", "kernelDigest"):
        hashed(binding[k])
    for k in ("intentDigest", "inputEvidenceDigest", "inputFingerprint"):
        hashed(ident[k])
    source = obj(ident["sourceInput"], ("executionId", "inputEvidenceId", "stageInputDigest"))
    uid(source["executionId"])
    uid(source["inputEvidenceId"])
    hashed(source["stageInputDigest"])
    if ident["basisRef"] is not None:
        obj(ident["basisRef"], ("evidenceId", "evidenceDigest"))
        uid(ident["basisRef"]["evidenceId"])
        hashed(ident["basisRef"]["evidenceDigest"])
    a = obj(value["authority"], ("attemptId", "controllerInstanceId", "controllerId", "keyVersion", "environmentDigest", "hostEpochId", "sessionId", "launchId", "policyDigest", "controllerSidDigest", "childSidDigest", "appContainerSidDigest"))
    for k in ("attemptId", "controllerInstanceId", "hostEpochId", "sessionId", "launchId"):
        uid(a[k])
    for k in ("controllerId", "keyVersion"):
        require(type(a[k]) is str and TOKEN.fullmatch(a[k]))
    for k in ("environmentDigest", "policyDigest", "controllerSidDigest", "childSidDigest", "appContainerSidDigest"):
        hashed(a[k])
    pins = obj(value["pins"], ("executableDigest", "bootstrapDigest", "helperRuntimeDigest", "helperScriptDigest", "runtimeFilesDigest", "nativeLimitsDigest"))
    for v in pins.values():
        hashed(v)
def _os_limits(p):
    integer(p["maxProcesses"], 1)
    require(decimal(p["processCommitLimitBytes"], True) <= decimal(p["jobCommitLimitBytes"], True))
    integer(p["cpuRatePer10000"], 1, 10000)


def _broker_limits(p):
    integer(p["wallTimeoutMs"], 1, 2147483647)
    integer(p["joinTimeoutMs"], 1, 2147483647)
    decimal(p["stdoutMaxBytes"], True)
    decimal(p["stderrMaxBytes"], True)


def _requested_policy(value):
    p = obj(value, POLICY_KEYS)
    _os_limits(p)
    _broker_limits(p)


def _origin(value):
    obj(value, ("identity", "authority", "pins", "policy", "limits"))
    _identity_fields(value)
    p = value["policy"]
    _requested_policy(p)
    limits = obj(value["limits"], LIMIT_KEYS)
    for v in limits.values():
        integer(v, 1, SAFE)
    integer(limits["maxMetadataBytes"], 1)
    integer(limits["timeoutMs"], 1, 2147483647)
    integer(limits["terminationWaitMs"], 1, 2147483647)
    require(limits["maxOutputBytes"] + limits["maxMetadataBytes"] + 12 <= SAFE)
    require(p["maxProcesses"] <= limits["maxProcesses"] and p["wallTimeoutMs"] <= limits["timeoutMs"] and p["joinTimeoutMs"] <= limits["terminationWaitMs"])
    require(value["authority"]["policyDigest"] == digest(p) and value["pins"]["nativeLimitsDigest"] == digest(limits), "WINDOWS_ORIGINAL_MISMATCH")



def _accounting(value):
    keys = ("userTime100ns", "kernelTime100ns", "peakJobMemoryBytes", "peakProcessMemoryBytes",
            "readOperations", "writeOperations", "otherOperations", "readBytes", "writeBytes", "otherBytes",
            "totalProcesses", "startQpcTicks", "endQpcTicks", "qpcFrequency", "snapshotScope", "memoryAccounting")
    a = obj(value, keys)
    for k in keys[:14]:
        decimal(a[k])
    require(decimal(a["totalProcesses"], True) <= 0xffffffff)
    decimal(a["qpcFrequency"], True)
    require(decimal(a["endQpcTicks"]) >= decimal(a["startQpcTicks"]))
    require(a["snapshotScope"] == "FRESH_JOB_LIFETIME" and a["memoryAccounting"] == "WIN32_JOB_MEMORY_NOT_RSS")


def _event_payload(kind, value):
    p = obj(value, EVENT_KEYS[kind])
    if kind == "PRE_CREATE":
        for v in p.values():
            hashed(v)
    elif kind == "CREATE_NOT_ATTEMPTED":
        error_code(p["code"])
    elif kind == "CREATE_ARMED":
        uid(p["callId"])
    elif kind == "CREATE_FAILED":
        integer(p["win32Error"], 1)
        require(p["creationConfirmedAbsent"] is True)
    elif kind == "CREATED_SUSPENDED":
        integer(p["pid"], 1)
        decimal(p["creationFileTime100ns"])
        require(p["assignedBy"] == "PROC_THREAD_ATTRIBUTE_JOB_LIST")
    elif kind == "PREPARED":
        require(p["membershipConfirmed"] is True)
        for k in ("tokenDigest", "osReadbackDigest", "brokerAppliedDigest"):
            hashed(p[k])
    elif kind == "BOOTSTRAP_RESUMED":
        require(p["resumeReturned"] is True)
    elif kind == "GO_AUTHORIZED":
        _go(p["goGrantRef"])
    elif kind in ("GO_WRITE_ARMED", "GO_WRITE"):
        decimal(p["bytesLength"], True)
        if kind == "GO_WRITE":
            require(p["result"] in ("RETURNED", "UNCONFIRMED"))
    elif kind == "ROOT_EXIT":
        integer(p["exitCode"])
    elif kind == "TREE_EMPTY":
        integer(p["activeProcesses"], 0, 0)
        require(decimal(p["totalProcesses"], True) <= 0xffffffff)
    elif kind == "IO_JOINED":
        require(all(v is True for v in p.values()))
    elif kind == "FINAL_ACCOUNTING":
        _accounting(p["accounting"])
    elif kind == "FAILED":
        error_code(p["code"])
        require(p["phase"] in ("CREATE", "PREPARE", "GO", "DRAIN"))


def _evidence_events(value):
    require(type(value) is list and 0 < len(value) <= 64)
    ranks = {"PRE_CREATE": 0, "CREATE_ARMED": 1, "CREATE_NOT_ATTEMPTED": 2, "CREATE_FAILED": 2,
             "CREATED_SUSPENDED": 2, "PREPARED": 3, "BOOTSTRAP_RESUMED": 4, "GO_AUTHORIZED": 5,
             "GO_WRITE_ARMED": 6, "GO_WRITE": 7, "ROOT_EXIT": 8, "TREE_EMPTY": 9, "IO_JOINED": 10,
             "FINAL_ACCOUNTING": 11, "FAILED": 12}
    predecessors = {"CREATE_ARMED": "PRE_CREATE", "CREATE_NOT_ATTEMPTED": "PRE_CREATE",
        "CREATE_FAILED": "CREATE_ARMED", "CREATED_SUSPENDED": "CREATE_ARMED", "PREPARED": "CREATED_SUSPENDED",
        "BOOTSTRAP_RESUMED": "PREPARED", "GO_AUTHORIZED": "BOOTSTRAP_RESUMED", "GO_WRITE_ARMED": "GO_AUTHORIZED",
        "GO_WRITE": "GO_WRITE_ARMED", "ROOT_EXIT": "CREATED_SUSPENDED", "TREE_EMPTY": "ROOT_EXIT",
        "IO_JOINED": "TREE_EMPTY", "FINAL_ACCOUNTING": "IO_JOINED", "FAILED": "PRE_CREATE"}
    seen, ids = {}, set()
    previous, ticks, rank, failed = None, 0, -1, False
    for index, raw in enumerate(value):
        e = obj(raw, ("eventId", "sequence", "kind", "qpcTicks", "previousDigest", "payload", "payloadDigest"))
        uid(e["eventId"])
        hashed(e["payloadDigest"])
        kind = e["kind"]
        require(type(kind) is str and kind in EVENT_KEYS)
        integer(e["sequence"], 1, 64)
        now = decimal(e["qpcTicks"])
        require(e["sequence"] == index + 1 and e["eventId"] not in ids and kind not in seen
                and e["previousDigest"] == previous and now >= ticks)
        require((index == 0) == (kind == "PRE_CREATE"))
        require(kind not in predecessors or predecessors[kind] in seen)
        if kind == "FAILED":
            failed = True
        else:
            require(ranks[kind] > rank and (not failed or ranks[kind] >= 8))
            rank = ranks[kind]
        _event_payload(kind, e["payload"])
        require(e["payloadDigest"] == digest({k: v for k, v in e.items() if k != "payloadDigest"}))
        seen[kind] = e
        ids.add(e["eventId"])
        previous, ticks = e["payloadDigest"], now
    return seen


def _evidence(value):
    """현재 W1 closed schema와 필수 관계. 원 OS/DB 권위의 인증은 아니다."""
    _measure(value, MAX_RECORD, 16, 4096)
    obj(value, ("version", "kind", "identity", "authority", "pins", "policy", "lifecycle", "final"))
    integer(value["version"], 1, 1)
    require(value["kind"] == "WINDOWS_JOB_OBJECT")
    _identity_fields(value)
    p = obj(value["policy"], ("requested", "osReadback", "brokerApplied"))
    _requested_policy(p["requested"])
    require(value["authority"]["policyDigest"] == digest(p["requested"]))
    if p["osReadback"] is not None:
        o = obj(p["osReadback"], ("maxProcesses", "jobCommitLimitBytes", "processCommitLimitBytes",
                                "cpuRatePer10000", "killOnJobClose", "breakawayAllowed"))
        _os_limits(o)
        require(o["killOnJobClose"] is True and o["breakawayAllowed"] is False)
    if p["brokerApplied"] is not None:
        _broker_limits(obj(p["brokerApplied"], ("wallTimeoutMs", "joinTimeoutMs", "stdoutMaxBytes", "stderrMaxBytes")))
    l = obj(value["lifecycle"], ("creation", "root", "goGrantRef", "goWrite", "rootExit", "events"))
    require(l["creation"] in ("NOT_ATTEMPTED", "FAILED", "CREATED", "UNCONFIRMED")
            and l["goWrite"] in ("NOT_ATTEMPTED", "RETURNED", "UNCONFIRMED"))
    f = obj(value["final"], ("outcome", "activeProcesses", "rootSignaled", "stdioJoined",
                            "parentIoJoined", "recordSealed", "accounting", "failureCode"))
    require(f["outcome"] in ("NO_CHILD_CREATED", "JOB_EMPTY", "UNCONFIRMED"))
    if f["activeProcesses"] is not None:
        integer(f["activeProcesses"])
    for k in ("rootSignaled", "stdioJoined", "parentIoJoined", "recordSealed"):
        require(type(f[k]) is bool)
    if f["failureCode"] is not None:
        error_code(f["failureCode"])
    events = _evidence_events(l["events"])
    def has(kind):
        return kind in events
    def payload(kind):
        return events[kind]["payload"]
    first = payload("PRE_CREATE")
    require(first["bindingDigest"] == digest(value["identity"])
            and first["policyDigest"] == value["authority"]["policyDigest"]
            and first["pinsDigest"] == digest(value["pins"]))
    require(not (has("CREATE_NOT_ATTEMPTED") and has("CREATE_ARMED")))
    require(not (has("CREATE_FAILED") and has("CREATED_SUSPENDED")))
    creation = ("CREATED" if has("CREATED_SUSPENDED") else "FAILED" if has("CREATE_FAILED")
                else "NOT_ATTEMPTED" if has("CREATE_NOT_ATTEMPTED") else "UNCONFIRMED")
    require(l["creation"] == creation)
    if creation == "CREATED":
        root = obj(l["root"], ("pid", "creationFileTime100ns"))
        integer(root["pid"], 1)
        decimal(root["creationFileTime100ns"])
        require(all(root[k] == payload("CREATED_SUSPENDED")[k] for k in root))
    else:
        require(l["root"] is None)
    if has("PREPARED"):
        require(p["osReadback"] is not None and p["brokerApplied"] is not None)
        require(payload("PREPARED")["osReadbackDigest"] == digest(p["osReadback"])
                and payload("PREPARED")["brokerAppliedDigest"] == digest(p["brokerApplied"]))
        require(all(p["osReadback"][k] == p["requested"][k] for k in
                    ("maxProcesses", "jobCommitLimitBytes", "processCommitLimitBytes", "cpuRatePer10000")))
        require(all(p["brokerApplied"][k] == p["requested"][k] for k in
                    ("wallTimeoutMs", "joinTimeoutMs", "stdoutMaxBytes", "stderrMaxBytes")))
    if has("GO_AUTHORIZED"):
        _go(l["goGrantRef"])
        require(l["goGrantRef"]["jobId"] == value["identity"]["binding"]["jobId"]
                and l["goGrantRef"] == payload("GO_AUTHORIZED")["goGrantRef"])
    else:
        require(l["goGrantRef"] is None)
    go_write = (payload("GO_WRITE")["result"] if has("GO_WRITE")
                else "UNCONFIRMED" if has("GO_WRITE_ARMED") else "NOT_ATTEMPTED")
    require(l["goWrite"] == go_write)
    if has("GO_WRITE"):
        require(payload("GO_WRITE")["bytesLength"] == payload("GO_WRITE_ARMED")["bytesLength"])
    if has("ROOT_EXIT"):
        exited = obj(l["rootExit"], ("exitCode", "observedQpcTicks"))
        integer(exited["exitCode"])
        decimal(exited["observedQpcTicks"])
        require(exited["exitCode"] == payload("ROOT_EXIT")["exitCode"]
                and exited["observedQpcTicks"] == events["ROOT_EXIT"]["qpcTicks"])
    else:
        require(l["rootExit"] is None)
    require(f["rootSignaled"] == has("ROOT_EXIT") and f["stdioJoined"] == has("IO_JOINED"))
    if creation == "CREATED":
        require(f["parentIoJoined"] == has("IO_JOINED"))
    if has("TREE_EMPTY"):
        require(f["activeProcesses"] == 0)
    elif f["activeProcesses"] is not None:
        require(creation == "CREATED" and f["activeProcesses"] > 0)
    if has("FINAL_ACCOUNTING"):
        a = f["accounting"]
        _accounting(a)
        require(a == payload("FINAL_ACCOUNTING")["accounting"]
                and a["startQpcTicks"] == events["CREATED_SUSPENDED"]["qpcTicks"]
                and a["endQpcTicks"] == events["FINAL_ACCOUNTING"]["qpcTicks"]
                and a["totalProcesses"] == payload("TREE_EMPTY")["totalProcesses"])
    else:
        require(f["accounting"] is None)
    if has("FAILED"):
        require(f["failureCode"] == payload("FAILED")["code"])
    if f["outcome"] == "JOB_EMPTY":
        require(creation == "CREATED" and all(has(k) for k in
                ("ROOT_EXIT", "TREE_EMPTY", "IO_JOINED", "FINAL_ACCOUNTING")) and f["recordSealed"] is True)
        if not has("GO_WRITE") or go_write != "RETURNED" or f["failureCode"] is not None:
            require(has("FAILED") and f["failureCode"] is not None)
    elif f["outcome"] == "NO_CHILD_CREATED":
        if creation == "NOT_ATTEMPTED":
            require(f["failureCode"] == payload("CREATE_NOT_ATTEMPTED")["code"])
        require(creation in ("NOT_ATTEMPTED", "FAILED") and f["activeProcesses"] is None
                and f["accounting"] is None and f["rootSignaled"] is False and f["stdioJoined"] is False
                and f["parentIoJoined"] is True and f["recordSealed"] is True and f["failureCode"] is not None)
    else:
        require(f["failureCode"] is not None)


def _common(v, payload_name):
    obj(v, ("version", "requestId", "originDigest", "attemptId", "sessionId", "launchId", payload_name, "payload"))
    integer(v["version"], 1, 1)
    for k in ("requestId", "attemptId", "sessionId", "launchId"):
        uid(v[k])
    hashed(v["originDigest"])


def _control(v):
    _measure(v)
    _common(v, "command")
    c, p = v["command"], v["payload"]
    if c == "PREPARE":
        obj(p, ("origin", "launchRef"))
        _origin(p["origin"])
        uid(p["launchRef"])
    elif c == "ACK_EVENT":
        _ack(p)
    elif c == "GRANT_GO":
        obj(p, ("goGrantRef",))
        _go(p["goGrantRef"])
    elif c == "PARENT_JOINED":
        _parent(p)
    elif c == "ACK_FINAL":
        _ref(p)
    elif c == "STOP":
        obj(p, ("reason",))
        require(p["reason"] in REASONS)
    elif c == "QUERY":
        obj(p, ())
    else:
        raise HostError("CONTROL_INVALID")
    return v


def _pairs(pairs):
    out = {}
    for k, v in pairs:
        require(k not in out, "CONTROL_DUPLICATE_KEY")
        out[k] = v
    return out


def _decode(data):
    require(type(data) is bytes and 4 < len(data) <= MAX_CONTROL + 4)
    size = int.from_bytes(data[:4], "big")
    require(0 < size <= MAX_CONTROL and size == len(data) - 4)
    try:
        # bounded raw nesting before recursive json decoding
        nesting = 0
        quoted = escaped = False
        for ch in data[4:]:
            if quoted:
                if escaped:
                    escaped = False
                elif ch == 92:
                    escaped = True
                elif ch == 34:
                    quoted = False
            elif ch == 34:
                quoted = True
            elif ch in (91, 123):
                nesting += 1
                require(nesting <= 21, "WINDOWS_BUFFER_LIMIT")
            elif ch in (93, 125):
                nesting -= 1
        def invalid(_):
            raise HostError("CONTROL_NUMBER_INVALID")
        def exact_integer(text):
            require(text != "-0", "CONTROL_NUMBER_INVALID")
            value = int(text)
            integer(value, -SAFE, SAFE)
            return value
        value = json.loads(data[4:].decode("utf-8", "strict"), object_pairs_hook=_pairs,
                           parse_int=exact_integer, parse_float=invalid, parse_constant=invalid)
        _measure(value)
        return value
    except (UnicodeError, json.JSONDecodeError, RecursionError, OverflowError) as exc:
        raise HostError("CONTROL_INVALID") from exc


def encode_control(value):
    body = canonical_bytes(_control(value))
    return struct.pack(">I", len(body)) + body


def decode_control(data):
    return _copy(_control(_decode(data)))



def _basic(value):
    obj(value, BASIC_KEYS)
    for i, k in enumerate(BASIC_KEYS):
        decimal(value[k]) if i < 4 else integer(value[k])


def _io_counts(value):
    obj(value, IO_KEYS)
    for v in value.values():
        decimal(v)


def _extended(value):
    obj(value, ("BasicLimitInformation", "IoInfo", "ProcessMemoryLimit", "JobMemoryLimit", "PeakProcessMemoryUsed", "PeakJobMemoryUsed"))
    b = obj(value["BasicLimitInformation"], EXT_BASIC_KEYS)
    for k, v in b.items():
        integer(v) if k in ("LimitFlags", "ActiveProcessLimit", "PriorityClass", "SchedulingClass") else decimal(v)
    _io_counts(value["IoInfo"])
    for k in ("ProcessMemoryLimit", "JobMemoryLimit", "PeakProcessMemoryUsed", "PeakJobMemoryUsed"):
        decimal(value[k])


def _win_value(api, v):
    if api in ("CreateJobObjectW", "OpenProcessToken"):
        uid(obj(v, ("objectRef",))["objectRef"])
    elif api == "CreateProcessAsUserW":
        obj(v, ("processRef", "threadRef", "pid"))
        uid(v["processRef"])
        uid(v["threadRef"])
        integer(v["pid"], 1)
    elif api == "GetProcessTimes":
        obj(v, ("processRef", "creationFileTime100ns", "userTime100ns", "kernelTime100ns"))
        uid(v["processRef"])
        for k in ("creationFileTime100ns", "userTime100ns", "kernelTime100ns"):
            decimal(v[k])
    elif api == "QueryInformationJobObject":
        obj(v, ("informationClass", "values"))
        name, values = v["informationClass"], v["values"]
        if name == "EXTENDED_LIMITS":
            _extended(values)
        elif name == "BASIC_ACCOUNTING":
            _basic(values)
        elif name == "BASIC_AND_IO":
            obj(values, ("BasicInfo", "IoInfo"))
            _basic(values["BasicInfo"])
            _io_counts(values["IoInfo"])
        elif name == "CPU_RATE":
            obj(values, ("ControlFlags", "CpuRate"))
            integer(values["ControlFlags"])
            integer(values["CpuRate"])
        else:
            raise HostError()
    elif api == "GetTokenInformation":
        obj(v, ("informationClass", "values"))
        name, values = v["informationClass"], v["values"]
        require(name in TOKEN_CLASSES)
        if name == "TOKEN_IS_APPCONTAINER":
            require(type(obj(values, ("isAppContainer",))["isAppContainer"]) is bool)
        elif name == "TOKEN_SESSION_ID":
            integer(obj(values, ("sessionId",))["sessionId"])
        else:
            hashed(obj(values, ("sidDigest",))["sidDigest"])
    elif api == "IsWow64Process2":
        obj(v, ("processMachine", "nativeMachine"))
        integer(v["processMachine"], 0, 65535)
        integer(v["nativeMachine"], 0, 65535)
    else:
        names = {"IsProcessInJob": "isMember", "ResumeThread": "previousSuspendCount",
                 "WaitForSingleObject": "waitResult", "GetExitCodeProcess": "exitCode",
                 "QueryPerformanceCounter": "ticks", "QueryPerformanceFrequency": "frequency",
                 "GetNativeSystemInfo": "processorArchitecture", "ProcessIdToSessionId": "sessionId",
                 "SetInformationJobObject": "returned", "TerminateJobObject": "returned", "CloseHandle": "returned"}
        require(api in names)
        key = names[api]
        value = obj(v, (key,))[key]
        if key in ("isMember", "returned"):
            require(type(value) is bool)
        elif key == "waitResult":
            require(value in ("SIGNALED", "TIMEOUT", "FAILED"))
        elif key in ("ticks", "frequency"):
            decimal(value, key == "frequency")
        else:
            integer(value, 0, 65535 if key == "processorArchitecture" else 0xffffffff)


def _fact(f):
    require(type(f) is dict)
    kind = f.get("kind")
    if kind == "WIN32":
        obj(f, ("kind", "callId", "api", "qpcTicks", "status", "win32Error", "value"))
        uid(f["callId"])
        decimal(f["qpcTicks"])
        require(f["status"] in ("RETURNED", "FAILED", "UNCONFIRMED"))
        if f["status"] == "RETURNED":
            require(f["win32Error"] is None and f["value"] is not None)
        elif f["status"] == "FAILED":
            integer(f["win32Error"], 1)
        else:
            require(f["win32Error"] is None and f["value"] is None)
        if f["value"] is not None:
            _win_value(f["api"], f["value"])
        else:
            require(f["api"] in ("GetNativeSystemInfo", "IsWow64Process2", "ProcessIdToSessionId",
                    "CreateJobObjectW", "SetInformationJobObject", "QueryInformationJobObject", "CreateProcessAsUserW",
                    "IsProcessInJob", "GetProcessTimes", "OpenProcessToken", "GetTokenInformation", "ResumeThread",
                    "WaitForSingleObject", "GetExitCodeProcess", "TerminateJobObject", "CloseHandle",
                    "QueryPerformanceCounter", "QueryPerformanceFrequency"))
    elif kind == "IO":
        obj(f, ("kind", "callId", "lane", "operation", "qpcTicks", "status", "bytesLength", "sha256"))
        uid(f["callId"])
        decimal(f["qpcTicks"])
        require(f["lane"] in ("IN", "OUT", "ERR") and f["operation"] in ("READ", "WRITE", "CLOSE"))
        require(f["status"] in ("RETURNED", "FAILED", "UNCONFIRMED"))
        if f["bytesLength"] is not None:
            decimal(f["bytesLength"])
            hashed(f["sha256"])
        else:
            require(f["sha256"] is None and f["status"] != "RETURNED")
        if f["status"] == "UNCONFIRMED":
            require(f["bytesLength"] is None)
    elif kind == "ORIGINAL_GO":
        obj(f, ("kind", "qpcTicks", "goGrantRef"))
        decimal(f["qpcTicks"])
        _go(f["goGrantRef"])
    elif kind == "PARENT_ACK":
        obj(f, ("kind", "qpcTicks", "ack"))
        decimal(f["qpcTicks"])
        _parent(f["ack"])
    else:
        raise HostError()


def _entry(row):
    obj(row, ("event", "source", "sourceDigest"))
    event = obj(row["event"], ("eventId", "sequence", "kind", "qpcTicks", "previousDigest", "payload", "payloadDigest"))
    uid(event["eventId"])
    integer(event["sequence"], 1, 64)
    decimal(event["qpcTicks"])
    hashed(event["payloadDigest"])
    if event["previousDigest"] is not None:
        hashed(event["previousDigest"])
    require(event["kind"] in EVENT_KEYS)
    obj(event["payload"], EVENT_KEYS[event["kind"]])
    require(event["payloadDigest"] == digest({k: v for k, v in event.items() if k != "payloadDigest"}))
    source = obj(row["source"], ("version", "originDigest", "eventId", "facts"))
    integer(source["version"], 1, 1)
    hashed(source["originDigest"])
    require(source["eventId"] == event["eventId"] and type(source["facts"]) is list)
    for f in source["facts"]:
        _fact(f)
    require(row["sourceDigest"] == digest(source))


def _host_message(v):
    _measure(v)
    _common(v, "message")
    name, p = v["message"], v["payload"]
    if name == "EVENT":
        _entry(p)
    elif name == "PROGRESS":
        obj(p, ("phase", "bootstrap", "bootstrapFact"))
        require(p["phase"] in PHASES and p["bootstrap"] in ("NONE", "WAIT", "READY"))
        if p["bootstrap"] == "NONE":
            require(p["bootstrapFact"] is None)
        else:
            _fact(p["bootstrapFact"])
    elif name == "ERROR":
        error_code(obj(p, ("code",))["code"])
    elif name == "FINALIZED":
        obj(p, ("recordId", "digest", "handles", "closeCode"))
        uid(p["recordId"])
        hashed(p["digest"])
        require(p["handles"] in ("CLOSED", "UNCONFIRMED"))
        require(p["closeCode"] is None if p["handles"] == "CLOSED" else p["closeCode"] is not None)
        if p["closeCode"] is not None:
            error_code(p["closeCode"])
    elif name == "FINAL_CANDIDATE":
        evidence = obj(p, ("evidence",))["evidence"]
        _evidence(evidence)
    else:
        raise HostError("CONTROL_INVALID")
    return v


def encode_host_message(value):
    body = canonical_bytes(_host_message(value))
    return struct.pack(">I", len(body)) + body


def decode_host_message(data):
    return _copy(_host_message(_decode(data)))


def _one(facts, api, status="RETURNED"):
    found = [f for f in facts if f["kind"] == "WIN32" and f["api"] == api and f["status"] == status]
    require(len(found) == 1, "WINDOWS_SOURCE_MISMATCH")
    return found[0]


def _query_value(facts, information_class):
    found = [f["value"]["values"] for f in facts if f["kind"] == "WIN32" and f["api"] == "QueryInformationJobObject"
             and f["status"] == "RETURNED" and f["value"]["informationClass"] == information_class]
    require(len(found) == 1, "WINDOWS_SOURCE_MISMATCH")
    return found[0]



class WindowsJobHost:
    def __init__(self, capture, win32, io, clock, ids, peers):
        size = _measure(capture)
        obj(capture, ("origin", "originDigest", "frameInputDigest", "launchRef"))
        _origin(capture["origin"])
        hashed(capture["originDigest"])
        hashed(capture["frameInputDigest"])
        uid(capture["launchRef"])
        origin = capture["origin"]
        expected = {k: origin[k] for k in ("identity", "authority", "pins", "policy")}
        expected.update(nativeLimitsDigest=digest(origin["limits"]), frameInputDigest=capture["frameInputDigest"])
        require(capture["originDigest"] == digest(expected) and
                capture["frameInputDigest"] == origin["identity"]["binding"]["inputDigest"], "WINDOWS_ORIGINAL_MISMATCH")
        require(size * 2 <= origin["limits"]["parentInFlightBytes"], "WINDOWS_BUFFER_LIMIT")
        for port, names in (
            (win32, ("preflight", "createJob", "setLimits", "queryLimits", "createSuspended", "inspectRoot", "resume", "waitRoot", "queryActive", "terminateJob", "queryAccounting", "closeOwned")),
            (io, ("openStdio", "read", "write", "pollWrite", "readInput", "forward", "pollForward", "closeInput", "pollClose", "controlLost", "pending")),
            (clock, ("qpc", "frequency")), (ids, ("nextId",)), (peers, ("requireCurrent",)),
        ):
            require(all(callable(getattr(port, name, None)) for name in names), "WINDOWS_PORT_MISSING")
        self.capture = _copy(capture)
        self.origin = self.capture["origin"]
        self.policy, self.limits = self.origin["policy"], self.origin["limits"]
        self.win32, self.io, self.clock, self.ids, self.peers = win32, io, clock, ids, peers
        self.phase, self.finalized, self.candidate = "NEW", None, None
        self.held = size
        self.rows, self.by_kind, self.acks, self.messages = [], {}, set(), []
        self.fact_ids, self.event_ids = {}, set()
        self.request = None
        self.seen_commands = {}
        self.job = self.process = self.thread = self.stdio = None
        self.owned, self.close_attempted, self.close_confirmed = [], set(), set()
        self.deadline = self.join_deadline = self.frequency = None
        self.last_qpc = 0
        self.failure = self.stopped = None
        self.created_called = self.resumed = self.terminated = self.backstop = False
        self.root = self.root_exit = self.active = self.total = None
        self.os_readback = self.broker_applied = None
        self.resume_facts = []
        self.bootstrap, self.wait_fact, self.ready_fact = "NONE", None, None
        self.go = self.parent = None
        self.accounting = None
        self.write_pending = self.close_pending = None
        self.forward_pending = {}
        self.eof = {}
        self.input_closed = None
        self.input_total = 0
        self.output_total = {"OUT": 0, "ERR": 0}
        self.cleanup_facts = []
        self.cleanup_bytes = 0
        self.invalid = False
        self.uncertain_io = set()
        self.unknown_buffers = []

    def _reserve(self, n):
        require(type(n) is int and n >= 0 and self.held + n <= self.limits["parentInFlightBytes"], "WINDOWS_BUFFER_LIMIT")
        self.held += n

    def _release(self, n):
        self.held -= n
        require(self.held >= 0, "WINDOWS_BUFFER_ACCOUNTING")

    def _owned_data(self, value):
        n = _measure(value)
        self._reserve(n)
        return _copy(value)

    def _now(self):
        raw = self.clock.qpc()
        n = decimal(raw)
        require(n >= self.last_qpc, "WINDOWS_QPC_REVERSED")
        self.last_qpc = n
        return raw

    def _id(self):
        value = self.ids.nextId()
        uid(value)
        require(value not in self.event_ids, "WINDOWS_ID_REUSED")
        self.event_ids.add(value)
        return value

    def _facts(self, result):
        require(type(result) is dict and "facts" in result and type(result["facts"]) is list)
        facts = result["facts"]
        _measure(facts)
        for f in facts:
            _fact(f)
        return facts

    def _success(self, facts):
        require(all(f["kind"] != "WIN32" or (f["status"] == "RETURNED" and
                (f["api"] not in ("SetInformationJobObject", "TerminateJobObject", "CloseHandle") or f["value"]["returned"] is True))
                for f in facts), "WINDOWS_WIN32_UNCONFIRMED")

    def _remember_facts(self, facts):
        # 의미 검사 전에 원 반환을 사본으로 확보한다. 이전 단계 사본은 교체 후 해제한다.
        size = _measure(facts)
        self._reserve(size)
        saved = _copy(facts)
        self._release(self.cleanup_bytes)
        self.cleanup_facts, self.cleanup_bytes = saved, size
        return saved

    def _send(self, name, payload, request=None):
        require(self.request is not None, "CONTROL_INVALID")
        a = self.origin["authority"]
        msg = {"version": 1, "requestId": request or self.request, "originDigest": self.capture["originDigest"],
               "attemptId": a["attemptId"], "sessionId": a["sessionId"], "launchId": a["launchId"],
               "message": name, "payload": payload}
        _host_message(msg)
        self.messages.append(msg)

    def _drain(self):
        out = []
        for value in self.messages:
            n = _measure(value)
            self._reserve(n)
            try:
                out.append(_copy(value))
            finally:
                # 반환값 소유권은 bounded transport가 인수한다.
                self._release(n)
        self.messages.clear()
        return out

    def _event(self, kind, payload, facts=(), ticks=None):
        require(kind not in self.by_kind and self.candidate is None and len(self.rows) < 64, "WINDOWS_EVENT_ORDER")
        ticks = ticks if ticks is not None else self._now()
        n = decimal(ticks)
        require(not self.rows or n >= decimal(self.rows[-1]["event"]["qpcTicks"]), "WINDOWS_QPC_REVERSED")
        for f in facts:
            _fact(f)
        confirmation = None
        if kind == "CREATED_SUSPENDED":
            require(len(facts) == 2 and all(f["kind"] == "WIN32" and f["status"] == "RETURNED" for f in facts),
                    "WINDOWS_SOURCE_MISMATCH")
            call, confirmation = _one(facts, "CreateProcessAsUserW"), _one(facts, "GetProcessTimes")
            armed = self.by_kind["CREATE_ARMED"]["event"]
            require(call["callId"] == armed["payload"]["callId"] and call["callId"] != confirmation["callId"]
                    and call["qpcTicks"] == ticks and call["value"]["pid"] == payload["pid"]
                    and confirmation["value"]["processRef"] == call["value"]["processRef"]
                    and confirmation["value"]["creationFileTime100ns"] == payload["creationFileTime100ns"],
                    "WINDOWS_SOURCE_MISMATCH")
            require(decimal(call["qpcTicks"]) >= decimal(armed["qpcTicks"])
                    and decimal(confirmation["qpcTicks"]) >= n, "WINDOWS_SOURCE_TIME")
        elif self._has("CREATED_SUSPENDED"):
            first = _one(self.by_kind["CREATED_SUSPENDED"]["source"]["facts"], "GetProcessTimes")
            require(n >= decimal(first["qpcTicks"]), "WINDOWS_SOURCE_TIME")
        for f in facts:
            require(decimal(f["qpcTicks"]) <= n or f is confirmation, "WINDOWS_SOURCE_TIME")
            if "callId" in f:
                fp = digest(f)
                require(f["callId"] not in self.fact_ids or self.fact_ids[f["callId"]] == fp, "WINDOWS_SOURCE_MISMATCH")
        eid = self._id()
        body = {"eventId": eid, "sequence": len(self.rows) + 1, "kind": kind, "qpcTicks": ticks,
                "previousDigest": self.rows[-1]["event"]["payloadDigest"] if self.rows else None, "payload": payload}
        event = dict(body, payloadDigest=digest(body))
        source = {"version": 1, "originDigest": self.capture["originDigest"], "eventId": eid, "facts": list(facts)}
        row = self._owned_data({"event": event, "source": source, "sourceDigest": digest(source)})
        _entry(row)
        self.rows.append(row)
        self.by_kind[kind] = row
        if confirmation is not None:
            # 해당 생성 사건 t0를 수락한 뒤 후속 관측에만 t1 floor를 적용한다.
            self.last_qpc = max(self.last_qpc, decimal(confirmation["qpcTicks"]))
        for f in facts:
            if "callId" in f:
                self.fact_ids[f["callId"]] = digest(f)
        self._send("EVENT", row)
        return row

    def _has(self, kind):
        return kind in self.by_kind

    def _acked(self, kind):
        return self._has(kind) and self.by_kind[kind]["event"]["eventId"] in self.acks

    def _progress(self, bootstrap="NONE", fact=None):
        self._send("PROGRESS", {"phase": self.phase, "bootstrap": bootstrap, "bootstrapFact": fact})

    def view(self):
        return {"phase": self.phase, "finalized": _copy(self.finalized)}

    def advance(self, control, peerContext):
        require(self.peers.requireCurrent(peerContext, self.capture["originDigest"]) is True, "WINDOWS_PEER_INVALID")
        c = _control(control)
        require(c["originDigest"] == self.capture["originDigest"] and
                all(c[k] == self.origin["authority"][k] for k in ("attemptId", "sessionId", "launchId")), "WINDOWS_ORIGINAL_MISMATCH")
        command, payload = c["command"], c["payload"]
        if command == "QUERY":
            self.request = c["requestId"]
            if self.finalized:
                self._send("FINALIZED", self.finalized)
            else:
                self._progress()
            return self._drain()
        if command == "ACK_EVENT":
            row = next((r for r in self.rows if r["event"]["eventId"] == payload["eventId"]), None)
            require(row is not None and payload == self._manifest(row), "WINDOWS_ACK_MISMATCH")
            self.request = c["requestId"]
            old = payload["eventId"] in self.acks
            self.acks.add(payload["eventId"])
            if not old:
                self._guarded(self._continue)
            return self._drain()
        if command == "ACK_FINAL":
            require(self.candidate is not None and self.parent is not None and len(self.acks) == len(self.rows),
                    "WINDOWS_FINAL_UNCONFIRMED")
            wrapper = self._envelope()
            require(payload["digest"] == digest(wrapper), "WINDOWS_SEAL_MISMATCH")
            if self.finalized:
                require(payload == {k: self.finalized[k] for k in ("recordId", "digest")}, "WINDOWS_SEAL_MISMATCH")
            else:
                require(not self.write_pending and not self.forward_pending and not self.close_pending and not self.io.pending(),
                        "WINDOWS_IO_UNCONFIRMED")
                good = self._close_all()
                self.finalized = dict(payload, handles="CLOSED" if good else "UNCONFIRMED",
                                      closeCode=None if good else "WINDOWS_CLOSE_UNCONFIRMED")
                self.phase = "JOINED" if good else "UNCONFIRMED"
            self.request = c["requestId"]
            self._send("FINALIZED", self.finalized, c["requestId"])
            return self._drain()
        if command in self.seen_commands:
            require(payload == self.seen_commands[command], "CONTROL_INVALID")
            # 명령 중복은 원 관측/쓰기/clock을 재실행하지 않는다.
            return []
        require(self.finalized is None, "CONTROL_INVALID")
        if command == "PREPARE":
            require(self.phase == "NEW" and payload == {"origin": self.origin, "launchRef": self.capture["launchRef"]}, "CONTROL_INVALID")
        elif command == "GRANT_GO":
            require(self.phase == "PREPARED" and self._acked("BOOTSTRAP_RESUMED") and not self.stopped, "CONTROL_INVALID")
            require(payload["goGrantRef"]["jobId"] == self.origin["identity"]["binding"]["jobId"], "WINDOWS_GO_UNCONFIRMED")
        elif command == "PARENT_JOINED":
            require(self.phase != "NEW" and payload["originDigest"] == self.capture["originDigest"], "CONTROL_INVALID")
        elif command == "STOP":
            require(self.phase != "NEW", "CONTROL_INVALID")
        else:
            raise HostError("CONTROL_INVALID")
        self.request = c["requestId"]
        self.seen_commands[command] = self._owned_data(payload)
        if command == "PREPARE":
            self.phase = "PREPARING"
            self._guarded(self._prepare)
        elif command == "GRANT_GO":
            self.go = self.seen_commands[command]["goGrantRef"]
            self.phase = "GO_GRANTED"
            self._guarded(self._authorize_go)
        elif command == "PARENT_JOINED":
            self.parent = self.seen_commands[command]
            self._guarded(self._finish)
        elif command == "STOP":
            self._stop(payload["reason"])
            self._guarded(self._cleanup)
        return self._drain()

    def _guarded(self, action):
        try:
            action()
        except Exception as exc:
            if isinstance(exc, HostError) and getattr(exc, "facts", None) is not None:
                try:
                    self._remember_facts(self._facts({"facts": exc.facts}))
                except Exception:
                    # 원 실패 관측을 봉인하지 못했으므로 최종 성공으로 승격하지 않는다.
                    self.invalid = True
            self._stop(exc.code if isinstance(exc, HostError) else "WINDOWS_PORT_FAILED")
            self._terminate()

    def _terminate(self):
        if self.job is None or self.terminated or self.backstop:
            return
        if not self.created_called:
            return
        self.terminated = True
        try:
            self._success(self._facts(self.win32.terminateJob(
                self.job, self.stopped if self.stopped in REASONS else "HOST_FAILED")))
        except Exception:
            self.phase = "UNCONFIRMED"

    def _authorize_go(self):
        ticks = self._now()
        self._event("GO_AUTHORIZED", {"goGrantRef": self.go},
                    [{"kind": "ORIGINAL_GO", "qpcTicks": ticks, "goGrantRef": self.go}], ticks)

    def _prepare(self):
        self.frequency = decimal(self.clock.frequency(), True)
        self._now()
        facts = self._remember_facts(self._facts(self.win32.preflight(self.capture["launchRef"], _copy(self.origin))))
        self._success(facts)
        ticks = self._now()
        self.deadline = decimal(ticks) + (self.policy["wallTimeoutMs"] * self.frequency + 999) // 1000
        require(self.deadline <= U64, "WINDOWS_QPC_OVERFLOW")
        self._event("PRE_CREATE", {"bindingDigest": digest(self.origin["identity"]),
                                  "policyDigest": self.origin["authority"]["policyDigest"],
                                  "pinsDigest": digest(self.origin["pins"])}, facts, ticks)

    def _continue(self):
        if self.stopped or self.candidate is not None:
            self._cleanup()
            self._finish()
            return
        self._check_deadline()
        if self.stopped:
            return
        if self._acked("PRE_CREATE") and not self._has("CREATE_ARMED"):
            self._setup_job()
        elif self._acked("CREATE_ARMED") and not self.created_called:
            self._create()
        elif self._acked("CREATED_SUSPENDED") and not self._has("PREPARED"):
            self._inspect()
        elif self._acked("PREPARED") and not self.resumed:
            self.resumed = True
            self.resume_facts = self._owned_data(self._facts(self.win32.resume(self.thread)))
            self._remember_facts(self.resume_facts)
            require(_one(self.resume_facts, "ResumeThread")["value"]["previousSuspendCount"] == 1, "WINDOWS_RESUME_UNCONFIRMED")
        elif self._acked("BOOTSTRAP_RESUMED") and self.phase == "PREPARING":
            self.phase = "PREPARED"
            self._progress("WAIT", self.wait_fact)
        elif self._acked("GO_AUTHORIZED") and not self._has("GO_WRITE_ARMED"):
            self._event("GO_WRITE_ARMED", {"bytesLength": "6"})
        elif self._acked("GO_WRITE_ARMED") and not self.write_pending and not self._has("GO_WRITE"):
            self._reserve(len(GO))
            try:
                ticket = self.io.write("IN", GO)
            except Exception:
                self.invalid = True
                self.uncertain_io.add(("WRITE", "IN"))
                self.unknown_buffers.append((GO, len(GO)))
                raise
            self.write_pending = (ticket, GO, True)
        self._finish()

    def _own(self, handle):
        if handle is not None and all(handle is not h for h in self.owned):
            self.owned.append(handle)

    def _setup_job(self):
        result = self.win32.createJob()
        self.job = result.get("job")
        self._own(self.job)
        facts = self._remember_facts(self._facts(result))
        _one(facts, "CreateJobObjectW")
        self._success(facts)
        require(self.job is not None)
        facts = self._remember_facts(facts + self._facts(self.win32.setLimits(self.job, _copy(self.policy))))
        self._success(facts)
        limits = self._facts(self.win32.queryLimits(self.job))
        facts = self._remember_facts(facts + limits)
        self.os_readback = self._os_policy(limits)
        self._check_os()
        self.stdio = self.io.openStdio()
        require(type(self.stdio) is dict and set(self.stdio) == {"childHandles", "owned"})
        require(type(self.stdio["childHandles"]) is list and len(self.stdio["childHandles"]) == 3
                and type(self.stdio["owned"]) is list and len(self.stdio["owned"]) <= 8)
        require(len({id(h) for h in self.stdio["childHandles"]}) == 3
                and not any(h is None or h is self.job for h in self.stdio["childHandles"]))
        require(not any(c is p for c in self.stdio["childHandles"] for p in self.stdio["owned"]),
                "WINDOWS_STDIO_INVALID")
        for handle in self.stdio["childHandles"] + self.stdio["owned"]:
            self._own(handle)
        self._event("CREATE_ARMED", {"callId": self._id()}, facts)

    def _os_policy(self, facts):
        x, cpu = _query_value(facts, "EXTENDED_LIMITS"), _query_value(facts, "CPU_RATE")
        flags = x["BasicLimitInformation"]["LimitFlags"]
        require(flags & 0x2308 == 0x2308 and flags & 0x1800 == 0 and cpu["ControlFlags"] == 5,
                "WINDOWS_LIMITS_NOT_APPLIED")
        return {"maxProcesses": x["BasicLimitInformation"]["ActiveProcessLimit"],
                "jobCommitLimitBytes": x["JobMemoryLimit"], "processCommitLimitBytes": x["ProcessMemoryLimit"],
                "cpuRatePer10000": cpu["CpuRate"], "killOnJobClose": True, "breakawayAllowed": False}

    def _check_os(self):
        require(self.os_readback == {**{k: self.policy[k] for k in ("maxProcesses", "jobCommitLimitBytes", "processCommitLimitBytes", "cpuRatePer10000")},
                                    "killOnJobClose": True, "breakawayAllowed": False}, "WINDOWS_POLICY_MISMATCH")

    def _create(self):
        self.created_called = True
        call_id = self.by_kind["CREATE_ARMED"]["event"]["payload"]["callId"]
        result = self.win32.createSuspended(self.job, self.capture["launchRef"], self.stdio, call_id)
        self.process, self.thread = result.get("process"), result.get("thread")
        self._own(self.process)
        self._own(self.thread)
        facts = self._remember_facts(self._facts(result))
        status = result.get("status")
        require(status in ("RETURNED", "FAILED", "UNCONFIRMED"))
        f = _one(facts, "CreateProcessAsUserW", status)
        require(f["callId"] == call_id, "WINDOWS_CREATE_MISMATCH")
        # 생성 호출이 반환한 뒤 부모의 child-side pipe 끝을 먼저 닫는다.
        # 이를 최종 봉인까지 보유하면 stdout/stderr EOF를 스스로 막는다.
        closes_ok = True
        for handle in self.stdio["childHandles"]:
            closes_ok = self._close_one(handle) and closes_ok
        require(closes_ok, "WINDOWS_CHILD_END_CLOSE_UNCONFIRMED")
        if status == "FAILED" and self.process is None and self.thread is None:
            self._event("CREATE_FAILED", {"win32Error": f["win32Error"], "creationConfirmedAbsent": True}, facts)
            self._stop("WINDOWS_CREATE_FAILED")
        elif status == "RETURNED":
            require(self.process is not None and self.thread is not None, "WINDOWS_CREATE_UNCONFIRMED")
            times = _one(facts, "GetProcessTimes")
            self.root = {"pid": f["value"]["pid"], "creationFileTime100ns": times["value"]["creationFileTime100ns"]}
            self._event("CREATED_SUSPENDED", dict(self.root, assignedBy="PROC_THREAD_ATTRIBUTE_JOB_LIST"), facts, f["qpcTicks"])
        else:
            self._stop("WINDOWS_CREATE_UNCONFIRMED")

    def _verify_root_identity(self, facts):
        original = self.by_kind["CREATED_SUSPENDED"]["source"]["facts"]
        first = _one(original, "GetProcessTimes")
        times = [f for f in facts if f["kind"] == "WIN32" and f["api"] == "GetProcessTimes"]
        require(len(times) == 1 and times[0]["status"] == "RETURNED", "WINDOWS_ROOT_MISMATCH")
        current = times[0]
        require(current["callId"] not in self.fact_ids
                and current["value"]["processRef"] == _one(original, "CreateProcessAsUserW")["value"]["processRef"]
                and current["value"]["creationFileTime100ns"] == self.root["creationFileTime100ns"],
                "WINDOWS_ROOT_MISMATCH")
        require(all(decimal(f["qpcTicks"]) >= decimal(first["qpcTicks"]) for f in facts), "WINDOWS_SOURCE_TIME")

    def _inspect(self):
        facts = self._remember_facts(self._facts(self.win32.inspectRoot(self.job, self.process)))
        self._success(facts)
        self._verify_root_identity(facts)
        require(_one(facts, "IsProcessInJob")["value"]["isMember"] is True, "WINDOWS_MEMBERSHIP_UNCONFIRMED")
        tokens = []
        for name in TOKEN_CLASSES:
            matches = [f["value"] for f in facts if f["kind"] == "WIN32" and f["api"] == "GetTokenInformation"
                       and f["status"] == "RETURNED" and f["value"]["informationClass"] == name]
            require(len(matches) == 1, "WINDOWS_TOKEN_UNCONFIRMED")
            tokens.append(matches[0])
        a = self.origin["authority"]
        require(tokens[0]["values"]["sidDigest"] == a["childSidDigest"]
                and tokens[1]["values"]["sidDigest"] == a["appContainerSidDigest"]
                and tokens[2]["values"]["isAppContainer"] is True, "WINDOWS_TOKEN_MISMATCH")
        limits = self._facts(self.win32.queryLimits(self.job))
        facts = self._remember_facts(facts + limits)
        self.os_readback = self._os_policy(limits)
        self._check_os()
        self.broker_applied = {k: self.policy[k] for k in ("wallTimeoutMs", "joinTimeoutMs", "stdoutMaxBytes", "stderrMaxBytes")}
        self._verify_root_identity(facts)
        self._event("PREPARED", {"membershipConfirmed": True, "tokenDigest": digest(tokens),
                                "osReadbackDigest": digest(self.os_readback), "brokerAppliedDigest": digest(self.broker_applied)}, facts)

    def _stop(self, code):
        if self.finalized or self.stopped:
            return
        self.stopped, self.failure, self.phase = code, code, "DRAINING"
        try:
            now = self._now()
            self.frequency = self.frequency or decimal(self.clock.frequency(), True)
            self.join_deadline = decimal(now) + (self.policy["joinTimeoutMs"] * self.frequency + 999) // 1000
            if not self._has("PRE_CREATE"):
                self._event("PRE_CREATE", {"bindingDigest": digest(self.origin["identity"]),
                    "policyDigest": self.origin["authority"]["policyDigest"], "pinsDigest": digest(self.origin["pins"])}, ticks=now)
            if not self._has("CREATE_ARMED"):
                self._event("CREATE_NOT_ATTEMPTED", {"code": code})
            if not self._has("FAILED"):
                stage = "DRAIN" if self._has("ROOT_EXIT") else "GO" if self.go else "PREPARE" if self._has("CREATED_SUSPENDED") else "CREATE"
                self._event("FAILED", {"code": code, "phase": stage}, self.cleanup_facts)
        except Exception:
            self.invalid = True
            self.phase = "UNCONFIRMED"
        self._send("ERROR", {"code": code if CODE.fullmatch(code) else "WINDOWS_HOST_UNCONFIRMED"})

    def _check_deadline(self):
        n = decimal(self._now())
        if not self.stopped and self.deadline is not None and n >= self.deadline:
            self._stop("DEADLINE")
        if self.join_deadline is not None and n >= self.join_deadline and not self.backstop:
            self.backstop = True
            self.phase, self.invalid = "UNCONFIRMED", True
            if self.job is not None and id(self.job) not in self.close_attempted:
                self.close_attempted.add(id(self.job))
                try:
                    self._facts(self.win32.closeOwned(self.job))
                except Exception:
                    pass
            self._send("ERROR", {"code": "WINDOWS_JOIN_TIMEOUT"})

    def poll(self):
        if self.phase == "NEW" or self.finalized is not None:
            return []
        self._guarded(self._check_deadline)
        try:
            if self.io.controlLost():
                self._stop("CONTROL_LOST")
        except Exception:
            self._stop("CONTROL_LOST")
        # 한 경계의 예외가 독립적인 나머지 정리를 막지 않는다.
        for action in (self._cleanup, self._pump_write, self._pump_forward, self._pump_close,
                       lambda: self._pump_read("OUT"), lambda: self._pump_read("ERR"),
                       self._pump_input, self._finish):
            self._guarded(action)
        return self._drain()

    def _cleanup(self):
        if self.stopped and not self.terminated:
            self._terminate()
        if self.process is None or self.backstop:
            return
        if self._has("TREE_EMPTY"):
            return
        facts = self._facts(self.win32.waitRoot(self.process))
        wait = _one(facts, "WaitForSingleObject")["value"]["waitResult"]
        require(wait in ("SIGNALED", "TIMEOUT"), "WINDOWS_ROOT_UNCONFIRMED")
        if wait != "SIGNALED":
            return
        if not self._has("CREATED_SUSPENDED"):
            self.phase = "UNCONFIRMED"
            return
        if not self._has("ROOT_EXIT"):
            if not self._has("GO_WRITE") or self.by_kind["GO_WRITE"]["event"]["payload"]["result"] != "RETURNED":
                self._stop("WINDOWS_ROOT_BEFORE_GO")
            code = _one(facts, "GetExitCodeProcess")["value"]["exitCode"]
            self._event("ROOT_EXIT", {"exitCode": code}, facts)
            self.root_exit = {"exitCode": code, "observedQpcTicks": self.by_kind["ROOT_EXIT"]["event"]["qpcTicks"]}
            if self.join_deadline is None:
                self.join_deadline = decimal(self._now()) + (self.policy["joinTimeoutMs"] * self.frequency + 999) // 1000
        active = self._facts(self.win32.queryActive(self.job))
        b = _query_value(active, "BASIC_ACCOUNTING")
        require(b["TotalProcesses"] >= 1, "WINDOWS_ACCOUNTING_INVALID")
        self.active, self.total = b["ActiveProcesses"], str(b["TotalProcesses"])
        if self.active > 0:
            if not self.terminated:
                self.terminated = True
                self._success(self._facts(self.win32.terminateJob(self.job, "HOST_FAILED")))
            return
        self._event("TREE_EMPTY", {"activeProcesses": 0, "totalProcesses": self.total}, active)
        self.phase = "DRAINING"

    def _io_fact(self, fact, lane, operation, data):
        _fact(fact)
        require(fact["kind"] == "IO" and fact["lane"] == lane and fact["operation"] == operation
                and fact["status"] == "RETURNED" and fact["bytesLength"] == str(len(data))
                and fact["sha256"] == hashlib.sha256(data).hexdigest(), "WINDOWS_IO_MISMATCH")

    def _pump_write(self):
        if not self.write_pending or ("WRITE", "IN") in self.uncertain_io:
            return
        ticket, data, bootstrap = self.write_pending
        try:
            f = self.io.pollWrite(ticket)
        except Exception:
            self.invalid = True
            self.uncertain_io.add(("WRITE", "IN"))
            raise
        if f is None:
            return
        self.write_pending = None
        try:
            _fact(f)
            if bootstrap and not self._has("FAILED") and not self._has("ROOT_EXIT"):
                if f["status"] == "RETURNED":
                    self._io_fact(f, "IN", "WRITE", GO)
                    self._event("GO_WRITE", {"result": "RETURNED", "bytesLength": "6"}, [f], f["qpcTicks"])
                else:
                    require(f["status"] == "UNCONFIRMED" and f["lane"] == "IN" and f["operation"] == "WRITE")
                    self._event("GO_WRITE", {"result": "UNCONFIRMED", "bytesLength": "6"}, [f], f["qpcTicks"])
                    self._stop("WINDOWS_GO_UNCONFIRMED")
            elif not self.stopped:
                self._io_fact(f, "IN", "WRITE", data)
        finally:
            self._release(len(data))

    def _pump_forward(self):
        for lane, (ticket, data) in list(self.forward_pending.items()):
            if ("FORWARD", lane) in self.uncertain_io:
                continue
            try:
                value = self.io.pollForward(ticket)
            except Exception:
                self.invalid = True
                self.uncertain_io.add(("FORWARD", lane))
                raise
            if value is None:
                continue
            del self.forward_pending[lane]
            self._release(len(data))
            require(value is True, "WINDOWS_FORWARD_UNCONFIRMED")

    def _pump_close(self):
        if ("CLOSE", "IN") in self.uncertain_io:
            return
        if self.close_pending is not None:
            try:
                f = self.io.pollClose(self.close_pending)
            except Exception:
                self.invalid = True
                self.uncertain_io.add(("CLOSE", "IN"))
                raise
            if f is None:
                return
            self.close_pending = None
            self._io_fact(f, "IN", "CLOSE", b"")
            self.input_closed = self._owned_data(f)
        elif self.process is not None and (self.stopped or self.root_exit) and self.input_closed is None and not self.write_pending:
            self._start_close()

    def _start_close(self):
        if ("CLOSE", "IN") in self.uncertain_io:
            return
        try:
            self.close_pending = self.io.closeInput()
        except Exception:
            self.invalid = True
            self.uncertain_io.add(("CLOSE", "IN"))
            raise

    def _pump_read(self, lane):
        if self.process is None or lane in self.eof or lane in self.forward_pending or ("READ", lane) in self.uncertain_io:
            return
        marker = None
        if lane == "OUT" and not self.stopped:
            if self.resumed and self.wait_fact is None:
                marker = WAIT
            elif self._has("GO_WRITE") and self.ready_fact is None:
                marker = READY
            elif self.ready_fact is None:
                return
        cap = int(self.policy["stdoutMaxBytes" if lane == "OUT" else "stderrMaxBytes"])
        remaining = cap - self.output_total[lane]
        credit = min(MAX_CHUNK, max(1, remaining), len(marker) if marker is not None else MAX_CHUNK,
                     self.limits["parentInFlightBytes"] - self.held)
        if credit <= 0:
            return
        self._reserve(credit)
        retained = 0
        try:
            try:
                packet = self.io.read(lane, credit)
            except Exception:
                self.invalid = True
                self.uncertain_io.add(("READ", lane))
                self.unknown_buffers.append((None, credit))
                retained = credit
                raise
            if packet is None:
                return
            obj(packet, ("data", "eof", "fact"))
            data, eof, f = packet["data"], packet["eof"], packet["fact"]
            require(type(data) is bytes and len(data) <= credit and type(eof) is bool and (not eof or not data), "WINDOWS_IO_INVALID")
            self._io_fact(f, lane, "READ", data)
            self.output_total[lane] += len(data)
            require(self.output_total[lane] <= cap, "OUTPUT_LIMIT")
            if eof:
                self.eof[lane] = self._owned_data(f)
                if marker is not None:
                    self._stop("WINDOWS_BOOTSTRAP_EOF")
                return
            require(len(data) > 0, "WINDOWS_IO_INVALID")
            if marker is not None:
                require(data == marker, "WINDOWS_BOOTSTRAP_INVALID")
                if marker == WAIT:
                    require(self.resumed and decimal(f["qpcTicks"]) >= decimal(_one(self.resume_facts, "ResumeThread")["qpcTicks"]))
                    self.wait_fact = self._owned_data(f)
                    self._event("BOOTSTRAP_RESUMED", {"resumeReturned": True}, self.resume_facts + [f], f["qpcTicks"])
                else:
                    require(decimal(f["qpcTicks"]) >= decimal(self.by_kind["GO_WRITE"]["event"]["qpcTicks"]))
                    self.ready_fact = self._owned_data(f)
                    self._progress("READY", self.ready_fact)
                return
            # bytes는 immutable이므로 새 무제한 사본 없이 수락된 credit을 넘긴다.
            try:
                ticket = self.io.forward(lane, data)
            except Exception:
                self.invalid = True
                self.uncertain_io.add(("READ", lane))
                self.unknown_buffers.append((data, len(data)))
                retained = len(data)
                raise
            self.forward_pending[lane] = (ticket, data)
            retained = len(data)
        finally:
            self._release(credit - retained)

    def _pump_input(self):
        if not self.ready_fact or self.stopped or self.root_exit or self.write_pending or self.close_pending or self.input_closed or ("READ", "IN") in self.uncertain_io:
            return
        limit = self.limits["maxInputBytes"] + self.limits["maxMetadataBytes"] + 12
        credit = min(MAX_CHUNK, max(1, limit - self.input_total), self.limits["parentInFlightBytes"] - self.held)
        if credit <= 0:
            return
        self._reserve(credit)
        retained = 0
        try:
            try:
                packet = self.io.readInput(credit)
            except Exception:
                self.invalid = True
                self.uncertain_io.add(("READ", "IN"))
                self.unknown_buffers.append((None, credit))
                retained = credit
                raise
            if packet is None:
                return
            obj(packet, ("data", "eof"))
            data, eof = packet["data"], packet["eof"]
            require(type(data) is bytes and len(data) <= credit and type(eof) is bool and (not eof or not data), "WINDOWS_IO_INVALID")
            self.input_total += len(data)
            require(self.input_total <= limit, "INPUT_LIMIT")
            if eof:
                self._start_close()
            else:
                require(data, "WINDOWS_IO_INVALID")
                try:
                    ticket = self.io.write("IN", data)
                except Exception:
                    self.invalid = True
                    self.uncertain_io.add(("READ", "IN"))
                    self.unknown_buffers.append((data, len(data)))
                    retained = len(data)
                    raise
                self.write_pending = (ticket, data, False)
                retained = len(data)
        finally:
            self._release(credit - retained)

    def _finish(self):
        if self.candidate is not None or self.invalid or self.parent is None:
            return
        if self.write_pending or self.forward_pending or self.close_pending or self.io.pending():
            return
        no_create = self._has("CREATE_NOT_ATTEMPTED") or self._has("CREATE_FAILED")
        if not no_create:
            if not self._has("TREE_EMPTY") or self.input_closed is None or set(self.eof) != {"OUT", "ERR"}:
                return
            if not self._has("IO_JOINED"):
                facts = [self.input_closed, self.eof["OUT"], self.eof["ERR"]]
                if self.ready_fact:
                    facts.append(self.ready_fact)
                facts.append({"kind": "PARENT_ACK", "qpcTicks": self._now(), "ack": self.parent})
                self._event("IO_JOINED", {"stdinClosed": True, "stdoutEof": True, "stderrEof": True, "parentIoJoined": True}, facts)
            if not self._has("FINAL_ACCOUNTING"):
                facts = self._facts(self.win32.queryAccounting(self.job))
                b = _query_value(facts, "BASIC_AND_IO")
                basic, io = b["BasicInfo"], b["IoInfo"]
                x = _query_value(facts, "EXTENDED_LIMITS")
                require(basic["ActiveProcesses"] == 0 and str(basic["TotalProcesses"]) == self.total and basic["TotalProcesses"] >= 1,
                        "WINDOWS_ACCOUNTING_INVALID")
                freq = _one(facts, "QueryPerformanceFrequency")["value"]["frequency"]
                end = _one(facts, "QueryPerformanceCounter")["value"]["ticks"]
                require(decimal(freq, True) == self.frequency and decimal(end) >= decimal(self.by_kind["IO_JOINED"]["event"]["qpcTicks"]),
                        "WINDOWS_ACCOUNTING_INVALID")
                accounting = {"userTime100ns": basic["TotalUserTime"], "kernelTime100ns": basic["TotalKernelTime"],
                    "peakJobMemoryBytes": x["PeakJobMemoryUsed"], "peakProcessMemoryBytes": x["PeakProcessMemoryUsed"],
                    "readOperations": io["ReadOperationCount"], "writeOperations": io["WriteOperationCount"], "otherOperations": io["OtherOperationCount"],
                    "readBytes": io["ReadTransferCount"], "writeBytes": io["WriteTransferCount"], "otherBytes": io["OtherTransferCount"],
                    "totalProcesses": self.total, "startQpcTicks": self.by_kind["CREATED_SUSPENDED"]["event"]["qpcTicks"],
                    "endQpcTicks": end, "qpcFrequency": freq, "snapshotScope": "FRESH_JOB_LIFETIME", "memoryAccounting": "WIN32_JOB_MEMORY_NOT_RSS"}
                self._event("FINAL_ACCOUNTING", {"accounting": accounting}, facts, end)
                self.accounting = accounting
        if len(self.acks) != len(self.rows):
            return
        self.candidate = self._owned_data(self._evidence(no_create))
        _measure(self.candidate, MAX_RECORD, 16, 4096)
        self._send("FINAL_CANDIDATE", {"evidence": self.candidate})

    def _evidence(self, no_create):
        creation = "CREATED" if self._has("CREATED_SUSPENDED") else "FAILED" if self._has("CREATE_FAILED") else "NOT_ATTEMPTED" if self._has("CREATE_NOT_ATTEMPTED") else "UNCONFIRMED"
        go_write = self.by_kind["GO_WRITE"]["event"]["payload"]["result"] if self._has("GO_WRITE") else "UNCONFIRMED" if self._has("GO_WRITE_ARMED") else "NOT_ATTEMPTED"
        return {"version": 1, "kind": "WINDOWS_JOB_OBJECT", **{k: self.origin[k] for k in ("identity", "authority", "pins")},
                "policy": {"requested": self.policy, "osReadback": self.os_readback, "brokerApplied": self.broker_applied},
                "lifecycle": {"creation": creation, "root": self.root if creation == "CREATED" else None,
                              "goGrantRef": self.go, "goWrite": go_write, "rootExit": self.root_exit,
                              "events": [r["event"] for r in self.rows]},
                "final": {"outcome": "NO_CHILD_CREATED" if no_create else "JOB_EMPTY",
                          "activeProcesses": None if no_create else 0, "rootSignaled": not no_create,
                          "stdioJoined": not no_create, "parentIoJoined": True, "recordSealed": True,
                          "accounting": self.accounting, "failureCode": self.failure}}

    @staticmethod
    def _manifest(row):
        return {"eventId": row["event"]["eventId"], "payloadDigest": row["event"]["payloadDigest"], "sourceDigest": row["sourceDigest"]}

    def _envelope(self):
        return {"version": 1, "originDigest": self.capture["originDigest"], "evidence": self.candidate,
                "entries": [self._manifest(row) for row in self.rows], "parentJoinAck": self.parent}

    def _close_all(self):
        good = True
        # Job handle은 마지막까지 유지한다.
        ordered = [h for h in reversed(self.owned) if h is not self.job] + ([self.job] if self.job is not None else [])
        for h in ordered:
            good = self._close_one(h) and good
        return good

    def _close_one(self, handle):
        if id(handle) in self.close_confirmed:
            return True
        if id(handle) in self.close_attempted:
            return False
        self.close_attempted.add(id(handle))
        try:
            facts = self._facts(self.win32.closeOwned(handle))
            require(_one(facts, "CloseHandle")["value"]["returned"] is True)
            self.close_confirmed.add(id(handle))
            return True
        except Exception:
            return False



def _sdk_types(c):
    """Windows x64 SDK 배치. 실제 ABI 대조는 별도 물리 검증 사항이다."""
    dword, word, size, ptr = c.c_uint32, c.c_uint16, c.c_size_t, c.c_void_p

    class IO_COUNTERS(c.Structure):
        _fields_ = [(name, c.c_uint64) for name in IO_KEYS]

    class BASIC_LIMIT(c.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", c.c_int64), ("PerJobUserTimeLimit", c.c_int64),
            ("LimitFlags", dword), ("MinimumWorkingSetSize", size), ("MaximumWorkingSetSize", size),
            ("ActiveProcessLimit", dword), ("Affinity", size), ("PriorityClass", dword), ("SchedulingClass", dword)]

    class EXTENDED_LIMIT(c.Structure):
        _fields_ = [("BasicLimitInformation", BASIC_LIMIT), ("IoInfo", IO_COUNTERS),
                    ("ProcessMemoryLimit", size), ("JobMemoryLimit", size),
                    ("PeakProcessMemoryUsed", size), ("PeakJobMemoryUsed", size)]

    class BASIC_ACCOUNTING(c.Structure):
        _fields_ = [(name, c.c_int64 if i < 4 else dword) for i, name in enumerate(BASIC_KEYS)]

    class BASIC_AND_IO(c.Structure):
        _fields_ = [("BasicInfo", BASIC_ACCOUNTING), ("IoInfo", IO_COUNTERS)]

    class CPU_RATE(c.Structure):
        _fields_ = [("ControlFlags", dword), ("CpuRate", dword)]

    class FILETIME(c.Structure):
        _fields_ = [("low", dword), ("high", dword)]

    class STARTUPINFO(c.Structure):
        _fields_ = [("cb", dword), ("lpReserved", c.c_wchar_p), ("lpDesktop", c.c_wchar_p), ("lpTitle", c.c_wchar_p)]
        _fields_ += [(name, dword) for name in ("dwX", "dwY", "dwXSize", "dwYSize", "dwXCountChars", "dwYCountChars", "dwFillAttribute", "dwFlags")]
        _fields_ += [("wShowWindow", word), ("cbReserved2", word), ("lpReserved2", ptr),
                     ("hStdInput", ptr), ("hStdOutput", ptr), ("hStdError", ptr)]

    class STARTUPINFOEX(c.Structure):
        _fields_ = [("StartupInfo", STARTUPINFO), ("lpAttributeList", ptr)]

    class PROCESS_INFORMATION(c.Structure):
        _fields_ = [("hProcess", ptr), ("hThread", ptr), ("dwProcessId", dword), ("dwThreadId", dword)]

    class SID_AND_ATTRIBUTES(c.Structure):
        _fields_ = [("Sid", ptr), ("Attributes", dword)]

    class SECURITY_CAPABILITIES(c.Structure):
        _fields_ = [("AppContainerSid", ptr), ("Capabilities", c.POINTER(SID_AND_ATTRIBUTES)),
                    ("CapabilityCount", dword), ("Reserved", dword)]

    class SYSTEM_INFO(c.Structure):
        _fields_ = [("architecture", word), ("reserved", word), ("pageSize", dword),
                    ("minimumAddress", ptr), ("maximumAddress", ptr), ("activeMask", size),
                    ("processors", dword), ("processorType", dword), ("allocationGranularity", dword),
                    ("processorLevel", word), ("processorRevision", word)]

    return {name: value for name, value in locals().items() if isinstance(value, type) and issubclass(value, c.Structure)}


class LaunchCapability:
    """신뢰 resolver가 제공하는 원 launch. 이 객체를 wire JSON에서 만들지 않는다.

    validateCurrent는 실제 pin/환경/owner·session/ACL/egress 검증을 완료한
    원 capture digest를 반환해야 한다. 정책/계정이나 ACL을 여기서 만들지 않는다.
    token과 SID 메모리의 실제 수명은 resolver가 driver 종료까지 유지한다.
    """
    def __init__(self, *, launch_ref, origin_digest, executable, command_line,
                 directory, environment, token, appcontainer_sid, windows_session_id,
                 validate_current):
        self.launch_ref = launch_ref
        self.origin_digest = origin_digest
        self.executable = executable
        self.command_line = command_line
        self.directory = directory
        self.environment = environment
        self.token = token
        self.appcontainer_sid = appcontainer_sid
        self.windows_session_id = windows_session_id
        self.validate_current = validate_current


class _OwnedHandle:
    __slots__ = ("value", "ref", "kind", "closed")

    def __init__(self, value, ref, kind):
        self.value, self.ref, self.kind, self.closed = value, ref, kind, False


def create_ctypes_driver(launch_resolver, clock, ids, *, enable_real=False):
    """명시적인 실제 실행 진입점. import/actor/fake 시험은 이를 호출하지 않는다."""
    require(enable_real is True, "WINDOWS_REAL_DRIVER_DISABLED")
    import sys
    import ctypes as c
    require(sys.platform == "win32" and c.sizeof(c.c_void_p) == 8, "WINDOWS_X64_REQUIRED")
    require(callable(launch_resolver) and callable(getattr(clock, "qpc", None))
            and callable(getattr(ids, "nextId", None)), "WINDOWS_PORT_MISSING")
    kernel = c.WinDLL("kernel32", use_last_error=True)
    advapi = c.WinDLL("advapi32", use_last_error=True)
    return _CtypesWin32(c, kernel, advapi, launch_resolver, clock, ids)


class _CtypesWin32:
    """Win32 원 반환값을 변환한다. 자동 spawn/재시도/기본 launch가 없다."""

    def __init__(self, c, kernel, advapi, resolver, clock, ids):
        self.c, self.kernel, self.advapi = c, kernel, advapi
        self.resolver, self.clock, self.ids = resolver, clock, ids
        self.t = _sdk_types(c)
        self.launch, self.origin = None, None
        self.owned = []
        self.token_cleanup_unconfirmed = False
        self.observed_facts = None
        self._bind()

    def _bind(self):
        c, k, a, t = self.c, self.kernel, self.advapi, self.t
        p, d, b, s = c.c_void_p, c.c_uint32, c.c_int32, c.c_size_t
        bindings = [
            (k, "CreateJobObjectW", [p, c.c_wchar_p], p),
            (k, "SetInformationJobObject", [p, c.c_int, p, d], b),
            (k, "QueryInformationJobObject", [p, c.c_int, p, d, c.POINTER(d)], b),
            (k, "IsProcessInJob", [p, p, c.POINTER(b)], b),
            (k, "GetProcessTimes", [p] + [c.POINTER(t["FILETIME"])] * 4, b),
            (k, "ResumeThread", [p], d), (k, "WaitForSingleObject", [p, d], d),
            (k, "GetExitCodeProcess", [p, c.POINTER(d)], b),
            (k, "TerminateJobObject", [p, d], b), (k, "CloseHandle", [p], b),
            (k, "GetNativeSystemInfo", [c.POINTER(t["SYSTEM_INFO"])], None),
            (k, "IsWow64Process2", [p, c.POINTER(c.c_uint16), c.POINTER(c.c_uint16)], b),
            (k, "GetCurrentProcess", [], p), (k, "GetCurrentProcessId", [], d),
            (k, "ProcessIdToSessionId", [d, c.POINTER(d)], b),
            (k, "QueryPerformanceCounter", [c.POINTER(c.c_int64)], b),
            (k, "QueryPerformanceFrequency", [c.POINTER(c.c_int64)], b),
            (k, "InitializeProcThreadAttributeList", [p, d, d, c.POINTER(s)], b),
            (k, "UpdateProcThreadAttribute", [p, d, s, p, s, p, c.POINTER(s)], b),
            (k, "DeleteProcThreadAttributeList", [p], None),
            (a, "CreateProcessAsUserW", [p, c.c_wchar_p, c.c_wchar_p, p, p, b, d, p, c.c_wchar_p,
                                       c.POINTER(t["STARTUPINFO"]), c.POINTER(t["PROCESS_INFORMATION"])], b),
            (a, "OpenProcessToken", [p, d, c.POINTER(p)], b),
            (a, "GetTokenInformation", [p, c.c_int, p, d, c.POINTER(d)], b),
            (a, "IsValidSid", [p], b), (a, "GetLengthSid", [p], d),
        ]
        for dll, name, args, result in bindings:
            fn = getattr(dll, name)
            fn.argtypes, fn.restype = args, result

    def _id(self):
        value = self.ids.nextId()
        uid(value)
        return value

    def _call(self, api, args, convert, ok=None, call_id=None):
        c = self.c
        call_id = call_id or self._id()
        fn = getattr(self.advapi if api in ("CreateProcessAsUserW", "OpenProcessToken", "GetTokenInformation") else self.kernel, api)
        c.set_last_error(0)
        result = fn(*args)
        # QPC 등 다음 API보다 먼저 저장한다.
        error = c.get_last_error()
        success = bool(result) if ok is None else ok(result)
        # 생성 성공 handle을 먼저 인수한다. 후속 QPC 실패가 소유권을 잃게 하지 않는다.
        value = convert(result) if success else None
        ticks = self.clock.qpc()
        decimal(ticks)
        status = "RETURNED" if success else "FAILED" if 0 < error <= 0xffffffff else "UNCONFIRMED"
        fact = {"kind": "WIN32", "callId": call_id, "api": api, "qpcTicks": ticks,
                "status": status, "win32Error": error if status == "FAILED" else None,
                "value": value}
        if self.observed_facts is not None:
            # 의미 검사와 finally의 후속 호출 전에 원 완료 관측을 예산 안에 보관한다.
            require(len(self.observed_facts) < 64, "WINDOWS_BUFFER_LIMIT")
            _measure(self.observed_facts + [fact], MAX_RECORD, 16, 4096)
            self.observed_facts.append(_copy(fact))
        return result, fact

    def _observe(self, action, *args):
        require(self.observed_facts is None, "WINDOWS_OBSERVATION_REENTRY")
        self.observed_facts = []
        try:
            return action(*args)
        except Exception as exc:
            error = exc if isinstance(exc, HostError) else HostError("WINDOWS_PORT_FAILED")
            # 같은 list의 소유권을 예외로 전달한다. QPC가 없던 호출을 가짜 fact로 만들지 않는다.
            error.facts = self.observed_facts
            raise error
        finally:
            self.observed_facts = None

    def _handle(self, h, kind=None):
        require(type(h) is _OwnedHandle and h in self.owned and not h.closed and h.value,
                "WINDOWS_HANDLE_UNCONFIRMED")
        if kind:
            require(h.kind == kind, "WINDOWS_HANDLE_UNCONFIRMED")
        return h.value

    def _own(self, value, kind):
        require(value, "WINDOWS_HANDLE_UNCONFIRMED")
        h = _OwnedHandle(value, self._id(), kind)
        self.owned.append(h)
        return h

    def _require_returned(self, facts):
        require(all(f["status"] == "RETURNED" for f in facts), "WINDOWS_WIN32_FAILED")

    def _sid_digest(self, pointer):
        require(pointer and self.advapi.IsValidSid(pointer), "WINDOWS_TOKEN_INVALID")
        length = self.advapi.GetLengthSid(pointer)
        require(8 <= length <= 68, "WINDOWS_TOKEN_INVALID")
        return hashlib.sha256(self.c.string_at(pointer, length)).hexdigest()

    def _tokens(self, token):
        c = self.c
        facts = []
        classes = ((1, "TOKEN_USER"), (31, "TOKEN_APPCONTAINER_SID"), (29, "TOKEN_IS_APPCONTAINER"),
                   (25, "TOKEN_INTEGRITY_LEVEL"), (12, "TOKEN_SESSION_ID"))
        for number, name in classes:
            needed = c.c_uint32()
            c.set_last_error(0)
            ok = self.advapi.GetTokenInformation(token, number, None, 0, c.byref(needed))
            error = c.get_last_error()
            require(not ok and error == 122 and 0 < needed.value <= 65536, "WINDOWS_TOKEN_INVALID")
            buf = c.create_string_buffer(needed.value)
            def convert(_result, name=name, buf=buf):
                if name in ("TOKEN_IS_APPCONTAINER", "TOKEN_SESSION_ID"):
                    n = c.cast(buf, c.POINTER(c.c_uint32)).contents.value
                    require(name != "TOKEN_IS_APPCONTAINER" or n in (0, 1))
                    values = {"isAppContainer": n == 1} if name == "TOKEN_IS_APPCONTAINER" else {"sessionId": n}
                else:
                    pointer = c.cast(buf, c.POINTER(c.c_void_p)).contents.value
                    values = {"sidDigest": self._sid_digest(pointer)}
                return {"informationClass": name, "values": values}
            _, fact = self._call("GetTokenInformation", [token, number, buf, needed.value, c.byref(needed)], convert)
            facts.append(fact)
            self._require_returned([fact])
        return facts

    def preflight(self, launchRef, origin):
        return self._observe(self._preflight, launchRef, origin)

    def _preflight(self, launchRef, origin):
        launch = self.resolver(launchRef, origin)
        require(type(launch) is LaunchCapability and launch.launch_ref == launchRef, "WINDOWS_LAUNCH_UNCONFIRMED")
        origin_digest = digest({k: origin[k] for k in ("identity", "authority", "pins", "policy")} |
                               {"nativeLimitsDigest": digest(origin["limits"]),
                                "frameInputDigest": origin["identity"]["binding"]["inputDigest"]})
        require(launch.origin_digest == origin_digest and callable(launch.validate_current)
                and launch.validate_current() == origin_digest, "WINDOWS_LAUNCH_UNCONFIRMED")
        require(all(type(v) is str and v and "\x00" not in v for v in
                    (launch.executable, launch.command_line, launch.directory)), "WINDOWS_LAUNCH_UNCONFIRMED")
        require(type(launch.environment) is str and launch.environment.endswith("\x00\x00") and len(launch.environment) <= 32767,
                "WINDOWS_LAUNCH_UNCONFIRMED")
        require(launch.token and launch.appcontainer_sid, "WINDOWS_TOKEN_INVALID")
        integer(launch.windows_session_id)
        c, k = self.c, self.kernel
        info = self.t["SYSTEM_INFO"]()
        _, system = self._call("GetNativeSystemInfo", [c.byref(info)], lambda _: {"processorArchitecture": info.architecture}, lambda _: True)
        pm, nm = c.c_uint16(), c.c_uint16()
        _, machine = self._call("IsWow64Process2", [k.GetCurrentProcess(), c.byref(pm), c.byref(nm)],
                                lambda _: {"processMachine": pm.value, "nativeMachine": nm.value})
        session = c.c_uint32()
        _, session_fact = self._call("ProcessIdToSessionId", [k.GetCurrentProcessId(), c.byref(session)], lambda _: {"sessionId": session.value})
        facts = [system, machine, session_fact]
        self._require_returned(facts)
        require(info.architecture == 9 and pm.value == 0 and nm.value == 0x8664, "WINDOWS_X64_REQUIRED")
        require(session.value == launch.windows_session_id, "WINDOWS_SESSION_MISMATCH")
        tokens = self._tokens(launch.token)
        values = {f["value"]["informationClass"]: f["value"]["values"] for f in tokens}
        require(values["TOKEN_USER"]["sidDigest"] == origin["authority"]["childSidDigest"]
                and values["TOKEN_APPCONTAINER_SID"]["sidDigest"] == origin["authority"]["appContainerSidDigest"]
                and values["TOKEN_IS_APPCONTAINER"]["isAppContainer"] is True
                and values["TOKEN_SESSION_ID"]["sessionId"] == launch.windows_session_id,
                "WINDOWS_TOKEN_MISMATCH")
        require(self._sid_digest(launch.appcontainer_sid) == origin["authority"]["appContainerSidDigest"], "WINDOWS_TOKEN_MISMATCH")
        self.launch, self.origin = launch, _copy(origin)
        return {"facts": facts + tokens}

    def createJob(self):
        require(self.launch is not None, "WINDOWS_LAUNCH_UNCONFIRMED")
        h = None
        def convert(result):
            nonlocal h
            h = self._own(result, "JOB")
            return {"objectRef": h.ref}
        try:
            _, fact = self._call("CreateJobObjectW", [None, None], convert)
        except Exception:
            if h is not None:
                return {"job": h, "facts": []}
            raise
        return {"job": h, "facts": [fact]}

    def setLimits(self, job, policy):
        c = self.c
        extended = self.t["EXTENDED_LIMIT"]()
        extended.BasicLimitInformation.LimitFlags = 0x2308
        extended.BasicLimitInformation.ActiveProcessLimit = policy["maxProcesses"]
        extended.ProcessMemoryLimit = decimal(policy["processCommitLimitBytes"], True)
        extended.JobMemoryLimit = decimal(policy["jobCommitLimitBytes"], True)
        cpu = self.t["CPU_RATE"](5, policy["cpuRatePer10000"])
        facts = []
        for number, value in ((9, extended), (15, cpu)):
            _, fact = self._call("SetInformationJobObject",
                                [self._handle(job, "JOB"), number, c.byref(value), c.sizeof(value)],
                                lambda _: {"returned": True})
            facts.append(fact)
            if fact["status"] != "RETURNED":
                break
        return {"facts": facts}

    def _struct_value(self, value, name):
        if name == "BASIC_ACCOUNTING":
            return {k: str(getattr(value, k)) if i < 4 else int(getattr(value, k)) for i, k in enumerate(BASIC_KEYS)}
        if name == "IO_COUNTERS":
            return {k: str(getattr(value, k)) for k in IO_KEYS}
        if name == "BASIC_AND_IO":
            return {"BasicInfo": self._struct_value(value.BasicInfo, "BASIC_ACCOUNTING"),
                    "IoInfo": self._struct_value(value.IoInfo, "IO_COUNTERS")}
        if name == "CPU_RATE":
            return {"ControlFlags": int(value.ControlFlags), "CpuRate": int(value.CpuRate)}
        b = value.BasicLimitInformation
        numbers = ("LimitFlags", "ActiveProcessLimit", "PriorityClass", "SchedulingClass")
        return {"BasicLimitInformation": {k: int(getattr(b, k)) if k in numbers else str(getattr(b, k)) for k in EXT_BASIC_KEYS},
                "IoInfo": self._struct_value(value.IoInfo, "IO_COUNTERS"),
                **{k: str(getattr(value, k)) for k in ("ProcessMemoryLimit", "JobMemoryLimit", "PeakProcessMemoryUsed", "PeakJobMemoryUsed")}}

    def _query(self, job, information):
        mappings = {"EXTENDED_LIMITS": (9, "EXTENDED_LIMIT"), "CPU_RATE": (15, "CPU_RATE"),
                    "BASIC_ACCOUNTING": (1, "BASIC_ACCOUNTING"), "BASIC_AND_IO": (8, "BASIC_AND_IO")}
        number, name = mappings[information]
        value, length = self.t[name](), self.c.c_uint32()
        _, fact = self._call("QueryInformationJobObject",
                            [self._handle(job, "JOB"), number, self.c.byref(value), self.c.sizeof(value), self.c.byref(length)],
                            lambda _: {"informationClass": information, "values": self._struct_value(value, name)})
        return fact

    def queryLimits(self, job):
        return {"facts": [self._query(job, "EXTENDED_LIMITS"), self._query(job, "CPU_RATE")]}

    def createSuspended(self, job, launchRef, stdio, callId):
        c, k, launch = self.c, self.kernel, self.launch
        require(launch and launch.launch_ref == launchRef and launch.validate_current() == launch.origin_digest,
                "WINDOWS_LAUNCH_UNCONFIRMED")
        uid(callId)
        # 실제 HostIo port는 같은 driver가 소유한 세 HANDLE만 제공해야 한다.
        handles = stdio["childHandles"]
        require(type(handles) is list and len(handles) == 3 and len({id(h) for h in handles}) == 3,
                "WINDOWS_STDIO_INVALID")
        raw = [self._handle(h, "PIPE") for h in handles]
        size = c.c_size_t()
        c.set_last_error(0)
        first = k.InitializeProcThreadAttributeList(None, 3, 0, c.byref(size))
        err = c.get_last_error()
        require(not first and err == 122 and 0 < size.value <= MAX_CONTROL, "WINDOWS_ATTRIBUTES_UNCONFIRMED")
        storage = c.create_string_buffer(size.value)
        require(k.InitializeProcThreadAttributeList(storage, 3, 0, c.byref(size)), "WINDOWS_ATTRIBUTES_UNCONFIRMED")
        process = thread = None
        facts = []
        try:
            jobs = (c.c_void_p * 1)(self._handle(job, "JOB"))
            pipes = (c.c_void_p * 3)(*raw)
            caps = self.t["SECURITY_CAPABILITIES"](launch.appcontainer_sid, None, 0, 0)
            # 상속 대상은 stdio뿐이다. Job은 JOB_LIST로 생성 순간 편입된다.
            for attribute, value in ((0x0002000D, jobs), (0x00020002, pipes), (0x00020009, caps)):
                c.set_last_error(0)
                success = k.UpdateProcThreadAttribute(storage, 0, attribute, c.byref(value), c.sizeof(value), None, None)
                error = c.get_last_error()
                require(success, "WINDOWS_ATTRIBUTE_FAILED")
            startup = self.t["STARTUPINFOEX"]()
            startup.StartupInfo.cb = c.sizeof(startup)
            startup.StartupInfo.dwFlags = 0x100
            startup.StartupInfo.hStdInput, startup.StartupInfo.hStdOutput, startup.StartupInfo.hStdError = raw
            startup.lpAttributeList = c.cast(storage, c.c_void_p)
            result = self.t["PROCESS_INFORMATION"]()
            command = c.create_unicode_buffer(launch.command_line)
            environment = c.create_unicode_buffer(launch.environment)
            def convert(_):
                nonlocal process, thread
                process = self._own(result.hProcess, "PROCESS")
                thread = self._own(result.hThread, "THREAD")
                return {"processRef": process.ref, "threadRef": thread.ref, "pid": int(result.dwProcessId)}
            try:
                _, created = self._call("CreateProcessAsUserW",
                    [launch.token, launch.executable, command, None, None, True, 0x00080000 | 0x00000400 | 0x4,
                     environment, launch.directory, c.cast(c.byref(startup), c.POINTER(self.t["STARTUPINFO"])), c.byref(result)],
                    convert, call_id=callId)
                facts.append(created)
                if created["status"] == "RETURNED":
                    facts.append(self._process_times(process))
            except Exception:
                # DLL 호출 성공 후의 관측 유실은 확정 미생성이 아니다.
                return {"status": "UNCONFIRMED", "process": process, "thread": thread, "facts": facts}
            return {"status": created["status"], "process": process, "thread": thread, "facts": facts}
        finally:
            k.DeleteProcThreadAttributeList(storage)

    def _process_times(self, process):
        c, t = self.c, self.t
        creation, exit_time, kernel, user = (t["FILETIME"]() for _ in range(4))
        def dec(value):
            return str((value.high << 32) | value.low)
        _, fact = self._call("GetProcessTimes",
                            [self._handle(process, "PROCESS"), c.byref(creation), c.byref(exit_time), c.byref(kernel), c.byref(user)],
                            lambda _: {"processRef": process.ref, "creationFileTime100ns": dec(creation), "userTime100ns": dec(user), "kernelTime100ns": dec(kernel)})
        return fact

    def inspectRoot(self, job, process):
        return self._observe(self._inspect_root, job, process)

    def _inspect_root(self, job, process):
        c = self.c
        member = c.c_int32()
        _, membership = self._call("IsProcessInJob", [self._handle(process, "PROCESS"), self._handle(job, "JOB"), c.byref(member)],
                                  lambda _: {"isMember": bool(member.value)})
        token = c.c_void_p()
        owned_token = None
        def convert(_):
            nonlocal owned_token
            owned_token = self._own(token.value, "TOKEN")
            return {"objectRef": owned_token.ref}
        facts = [membership]
        try:
            # 성공 handle 인수 뒤 QPC/FILETIME 관측 예외도 이 정리 범위에 포함한다.
            _, opened = self._call("OpenProcessToken", [self._handle(process, "PROCESS"), 0x8, c.byref(token)], convert)
            facts.append(opened)
            facts.append(self._process_times(process))
            self._require_returned(facts)
            facts += self._tokens(token.value)
        finally:
            if owned_token:
                try:
                    closed = self.closeOwned(owned_token)["facts"]
                    facts += closed
                    if not all(f["status"] == "RETURNED" and f["value"]["returned"] is True for f in closed):
                        self.token_cleanup_unconfirmed = True
                except Exception:
                    self.token_cleanup_unconfirmed = True
                    raise
        return {"facts": facts}

    def resume(self, thread):
        _, fact = self._call("ResumeThread", [self._handle(thread, "THREAD")],
                            lambda result: {"previousSuspendCount": int(result)}, lambda result: result != 0xffffffff)
        return {"facts": [fact]}

    def waitRoot(self, process):
        _, waited = self._call("WaitForSingleObject", [self._handle(process, "PROCESS"), 0],
                              lambda result: {"waitResult": "SIGNALED" if result == 0 else "TIMEOUT"},
                              lambda result: result in (0, 258))
        facts = [waited]
        if waited["status"] == "RETURNED" and waited["value"]["waitResult"] == "SIGNALED":
            code = self.c.c_uint32()
            _, exited = self._call("GetExitCodeProcess", [self._handle(process, "PROCESS"), self.c.byref(code)],
                                  lambda _: {"exitCode": int(code.value)})
            facts.append(exited)
        return {"facts": facts}

    def terminateJob(self, job, reason):
        require(reason in REASONS)
        _, fact = self._call("TerminateJobObject", [self._handle(job, "JOB"), 1], lambda _: {"returned": True})
        return {"facts": [fact]}

    def queryActive(self, job):
        return {"facts": [self._query(job, "BASIC_ACCOUNTING")]}

    def queryAccounting(self, job):
        facts = [self._query(job, "BASIC_AND_IO"), self._query(job, "EXTENDED_LIMITS")]
        frequency, ticks = self.c.c_int64(), self.c.c_int64()
        _, freq = self._call("QueryPerformanceFrequency", [self.c.byref(frequency)],
                            lambda _: {"frequency": str(frequency.value)})
        _, counter = self._call("QueryPerformanceCounter", [self.c.byref(ticks)],
                               lambda _: {"ticks": str(ticks.value)})
        # counter.value는 바로 그 API의 원 관측값이다.
        if counter["status"] == "RETURNED":
            counter["qpcTicks"] = counter["value"]["ticks"]
        return {"facts": facts + [freq, counter]}

    def closeOwned(self, handle):
        value = self._handle(handle)
        def closed(_):
            handle.closed = True
            return {"returned": True}
        _, fact = self._call("CloseHandle", [value], closed)
        if handle.kind == "JOB" and self.token_cleanup_unconfirmed:
            # Job 자체의 반환은 그대로 보존한다. 내부 token까지 정리됐다는 뜻은 아니다.
            error = HostError("WINDOWS_TOKEN_CLOSE_UNCONFIRMED")
            error.facts = [fact]
            raise error
        return {"facts": [fact]}

