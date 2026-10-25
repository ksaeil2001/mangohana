"""W2-B: 실제 Windows 포트 없이 원 host의 동작을 검사한다."""

import builtins
import copy
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import types
import unittest
from contextlib import ExitStack
from unittest import mock


HOST_PATH = Path(__file__).resolve().parents[2] / "packages/native/src/windows-job-host.py"
# 검사 loader의 source 읽기는 허용한다. 제품 실행부터 실제 I/O를 차단한다.
HOST_SOURCE = HOST_PATH.read_text(encoding="utf-8-sig") if HOST_PATH.is_file() else None
QUERY_BODY = (
    b'{"attemptId":"00000000-0000-4000-8000-000000000002","command":"QUERY",'
    b'"launchId":"00000000-0000-4000-8000-000000000004","originDigest":"'
    b'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
    b'"payload":{},"requestId":"00000000-0000-4000-8000-000000000001",'
    b'"sessionId":"00000000-0000-4000-8000-000000000003","version":1}'
)
QUERY_WIRE = b"\x00\x00\x01\x49" + QUERY_BODY
QUERY_BODY_SHA = "d0fc90a6d5e7e9bf64d8eefe139be5c78d6e4209df5105ced51d518019adb18a"
QUERY_WIRE_SHA = "08e248a6f55ebe66272dad17c4655be775fc93a4844a8f757c160ac4b11f3eb3"


def independent_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def independent_digest(value):
    return hashlib.sha256(independent_bytes(value)).hexdigest()


class HostTestCase(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(HOST_SOURCE,
                             "W2-B 실제 windows-job-host.py가 아직 없어 host 동작을 실행할 수 없습니다")
        self.port_attempts = []
        self.guards = ExitStack()
        self.addCleanup(self.guards.close)

        def forbidden(label):
            def stop(*args, **kwargs):
                self.port_attempts.append(label)
                raise AssertionError("REAL_PRODUCT_PORT_FORBIDDEN: " + label)
            return stop

        ports = [
            (builtins, "open"), (io, "open"), (io, "FileIO"),
            (os, "open"), (os, "pipe"), (os, "system"), (os, "startfile"),
            (os, "spawnv"), (os, "spawnve"), (os, "spawnl"), (os, "spawnle"),
            (socket, "socket"), (socket, "socketpair"), (socket, "create_connection"),
            (subprocess, "Popen"), (subprocess, "run"), (subprocess, "call"),
            (subprocess, "check_call"), (subprocess, "check_output"),
            (ctypes, "WinDLL"), (ctypes, "CDLL"), (ctypes, "OleDLL"),
            (ctypes, "PyDLL"),
        ]
        for owner, name in ports:
            if hasattr(owner, name):
                self.guards.enter_context(mock.patch.object(owner, name,
                    side_effect=forbidden(owner.__name__ + "." + name)))
        for name in ("windll", "cdll", "oledll", "pydll"):
            if hasattr(ctypes, name):
                loader = getattr(ctypes, name)
                self.guards.enter_context(mock.patch.object(loader, "_dlltype",
                    side_effect=forbidden("ctypes." + name)))
        self.api = types.ModuleType("windows_job_host_under_test")
        self.api.__file__ = str(HOST_PATH)
        self.guards.enter_context(mock.patch.dict(sys.modules,
                                  {self.api.__name__: self.api}))
        exec(compile(HOST_SOURCE, str(HOST_PATH), "exec"), self.api.__dict__)

    def tearDown(self):
        self.assertEqual(self.port_attempts, [], "실제 포트 호출을 삼켜도 검사는 실패해야 한다")

    def assert_host_error(self, action):
        with self.assertRaises(self.api.HostError) as raised:
            action()
        self.assertIsInstance(raised.exception, ValueError)
        self.assertEqual(raised.exception.next_action, "WAIT")
        self.assertRegex(raised.exception.code, r"^[A-Z][A-Z0-9_]{0,127}$")
        return raised.exception


class CodecTests(HostTestCase):
    def test_w2_07_query_matches_ts_literal_and_independent_fixed_sha(self):
        query = json.loads(QUERY_BODY)
        self.assertEqual(self.api.encode_control(query), QUERY_WIRE)
        self.assertEqual(self.api.decode_control(QUERY_WIRE), query)
        self.assertEqual(self.api.canonical_bytes(query), QUERY_BODY)
        self.assertEqual(self.api.digest(query), QUERY_BODY_SHA)
        self.assertEqual(hashlib.sha256(QUERY_WIRE).hexdigest(), QUERY_WIRE_SHA)

    def test_w2_07_unknown_command_cannot_reach_an_actor(self):
        query = json.loads(QUERY_BODY)
        query["command"] = "SPAWN"
        self.assert_host_error(lambda: self.api.encode_control(query))

    def test_w2_07_bool_is_not_version_integer(self):
        query = json.loads(QUERY_BODY)
        query["version"] = True
        self.assert_host_error(lambda: self.api.encode_control(query))

    def test_w2_08_import_never_loads_dll_or_creates_product_io(self):
        self.assertTrue(callable(self.api.WindowsJobHost))
        self.assertEqual(self.port_attempts, [])




def uid(number):
    return "00000000-0000-4000-8000-" + format(number, "012x")


def capture_fixture():
    """W2-A input()/fixture()의 합성 원 tuple. 제품 helper는 사용하지 않는다."""
    h = independent_digest
    limits = {"maxMetadataBytes": 4096, "maxInputBytes": 16384, "maxOutputBytes": 16384,
              "maxItems": 8, "childMemoryBytes": 16777216, "maxProcesses": 4,
              "timeoutMs": 1000, "terminationWaitMs": 500, "parentInFlightBytes": 131072}
    blob = b"synthetic image bytes"
    job = {"version": 1, "jobId": uid(3), "task": "DECODE_IMAGE", "taskVersion": "native-pure-v1",
           "profileDigest": h("profile"), "metadata": {"title": "한국어 합성 입력"},
           "blobs": [{"id": "source", "byteLength": len(blob), "sha256": hashlib.sha256(blob).hexdigest()}]}
    job["inputDigest"] = h(job)
    identity = {"binding": {"accountId": uid(1), "capacityReservationId": uid(2), "jobId": uid(3),
                           "parentInstanceId": uid(4), "inputDigest": job["inputDigest"],
                           "profileDigest": job["profileDigest"], "kernelDigest": h("kernel")},
                "intentDigest": h("intent"),
                "sourceInput": {"executionId": uid(5), "inputEvidenceId": uid(6),
                                "stageInputDigest": h("stage input")},
                "inputEvidenceDigest": h("input record"), "inputFingerprint": h("canonical stage input"),
                "basisRef": {"evidenceId": uid(7), "evidenceDigest": h("basis")}}
    policy = {"maxProcesses": 4, "jobCommitLimitBytes": "1048576", "processCommitLimitBytes": "524288",
              "cpuRatePer10000": 2000, "wallTimeoutMs": 1000, "joinTimeoutMs": 500,
              "stdoutMaxBytes": "32768", "stderrMaxBytes": "1024"}
    authority = {"attemptId": uid(8), "controllerInstanceId": uid(9), "controllerId": "windows-controller",
                 "keyVersion": "key-v1", "environmentDigest": h("environment"), "hostEpochId": uid(10),
                 "sessionId": uid(11), "launchId": uid(12), "policyDigest": h(policy),
                 "controllerSidDigest": h("controller sid"), "childSidDigest": h("child sid"),
                 "appContainerSidDigest": h("container sid")}
    pins = {"executableDigest": h("node"), "bootstrapDigest": h("bootstrap"),
            "helperRuntimeDigest": h("python"), "helperScriptDigest": h("helper"),
            "runtimeFilesDigest": h("runtime"), "nativeLimitsDigest": h(limits)}
    origin = {"identity": identity, "authority": authority, "pins": pins, "policy": policy, "limits": limits}
    capture = {"origin": origin,
               "originDigest": h({"identity": identity, "authority": authority, "pins": pins,
                                  "policy": policy, "nativeLimitsDigest": h(limits),
                                  "frameInputDigest": job["inputDigest"]}),
               "frameInputDigest": job["inputDigest"], "launchRef": uid(23)}
    return capture, job, blob


class ActorConstructionTests(HostTestCase):
    def test_w2_08_constructor_and_query_are_observational_without_product_io(self):
        capture, _, _ = capture_fixture()
        calls = []

        def forbidden(*args, **kwargs):
            calls.append("unexpected port")
            raise AssertionError("constructor/QUERY must not perform product I/O")

        win32 = types.SimpleNamespace(**{name: forbidden for name in (
            "preflight", "createJob", "setLimits", "queryLimits", "createSuspended", "inspectRoot",
            "resume", "waitRoot", "queryActive", "terminateJob", "queryAccounting", "closeOwned")})
        host_io = types.SimpleNamespace(**{name: forbidden for name in (
            "openStdio", "read", "write", "pollWrite", "readInput", "forward", "pollForward",
            "closeInput", "pollClose", "controlLost", "pending")})
        peer = object()
        peers = types.SimpleNamespace(requireCurrent=lambda p, d: p is peer and d == capture["originDigest"])
        clock = types.SimpleNamespace(qpc=lambda: "100", frequency=lambda: "10000000")
        ids = types.SimpleNamespace(nextId=lambda: uid(5000))
        try:
            host = self.api.WindowsJobHost(capture, win32, host_io, clock, ids, peers)
        except self.api.HostError as error:
            self.fail("valid capture must construct an actor: " + error.code)
        self.assertEqual(host.view(), {"phase": "NEW", "finalized": None})
        authority = capture["origin"]["authority"]
        query = {"version": 1, "requestId": uid(3000), "originDigest": capture["originDigest"],
                 "attemptId": authority["attemptId"], "sessionId": authority["sessionId"],
                 "launchId": authority["launchId"], "command": "QUERY", "payload": {}}
        self.assertIsInstance(host.advance(query, peer), list)
        self.assertEqual(host.view(), {"phase": "NEW", "finalized": None})
        self.assertEqual(calls, [])


class PrepareBarrierTests(HostTestCase):
    def test_w2_01_pre_create_ack_blocks_job_limits_stdio_and_child(self):
        capture, _, _ = capture_fixture()
        calls = []

        def forbidden(*args, **kwargs):
            calls.append("unexpected next stage")
            raise AssertionError("PRE_CREATE ACK barrier crossed")

        def preflight(launch_ref, origin):
            self.assertEqual(launch_ref, capture["launchRef"])
            self.assertEqual(origin, capture["origin"])
            calls.append("preflight")
            return {"facts": []}

        win32 = types.SimpleNamespace(**{name: forbidden for name in (
            "createJob", "setLimits", "queryLimits", "createSuspended", "inspectRoot", "resume",
            "waitRoot", "queryActive", "terminateJob", "queryAccounting", "closeOwned")})
        win32.preflight = preflight
        host_io = types.SimpleNamespace(**{name: forbidden for name in (
            "openStdio", "read", "write", "pollWrite", "readInput", "forward", "pollForward",
            "closeInput", "pollClose")}, controlLost=lambda: False, pending=lambda: False)
        peer = object()
        peers = types.SimpleNamespace(requireCurrent=lambda p, d: p is peer and d == capture["originDigest"])
        clock = types.SimpleNamespace(qpc=lambda: "100", frequency=lambda: "10000000")
        generated = iter(uid(n) for n in range(5000, 5100))
        ids = types.SimpleNamespace(nextId=lambda: next(generated))
        host = self.api.WindowsJobHost(capture, win32, host_io, clock, ids, peers)
        authority = capture["origin"]["authority"]
        prepare = {"version": 1, "requestId": uid(3000), "originDigest": capture["originDigest"],
                   "attemptId": authority["attemptId"], "sessionId": authority["sessionId"],
                   "launchId": authority["launchId"], "command": "PREPARE",
                   "payload": {"origin": copy.deepcopy(capture["origin"]), "launchRef": capture["launchRef"]}}
        try:
            messages = host.advance(prepare, peer)
        except self.api.HostError as error:
            self.fail("valid PREPARE must emit PRE_CREATE and wait: " + error.code)
        self.assertIsInstance(messages, list)
        for _ in range(3):
            messages += host.poll()
        events = [m["payload"]["event"] for m in messages if m["message"] == "EVENT"]
        self.assertEqual([e["kind"] for e in events], ["PRE_CREATE"])
        self.assertEqual(events[0]["payload"], {
            "bindingDigest": independent_digest(capture["origin"]["identity"]),
            "policyDigest": authority["policyDigest"],
            "pinsDigest": independent_digest(capture["origin"]["pins"])})
        self.assertEqual(calls, ["preflight"])
        self.assertIsNone(host.view()["finalized"])


WAIT = b"WAIT_V1\n"
GO = b"GO_V1\n"
READY = b"READY_V1\n"
WAIT_SHA = "b9e6d54a9694eb1ddba925555cbf67d3bee05d4d9c38507347ae43802557269b"
GO_SHA = "dd534169003916274ed5ead59b2ed78b931a1fffdee3b41e44999ce8dcc624ca"
READY_SHA = "ba68decf5e8f845bf12cc7b54043cfc0d0ea5a625b9657df28334bccb7d67c4d"


class FakeClock:
    def __init__(self):
        self.ticks = 100
        self.hz = "10000000"
        self.qpc_override = None

    def qpc(self):
        return str(self.ticks) if self.qpc_override is None else self.qpc_override

    def frequency(self):
        return self.hz


class FakeIds:
    def __init__(self, start=5000):
        self.value = start

    def nextId(self):
        self.value += 1
        return uid(self.value)


class FakePeers:
    def __init__(self, peer, origin_digest):
        self.peer = peer
        self.origin_digest = origin_digest
        self.current = True

    def requireCurrent(self, peer, origin_digest):
        return self.current and peer is self.peer and origin_digest == self.origin_digest


class FakeWin32:
    """오직 주입된 Win32 호출의 원 반환값만 제공한다. OS 자원은 만들지 않는다."""
    def __init__(self, case, capture, clock, trace):
        self.case, self.capture, self.clock, self.trace = case, capture, clock, trace
        self.job, self.process, self.thread = object(), object(), object()
        self.fact_id = 1000
        self.facts = []
        self.faults = {}
        self.rewrite_fact = None
        self.signaled = False
        self.active = 1
        self.total = 2
        self.member = True
        self.filetime = "133000000000000000"
        self.create_status = "RETURNED"
        self.failure_owns_handles = False
        self.suspend_count = 1
        self.resume_status = "RETURNED"
        self.close_status = "RETURNED"
        self.close_returned = True
        self.closed = []
        self.basic = {"TotalUserTime": "9007199254740993", "TotalKernelTime": "300",
                      "ThisPeriodTotalUserTime": "9007199254740993", "ThisPeriodTotalKernelTime": "300",
                      "TotalPageFaultCount": 1, "TotalProcesses": 2, "ActiveProcesses": 0,
                      "TotalTerminatedProcesses": 2}
        self.io_counts = {"ReadOperationCount": "2", "WriteOperationCount": "3", "OtherOperationCount": "0",
                          "ReadTransferCount": "500", "WriteTransferCount": "600", "OtherTransferCount": "0"}
        self.extended = {"BasicLimitInformation": {"PerProcessUserTimeLimit": "0", "PerJobUserTimeLimit": "0",
                        "LimitFlags": 0x2308, "MinimumWorkingSetSize": "0", "MaximumWorkingSetSize": "0",
                        "ActiveProcessLimit": 4, "Affinity": "0", "PriorityClass": 0, "SchedulingClass": 0},
                         "IoInfo": copy.deepcopy(self.io_counts), "ProcessMemoryLimit": "524288",
                         "JobMemoryLimit": "1048576", "PeakProcessMemoryUsed": "8192", "PeakJobMemoryUsed": "16384"}
        self.cpu = {"ControlFlags": 5, "CpuRate": 2000}
        a = capture["origin"]["authority"]
        self.tokens = [
            {"informationClass": "TOKEN_USER", "values": {"sidDigest": a["childSidDigest"]}},
            {"informationClass": "TOKEN_APPCONTAINER_SID", "values": {"sidDigest": a["appContainerSidDigest"]}},
            {"informationClass": "TOKEN_IS_APPCONTAINER", "values": {"isAppContainer": True}},
            {"informationClass": "TOKEN_INTEGRITY_LEVEL", "values": {"sidDigest": independent_digest("low integrity")}},
            {"informationClass": "TOKEN_SESSION_ID", "values": {"sessionId": 7}},
        ]

    def call(self, name, *args):
        self.trace.append((name,) + args)
        self.clock.ticks += 10
        if name in self.faults:
            raise self.faults[name]

    def fact(self, api, value, status="RETURNED", call_id=None):
        self.fact_id += 1
        fact = {"kind": "WIN32", "callId": call_id or uid(self.fact_id), "api": api,
                "qpcTicks": str(self.clock.ticks), "status": status,
                "win32Error": 5 if status == "FAILED" else None,
                "value": copy.deepcopy(value) if status == "RETURNED" else None}
        if self.rewrite_fact is not None:
            self.rewrite_fact(fact)
        self.facts.append(copy.deepcopy(fact))
        return fact

    def query_fact(self, information_class, values):
        return self.fact("QueryInformationJobObject", {"informationClass": information_class, "values": values})

    def preflight(self, launch_ref, origin):
        self.call("preflight", launch_ref)
        self.case.assertEqual(launch_ref, self.capture["launchRef"])
        self.case.assertEqual(origin, self.capture["origin"])
        return {"facts": [self.fact("GetNativeSystemInfo", {"processorArchitecture": 9}),
                          self.fact("IsWow64Process2", {"processMachine": 0, "nativeMachine": 34404}),
                          self.fact("ProcessIdToSessionId", {"sessionId": 7})]}

    def createJob(self):
        self.call("createJob")
        return {"job": self.job, "facts": [self.fact("CreateJobObjectW", {"objectRef": uid(29)})]}

    def setLimits(self, job, policy):
        self.call("setLimits", job)
        self.case.assertIs(job, self.job)
        self.case.assertEqual(policy, self.capture["origin"]["policy"])
        return {"facts": [self.fact("SetInformationJobObject", {"returned": True})]}

    def queryLimits(self, job):
        self.call("queryLimits", job)
        self.case.assertIs(job, self.job)
        return {"facts": [self.query_fact("EXTENDED_LIMITS", self.extended),
                          self.query_fact("CPU_RATE", self.cpu)]}

    def createSuspended(self, job, launch_ref, stdio, call_id):
        self.call("createSuspended", job, launch_ref, stdio, call_id)
        self.case.assertIs(job, self.job)
        self.case.assertEqual(launch_ref, self.capture["launchRef"])
        self.case.assertEqual(stdio, self.opened_stdio)
        facts = [self.fact("CreateProcessAsUserW", {"processRef": uid(30), "threadRef": uid(31), "pid": 42},
                           self.create_status, call_id)]
        created = self.create_status == "RETURNED"
        if created:
            facts.append(self.fact("GetProcessTimes", {"processRef": uid(30), "creationFileTime100ns": self.filetime,
                                                        "userTime100ns": "0", "kernelTime100ns": "0"}))
        owned = created or self.failure_owns_handles
        return {"status": self.create_status, "process": self.process if owned else None,
                "thread": self.thread if owned else None, "facts": facts}

    def inspectRoot(self, job, process):
        self.call("inspectRoot", job, process)
        self.case.assertIs(job, self.job)
        self.case.assertIs(process, self.process)
        return {"facts": [self.fact("IsProcessInJob", {"isMember": self.member}),
                          self.fact("GetProcessTimes", {"processRef": uid(30), "creationFileTime100ns": self.filetime,
                                                        "userTime100ns": "0", "kernelTime100ns": "0"})]
                         + [self.fact("GetTokenInformation", token) for token in self.tokens]}

    def resume(self, thread):
        self.call("resume", thread)
        self.case.assertIs(thread, self.thread)
        return {"facts": [self.fact("ResumeThread", {"previousSuspendCount": self.suspend_count},
                                    self.resume_status)]}

    def waitRoot(self, process):
        self.call("waitRoot", process)
        self.case.assertIs(process, self.process)
        facts = [self.fact("WaitForSingleObject", {"waitResult": "SIGNALED" if self.signaled else "TIMEOUT"})]
        if self.signaled:
            facts.append(self.fact("GetExitCodeProcess", {"exitCode": 0}))
        return {"facts": facts}

    def queryActive(self, job):
        self.call("queryActive", job)
        self.case.assertIs(job, self.job)
        basic = dict(self.basic, ActiveProcesses=self.active, TotalProcesses=self.total)
        return {"facts": [self.query_fact("BASIC_ACCOUNTING", basic)]}

    def terminateJob(self, job, reason):
        self.call("terminateJob", job, reason)
        self.case.assertIs(job, self.job)
        return {"facts": [self.fact("TerminateJobObject", {"returned": True})]}

    def queryAccounting(self, job):
        self.call("queryAccounting", job)
        self.case.assertIs(job, self.job)
        basic = dict(self.basic, ActiveProcesses=self.active, TotalProcesses=self.total)
        return {"facts": [self.query_fact("BASIC_AND_IO", {"BasicInfo": basic, "IoInfo": self.io_counts}),
                          self.query_fact("EXTENDED_LIMITS", self.extended),
                          self.fact("QueryPerformanceFrequency", {"frequency": self.clock.hz}),
                          self.fact("QueryPerformanceCounter", {"ticks": str(self.clock.ticks)})]}

    def closeOwned(self, handle):
        self.call("closeOwned", handle)
        self.closed.append(handle)
        return {"facts": [self.fact("CloseHandle", {"returned": self.close_returned}, self.close_status)]}


class FakeIo:
    def __init__(self, case, clock, trace, win32):
        self.case, self.clock, self.trace, self.win32 = case, clock, trace, win32
        self.stdio = {"childHandles": [object(), object(), object()], "owned": [object(), object(), object()]}
        self.reads = {"OUT": [], "ERR": []}
        self.input_chunks = []
        self.writes = []
        self.forwards = []
        self.tickets = {}
        self.fact_id = 20000
        self.write_complete = True
        self.forward_complete = True
        self.close_complete = True
        self.write_status = "RETURNED"
        self.write_fact_override = None
        self.read_fact_override = None
        self.lost = False
        self.extra_pending = False
        self.eof_read = set()
        self.stdin_closed = False
        self.read_override = None
        self.input_override = None
        self.forward_result = True

    def fact(self, lane, operation, data, status="RETURNED"):
        self.fact_id += 1
        self.clock.ticks += 1
        return {"kind": "IO", "callId": uid(self.fact_id), "lane": lane, "operation": operation,
                "qpcTicks": str(self.clock.ticks), "status": status,
                "bytesLength": str(len(data)) if status == "RETURNED" else None,
                "sha256": hashlib.sha256(data).hexdigest() if status == "RETURNED" else None}

    def openStdio(self):
        self.trace.append(("openStdio",))
        self.win32.opened_stdio = self.stdio
        return self.stdio

    def push(self, lane, data, eof=False):
        self.reads[lane].append((data, eof))

    def read(self, lane, max_bytes):
        self.trace.append(("read", lane, max_bytes))
        self.case.assertIn(lane, ("OUT", "ERR"))
        self.case.assertGreater(max_bytes, 0)
        self.case.assertLessEqual(max_bytes, 65536)
        if self.read_override is not None:
            return self.read_override(lane, max_bytes)
        if not self.reads[lane]:
            return None
        data, eof = self.reads[lane].pop(0)
        if len(data) > max_bytes:
            self.reads[lane].insert(0, (data[max_bytes:], eof))
            data, eof = data[:max_bytes], False
        fact = self.fact(lane, "READ", bytes(data))
        if self.read_fact_override is not None:
            self.read_fact_override(fact)
        if eof:
            self.eof_read.add(lane)
        return {"data": data, "eof": eof, "fact": fact}

    def ticket(self, kind, data=None, lane=None):
        ticket = object()
        self.tickets[ticket] = (kind, data, lane)
        return ticket

    def write(self, lane, data):
        self.case.assertEqual(lane, "IN")
        self.case.assertIsInstance(data, bytes)
        self.trace.append(("write", lane, data))
        self.writes.append(data)
        return self.ticket("write", data, lane)

    def pollWrite(self, ticket):
        self.trace.append(("pollWrite", ticket))
        self.case.assertIn(ticket, self.tickets)
        if not self.write_complete:
            return None
        kind, data, lane = self.tickets.pop(ticket)
        self.case.assertEqual(kind, "write")
        fact = self.fact(lane, "WRITE", data, self.write_status)
        if self.write_fact_override is not None:
            self.write_fact_override(fact)
        return fact

    def readInput(self, max_bytes):
        self.trace.append(("readInput", max_bytes))
        self.case.assertGreater(max_bytes, 0)
        self.case.assertLessEqual(max_bytes, 65536)
        if self.input_override is not None:
            return self.input_override(max_bytes)
        if not self.input_chunks:
            return None
        data, eof = self.input_chunks.pop(0)
        if len(data) > max_bytes:
            self.input_chunks.insert(0, (data[max_bytes:], eof))
            data, eof = data[:max_bytes], False
        return {"data": data, "eof": eof}

    def forward(self, lane, data):
        self.trace.append(("forward", lane, bytes(data)))
        self.forwards.append((lane, bytes(data)))
        return self.ticket("forward", data, lane)

    def pollForward(self, ticket):
        self.trace.append(("pollForward", ticket))
        self.case.assertIn(ticket, self.tickets)
        if not self.forward_complete:
            return None
        self.tickets.pop(ticket)
        return self.forward_result

    def closeInput(self):
        self.trace.append(("closeInput",))
        return self.ticket("close")

    def pollClose(self, ticket):
        self.trace.append(("pollClose", ticket))
        self.case.assertIn(ticket, self.tickets)
        if not self.close_complete:
            return None
        self.tickets.pop(ticket)
        self.stdin_closed = True
        return self.fact("IN", "CLOSE", b"")

    def controlLost(self):
        return self.lost

    def pending(self):
        return bool(self.tickets) or self.extra_pending


class HostHarness:
    def __init__(self, case, capture=None):
        self.case = case
        default, self.job, self.blob = capture_fixture()
        self.capture = copy.deepcopy(default if capture is None else capture)
        self.clock = FakeClock()
        self.trace = []
        self.win = FakeWin32(case, self.capture, self.clock, self.trace)
        self.io = FakeIo(case, self.clock, self.trace, self.win)
        self.peer = object()
        self.peers = FakePeers(self.peer, self.capture["originDigest"])
        self.ids = FakeIds()
        self.host = case.api.WindowsJobHost(self.capture, self.win, self.io, self.clock, self.ids, self.peers)
        self.request_id = 3000
        self.messages = []
        self.entries = []
        self.acked = set()
        self.parent_ack = {"joinId": uid(22), "originDigest": self.capture["originDigest"],
                           "digest": independent_digest("joined original parent work")}
        self.go = {"jobId": self.capture["origin"]["identity"]["binding"]["jobId"],
                   "rowDigest": independent_digest("original GO")}

    def control(self, command, payload):
        self.request_id += 1
        a = self.capture["origin"]["authority"]
        return {"version": 1, "requestId": uid(self.request_id), "originDigest": self.capture["originDigest"],
                "attemptId": a["attemptId"], "sessionId": a["sessionId"], "launchId": a["launchId"],
                "command": command, "payload": copy.deepcopy(payload)}

    def collect(self, messages):
        self.case.assertIsInstance(messages, list)
        for message in messages:
            self.case.assertEqual(set(message), {"version", "requestId", "originDigest", "attemptId",
                                                "sessionId", "launchId", "message", "payload"})
            self.case.assertEqual(message["originDigest"], self.capture["originDigest"])
            self.case.assertEqual(self.case.api.decode_host_message(self.case.api.encode_host_message(message)), message)
            if message["message"] == "EVENT":
                entry = message["payload"]
                self.case.assertEqual(independent_digest(entry["source"]), entry["sourceDigest"])
                event = entry["event"]
                body = {k: v for k, v in event.items() if k != "payloadDigest"}
                self.case.assertEqual(independent_digest(body), event["payloadDigest"])
                old = next((row for row in self.entries if row["event"]["eventId"] == event["eventId"]), None)
                if old is None:
                    self.case.assertEqual(event["sequence"], len(self.entries) + 1)
                    self.case.assertEqual(event["previousDigest"], self.entries[-1]["event"]["payloadDigest"] if self.entries else None)
                    self.entries.append(copy.deepcopy(entry))
                else:
                    self.case.assertEqual(entry, old, "같은 원 사건 ID의 bytes는 바뀌면 안 된다")
            self.messages.append(copy.deepcopy(message))
        return messages

    def send(self, command, payload):
        try:
            result = self.host.advance(self.control(command, payload), self.peer)
        except self.case.api.HostError as error:
            self.case.fail("valid " + command + " must run: " + error.code)
        return self.collect(result)

    def poll(self, count=1):
        messages = []
        for _ in range(count):
            messages.extend(self.collect(self.host.poll()))
        return messages

    def names(self):
        return [call[0] for call in self.trace]

    def kinds(self):
        return [row["event"]["kind"] for row in self.entries]

    def entry(self, kind):
        return next((row for row in self.entries if row["event"]["kind"] == kind), None)

    def until(self, predicate, label, count=40):
        for _ in range(count):
            if predicate():
                return
            self.poll()
        self.case.assertTrue(predicate(), label + "; events=" + repr(self.kinds())
                             + "; errors=" + repr([m["payload"] for m in self.messages if m["message"] == "ERROR"]))

    def reach(self, kind):
        self.until(lambda: self.entry(kind) is not None, "원 사건 미관측: " + kind)
        return self.entry(kind)

    def ack_payload(self, kind):
        row = self.reach(kind)
        return {"eventId": row["event"]["eventId"], "payloadDigest": row["event"]["payloadDigest"],
                "sourceDigest": row["sourceDigest"]}

    def ack(self, kind):
        payload = self.ack_payload(kind)
        messages = self.send("ACK_EVENT", payload)
        self.acked.add(payload["eventId"])
        return messages

    def ack_all(self, except_kind=None):
        for row in list(self.entries):
            if row["event"]["eventId"] not in self.acked and row["event"]["kind"] != except_kind:
                self.ack(row["event"]["kind"])

    def prepare(self):
        self.send("PREPARE", {"origin": self.capture["origin"], "launchRef": self.capture["launchRef"]})
        self.reach("PRE_CREATE")

    def prepare_suspended(self):
        self.prepare()
        self.ack("PRE_CREATE")
        self.ack("CREATE_ARMED")
        self.ack("CREATED_SUSPENDED")
        self.reach("PREPARED")

    def bootstrap(self):
        self.prepare_suspended()
        self.ack("PREPARED")
        self.until(lambda: "resume" in self.names(), "PREPARED ACK 뒤 resume")
        self.io.push("OUT", WAIT)
        self.ack("BOOTSTRAP_RESUMED")
        self.until(lambda: any(m["message"] == "PROGRESS" and m["payload"]["bootstrap"] == "WAIT"
                               for m in self.messages), "WAIT progress")

    def grant(self):
        self.send("GRANT_GO", {"goGrantRef": self.go})
        self.ack("GO_AUTHORIZED")
        self.ack("GO_WRITE_ARMED")
        self.until(lambda: GO in self.io.writes, "원 GO6 write 호출")

    def ready(self):
        self.bootstrap()
        self.grant()
        self.ack("GO_WRITE")
        self.io.push("OUT", READY)
        self.until(lambda: any(m["message"] == "PROGRESS" and m["payload"]["bootstrap"] == "READY"
                               for m in self.messages), "READY progress")

    def candidate(self):
        return next((m["payload"]["evidence"] for m in reversed(self.messages)
                     if m["message"] == "FINAL_CANDIDATE"), None)

    def join_created(self, except_ack=None, parent=True):
        self.win.signaled = True
        self.win.active = 0
        self.io.input_chunks.append((b"", True))
        self.io.push("OUT", b"", True)
        self.io.push("ERR", b"", True)
        for _ in range(40):
            self.poll()
            self.ack_all(except_ack)
            if self.io.eof_read == {"OUT", "ERR"} and self.io.stdin_closed and not self.io.pending():
                break
        self.case.assertEqual(self.io.eof_read, {"OUT", "ERR"})
        self.case.assertTrue(self.io.stdin_closed)
        if parent:
            self.send("PARENT_JOINED", self.parent_ack)
            for _ in range(40):
                self.poll()
                self.ack_all(except_ack)
                if self.candidate() is not None or except_ack is not None and self.entry(except_ack) is not None:
                    return
            self.case.assertIsNotNone(self.candidate(), "생성 작업의 완전 원 candidate")

    def final_ref(self, evidence=None, entries=None, parent_ack=None):
        manifest = [{"eventId": row["event"]["eventId"], "payloadDigest": row["event"]["payloadDigest"],
                     "sourceDigest": row["sourceDigest"]} for row in self.entries]
        envelope = {"version": 1, "originDigest": self.capture["originDigest"],
                    "evidence": copy.deepcopy(self.candidate() if evidence is None else evidence),
                    "entries": manifest if entries is None else entries,
                    "parentJoinAck": self.parent_ack if parent_ack is None else parent_ack}
        return {"recordId": uid(24), "digest": independent_digest(envelope)}


class PreparationTests(HostTestCase):
    def test_w2_01_each_journal_ack_is_a_barrier_for_the_next_os_stage(self):
        h = HostHarness(self)
        h.prepare()
        h.poll(3)
        self.assertEqual(h.names(), ["preflight"])
        h.ack("PRE_CREATE")
        h.reach("CREATE_ARMED")
        h.poll(3)
        relevant = [n for n in h.names() if n in {"preflight", "createJob", "setLimits", "queryLimits", "openStdio"}]
        self.assertEqual(relevant, ["preflight", "createJob", "setLimits", "queryLimits", "openStdio"])
        self.assertNotIn("createSuspended", h.names())
        h.ack("CREATE_ARMED")
        created = h.reach("CREATED_SUSPENDED")
        self.assertEqual(created["event"]["payload"], {"pid": 42, "creationFileTime100ns": "133000000000000000",
                                                      "assignedBy": "PROC_THREAD_ATTRIBUTE_JOB_LIST"})
        self.assertEqual(h.names().count("createSuspended"), 1)
        self.assertNotIn("inspectRoot", h.names())
        h.ack("CREATED_SUSPENDED")
        h.reach("PREPARED")
        h.poll(3)
        self.assertEqual(h.names().count("inspectRoot"), 1)
        self.assertNotIn("resume", h.names())
        h.ack("PREPARED")
        h.until(lambda: "resume" in h.names(), "PREPARED 원 ACK 뒤 resume")
        self.assertNotIn("BOOTSTRAP_RESUMED", h.kinds())
        h.io.push("OUT", WAIT)
        resumed = h.reach("BOOTSTRAP_RESUMED")
        self.assertEqual([f["sha256"] for f in resumed["source"]["facts"] if f["kind"] == "IO"], [WAIT_SHA])
        h.ack("BOOTSTRAP_RESUMED")
        self.assertEqual(h.names().count("resume"), 1)

    def test_w2_01_duplicate_prepare_and_ack_do_not_recreate_original_work(self):
        h = HostHarness(self)
        h.prepare()
        prepare = h.control("PREPARE", {"origin": h.capture["origin"], "launchRef": h.capture["launchRef"]})
        h.collect(h.host.advance(prepare, h.peer))
        h.ack("PRE_CREATE")
        armed = copy.deepcopy(h.reach("CREATE_ARMED"))
        calls = [n for n in h.names() if n in {"preflight", "createJob", "setLimits", "queryLimits", "openStdio"}]
        h.send("ACK_EVENT", h.ack_payload("PRE_CREATE"))
        h.poll(3)
        self.assertEqual([n for n in h.names() if n in set(calls)], calls)
        self.assertEqual(h.entry("CREATE_ARMED"), armed)
        self.assertEqual(h.kinds().count("PRE_CREATE"), 1)
        self.assertNotIn("createSuspended", h.names())

    def test_w2_01_stop_before_late_arm_ack_prevents_create(self):
        h = HostHarness(self)
        h.prepare()
        h.ack("PRE_CREATE")
        arm_ack = h.ack_payload("CREATE_ARMED")
        h.send("STOP", {"reason": "CALLER_ABORT"})
        h.send("ACK_EVENT", arm_ack)
        h.poll(4)
        self.assertNotIn("createSuspended", h.names())
        self.assertNotIn("CREATED_SUSPENDED", h.kinds())
        self.assertNotIn("resume", h.names())

    def test_w2_02_resume_requires_exactly_one_suspend_and_is_never_retried(self):
        for count in (0, 2, 0xFFFFFFFF):
            with self.subTest(previousSuspendCount=count):
                h = HostHarness(self)
                h.prepare_suspended()
                h.win.suspend_count = count
                h.ack("PREPARED")
                h.until(lambda: "FAILED" in h.kinds(), "실패한 resume 원 사실")
                h.poll(3)
                self.assertEqual(h.names().count("resume"), 1)
                self.assertNotIn("BOOTSTRAP_RESUMED", h.kinds())
                self.assertNotIn("write", h.names())
                self.assertEqual(h.names().count("terminateJob"), 1)
                self.assertIsNone(h.host.view()["finalized"])

    def test_w2_02_resume_return_loss_is_unconfirmed_without_second_resume(self):
        h = HostHarness(self)
        h.prepare_suspended()
        h.win.resume_status = "UNCONFIRMED"
        h.ack("PREPARED")
        h.until(lambda: "FAILED" in h.kinds(), "resume 반환 소실")
        h.poll(4)
        self.assertEqual(h.names().count("resume"), 1)
        self.assertNotIn("BOOTSTRAP_RESUMED", h.kinds())
        self.assertEqual(h.names().count("terminateJob"), 1)

    def test_w2_01_peer_tuple_command_order_and_tampered_ack_have_no_side_effects(self):
        h = HostHarness(self)
        h.prepare()
        controls = []
        for key, value in (("originDigest", "b" * 64), ("attemptId", uid(90)),
                           ("sessionId", uid(91)), ("launchId", uid(92))):
            control = h.control("QUERY", {})
            control[key] = value
            controls.append(control)
        controls.append(h.control("SPAWN", {}))
        controls.append(h.control("GRANT_GO", {"goGrantRef": h.go}))
        for key in ("eventId", "payloadDigest", "sourceDigest"):
            ack = h.ack_payload("PRE_CREATE")
            ack[key] = uid(93) if key == "eventId" else "c" * 64
            controls.append(h.control("ACK_EVENT", ack))
        for control in controls:
            with self.subTest(command=control["command"], request=control["requestId"]):
                before = copy.deepcopy(h.entries), list(h.trace), h.host.view()
                self.assert_host_error(lambda: h.host.advance(control, h.peer))
                self.assertEqual((h.entries, h.trace, h.host.view()), before)
        query = h.control("QUERY", {})
        self.assert_host_error(lambda: h.host.advance(query, object()))
        h.peers.requireCurrent = lambda p, d: 1
        self.assert_host_error(lambda: h.host.advance(query, h.peer))
        self.assertNotIn("createJob", h.names())

    def test_w2_01_query_does_not_poll_deadline_or_issue_new_events(self):
        h = HostHarness(self)
        h.prepare()
        before = list(h.trace), copy.deepcopy(h.entries), h.host.view()
        h.clock.ticks += 20_000_000
        for _ in range(4):
            h.send("QUERY", {})
        self.assertEqual((h.trace, h.entries, h.host.view()), before)
        h.poll()
        self.assertIn("CREATE_NOT_ATTEMPTED", h.kinds())


class GoAndIoTests(HostTestCase):
    def test_w2_03_transport_acceptance_is_not_go_write_completion(self):
        h = HostHarness(self)
        h.bootstrap()
        h.io.write_complete = False
        h.grant()
        h.poll(4)
        self.assertEqual(h.io.writes, [GO])
        self.assertNotIn("GO_WRITE", h.kinds())
        self.assertNotIn("readInput", h.names())
        self.assertFalse(any(m["message"] == "PROGRESS" and m["payload"]["bootstrap"] == "READY" for m in h.messages))
        h.io.write_complete = True
        written = h.reach("GO_WRITE")
        self.assertEqual(written["event"]["payload"], {"result": "RETURNED", "bytesLength": "6"})
        self.assertEqual([f["sha256"] for f in written["source"]["facts"] if f["kind"] == "IO"], [GO_SHA])
        h.ack("GO_WRITE")
        h.poll(3)
        self.assertEqual(h.io.writes, [GO])

    def test_w2_03_ready_strips_only_marker_and_relays_original_native_bytes(self):
        h = HostHarness(self)
        h.bootstrap()
        metadata = json.dumps(h.job, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        native = b"TMNATV1\0" + len(metadata).to_bytes(4, "big") + metadata + h.blob
        h.io.input_chunks.extend([(native, False), (b"", True)])
        h.poll(3)
        self.assertNotIn("readInput", h.names())
        self.assertEqual(h.io.writes, [])
        h.grant()
        h.ack("GO_WRITE")
        h.io.push("OUT", READY + native)
        h.until(lambda: h.io.stdin_closed and b"".join(data for lane, data in h.io.forwards if lane == "OUT") == native,
                "READY 뒤 원 native bytes와 stdin close")
        self.assertEqual(h.io.writes[0], GO)
        self.assertEqual(b"".join(h.io.writes[1:]), native)
        self.assertEqual(b"".join(data for lane, data in h.io.forwards if lane == "OUT"), native)
        ready = next(m["payload"]["bootstrapFact"] for m in h.messages
                     if m["message"] == "PROGRESS" and m["payload"]["bootstrap"] == "READY")
        self.assertEqual((ready["lane"], ready["operation"], ready["bytesLength"], ready["sha256"]),
                         ("OUT", "READ", "9", READY_SHA))
        self.assertEqual(h.capture["frameInputDigest"], h.job["inputDigest"])
        self.assertEqual(h.job["blobs"][0]["sha256"], hashlib.sha256(h.blob).hexdigest())
        self.assertLess(h.names().index("write"), h.names().index("readInput"))

    def test_w2_03_lost_go_return_is_not_retried_or_reported_returned(self):
        h = HostHarness(self)
        h.bootstrap()
        h.io.write_status = "UNCONFIRMED"
        h.grant()
        written = h.reach("GO_WRITE")
        self.assertEqual(written["event"]["payload"], {"result": "UNCONFIRMED", "bytesLength": "6"})
        h.poll(5)
        self.assertEqual(h.io.writes, [GO])
        self.assertNotIn("readInput", h.names())
        self.assertEqual(h.names().count("terminateJob"), 1)
        self.assertIsNone(h.host.view()["finalized"])

    def test_w2_07_pending_output_forward_holds_lane_credit_until_actual_return(self):
        h = HostHarness(self)
        h.ready()
        h.io.forward_complete = False
        h.io.push("OUT", b"first native chunk")
        h.io.push("OUT", b"second native chunk")
        h.until(lambda: len(h.io.forwards) == 1, "첫 native forward")
        reads = sum(call[:2] == ("read", "OUT") for call in h.trace)
        h.poll(5)
        self.assertEqual(h.io.forwards, [("OUT", b"first native chunk")])
        self.assertEqual(sum(call[:2] == ("read", "OUT") for call in h.trace), reads)
        h.io.forward_complete = True
        h.until(lambda: len(h.io.forwards) == 2, "pending forward 반환 뒤 다음 read")
        self.assertEqual(h.io.forwards[-1], ("OUT", b"second native chunk"))

    def test_w2_07_pending_child_write_holds_input_credit_and_defers_close(self):
        h = HostHarness(self)
        h.ready()
        h.io.write_complete = False
        h.io.input_chunks.extend([(b"TMNATV1\0", False), (b"remaining original frame", False), (b"", True)])
        h.until(lambda: len(h.io.writes) == 2, "첫 frame write")
        reads = h.names().count("readInput")
        h.poll(5)
        self.assertEqual(h.names().count("readInput"), reads)
        self.assertEqual(len(h.io.writes), 2)
        self.assertNotIn("closeInput", h.names())
        h.io.write_complete = True
        h.until(lambda: h.io.stdin_closed, "모든 write 실제 반환 뒤 close")
        self.assertEqual(h.io.writes, [GO, b"TMNATV1\0", b"remaining original frame"])

    def test_w2_03_child_write_fact_must_match_actual_go_bytes(self):
        h = HostHarness(self)
        h.bootstrap()
        h.io.write_fact_override = lambda fact: fact.update(sha256="0" * 64)
        h.grant()
        h.until(lambda: "FAILED" in h.kinds(), "변조된 child write fact 거부")
        self.assertFalse(any(row["event"]["kind"] == "GO_WRITE" and row["event"]["payload"]["result"] == "RETURNED"
                             for row in h.entries))
        self.assertEqual(h.io.writes, [GO])


class TreeAndFinalTests(HostTestCase):
    def test_w2_04_root_exit_kills_descendants_before_eof_or_event_ack(self):
        h = HostHarness(self)
        h.bootstrap()
        h.io.write_complete = False
        h.grant()
        h.win.signaled = True
        h.win.active = 2
        before_deadline = int(h.entry("PRE_CREATE")["event"]["qpcTicks"]) + 10_000_000
        h.poll(3)
        self.assertLess(h.clock.ticks, before_deadline)
        kills = [call for call in h.trace if call[0] == "terminateJob"]
        self.assertEqual(len(kills), 1)
        self.assertIs(kills[0][1], h.win.job)
        self.assertNotIn("TREE_EMPTY", h.kinds())
        self.assertNotIn("IO_JOINED", h.kinds())
        self.assertIsNone(h.candidate())
        assert_parent_handles_open(self, h)
        self.assertIsNone(h.host.view()["finalized"])

    def test_w2_04_parent_join_and_accounting_event_ack_are_required_before_candidate(self):
        h = HostHarness(self)
        h.ready()
        h.join_created(parent=False)
        h.poll(3)
        self.assertIsNone(h.candidate())
        self.assertNotIn("IO_JOINED", h.kinds())
        h.send("PARENT_JOINED", h.parent_ack)
        for _ in range(10):
            h.poll()
            h.ack_all("FINAL_ACCOUNTING")
        h.reach("FINAL_ACCOUNTING")
        self.assertIsNone(h.candidate())
        assert_parent_handles_open(self, h)
        h.ack("FINAL_ACCOUNTING")
        h.until(lambda: h.candidate() is not None, "마지막 원 accounting ACK 뒤 candidate")
        assert_parent_handles_open(self, h)
        evidence = h.candidate()
        self.assertEqual(evidence["final"]["outcome"], "JOB_EMPTY")
        self.assertEqual(evidence["final"]["accounting"]["userTime100ns"], "9007199254740993")
        self.assertEqual(evidence["final"]["accounting"]["startQpcTicks"], h.entry("CREATED_SUSPENDED")["event"]["qpcTicks"])
        self.assertEqual(evidence["final"]["accounting"]["endQpcTicks"], h.entry("FINAL_ACCOUNTING")["event"]["qpcTicks"])

    def test_w2_06_final_ack_uses_exact_five_key_wrapper_and_closes_owned_handles_once(self):
        h = HostHarness(self)
        h.ready()
        h.join_created()
        ref = h.final_ref()
        self.assertNotEqual(ref["digest"], independent_digest(h.candidate()))
        wrong = dict(ref, digest=independent_digest(h.candidate()))
        self.assert_host_error(lambda: h.host.advance(h.control("ACK_FINAL", wrong), h.peer))
        assert_parent_handles_open(self, h)
        ack = h.control("ACK_FINAL", ref)
        h.collect(h.host.advance(ack, h.peer))
        h.until(lambda: h.host.view()["phase"] == "JOINED", "최종 원 ACK와 실제 handle close")
        finalized = h.host.view()["finalized"]
        self.assertEqual(finalized, dict(ref, handles="CLOSED", closeCode=None))
        expected = [h.win.job, h.win.process, h.win.thread] + h.io.stdio["owned"] + h.io.stdio["childHandles"]
        self.assertEqual({id(handle) for handle in h.win.closed}, {id(handle) for handle in expected})
        self.assertEqual(len(h.win.closed), len(expected))
        final_messages = [m for m in h.messages if m["message"] == "FINALIZED"]
        self.assertTrue(final_messages)
        self.assertEqual(final_messages[-1]["requestId"], ack["requestId"])
        closed = list(h.win.closed)
        ids_before = [row["event"]["eventId"] for row in h.entries]
        h.collect(h.host.advance(ack, h.peer))
        h.send("QUERY", {})
        h.poll(2)
        self.assertEqual(h.win.closed, closed)
        self.assertEqual([row["event"]["eventId"] for row in h.entries], ids_before)
        self.assertEqual(h.host.view(), {"phase": "JOINED", "finalized": finalized})

    def test_w2_06_other_valid_chain_or_source_manifest_cannot_replace_original_seal(self):
        h = HostHarness(self)
        h.ready()
        h.join_created()
        evidence = copy.deepcopy(h.candidate())
        manifest = []
        previous = None
        for index, event in enumerate(evidence["lifecycle"]["events"]):
            event["eventId"] = uid(40000 + index)
            event["previousDigest"] = previous
            event["payloadDigest"] = independent_digest({k: v for k, v in event.items() if k != "payloadDigest"})
            previous = event["payloadDigest"]
            source = copy.deepcopy(h.entries[index]["source"])
            source["eventId"] = event["eventId"]
            manifest.append({"eventId": event["eventId"], "payloadDigest": event["payloadDigest"],
                             "sourceDigest": independent_digest(source)})
        replacement_chain = h.final_ref(evidence=evidence, entries=manifest)
        source_manifest = [{"eventId": row["event"]["eventId"], "payloadDigest": row["event"]["payloadDigest"],
                            "sourceDigest": row["sourceDigest"]} for row in h.entries]
        other_source = copy.deepcopy(h.entries[0]["source"])
        other_source["facts"].append({"kind": "WIN32", "callId": uid(45000), "api": "GetNativeSystemInfo",
                                     "qpcTicks": h.entries[0]["event"]["qpcTicks"], "status": "RETURNED",
                                     "win32Error": None, "value": {"processorArchitecture": 9}})
        source_manifest[0]["sourceDigest"] = independent_digest(other_source)
        replacement_source = h.final_ref(entries=source_manifest)
        for ref in (replacement_chain, replacement_source):
            with self.subTest(digest=ref["digest"]):
                self.assert_host_error(lambda: h.host.advance(h.control("ACK_FINAL", ref), h.peer))
                assert_parent_handles_open(self, h)
                self.assertIsNone(h.host.view()["finalized"])
        h.send("ACK_FINAL", h.final_ref())
        h.until(lambda: h.host.view()["phase"] == "JOINED", "원 seal만 허용")


def refresh_capture(capture):
    origin = capture["origin"]
    origin["authority"]["policyDigest"] = independent_digest(origin["policy"])
    origin["pins"]["nativeLimitsDigest"] = independent_digest(origin["limits"])
    capture["originDigest"] = independent_digest({"identity": origin["identity"], "authority": origin["authority"],
        "pins": origin["pins"], "policy": origin["policy"], "nativeLimitsDigest": independent_digest(origin["limits"]),
        "frameInputDigest": capture["frameInputDigest"]})
    return capture


def join_no_create(h):
    h.send("PARENT_JOINED", h.parent_ack)
    for _ in range(40):
        h.ack_all()
        h.poll()
        if h.candidate() is not None:
            return h.candidate()
    h.case.fail("미생성 원 prefix와 부모 ACK가 완전 candidate로 합류해야 한다")


class FailurePrefixTests(HostTestCase):
    def test_w2_05_preflight_errors_preserve_no_create_prefix_without_child_io_or_accounting(self):
        for code in ("PIN_MISMATCH", "SESSION_MISMATCH", "WINDOWS_UNSUPPORTED", "LIMIT_UNSUPPORTED"):
            with self.subTest(code=code):
                h = HostHarness(self)
                h.win.faults["preflight"] = self.api.HostError(code)
                h.prepare()
                h.reach("CREATE_NOT_ATTEMPTED")
                self.assertNotIn("createJob", h.names())
                candidate = join_no_create(h)
                self.assertEqual(candidate["lifecycle"]["creation"], "NOT_ATTEMPTED")
                self.assertEqual(candidate["lifecycle"]["goWrite"], "NOT_ATTEMPTED")
                self.assertIsNone(candidate["lifecycle"]["root"])
                self.assertIsNone(candidate["lifecycle"]["rootExit"])
                self.assertIsNone(candidate["lifecycle"]["goGrantRef"])
                self.assertEqual(candidate["final"], {"outcome": "NO_CHILD_CREATED", "activeProcesses": None,
                    "rootSignaled": False, "stdioJoined": False, "parentIoJoined": True,
                    "recordSealed": True, "accounting": None, "failureCode": code})
                self.assertFalse({"ROOT_EXIT", "TREE_EMPTY", "IO_JOINED", "FINAL_ACCOUNTING"} & set(h.kinds()))
                self.assertFalse({"read", "readInput", "write", "waitRoot", "queryAccounting", "closeInput"} & set(h.names()))
                missing_parent = {"version": 1, "originDigest": h.capture["originDigest"], "evidence": candidate,
                    "entries": [{"eventId": row["event"]["eventId"], "payloadDigest": row["event"]["payloadDigest"],
                                 "sourceDigest": row["sourceDigest"]} for row in h.entries], "parentJoinAck": None}
                forged = {"recordId": uid(24), "digest": independent_digest(missing_parent)}
                self.assert_host_error(lambda: h.host.advance(h.control("ACK_FINAL", forged), h.peer))
                h.send("ACK_FINAL", h.final_ref())
                h.until(lambda: h.host.view()["phase"] == "JOINED", "미생성 부모 작업 원 봉인")

    def test_w2_05_definite_creation_failure_keeps_original_win32_error_and_absence(self):
        h = HostHarness(self)
        h.prepare()
        h.ack("PRE_CREATE")
        h.win.create_status = "FAILED"
        h.ack("CREATE_ARMED")
        failure = h.reach("CREATE_FAILED")
        self.assertEqual(failure["event"]["payload"], {"win32Error": 5, "creationConfirmedAbsent": True})
        create_call = next(f for f in failure["source"]["facts"] if f["api"] == "CreateProcessAsUserW")
        self.assertEqual(create_call["callId"], h.entry("CREATE_ARMED")["event"]["payload"]["callId"])
        self.assertEqual((create_call["status"], create_call["win32Error"], create_call["value"]), ("FAILED", 5, None))
        candidate = join_no_create(h)
        self.assertEqual(candidate["lifecycle"]["creation"], "FAILED")
        self.assertEqual(candidate["final"]["outcome"], "NO_CHILD_CREATED")
        self.assertIsNone(candidate["final"]["accounting"])
        self.assertNotIn("waitRoot", h.names())
        self.assertNotIn("queryAccounting", h.names())
        h.send("ACK_FINAL", h.final_ref())
        h.until(lambda: h.host.view()["phase"] == "JOINED", "생성 실패 local handle 합류")
        self.assertEqual({id(x) for x in h.win.closed}, {id(x) for x in [h.win.job] + h.io.stdio["owned"] + h.io.stdio["childHandles"]})

    def test_w2_05_unconfirmed_creation_never_becomes_absent_or_synthetic_zero(self):
        h = HostHarness(self)
        h.prepare()
        h.ack("PRE_CREATE")
        h.win.create_status = "UNCONFIRMED"
        h.ack("CREATE_ARMED")
        h.until(lambda: "FAILED" in h.kinds(), "생성 반환 불명확")
        h.poll(4)
        self.assertEqual(h.names().count("createSuspended"), 1)
        self.assertNotIn("CREATE_FAILED", h.kinds())
        self.assertNotIn("CREATE_NOT_ATTEMPTED", h.kinds())
        self.assertNotIn("CREATED_SUSPENDED", h.kinds())
        self.assertNotIn("FINAL_ACCOUNTING", h.kinds())
        self.assertFalse(h.candidate() is not None and h.candidate()["final"]["outcome"] == "NO_CHILD_CREATED")
        self.assertIsNone(h.host.view()["finalized"])
        self.assertEqual(h.names().count("terminateJob"), 1)

    def test_w2_05_real_readback_mismatch_is_preserved_and_cannot_prepare_or_create(self):
        h = HostHarness(self)
        h.prepare()
        h.win.cpu["CpuRate"] = 1000
        h.ack("PRE_CREATE")
        h.until(lambda: "FAILED" in h.kinds(), "요청과 다른 실제 CPU readback")
        self.assertNotIn("createSuspended", h.names())
        self.assertNotIn("PREPARED", h.kinds())
        self.assertNotIn("resume", h.names())
        candidate = join_no_create(h)
        self.assertEqual(candidate["policy"]["requested"]["cpuRatePer10000"], 2000)
        self.assertEqual(candidate["policy"]["osReadback"]["cpuRatePer10000"], 1000)
        self.assertNotIn("queryAccounting", h.names())

    def test_w2_05_created_membership_failure_keeps_created_prefix_and_cleans_same_job(self):
        h = HostHarness(self)
        h.prepare()
        h.ack("PRE_CREATE")
        h.ack("CREATE_ARMED")
        h.win.member = False
        h.ack("CREATED_SUSPENDED")
        h.until(lambda: "FAILED" in h.kinds(), "생성 뒤 편입 확인 실패")
        self.assertIn("CREATED_SUSPENDED", h.kinds())
        self.assertNotIn("PREPARED", h.kinds())
        self.assertNotIn("resume", h.names())
        self.assertEqual(h.names().count("terminateJob"), 1)
        self.assertIs([c for c in h.trace if c[0] == "terminateJob"][0][1], h.win.job)
        self.assertNotIn("createJob", h.names()[h.names().index("terminateJob") + 1:])

    def test_w2_03_stop_before_authorization_ack_never_arms_or_writes_late_go(self):
        h = HostHarness(self)
        h.bootstrap()
        h.send("GRANT_GO", {"goGrantRef": h.go})
        ack = h.ack_payload("GO_AUTHORIZED")
        h.send("STOP", {"reason": "CALLER_ABORT"})
        h.send("ACK_EVENT", ack)
        h.poll(4)
        self.assertNotIn("GO_WRITE_ARMED", h.kinds())
        self.assertEqual(h.io.writes, [])
        self.assertEqual(h.names().count("terminateJob"), 1)
        self.assertEqual(h.entry("GO_AUTHORIZED")["event"]["payload"]["goGrantRef"], h.go)


class TimerAndBudgetTests(HostTestCase):
    def test_w2_07_wall_deadline_uses_ceil_from_original_pre_create_qpc(self):
        capture, _, _ = capture_fixture()
        capture["origin"]["policy"]["wallTimeoutMs"] = 1
        h = HostHarness(self, refresh_capture(capture))
        h.clock.hz = "1001"
        h.prepare()
        start = int(h.entry("PRE_CREATE")["event"]["qpcTicks"])
        h.clock.ticks = start + 1
        h.poll()
        self.assertNotIn("CREATE_NOT_ATTEMPTED", h.kinds())
        h.clock.ticks = start + 2
        h.poll()
        self.assertIn("CREATE_NOT_ATTEMPTED", h.kinds())
        self.assertNotIn("createJob", h.names())
        self.assertIsNone(h.host.view()["finalized"])

    def test_w2_06_control_loss_and_peer_revocation_cannot_stop_cleanup_poll(self):
        h = HostHarness(self)
        h.ready()
        h.io.lost = True
        h.peers.current = False
        h.poll(3)
        self.assertEqual(h.names().count("terminateJob"), 1)
        self.assertNotIn("TREE_EMPTY", h.kinds())
        self.assertIsNone(h.candidate())
        self.assertIsNone(h.host.view()["finalized"])

    def test_w2_04_deadline_during_pending_write_kills_once_and_never_releases_pending_io_as_closed(self):
        h = HostHarness(self)
        h.bootstrap()
        h.io.write_complete = False
        h.grant()
        h.clock.ticks = int(h.entry("PRE_CREATE")["event"]["qpcTicks"]) + 10_000_000
        h.poll(3)
        self.assertEqual(h.names().count("terminateJob"), 1)
        self.assertTrue(h.io.pending())
        self.assertEqual(h.io.writes, [GO])
        h.clock.ticks += 5_001_000
        h.poll(3)
        self.assertEqual(h.names().count("terminateJob"), 1)
        self.assertEqual(h.host.view()["phase"], "UNCONFIRMED")
        finalized = h.host.view()["finalized"]
        self.assertTrue(finalized is None or finalized["handles"] == "UNCONFIRMED")
        self.assertNotIn("FINAL_ACCOUNTING", h.kinds())
        self.assertTrue(h.io.pending())

    def test_w2_07_stdout_and_stderr_budgets_include_bootstrap_and_stop_floods(self):
        for lane, size in (("OUT", 32768), ("ERR", 1025)):
            with self.subTest(lane=lane):
                h = HostHarness(self)
                h.ready()
                h.io.push(lane, b"x" * size)
                h.until(lambda: "FAILED" in h.kinds(), "방향별 출력 상한 초과")
                h.poll(2)
                self.assertEqual(h.names().count("terminateJob"), 1)
                self.assertIsNone(h.candidate())
                self.assertIsNone(h.host.view()["finalized"])

    def test_w2_07_port_cannot_return_more_than_the_reserved_read_credit(self):
        h = HostHarness(self)
        h.ready()
        def excess(lane, max_bytes):
            if lane == "ERR":
                return None
            data = b"x" * (max_bytes + 1)
            return {"data": data, "eof": False, "fact": h.io.fact(lane, "READ", data)}
        h.io.read_override = excess
        h.poll(3)
        self.assertIn("FAILED", h.kinds())
        self.assertEqual(h.io.forwards, [])
        self.assertEqual(h.names().count("terminateJob"), 1)

    def test_w2_07_constructor_rejects_parent_hold_shortage_before_any_product_call(self):
        capture, _, _ = capture_fixture()
        capture["origin"]["limits"]["parentInFlightBytes"] = 1
        refresh_capture(capture)
        trace = []
        clock = FakeClock()
        win = FakeWin32(self, capture, clock, trace)
        host_io = FakeIo(self, clock, trace, win)
        peer = object()
        self.assert_host_error(lambda: self.api.WindowsJobHost(capture, win, host_io, clock, FakeIds(),
                                                               FakePeers(peer, capture["originDigest"])))
        self.assertEqual(trace, [])

    def test_w2_07_bad_read_hash_is_rejected_before_forwarding_bytes(self):
        h = HostHarness(self)
        h.ready()
        h.io.push("OUT", b"original output bytes")
        h.io.read_fact_override = lambda fact: fact.update(sha256="f" * 64)
        h.poll(3)
        self.assertIn("FAILED", h.kinds())
        self.assertEqual(h.io.forwards, [])
        self.assertEqual(h.names().count("terminateJob"), 1)


class WireDefenseTests(HostTestCase):
    def test_w2_07_rejects_bad_length_utf8_duplicate_keys_nan_and_unknown_authority(self):
        bodies = [
            b"", b"\xff", QUERY_BODY + b" ",
            QUERY_BODY[:-1] + b',"version":1}',
            QUERY_BODY.replace(b'"version":1', b'"version":NaN'),
            QUERY_BODY.replace(b'"version":1', b'"version":Infinity'),
            QUERY_BODY.replace(b'"version":1', b'"version":true'),
            QUERY_BODY.replace(b'"command":"QUERY"', b'"command":"SPAWN"'),
            QUERY_BODY[:-1] + b',"role":"controller"}',
            QUERY_BODY.replace(b'"payload":{}', b'"payload":{"authority":true}'),
        ]
        # 공백 trailing은 JSON 공백 여부가 아니라 명시 길이 뒤 추가 byte로 검사한다.
        bodies.remove(QUERY_BODY + b" ")
        wires = [len(body).to_bytes(4, "big") + body for body in bodies]
        wires += [QUERY_WIRE[:-1], QUERY_WIRE + b"x", b"\x00\x02\x00\x01" + b"x" * 131073,
                  b"\x00\x00\x00", b"\x00\x00\x00\x00"]
        for wire in wires:
            with self.subTest(length=len(wire), prefix=wire[:20]):
                self.assert_host_error(lambda: self.api.decode_control(wire))

    def test_w2_07_uint64_strings_remain_exact_and_bool_or_overflow_policy_is_refused(self):
        value = {"counter": "18446744073709551615", "previous": "9007199254740993"}
        self.assertEqual(self.api.canonical_bytes(value), b'{"counter":"18446744073709551615","previous":"9007199254740993"}')
        capture, _, _ = capture_fixture()
        a = capture["origin"]["authority"]
        for invalid in (True, 18446744073709551615, "18446744073709551616", "01", "-1"):
            with self.subTest(limit=invalid):
                cap = copy.deepcopy(capture)
                cap["origin"]["policy"]["jobCommitLimitBytes"] = invalid
                refresh_capture(cap)
                command = {"version": 1, "requestId": uid(3000), "originDigest": cap["originDigest"],
                           "attemptId": a["attemptId"], "sessionId": a["sessionId"], "launchId": a["launchId"],
                           "command": "PREPARE", "payload": {"origin": cap["origin"], "launchRef": cap["launchRef"]}}
                self.assert_host_error(lambda: self.api.encode_control(command))

    def test_w2_07_control_ascii_depth_nodes_and_byte_bound_are_enforced(self):
        for payload in ({"text": "한글"}, {"text": "\ud800"}, {"binary": b"x"},
                        {"large": "a" * 131073}, {"nodes": [None] * 8193}):
            with self.subTest(keys=list(payload)):
                query = json.loads(QUERY_BODY)
                query["payload"] = payload
                self.assert_host_error(lambda: self.api.encode_control(query))
        nested = {}
        for _ in range(21):
            nested = {"x": nested}
        query = json.loads(QUERY_BODY)
        query["payload"] = nested
        self.assert_host_error(lambda: self.api.encode_control(query))

    def test_w2_08_ctypes_factory_default_is_disabled_without_real_loader(self):
        self.assertTrue(callable(getattr(self.api, "create_ctypes_driver", None)))
        self.assert_host_error(lambda: self.api.create_ctypes_driver(lambda ref: None, FakeClock(), FakeIds()))
        self.assertEqual(self.port_attempts, [])


def assert_parent_handles_open(case, h):
    final_handles = {id(x) for x in [h.win.job, h.win.process, h.win.thread] + h.io.stdio["owned"]}
    case.assertFalse(final_handles & {id(x) for x in h.win.closed},
                     "최종 원 ACK 전 job/process/thread/부모 stdio는 닫히면 안 된다")
    children = {id(x) for x in h.io.stdio["childHandles"]}
    case.assertTrue({id(x) for x in h.win.closed} <= children)
    case.assertEqual(len(h.win.closed), len({id(x) for x in h.win.closed}), "child 상속용 handle도 한 번만 close")


class HandleLifetimeTests(HostTestCase):
    def test_w2_02_successful_creation_closes_child_stdio_ends_before_created_ack(self):
        h = HostHarness(self)
        h.prepare()
        h.ack("PRE_CREATE")
        h.ack("CREATE_ARMED")
        h.reach("CREATED_SUSPENDED")
        self.assertEqual({id(x) for x in h.win.closed}, {id(x) for x in h.io.stdio["childHandles"]})
        self.assertEqual(len(h.win.closed), 3)
        assert_parent_handles_open(self, h)
        h.poll(3)
        self.assertEqual(len(h.win.closed), 3)
        self.assertNotIn("inspectRoot", h.names())

    def test_w2_02_definite_failure_closes_child_stdio_ends_before_final_parent_seal(self):
        h = HostHarness(self)
        h.prepare()
        h.ack("PRE_CREATE")
        h.win.create_status = "FAILED"
        h.ack("CREATE_ARMED")
        h.reach("CREATE_FAILED")
        self.assertEqual({id(x) for x in h.win.closed}, {id(x) for x in h.io.stdio["childHandles"]})
        self.assertEqual(len(h.win.closed), 3)
        assert_parent_handles_open(self, h)

    def test_w2_time_t01_later_filetime_preserves_both_observations_and_cost_start(self):
        h = HostHarness(self)
        h.prepare()
        h.ack("PRE_CREATE")
        def later_filetime(fact):
            if fact["api"] == "GetProcessTimes":
                h.clock.ticks += 1
                fact["qpcTicks"] = str(h.clock.ticks)
        h.win.rewrite_fact = later_filetime
        h.ack("CREATE_ARMED")
        created = h.reach("CREATED_SUSPENDED")
        raw = [f for f in h.win.facts if f["api"] in {"CreateProcessAsUserW", "GetProcessTimes"}]
        self.assertEqual(len(raw), 2)
        self.assertGreater(int(raw[1]["qpcTicks"]), int(raw[0]["qpcTicks"]))
        for original in raw:
            self.assertIn(original, created["source"]["facts"], "원 생성/FILETIME 반환을 변경하거나 버리면 안 된다")
        self.assertEqual(created["event"]["qpcTicks"], raw[0]["qpcTicks"])
        h.ack("CREATED_SUSPENDED")
        h.ack("PREPARED")
        h.io.push("OUT", WAIT)
        h.ack("BOOTSTRAP_RESUMED")
        h.grant()
        h.ack("GO_WRITE")
        h.io.push("OUT", READY)
        h.until(lambda: any(m["message"] == "PROGRESS" and m["payload"]["bootstrap"] == "READY" for m in h.messages), "원 READY 관측")
        h.join_created()
        self.assertEqual(h.candidate()["final"]["accounting"]["startQpcTicks"], raw[0]["qpcTicks"])
        self.assertEqual(h.names().count("createSuspended"), 1)
        self.assertNotIn("FAILED", h.kinds())


def drain_after_unknown_start(h):
    h.win.signaled = True
    h.win.active = 0
    h.io.input_chunks.append((b"", True))
    h.io.push("OUT", b"", True)
    h.io.push("ERR", b"", True)
    h.poll(2)
    h.send("PARENT_JOINED", h.parent_ack)
    for _ in range(15):
        h.ack_all()
        h.poll()


class CompletionAndSnapshotTests(HostTestCase):
    def test_w2_04_natural_exit_join_timeout_runs_before_later_wall_deadline(self):
        h = HostHarness(self)
        h.ready()
        h.win.signaled = True
        h.win.active = 0
        h.reach("TREE_EMPTY")
        self.assertEqual(h.host.view()["phase"], "DRAINING")
        h.clock.ticks = int(h.entry("ROOT_EXIT")["event"]["qpcTicks"]) + 5_001_000
        self.assertLess(h.clock.ticks, int(h.entry("PRE_CREATE")["event"]["qpcTicks"]) + 10_000_000)
        h.poll(2)
        self.assertEqual(h.host.view()["phase"], "UNCONFIRMED")
        self.assertIsNone(h.candidate())
        self.assertIsNone(h.host.view()["finalized"])
        self.assertTrue(any(m["message"] == "ERROR" and m["payload"]["code"] == "WINDOWS_JOIN_TIMEOUT"
                            for m in h.messages))

    def test_w2_04_unknown_read_forward_or_write_start_remains_pending_without_ticket(self):
        for operation in ("read", "forward", "write"):
            with self.subTest(operation=operation):
                h = HostHarness(self)
                h.ready()
                original = getattr(h.io, operation)
                attempts = []
                def unknown_start(*args):
                    attempts.append(args)
                    raise self.api.HostError(operation.upper() + "_START_UNCONFIRMED")
                setattr(h.io, operation, unknown_start)
                if operation == "forward":
                    h.io.push("OUT", b"retained original output")
                if operation == "write":
                    h.io.input_chunks.append((b"retained original input", False))
                h.poll()
                self.assertTrue(attempts)
                setattr(h.io, operation, original)
                self.assertFalse(h.io.pending(), "가짜 transport에도 완료 ticket은 없는 불명확한 시작")
                drain_after_unknown_start(h)
                self.assertIsNone(h.candidate(), "시작 반환 소실을 완료로 바꿔 최종 봉인하면 안 된다")
                self.assertIsNone(h.host.view()["finalized"])
                self.assertNotEqual(h.host.view()["phase"], "JOINED")
                assert_parent_handles_open(self, h)

    def test_w2_01_constructor_captures_input_before_caller_can_mutate_it(self):
        h = HostHarness(self)
        original = copy.deepcopy(h.capture)
        prepare = h.control("PREPARE", {"origin": original["origin"], "launchRef": original["launchRef"]})
        h.win.capture = copy.deepcopy(original)
        h.capture["origin"]["policy"]["cpuRatePer10000"] = 1
        h.capture["origin"]["pins"]["executableDigest"] = "f" * 64
        h.collect(h.host.advance(prepare, h.peer))
        self.assertEqual(h.reach("PRE_CREATE")["event"]["payload"]["pinsDigest"],
                         independent_digest(original["origin"]["pins"]))
        h.ack("PRE_CREATE")
        h.ack("CREATE_ARMED")
        h.ack("CREATED_SUSPENDED")
        prepared = h.reach("PREPARED")
        expected_os = {"maxProcesses": 4, "jobCommitLimitBytes": "1048576", "processCommitLimitBytes": "524288",
                       "cpuRatePer10000": 2000, "killOnJobClose": True, "breakawayAllowed": False}
        self.assertEqual(prepared["event"]["payload"]["osReadbackDigest"], independent_digest(expected_os))

    def test_w2_06_later_port_mutation_cannot_change_already_observed_source(self):
        h = HostHarness(self)
        returned = []
        original_fact = h.win.fact
        def retain(*args, **kwargs):
            fact = original_fact(*args, **kwargs)
            returned.append(fact)
            return fact
        h.win.fact = retain
        original_inspect = h.win.inspectRoot
        def mutate_previous(job, process):
            for fact in returned:
                if fact["api"] == "CreateProcessAsUserW":
                    fact["value"]["pid"] = 77
            return original_inspect(job, process)
        h.win.inspectRoot = mutate_previous
        h.ready()
        h.join_created()
        create_facts = [fact for fact in returned if fact["api"] == "CreateProcessAsUserW"]
        self.assertEqual(create_facts[0]["value"]["pid"], 77)
        row = h.entry("CREATED_SUSPENDED")
        self.assertEqual(row["event"]["payload"]["pid"], 42)
        self.assertEqual(next(f for f in row["source"]["facts"] if f["api"] == "CreateProcessAsUserW")["value"]["pid"], 42)
        h.send("ACK_FINAL", h.final_ref())
        h.until(lambda: h.host.view()["phase"] == "JOINED", "원사실 사본이 유지된 최종 봉인")

    def test_w2_06_dropped_finalized_response_is_retrieved_without_reclose_or_new_events(self):
        h = HostHarness(self)
        h.ready()
        h.join_created()
        control = h.control("ACK_FINAL", h.final_ref())
        lost_response = h.host.advance(control, h.peer)
        self.assertTrue(any(m["message"] == "FINALIZED" for m in lost_response))
        finalized = h.host.view()["finalized"]
        self.assertEqual(finalized["handles"], "CLOSED")
        closes, events, ids = list(h.win.closed), copy.deepcopy(h.entries), h.ids.value
        h.poll(2)
        h.send("QUERY", {})
        self.assertEqual(h.messages[-1]["payload"], finalized)
        h.collect(h.host.advance(control, h.peer))
        self.assertEqual((h.win.closed, h.entries, h.ids.value), (closes, events, ids))
        self.assertEqual(h.host.view(), {"phase": "JOINED", "finalized": finalized})

    def test_w2_06_unconfirmed_handle_close_is_cached_as_wait_and_never_retried(self):
        h = HostHarness(self)
        h.ready()
        h.join_created()
        h.win.close_status = "UNCONFIRMED"
        ack = h.control("ACK_FINAL", h.final_ref())
        h.collect(h.host.advance(ack, h.peer))
        self.assertEqual(h.host.view()["phase"], "UNCONFIRMED")
        self.assertEqual(h.host.view()["finalized"]["handles"], "UNCONFIRMED")
        attempts = list(h.win.closed)
        h.collect(h.host.advance(ack, h.peer))
        h.send("QUERY", {})
        h.poll(2)
        self.assertEqual(h.win.closed, attempts)
        self.assertEqual(len(attempts), len({id(x) for x in attempts}))

    def test_w2_06_pending_transport_cannot_be_ignored_at_final_ack(self):
        h = HostHarness(self)
        h.ready()
        h.join_created()
        h.io.extra_pending = True
        ack = h.control("ACK_FINAL", h.final_ref())
        self.assert_host_error(lambda: h.host.advance(ack, h.peer))
        assert_parent_handles_open(self, h)
        self.assertIsNone(h.host.view()["finalized"])
        h.io.extra_pending = False
        h.collect(h.host.advance(ack, h.peer))
        self.assertEqual(h.host.view()["phase"], "JOINED")


class NumericAndIdentityTests(HostTestCase):
    def test_w2_05_total_process_zero_is_not_a_complete_tree_record(self):
        h = HostHarness(self)
        h.ready()
        h.win.total = 0
        h.join_created(parent=False)
        h.send("PARENT_JOINED", h.parent_ack)
        for _ in range(6):
            h.ack_all()
            h.poll()
        self.assertNotIn("TREE_EMPTY", h.kinds())
        self.assertNotIn("FINAL_ACCOUNTING", h.kinds())
        self.assertIsNone(h.candidate())
        self.assertIsNone(h.host.view()["finalized"])

    def test_w2_05_uint64_maximum_is_preserved_without_float_or_safe_integer_conversion(self):
        h = HostHarness(self)
        h.ready()
        h.win.basic["TotalUserTime"] = "18446744073709551615"
        h.win.basic["ThisPeriodTotalUserTime"] = "18446744073709551615"
        h.win.io_counts["ReadTransferCount"] = "18446744073709551615"
        h.join_created()
        actual = h.candidate()["final"]["accounting"]
        self.assertEqual(actual["userTime100ns"], "18446744073709551615")
        self.assertEqual(actual["readBytes"], "18446744073709551615")
        self.assertIsInstance(actual["userTime100ns"], str)

    def test_w2_05_uint64_overflow_and_noncanonical_raw_counter_cannot_be_sealed(self):
        for invalid in ("18446744073709551616", "01", "-1", True):
            with self.subTest(counter=invalid):
                h = HostHarness(self)
                h.ready()
                h.win.basic["TotalUserTime"] = invalid
                h.join_created(parent=False)
                h.send("PARENT_JOINED", h.parent_ack)
                for _ in range(5):
                    h.ack_all()
                    h.poll()
                self.assertNotIn("FINAL_ACCOUNTING", h.kinds())
                self.assertIsNone(h.candidate())
                self.assertIsNone(h.host.view()["finalized"])

    def test_w2_05_qpc_reversal_never_rewrites_original_events_or_creates_zero_accounting(self):
        h = HostHarness(self)
        h.ready()
        before = copy.deepcopy(h.entries)
        h.clock.qpc_override = "0"
        h.poll(3)
        self.assertEqual(h.entries[:len(before)], before)
        self.assertEqual(h.host.view()["phase"], "UNCONFIRMED")
        self.assertNotIn("FINAL_ACCOUNTING", h.kinds())
        self.assertIsNone(h.candidate())
        self.assertEqual(h.names().count("terminateJob"), 1)

    def test_w2_06_reused_event_id_is_rejected_before_new_child_or_go(self):
        h = HostHarness(self)
        h.prepare()
        first_id = h.entry("PRE_CREATE")["event"]["eventId"]
        h.ids.nextId = lambda: first_id
        h.ack("PRE_CREATE")
        h.poll(2)
        ids = [row["event"]["eventId"] for row in h.entries]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertNotIn("createSuspended", h.names())
        self.assertEqual(h.host.view()["phase"], "UNCONFIRMED")
        self.assertIsNone(h.candidate())

    def test_w2_06_reused_fact_id_with_other_payload_cannot_prepare(self):
        h = HostHarness(self)
        h.prepare()
        h.ack("PRE_CREATE")
        h.ack("CREATE_ARMED")
        created = copy.deepcopy(h.reach("CREATED_SUSPENDED"))
        create_call = next(f for f in created["source"]["facts"] if f["api"] == "CreateProcessAsUserW")
        def reuse(fact):
            if fact["api"] == "GetTokenInformation" and fact["value"]["informationClass"] == "TOKEN_USER":
                fact["callId"] = create_call["callId"]
        h.win.rewrite_fact = reuse
        h.ack("CREATED_SUSPENDED")
        h.poll(3)
        self.assertEqual(h.entry("CREATED_SUSPENDED"), created)
        self.assertNotIn("PREPARED", h.kinds())
        self.assertNotIn("resume", h.names())
        self.assertEqual(h.names().count("terminateJob"), 1)
        self.assertIsNone(h.candidate())

    def test_w2_06_pid_reuse_filetime_change_is_wait_without_reconnect(self):
        h = HostHarness(self)
        h.prepare()
        h.ack("PRE_CREATE")
        h.ack("CREATE_ARMED")
        h.win.filetime = "133000000000000001"
        h.ack("CREATED_SUSPENDED")
        h.poll(3)
        self.assertNotIn("PREPARED", h.kinds())
        self.assertNotIn("resume", h.names())
        self.assertEqual(h.names().count("createSuspended"), 1)
        self.assertEqual(h.names().count("createJob"), 1)
        self.assertEqual(h.names().count("terminateJob"), 1)

    def test_w2_07_json_negative_zero_is_rejected_even_where_numeric_zero_is_valid(self):
        capture, _, _ = capture_fixture()
        event_body = {"eventId": uid(100), "sequence": 1, "kind": "PRE_CREATE", "qpcTicks": "100",
                      "previousDigest": None, "payload": {"bindingDigest": independent_digest(capture["origin"]["identity"]),
                          "policyDigest": capture["origin"]["authority"]["policyDigest"],
                          "pinsDigest": independent_digest(capture["origin"]["pins"])}}
        event = dict(event_body, payloadDigest=independent_digest(event_body))
        source = {"version": 1, "originDigest": capture["originDigest"], "eventId": event["eventId"],
                  "facts": [{"kind": "WIN32", "callId": uid(1001), "api": "GetNativeSystemInfo",
                             "qpcTicks": "100", "status": "RETURNED", "win32Error": None,
                             "value": {"processorArchitecture": 0}}]}
        common = json.loads(QUERY_BODY)
        del common["command"]
        common["originDigest"] = capture["originDigest"]
        common["message"] = "EVENT"
        common["payload"] = {"event": event, "source": source, "sourceDigest": independent_digest(source)}
        good = independent_bytes(common)
        self.assertEqual(self.api.decode_host_message(len(good).to_bytes(4, "big") + good), common)
        bad = good.replace(b'"processorArchitecture":0', b'"processorArchitecture":-0')
        self.assertNotEqual(bad, good)
        self.assert_host_error(lambda: self.api.decode_host_message(len(bad).to_bytes(4, "big") + bad))


class FakeDllFunction:
    def __init__(self, owner, name):
        self.owner, self.name = owner, name
        self.argtypes = self.restype = None

    def __call__(self, *args):
        self.owner.calls.append((self.name, args))
        action = self.owner.actions.get(self.name)
        if action is None:
            raise AssertionError("UNEXPECTED_FAKE_DLL_CALL: " + self.name)
        return action(*args)


class FakeDll:
    def __init__(self, calls, actions):
        self.calls, self.actions = calls, actions
        self.functions = {}

    def __getattr__(self, name):
        if name not in self.functions:
            self.functions[name] = FakeDllFunction(self, name)
        return self.functions[name]


class PureDriverFixture:
    """명시 factory의 DLL을 모두 메모리 함수로 치환한다. 실제 ABI 검증은 아니다."""
    def __init__(self, case):
        self.case = case
        self.clock, self.ids = FakeClock(), FakeIds(60000)
        self.capture, _, _ = capture_fixture()
        self.calls = []
        self.last_error = 0
        self.create_result = 1
        self.create_error = 0
        self.fail_qpc_after_create = False
        self.sids = {1: ctypes.create_string_buffer(b"childSID"),
                     31: ctypes.create_string_buffer(b"appcnSID"),
                     25: ctypes.create_string_buffer(b"low-SID!")}
        self.capture["origin"]["authority"]["childSidDigest"] = hashlib.sha256(b"childSID").hexdigest()
        self.capture["origin"]["authority"]["appContainerSidDigest"] = hashlib.sha256(b"appcnSID").hexdigest()
        refresh_capture(self.capture)
        self.kernel = FakeDll(self.calls, {
            "GetNativeSystemInfo": self.system,
            "GetCurrentProcess": lambda: 100,
            "GetCurrentProcessId": lambda: 42,
            "IsWow64Process2": self.machine,
            "ProcessIdToSessionId": self.session,
            "CreateJobObjectW": lambda security, name: 0x2100,
            "InitializeProcThreadAttributeList": self.attributes,
            "UpdateProcThreadAttribute": lambda *args: 1,
            "DeleteProcThreadAttributeList": lambda storage: None,
            "GetProcessTimes": self.process_times,
            "CloseHandle": lambda handle: 1,
        })
        self.advapi = FakeDll(self.calls, {
            "GetTokenInformation": self.token,
            "IsValidSid": lambda pointer: 1,
            "GetLengthSid": lambda pointer: 8,
            "CreateProcessAsUserW": self.create_process,
        })
        def loader(name, **kwargs):
            case.assertEqual(kwargs, {"use_last_error": True})
            case.assertIn(name, ("kernel32", "advapi32"))
            return self.kernel if name == "kernel32" else self.advapi
        case.guards.enter_context(mock.patch.object(ctypes, "WinDLL", side_effect=loader))
        case.guards.enter_context(mock.patch.object(ctypes, "get_last_error", side_effect=lambda: self.last_error))
        case.guards.enter_context(mock.patch.object(ctypes, "set_last_error", side_effect=self.set_error))
        cap = self.capture
        launch = case.api.LaunchCapability(launch_ref=cap["launchRef"], origin_digest=cap["originDigest"],
            executable="C:\\synthetic\\child.exe", command_line="synthetic-child", directory="C:\\synthetic",
            environment="SYNTHETIC=1\0\0", token=0x3100,
            appcontainer_sid=ctypes.addressof(self.sids[31]), windows_session_id=7,
            validate_current=lambda: cap["originDigest"])
        self.driver = case.api.create_ctypes_driver(lambda ref, origin: launch, self.clock, self.ids, enable_real=True)
        self.driver.preflight(cap["launchRef"], cap["origin"])
        self.job = self.driver.createJob()["job"]
        # 실제 HostIo가 넘길 동일 driver 소유 PIPE capability를 메모리 fixture로만 만든다.
        self.stdio = {"childHandles": [self.driver._own(value, "PIPE") for value in (0x4101, 0x4102, 0x4103)],
                      "owned": []}

    def set_error(self, value):
        self.last_error = value

    def system(self, info):
        info._obj.architecture = 9

    def machine(self, process, process_machine, native_machine):
        process_machine._obj.value, native_machine._obj.value = 0, 0x8664
        return 1

    def session(self, pid, session):
        session._obj.value = 7
        return 1

    def token(self, token, number, data, length, needed):
        needed._obj.value = 4 if number in (29, 12) else ctypes.sizeof(ctypes.c_void_p)
        if data is None:
            self.last_error = 122
            return 0
        if number in (29, 12):
            ctypes.cast(data, ctypes.POINTER(ctypes.c_uint32)).contents.value = 1 if number == 29 else 7
        else:
            ctypes.cast(data, ctypes.POINTER(ctypes.c_void_p)).contents.value = ctypes.addressof(self.sids[number])
        return 1

    def attributes(self, storage, count, flags, size):
        self.case.assertEqual(count, 3)
        if storage is None:
            size._obj.value = 128
            self.last_error = 122
            return 0
        return 1

    def create_process(self, *args):
        self.case.assertEqual(args[5], True)
        self.case.assertEqual(args[6], 0x00080000 | 0x00000400 | 0x4)
        self.last_error = self.create_error
        if self.create_result:
            info = args[-1]._obj
            info.hProcess, info.hThread, info.dwProcessId, info.dwThreadId = 0x2201, 0x2202, 42, 43
        if self.fail_qpc_after_create:
            def missing_qpc():
                raise self.case.api.HostError("QPC_RETURN_LOST")
            self.clock.qpc = missing_qpc
        return self.create_result

    def process_times(self, process, creation, exit_time, kernel, user):
        creation._obj.low, creation._obj.high = 5, 1
        return 1


class PureDriverTests(HostTestCase):
    def test_w2_05_fake_dll_creation_success_preserves_handles_when_qpc_return_throws(self):
        f = PureDriverFixture(self)
        f.fail_qpc_after_create = True
        try:
            result = f.driver.createSuspended(f.job, f.capture["launchRef"], f.stdio, uid(600))
        except self.api.HostError as error:
            self.fail("created handles must return for cleanup even when QPC is lost: " + error.code)
        self.assertEqual(result["status"], "UNCONFIRMED")
        self.assertIsNotNone(result["process"])
        self.assertIsNotNone(result["thread"])
        self.assertIsNot(result["process"], result["thread"])
        self.assertFalse(any(fact["qpcTicks"] == "0" for fact in result["facts"]))
        f.clock.qpc = lambda: "100"
        f.driver.closeOwned(result["process"])
        f.driver.closeOwned(result["thread"])
        self.assertEqual([args[0] for name, args in f.calls if name == "CloseHandle"], [0x2201, 0x2202])
        self.assertEqual(sum(name == "CreateProcessAsUserW" for name, args in f.calls), 1)
        self.assertEqual(self.port_attempts, [])

    def test_w2_05_fake_dll_failed_return_with_error_zero_never_fabricates_error_one(self):
        f = PureDriverFixture(self)
        f.create_result = 0
        f.create_error = 0
        result = f.driver.createSuspended(f.job, f.capture["launchRef"], f.stdio, uid(601))
        self.assertEqual(result["status"], "UNCONFIRMED")
        self.assertIsNone(result["process"])
        self.assertIsNone(result["thread"])
        for fact in result["facts"]:
            self.assertIsNone(fact["win32Error"])
            self.assertEqual(fact["status"], "UNCONFIRMED")
        self.assertEqual(sum(name == "CreateProcessAsUserW" for name, args in f.calls), 1)
        self.assertFalse(any(name == "GetProcessTimes" for name, args in f.calls))
        self.assertEqual(self.port_attempts, [])


class UnknownGoAndCloseTests(HostTestCase):
    def test_w2_03_go_write_start_exception_never_retries_or_seals_without_completion(self):
        h = HostHarness(self)
        h.bootstrap()
        attempts = []
        original_write = h.io.write
        def unknown_go(lane, data):
            self.assertEqual((lane, data), ("IN", GO))
            attempts.append(data)
            raise self.api.HostError("GO_START_UNCONFIRMED")
        h.io.write = unknown_go
        h.send("GRANT_GO", {"goGrantRef": h.go})
        h.ack("GO_AUTHORIZED")
        h.ack("GO_WRITE_ARMED")
        self.assertEqual(attempts, [GO])
        h.io.write = original_write
        drain_after_unknown_start(h)
        self.assertEqual(attempts, [GO])
        self.assertEqual(h.io.writes, [])
        self.assertNotIn("GO_WRITE", h.kinds())
        self.assertIsNone(h.candidate())
        self.assertIsNone(h.host.view()["finalized"])
        assert_parent_handles_open(self, h)

    def test_w2_04_close_input_start_exception_is_not_retried_or_treated_joined(self):
        h = HostHarness(self)
        h.ready()
        attempts = []
        original_close = h.io.closeInput
        def unknown_close():
            attempts.append("start")
            raise self.api.HostError("CLOSE_START_UNCONFIRMED")
        h.io.closeInput = unknown_close
        h.io.input_chunks.append((b"", True))
        h.poll()
        self.assertEqual(attempts, ["start"])
        self.assertFalse(h.io.pending())
        h.io.closeInput = original_close
        drain_after_unknown_start(h)
        self.assertNotIn("closeInput", h.names(), "같은 close 시작을 재시도하면 안 된다")
        self.assertIsNone(h.candidate())
        self.assertNotIn("IO_JOINED", h.kinds())
        self.assertIsNone(h.host.view()["finalized"])
        assert_parent_handles_open(self, h)

    def test_w2_04_close_return_exception_is_not_repolled_or_counted_as_actual_close(self):
        h = HostHarness(self)
        h.ready()
        h.io.close_complete = False
        h.io.input_chunks.append((b"", True))
        h.until(lambda: "closeInput" in h.names(), "지연 close ticket")
        attempts = []
        def unknown_close_return(ticket):
            attempts.append(ticket)
            h.io.tickets.pop(ticket, None)
            raise self.api.HostError("CLOSE_RETURN_UNCONFIRMED")
        h.io.pollClose = unknown_close_return
        h.poll()
        self.assertEqual(len(attempts), 1)
        self.assertFalse(h.io.pending())
        drain_after_unknown_start(h)
        self.assertEqual(len(attempts), 1)
        self.assertEqual(h.names().count("closeInput"), 1)
        self.assertFalse(h.io.stdin_closed)
        self.assertNotIn("IO_JOINED", h.kinds())
        self.assertIsNone(h.candidate())
        self.assertIsNone(h.host.view()["finalized"])
        assert_parent_handles_open(self, h)




class ReviewGoTimestampTests(HostTestCase):
    def test_review_01_grant_go_binds_original_fact_to_one_advancing_qpc_observation(self):
        h = HostHarness(self)
        h.bootstrap()
        def increasing_qpc():
            h.clock.ticks += 1
            return str(h.clock.ticks)
        h.clock.qpc = increasing_qpc
        h.send("GRANT_GO", {"goGrantRef": h.go})
        row = h.reach("GO_AUTHORIZED")
        originals = [fact for fact in row["source"]["facts"] if fact["kind"] == "ORIGINAL_GO"]
        self.assertEqual(len(originals), 1)
        with self.subTest(rule="one original GO observation"):
            self.assertEqual(originals[0]["qpcTicks"], row["event"]["qpcTicks"])
        with self.subTest(rule="source never later than event"):
            self.assertTrue(all(int(fact["qpcTicks"]) <= int(row["event"]["qpcTicks"])
                                for fact in row["source"]["facts"]))
        self.assertEqual(originals[0]["goGrantRef"], h.go)
        self.assertEqual(h.io.writes, [])


class ReviewFailureSourceTests(HostTestCase):
    def assert_original_failed_fact(self, h, original):
        self.assertIsNotNone(original, "실패를 일으킨 포트의 원 반환값이 있어야 한다")
        failed = h.reach("FAILED")
        matches = [fact for fact in failed["source"]["facts"] if fact.get("callId") == original["callId"]]
        self.assertEqual(len(matches), 1, "FAILED.source must retain original " + original["api"] + " callId")
        self.assertEqual(matches[0], original, "callId/qpc/status/error/value 원 반환을 정확히 보존해야 한다")
        h.poll(2)
        self.assertEqual(h.kinds().count("FAILED"), 1)

    def test_review_02_membership_false_fact_is_preserved_in_failed_source(self):
        h = HostHarness(self)
        h.prepare()
        h.ack("PRE_CREATE")
        h.ack("CREATE_ARMED")
        h.win.member = False
        h.ack("CREATED_SUSPENDED")
        original = next((f for f in h.win.facts if f["api"] == "IsProcessInJob"), None)
        self.assertEqual(original["value"], {"isMember": False})
        self.assert_original_failed_fact(h, original)

    def test_review_02_suspend_count_two_fact_is_preserved_in_failed_source(self):
        h = HostHarness(self)
        h.prepare_suspended()
        h.win.suspend_count = 2
        h.ack("PREPARED")
        original = next((f for f in h.win.facts if f["api"] == "ResumeThread"), None)
        self.assertEqual(original["value"], {"previousSuspendCount": 2})
        self.assert_original_failed_fact(h, original)

    def test_review_02_token_failure_or_mismatch_preserves_raw_fact(self):
        for mode in ("MISMATCH", "FAILED"):
            with self.subTest(mode=mode):
                h = HostHarness(self)
                h.prepare()
                h.ack("PRE_CREATE")
                h.ack("CREATE_ARMED")
                if mode == "MISMATCH":
                    h.win.tokens[0]["values"]["sidDigest"] = "f" * 64
                else:
                    def fail_token(fact):
                        if fact["api"] == "GetTokenInformation" and fact["value"]["informationClass"] == "TOKEN_USER":
                            fact.update(status="FAILED", win32Error=5, value=None)
                    h.win.rewrite_fact = fail_token
                h.ack("CREATED_SUSPENDED")
                original = next((f for f in h.win.facts if f["api"] == "GetTokenInformation" and
                    (f["status"] == "FAILED" if mode == "FAILED" else
                     f["value"]["informationClass"] == "TOKEN_USER")), None)
                self.assert_original_failed_fact(h, original)

    def test_review_02_readback_failure_or_mismatch_preserves_raw_fact(self):
        for mode in ("MISMATCH", "FAILED"):
            with self.subTest(mode=mode):
                h = HostHarness(self)
                h.prepare()
                h.ack("PRE_CREATE")
                h.ack("CREATE_ARMED")
                if mode == "MISMATCH":
                    h.win.cpu["CpuRate"] = 1000
                else:
                    def fail_readback(fact):
                        if fact["api"] == "QueryInformationJobObject" and fact["value"]["informationClass"] == "CPU_RATE":
                            fact.update(status="FAILED", win32Error=5, value=None)
                    h.win.rewrite_fact = fail_readback
                h.ack("CREATED_SUSPENDED")
                originals = [f for f in h.win.facts if f["api"] == "QueryInformationJobObject" and
                    (f["status"] == "FAILED" if mode == "FAILED" else f["value"]["informationClass"] == "CPU_RATE"
                     and f["value"]["values"]["CpuRate"] == 1000)]
                self.assertTrue(originals)
                self.assert_original_failed_fact(h, originals[-1])


def review_token_driver(case, fail_stage=None, close_mode="RETURNED"):
    f = PureDriverFixture(case)
    created = f.driver.createSuspended(f.job, f.capture["launchRef"], f.stdio, uid(610))
    case.assertEqual(created["status"], "RETURNED")
    f.process = created["process"]
    f.token_handle = 0x3200
    def fail_qpc_once(code):
        original_qpc = f.clock.qpc
        def missing():
            f.clock.qpc = original_qpc
            raise case.api.HostError(code)
        f.clock.qpc = missing
    def membership(process, job, member):
        member._obj.value = 1
        return 1
    def open_token(process, access, token):
        case.assertEqual(access, 0x8)
        token._obj.value = f.token_handle
        if fail_stage == "OPEN_TOKEN_QPC":
            fail_qpc_once("OPEN_TOKEN_QPC_RETURN_LOST")
        return 1
    def close_handle(handle):
        f.last_error = 0
        if handle == f.token_handle:
            if close_mode == "EXCEPTION":
                raise case.api.HostError("TOKEN_CLOSE_RETURN_LOST")
            if close_mode == "QPC_LOST":
                fail_qpc_once("TOKEN_CLOSE_QPC_RETURN_LOST")
            if close_mode in ("FAILED", "UNCONFIRMED"):
                f.last_error = 5 if close_mode == "FAILED" else 0
                return 0
        return 1
    f.kernel.actions["IsProcessInJob"] = membership
    f.advapi.actions["OpenProcessToken"] = open_token
    f.kernel.actions["CloseHandle"] = close_handle
    if fail_stage == "PROCESS_TIMES":
        def missing_times(*args):
            raise case.api.HostError("PROCESS_TIMES_RETURN_LOST")
        f.kernel.actions["GetProcessTimes"] = missing_times
    return f


class ReviewTokenCleanupTests(HostTestCase):
    def test_review_03_token_is_closed_once_if_open_qpc_or_followup_times_throws(self):
        for stage in ("OPEN_TOKEN_QPC", "PROCESS_TIMES"):
            for close_mode in ("RETURNED", "UNCONFIRMED"):
                with self.subTest(stage=stage, close_mode=close_mode):
                    f = review_token_driver(self, fail_stage=stage, close_mode=close_mode)
                    result, error = None, None
                    try:
                        result = f.driver.inspectRoot(f.job, f.process)
                    except self.api.HostError as caught:
                        error = caught
                    closes = [args[0] for name, args in f.calls if name == "CloseHandle"]
                    self.assertEqual(closes, [f.token_handle], "획득한 token의 CloseHandle은 모든 후속 예외에서도 한 번 시도")
                    self.assertEqual(sum(name == "OpenProcessToken" for name, args in f.calls), 1)
                    if error is None:
                        self.assertIsInstance(result, dict)
                        self.assertTrue(any(fact["status"] != "RETURNED" for fact in result["facts"]),
                                        "관측 또는 token close 미확정을 성공 fact 집합으로 반환하면 안 된다")
                    else:
                        self.assertEqual(error.next_action, "WAIT")
                    self.assertEqual(self.port_attempts, [])

    def attach_driver_job_close(self, h, f):
        h.win.job = f.job
        original_close = h.win.closeOwned
        job_errors = []
        def close_owned(handle):
            if handle is f.job:
                h.win.call("closeOwned", handle)
                h.win.closed.append(handle)
                try:
                    return f.driver.closeOwned(handle)
                except self.api.HostError as error:
                    job_errors.append(error)
                    raise
            return original_close(handle)
        h.win.closeOwned = close_owned
        return job_errors

    def test_review_03_token_close_latch_keeps_final_unknown_after_actual_job_close_returned(self):
        for mode in ("FAILED", "UNCONFIRMED", "EXCEPTION", "QPC_LOST"):
            with self.subTest(token_close=mode):
                f = review_token_driver(self, close_mode=mode)
                try:
                    f.driver.inspectRoot(f.job, f.process)
                except self.api.HostError:
                    pass  # 원 관측 실패는 허용하되 뒤 Job close의 완료 판정에서 숨기면 안 된다.
                self.assertEqual([args[0] for name, args in f.calls if name == "CloseHandle"], [f.token_handle])
                h = HostHarness(self)
                job_errors = self.attach_driver_job_close(h, f)
                h.ready()
                h.join_created()
                ack = h.control("ACK_FINAL", h.final_ref())
                h.collect(h.host.advance(ack, h.peer))
                self.assertEqual(h.host.view()["phase"], "UNCONFIRMED")
                self.assertEqual(h.host.view()["finalized"]["handles"], "UNCONFIRMED")
                self.assertEqual(len(job_errors), 1)
                original_facts = getattr(job_errors[0], "facts", None)
                self.assertIsInstance(original_facts, list, "HostError.facts는 실제 Job close 원 반환을 보존해야 한다")
                job_facts = [fact for fact in original_facts if fact["api"] == "CloseHandle"]
                self.assertEqual(len(job_facts), 1)
                self.assertEqual((job_facts[0]["status"], job_facts[0]["win32Error"], job_facts[0]["value"]),
                                 ("RETURNED", None, {"returned": True}))
                self.assertEqual(job_facts[0]["qpcTicks"], "100")
                counts = [args[0] for name, args in f.calls if name == "CloseHandle"]
                self.assertEqual(counts, [f.token_handle, 0x2100])
                h.collect(h.host.advance(ack, h.peer))
                h.send("QUERY", {})
                h.poll(2)
                self.assertEqual([args[0] for name, args in f.calls if name == "CloseHandle"], counts)
                self.assertEqual(self.port_attempts, [])

    def test_review_03_confirmed_token_close_allows_final_closed_without_reclose(self):
        f = review_token_driver(self)
        observed = f.driver.inspectRoot(f.job, f.process)
        self.assertTrue(all(fact["status"] == "RETURNED" for fact in observed["facts"]))
        h = HostHarness(self)
        job_errors = self.attach_driver_job_close(h, f)
        h.ready()
        h.join_created()
        ack = h.control("ACK_FINAL", h.final_ref())
        h.collect(h.host.advance(ack, h.peer))
        self.assertEqual(h.host.view()["phase"], "JOINED")
        self.assertEqual(h.host.view()["finalized"]["handles"], "CLOSED")
        self.assertEqual(job_errors, [])
        h.collect(h.host.advance(ack, h.peer))
        h.send("QUERY", {})
        self.assertEqual([args[0] for name, args in f.calls if name == "CloseHandle"], [f.token_handle, 0x2100])
        self.assertEqual(self.port_attempts, [])


def replace_review_path(value, path, replacement):
    target = value
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = copy.deepcopy(replacement)


class ReviewCandidateCodecTests(HostTestCase):
    def valid_candidate_message(self):
        h = HostHarness(self)
        h.ready()
        h.join_created()
        message = next(copy.deepcopy(m) for m in h.messages if m["message"] == "FINAL_CANDIDATE")
        body = independent_bytes(message)
        wire = len(body).to_bytes(4, "big") + body
        self.assertEqual(self.api.encode_host_message(message), wire)
        self.assertEqual(self.api.decode_host_message(wire), message)
        return message

    def assert_candidate_rejected_both_ways(self, message, label):
        body = independent_bytes(message)
        wire = len(body).to_bytes(4, "big") + body
        with self.subTest(case=label, codec="encode"):
            self.assert_host_error(lambda: self.api.encode_host_message(message))
        with self.subTest(case=label, codec="decode"):
            self.assert_host_error(lambda: self.api.decode_host_message(wire))

    def test_review_04_candidate_required_w1_sections_cannot_be_null(self):
        valid = self.valid_candidate_message()
        for section in ("identity", "authority", "pins", "policy", "lifecycle", "final"):
            invalid = copy.deepcopy(valid)
            invalid["payload"]["evidence"][section] = None
            self.assert_candidate_rejected_both_ways(invalid, section + "=null")

    def test_review_04_candidate_unknown_nested_keys_are_rejected_by_w1_closed_schema(self):
        valid = self.valid_candidate_message()
        paths = [
            ("identity",), ("identity", "binding"), ("identity", "sourceInput"), ("identity", "basisRef"),
            ("authority",), ("pins",), ("policy",), ("policy", "requested"),
            ("policy", "osReadback"), ("policy", "brokerApplied"),
            ("lifecycle",), ("lifecycle", "root"), ("lifecycle", "goGrantRef"), ("lifecycle", "rootExit"),
            ("lifecycle", "events", 0), ("lifecycle", "events", 0, "payload"),
            ("final",), ("final", "accounting"),
        ]
        for path in paths:
            invalid = copy.deepcopy(valid)
            target = invalid["payload"]["evidence"]
            for part in path:
                target = target[part]
            target["unexpected"] = True
            self.assert_candidate_rejected_both_ways(invalid, repr(path) + ".unexpected")

    def test_review_04_candidate_lifecycle_and_final_relations_and_values_match_w1(self):
        valid = self.valid_candidate_message()
        mutations = [
            (("lifecycle", "creation"), "NOT_ATTEMPTED"),
            (("lifecycle", "root"), None),
            (("lifecycle", "root", "pid"), 43),
            (("lifecycle", "root", "creationFileTime100ns"), "01"),
            (("lifecycle", "goGrantRef"), None),
            (("lifecycle", "goWrite"), "NOT_ATTEMPTED"),
            (("lifecycle", "rootExit"), None),
            (("lifecycle", "rootExit", "exitCode"), 1),
            (("lifecycle", "events"), []),
            (("lifecycle", "events", 0, "sequence"), 0),
            (("final", "outcome"), "NO_CHILD_CREATED"),
            (("final", "activeProcesses"), 1),
            (("final", "activeProcesses"), True),
            (("final", "rootSignaled"), False),
            (("final", "stdioJoined"), False),
            (("final", "parentIoJoined"), False),
            (("final", "recordSealed"), False),
            (("final", "accounting"), None),
            (("final", "accounting", "totalProcesses"), "0"),
            (("final", "accounting", "userTime100ns"), "18446744073709551616"),
            (("final", "failureCode"), "UNRECORDED_FAILURE"),
            (("policy", "osReadback"), None),
            (("policy", "brokerApplied"), None),
            (("policy", "requested", "cpuRatePer10000"), 2001),
        ]
        for path, replacement in mutations:
            invalid = copy.deepcopy(valid)
            replace_review_path(invalid["payload"]["evidence"], path, replacement)
            self.assert_candidate_rejected_both_ways(invalid, repr(path) + "=" + repr(replacement))


class ReviewDriverFailureSourceTests(HostTestCase):
    def check_driver_failure_source(self, stage):
        for mode in ("FAILED", "QPC_LOST"):
            with self.subTest(stage=stage, mode=mode):
                f = review_token_driver(self)
                raw_facts = []
                original_call = f.driver._call
                def observed_call(*args, **kwargs):
                    result, fact = original_call(*args, **kwargs)
                    raw_facts.append(copy.deepcopy(fact))
                    return result, fact
                f.driver._call = observed_call
                original_token = f.advapi.actions["GetTokenInformation"]
                def token_failure(token, number, data, length, needed):
                    if number == 1 and data is not None:
                        if mode == "FAILED":
                            f.last_error = 5
                            return 0
                        result = original_token(token, number, data, length, needed)
                        original_qpc = f.clock.qpc
                        def lost_once():
                            f.clock.qpc = original_qpc
                            raise self.api.HostError("TOKEN_QPC_RETURN_LOST")
                        f.clock.qpc = lost_once
                        return result
                    return original_token(token, number, data, length, needed)
                f.advapi.actions["GetTokenInformation"] = token_failure
                h = HostHarness(self, f.capture)
                if stage == "PREFLIGHT":
                    h.win.preflight = f.driver.preflight
                    h.prepare()
                    self.assertNotIn("createSuspended", h.names())
                else:
                    h.prepare()
                    h.ack("PRE_CREATE")
                    h.ack("CREATE_ARMED")
                    h.win.inspectRoot = lambda job, process: f.driver.inspectRoot(f.job, f.process)
                    h.ack("CREATED_SUSPENDED")
                    self.assertEqual([args[0] for name, args in f.calls if name == "CloseHandle"], [f.token_handle])
                failed = h.reach("FAILED")
                self.assertEqual(failed["event"]["payload"]["code"],
                                 "WINDOWS_WIN32_FAILED" if mode == "FAILED" else "TOKEN_QPC_RETURN_LOST")
                self.assertGreater(len(raw_facts), 0)
                if mode == "FAILED":
                    token_fact = next(fact for fact in raw_facts if fact["api"] == "GetTokenInformation")
                    self.assertEqual((token_fact["status"], token_fact["win32Error"], token_fact["value"]),
                                     ("FAILED", 5, None))
                for original in raw_facts:
                    matches = [fact for fact in failed["source"]["facts"] if fact.get("callId") == original["callId"]]
                    self.assertEqual(matches, [original], "driver 예외 전후 원 반환을 actor FAILED에 정확히 보존")
                self.assertIsNone(h.candidate())
                self.assertEqual(self.port_attempts, [])

    def test_review_02_driver_preflight_exception_preserves_completed_raw_facts_in_actor(self):
        self.check_driver_failure_source("PREFLIGHT")

    def test_review_02_driver_root_token_exception_preserves_completed_raw_facts_and_close_in_actor(self):
        self.check_driver_failure_source("ROOT")


class TimeContractTests(HostTestCase):
    def create_later_identity(self):
        h = HostHarness(self)
        h.prepare()
        h.ack("PRE_CREATE")
        def later(fact):
            if fact["api"] == "GetProcessTimes":
                h.clock.ticks += 3
                fact["qpcTicks"] = str(h.clock.ticks)
        h.win.rewrite_fact = later
        h.ack("CREATE_ARMED")
        h.reach("CREATED_SUSPENDED")
        h.win.rewrite_fact = None
        return h

    def test_w2_time_t02_creation_rejects_wrong_or_incomplete_original_pair(self):
        for mode in ("OTHER_REF", "EXTRA_FACT", "DUPLICATE", "MISSING", "LEGACY_REF", "FAILED", "UNCONFIRMED", "BEFORE_CREATE", "SAME_CALL"):
            with self.subTest(mode=mode):
                h = HostHarness(self)
                h.prepare()
                h.ack("PRE_CREATE")
                original = h.win.createSuspended
                def malformed(*args):
                    result = original(*args)
                    creation, time = result["facts"]
                    if mode == "OTHER_REF":
                        time["value"]["processRef"] = uid(999)
                    elif mode == "LEGACY_REF":
                        time["value"].pop("processRef", None)
                    elif mode == "EXTRA_FACT":
                        result["facts"].append(h.win.fact("GetNativeSystemInfo", {"processorArchitecture": 9}))
                    elif mode == "DUPLICATE":
                        result["facts"].append(dict(copy.deepcopy(time), callId=uid(999)))
                    elif mode == "MISSING":
                        result["facts"].remove(time)
                    elif mode in ("FAILED", "UNCONFIRMED"):
                        time.update(status=mode, win32Error=5 if mode == "FAILED" else None, value=None)
                    elif mode == "BEFORE_CREATE":
                        time["qpcTicks"] = str(int(creation["qpcTicks"]) - 1)
                    elif mode == "SAME_CALL":
                        time["callId"] = creation["callId"]
                    return result
                h.win.createSuspended = malformed
                h.ack("CREATE_ARMED")
                self.assertNotIn("CREATED_SUSPENDED", h.kinds())
                self.assertNotIn("CREATE_NOT_ATTEMPTED", h.kinds())
                self.assertNotIn("CREATE_FAILED", h.kinds())
                self.assertEqual(h.names().count("createSuspended"), 1)
                self.assertEqual(h.names().count("terminateJob"), 1)
                self.assertIsNone(h.candidate())
                self.assertEqual(self.port_attempts, [])

    def test_w2_time_t03_prepared_requires_new_original_query_and_confirmation_floor(self):
        for mode in ("REUSED_QUERY", "MISSING", "OTHER_REF", "OTHER_FILETIME", "BEFORE_FLOOR"):
            with self.subTest(mode=mode):
                h = self.create_later_identity()
                original = h.win.inspectRoot
                old_time = next(f for f in h.entry("CREATED_SUSPENDED")["source"]["facts"] if f["api"] == "GetProcessTimes")
                def malformed(*args):
                    result = original(*args)
                    time = next(f for f in result["facts"] if f["api"] == "GetProcessTimes")
                    if mode == "REUSED_QUERY":
                        result["facts"][result["facts"].index(time)] = copy.deepcopy(old_time)
                    elif mode == "MISSING":
                        result["facts"].remove(time)
                    elif mode == "OTHER_REF":
                        time["value"]["processRef"] = uid(999)
                    elif mode == "OTHER_FILETIME":
                        time["value"]["creationFileTime100ns"] = "133000000000000001"
                    elif mode == "BEFORE_FLOOR":
                        result["facts"][0]["qpcTicks"] = str(int(old_time["qpcTicks"]) - 1)
                    return result
                h.win.inspectRoot = malformed
                h.ack("CREATED_SUSPENDED")
                self.assertNotIn("PREPARED", h.kinds())
                self.assertNotIn("resume", h.names())
                self.assertIsNone(h.candidate())
                self.assertEqual(h.names().count("terminateJob"), 1)

    def test_w2_time_t01_same_tick_new_query_is_allowed_and_created_ack_remains_barrier(self):
        h = self.create_later_identity()
        h.poll(3)
        self.assertNotIn("inspectRoot", h.names())
        created = h.entry("CREATED_SUSPENDED")
        original_time = next(f for f in created["source"]["facts"] if f["api"] == "GetProcessTimes")
        def same_tick(fact):
            if fact["api"] == "GetProcessTimes":
                fact["qpcTicks"] = original_time["qpcTicks"]
        h.win.rewrite_fact = same_tick
        h.ack("CREATED_SUSPENDED")
        prepared = h.reach("PREPARED")
        new_time = next(f for f in prepared["source"]["facts"] if f.get("api") == "GetProcessTimes")
        self.assertEqual(new_time["qpcTicks"], original_time["qpcTicks"])
        self.assertNotEqual(new_time["callId"], original_time["callId"])
        h.poll(3)
        self.assertNotIn("resume", h.names())
        h.send("STOP", {"reason": "CALLER_ABORT"})
        h.ack("PREPARED")
        h.ack("CREATED_SUSPENDED")
        self.assertNotIn("resume", h.names())
        self.assertEqual(h.io.writes, [])

    def test_w2_time_t03_clock_reversal_preserves_held_facts_without_fabricated_failed_timestamp(self):
        h = self.create_later_identity()
        created = copy.deepcopy(h.entry("CREATED_SUSPENDED"))
        time = next(f for f in created["source"]["facts"] if f["api"] == "GetProcessTimes")
        h.clock.ticks = int(time["qpcTicks"]) - 1
        h.ack("CREATED_SUSPENDED")
        self.assertNotIn("PREPARED", h.kinds())
        self.assertNotIn("FAILED", h.kinds())
        self.assertEqual(h.host.view()["phase"], "UNCONFIRMED")
        self.assertEqual(h.entry("CREATED_SUSPENDED"), created)
        self.assertEqual(h.names().count("terminateJob"), 1)
        self.assertIsNone(h.candidate())
        assert_parent_handles_open(self, h)

    def test_w2_time_t03_prepared_limit_observation_cannot_precede_identity_confirmation(self):
        h = self.create_later_identity()
        time = next(f for f in h.entry("CREATED_SUSPENDED")["source"]["facts"] if f["api"] == "GetProcessTimes")
        original = h.win.queryLimits
        def stale_limit(*args):
            result = original(*args)
            result["facts"][0]["qpcTicks"] = str(int(time["qpcTicks"]) - 1)
            return result
        h.win.queryLimits = stale_limit
        h.ack("CREATED_SUSPENDED")
        self.assertNotIn("PREPARED", h.kinds())
        self.assertNotIn("resume", h.names())
        self.assertEqual(h.names().count("terminateJob"), 1)
        self.assertIsNone(h.candidate())

    def test_w2_time_t02_limit_port_cannot_add_reused_failed_or_second_identity_query(self):
        for mode in ("REUSED", "FAILED", "OTHER_REF"):
            with self.subTest(mode=mode):
                h = self.create_later_identity()
                time = next(f for f in h.entry("CREATED_SUSPENDED")["source"]["facts"] if f["api"] == "GetProcessTimes")
                original = h.win.queryLimits
                def extra_identity(*args):
                    result = original(*args)
                    extra = copy.deepcopy(time)
                    if mode == "FAILED":
                        extra.update(callId=uid(999), status="FAILED", win32Error=5, value=None)
                    elif mode == "OTHER_REF":
                        extra["callId"] = uid(999)
                        extra["value"]["processRef"] = uid(999)
                    result["facts"].append(extra)
                    return result
                h.win.queryLimits = extra_identity
                h.ack("CREATED_SUSPENDED")
                self.assertNotIn("PREPARED", h.kinds())
                self.assertNotIn("resume", h.names())
                self.assertIsNone(h.candidate())
                self.assertEqual(h.names().count("terminateJob"), 1)

    def test_w2_time_t05_fake_dll_records_original_handle_ref_and_distinct_return_qpcs(self):
        f = PureDriverFixture(self)
        def advancing_qpc():
            f.clock.ticks += 1
            return str(f.clock.ticks)
        f.clock.qpc = advancing_qpc
        result = f.driver.createSuspended(f.job, f.capture["launchRef"], f.stdio, uid(610))
        self.assertEqual(result["status"], "RETURNED")
        creation, time = result["facts"]
        self.assertGreater(int(time["qpcTicks"]), int(creation["qpcTicks"]))
        self.assertIn("processRef", time["value"], "원 handle ref가 조회 결과에 보존되어야 한다")
        self.assertEqual(time["value"]["processRef"], result["process"].ref)
        self.assertEqual(time["value"]["processRef"], creation["value"]["processRef"])
        self.assertEqual([args[0] for name, args in f.calls if name == "GetProcessTimes"], [result["process"].value])
        self.assertFalse(any(name == "OpenProcess" for name, args in f.calls))
        self.assertEqual(self.port_attempts, [])


if __name__ == "__main__":
    unittest.main()
