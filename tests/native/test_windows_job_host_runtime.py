"""W5-A의 실제 포트를 차단하고 고정 core와 runtime을 검사한다."""
import builtins
import ctypes
import io
import os
from pathlib import Path
import socket
import subprocess
import sys
import types
import unittest
from contextlib import ExitStack
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
CORE_PATH = ROOT / "packages/native/src/windows-job-host.py"
RUNTIME_PATH = ROOT / "packages/native/src/windows-job-host-runtime.py"
CORE_SOURCE = CORE_PATH.read_text(encoding="utf-8-sig")
RUNTIME_SOURCE = RUNTIME_PATH.read_text(encoding="utf-8-sig") if RUNTIME_PATH.is_file() else None


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.attempts = []
        self.guards = ExitStack()
        self.addCleanup(self.guards.close)

        def forbidden(label):
            def reject(*args, **kwargs):
                self.attempts.append(label)
                raise AssertionError("REAL_PORT_FORBIDDEN: " + label)
            return reject

        blocked = [(builtins, "open"), (io, "open"), (io, "FileIO"),
                   (os, "open"), (os, "pipe"), (os, "pipe2"), (os, "system"),
                   (os, "startfile"), (os, "spawnv"), (os, "spawnve"),
                   (os, "spawnl"), (os, "spawnle"), (os, "posix_spawn"),
                   (socket, "socket"), (socket, "socketpair"), (socket, "create_connection"),
                   (subprocess, "Popen"), (subprocess, "run"), (subprocess, "call"),
                   (subprocess, "check_call"), (subprocess, "check_output"),
                   (ctypes, "WinDLL"), (ctypes, "CDLL"), (ctypes, "OleDLL"), (ctypes, "PyDLL")]
        for owner, name in blocked:
            if hasattr(owner, name):
                self.guards.enter_context(mock.patch.object(owner, name,
                    side_effect=forbidden(owner.__name__ + "." + name)))
        for name in ("windll", "cdll", "oledll", "pydll"):
            if hasattr(ctypes, name):
                self.guards.enter_context(mock.patch.object(getattr(ctypes, name), "_dlltype",
                    side_effect=forbidden("ctypes." + name)))
        self.core = types.ModuleType("w5a_core")
        self.core.__file__ = str(CORE_PATH)
        exec(compile(CORE_SOURCE, str(CORE_PATH), "exec"), self.core.__dict__)
        self.runtime = types.ModuleType("w5a_runtime")
        self.runtime.__file__ = str(RUNTIME_PATH)
        if RUNTIME_SOURCE is not None:
            exec(compile(RUNTIME_SOURCE, str(RUNTIME_PATH), "exec"), self.runtime.__dict__)
            self.core = self.runtime.load_windows_host_core(CORE_SOURCE.encode("utf-8"))

    def tearDown(self):
        self.assertEqual(self.attempts, [], "차단된 실제 포트 시도를 숨길 수 없다")

    def check_factory_is_available_without_product_io(self):
        self.assertTrue(callable(getattr(self.runtime, "create_windows_host_runtime", None)),
                        "승인된 create_windows_host_runtime factory가 없다")


import base64
import copy
import hashlib
import hmac
import json
import struct

OLD_TEST_PATH = ROOT / "tests/native/test_windows_job_host.py"
OLD_TEST_SOURCE = OLD_TEST_PATH.read_text(encoding="utf-8-sig")
GOLDEN_UNSIGNED = b'{"body":{"attemptId":"00000000-0000-4000-8000-000000000005","clientNonce":"1111111111111111111111111111111111111111111111111111111111111111","controllerInstanceId":"00000000-0000-4000-8000-000000000006","controllerProcess":{"creationFileTime100ns":"456","pid":202,"windowsSessionId":7},"controllerSidDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","environmentDigest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","hostEpochId":"00000000-0000-4000-8000-000000000002","hostProcess":{"creationFileTime100ns":"123","pid":101,"windowsSessionId":7},"hostSidDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","launchId":"00000000-0000-4000-8000-000000000004","launchRef":"00000000-0000-4000-8000-000000000007","originDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","serverNonce":"2222222222222222222222222222222222222222222222222222222222222222","sessionId":"00000000-0000-4000-8000-000000000003"},"domain":"trio-windows-broker-v1","endpointId":"00000000-0000-4000-8000-000000000001","kind":"CHALLENGE","lane":"CONTROL","version":1}'
GOLDEN_MAC = "574e52801765a93b3e80bcea9375fcf46157b62ee81f4b160c0df68550411fe6"
CONTROL_NAME = r"\\.\pipe\trio-w5a-00000000-0000-4000-8000-000000000001-00000000-0000-4000-8000-000000000002-ctl"
IN_NAME = r"\\.\pipe\trio-w5a-00000000-0000-4000-8000-000000000001-00000000-0000-4000-8000-000000000002-00000000-0000-4000-8000-000000000003-00000000-0000-4000-8000-000000000004-aaaaaaaaaaaaaaaa-in"


def ident(n):
    return "00000000-0000-4000-8000-" + format(n, "012x")


def independent(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


FULL_WIRE_GOLDEN = json.loads(r'''{
  "capture": {
    "origin": {
      "identity": {
        "binding": {
          "accountId": "00000000-0000-4000-8000-000000000016",
          "capacityReservationId": "00000000-0000-4000-8000-000000000017",
          "jobId": "00000000-0000-4000-8000-000000000015",
          "parentInstanceId": "00000000-0000-4000-8000-000000000018",
          "inputDigest": "e064cc2694b39a57768c615269245a7dce73ad055c94e246e63bd7490bd30082",
          "profileDigest": "2021b7c372990f797e86cb0f85931f66372edc040135039b0a741c1827b3475c",
          "kernelDigest": "0cfa9728aa127866a3ccaadc571b994aa622b4fd3b85b48b47a70e3391d04583"
        },
        "intentDigest": "3a4c15e51a0dff4a561a2966e5bd7d49b6914f42ff3cd950832b476ee6ac25f8",
        "sourceInput": {
          "executionId": "00000000-0000-4000-8000-000000000019",
          "inputEvidenceId": "00000000-0000-4000-8000-00000000001a",
          "stageInputDigest": "f0122973a228dfee0c0ed515bca6edf26ad455cec6072117bbb1f7063187be7e"
        },
        "inputEvidenceDigest": "d88a7ce5a47d826a6fa4463c9423b177b0df662ca6a121997e591f944facd332",
        "inputFingerprint": "48aed2374cea5f3bbbee1c8742439be758dcc1e999e0e3f0e03c1ee80e3565a0",
        "basisRef": {
          "evidenceId": "00000000-0000-4000-8000-00000000001b",
          "evidenceDigest": "92e590c9eefab28e8a6cce5254660e360ce1c859d96536250263c11dad8425c5"
        }
      },
      "authority": {
        "attemptId": "00000000-0000-4000-8000-00000000001c",
        "controllerInstanceId": "00000000-0000-4000-8000-00000000001d",
        "controllerId": "controller",
        "keyVersion": "key-v1",
        "environmentDigest": "77c14283c58bbf3de1ec75e1c4d5544522fe0438c0869f4ffd6a7ef091da4838",
        "hostEpochId": "00000000-0000-4000-8000-000000000002",
        "sessionId": "00000000-0000-4000-8000-000000000003",
        "launchId": "00000000-0000-4000-8000-000000000004",
        "policyDigest": "a6daef5724a063b8857b196a6c3c49ceb1cdd4a5c48242173a8abc6c0de4c82c",
        "controllerSidDigest": "03f787b40211d10a2fce666f3eafb152da7c4d245876d961f130f0230b2720e0",
        "childSidDigest": "d35dd89d7a3c570c942df54e62a1ad97f1a1dc080e91cce29e2500403b9fad12",
        "appContainerSidDigest": "e5f5daac135a7e6887e9daddff45ff1ab2817d597dfcff150e1256770a228e04"
      },
      "pins": {
        "executableDigest": "e0c6740700d6cdaaad9e7029d2d95f7986a13e1a9bca94732baaab2078eb1fe3",
        "bootstrapDigest": "1debf0dd5aba45749b8fe8ce9e296f600907825a8ca99a4b3b3e8ed95eca0d0a",
        "helperRuntimeDigest": "2d0edc2f0650c5218a2cbe6022e4bad2f146e015c465a29754ad6407b054d6b3",
        "helperScriptDigest": "904f41bf5e539c854cea8059af5a1070d0d111d06bd3c8ae5b31ffde0b458fe2",
        "runtimeFilesDigest": "2d52cd9073053426a522ce4fb85745902ca2f9482e61774b7c1fa6c44a68931d",
        "nativeLimitsDigest": "6d754d28ae58d5f825473b475db4efd7d267a365a40b26bcd9e75e7e88d0a30c"
      },
      "policy": {
        "maxProcesses": 4,
        "jobCommitLimitBytes": "1048576",
        "processCommitLimitBytes": "524288",
        "cpuRatePer10000": 2000,
        "wallTimeoutMs": 1000,
        "joinTimeoutMs": 500,
        "stdoutMaxBytes": "32768",
        "stderrMaxBytes": "1024"
      },
      "limits": {
        "maxMetadataBytes": 4096,
        "maxInputBytes": 16384,
        "maxOutputBytes": 16384,
        "maxItems": 8,
        "childMemoryBytes": 16777216,
        "maxProcesses": 4,
        "timeoutMs": 1000,
        "terminationWaitMs": 500,
        "parentInFlightBytes": 1048576
      }
    },
    "originDigest": "d077c6de5b8ff64166784635a606eeaca87ca857ec011a30fe6808fc0fc1ebd9",
    "frameInputDigest": "e064cc2694b39a57768c615269245a7dce73ad055c94e246e63bd7490bd30082",
    "launchRef": "00000000-0000-4000-8000-00000000001e"
  },
  "control": {
    "version": 1,
    "requestId": "00000000-0000-4000-8000-000000000320",
    "originDigest": "d077c6de5b8ff64166784635a606eeaca87ca857ec011a30fe6808fc0fc1ebd9",
    "attemptId": "00000000-0000-4000-8000-00000000001c",
    "sessionId": "00000000-0000-4000-8000-000000000003",
    "launchId": "00000000-0000-4000-8000-000000000004",
    "command": "PREPARE",
    "payload": {
      "origin": {
        "identity": {
          "binding": {
            "accountId": "00000000-0000-4000-8000-000000000016",
            "capacityReservationId": "00000000-0000-4000-8000-000000000017",
            "jobId": "00000000-0000-4000-8000-000000000015",
            "parentInstanceId": "00000000-0000-4000-8000-000000000018",
            "inputDigest": "e064cc2694b39a57768c615269245a7dce73ad055c94e246e63bd7490bd30082",
            "profileDigest": "2021b7c372990f797e86cb0f85931f66372edc040135039b0a741c1827b3475c",
            "kernelDigest": "0cfa9728aa127866a3ccaadc571b994aa622b4fd3b85b48b47a70e3391d04583"
          },
          "intentDigest": "3a4c15e51a0dff4a561a2966e5bd7d49b6914f42ff3cd950832b476ee6ac25f8",
          "sourceInput": {
            "executionId": "00000000-0000-4000-8000-000000000019",
            "inputEvidenceId": "00000000-0000-4000-8000-00000000001a",
            "stageInputDigest": "f0122973a228dfee0c0ed515bca6edf26ad455cec6072117bbb1f7063187be7e"
          },
          "inputEvidenceDigest": "d88a7ce5a47d826a6fa4463c9423b177b0df662ca6a121997e591f944facd332",
          "inputFingerprint": "48aed2374cea5f3bbbee1c8742439be758dcc1e999e0e3f0e03c1ee80e3565a0",
          "basisRef": {
            "evidenceId": "00000000-0000-4000-8000-00000000001b",
            "evidenceDigest": "92e590c9eefab28e8a6cce5254660e360ce1c859d96536250263c11dad8425c5"
          }
        },
        "authority": {
          "attemptId": "00000000-0000-4000-8000-00000000001c",
          "controllerInstanceId": "00000000-0000-4000-8000-00000000001d",
          "controllerId": "controller",
          "keyVersion": "key-v1",
          "environmentDigest": "77c14283c58bbf3de1ec75e1c4d5544522fe0438c0869f4ffd6a7ef091da4838",
          "hostEpochId": "00000000-0000-4000-8000-000000000002",
          "sessionId": "00000000-0000-4000-8000-000000000003",
          "launchId": "00000000-0000-4000-8000-000000000004",
          "policyDigest": "a6daef5724a063b8857b196a6c3c49ceb1cdd4a5c48242173a8abc6c0de4c82c",
          "controllerSidDigest": "03f787b40211d10a2fce666f3eafb152da7c4d245876d961f130f0230b2720e0",
          "childSidDigest": "d35dd89d7a3c570c942df54e62a1ad97f1a1dc080e91cce29e2500403b9fad12",
          "appContainerSidDigest": "e5f5daac135a7e6887e9daddff45ff1ab2817d597dfcff150e1256770a228e04"
        },
        "pins": {
          "executableDigest": "e0c6740700d6cdaaad9e7029d2d95f7986a13e1a9bca94732baaab2078eb1fe3",
          "bootstrapDigest": "1debf0dd5aba45749b8fe8ce9e296f600907825a8ca99a4b3b3e8ed95eca0d0a",
          "helperRuntimeDigest": "2d0edc2f0650c5218a2cbe6022e4bad2f146e015c465a29754ad6407b054d6b3",
          "helperScriptDigest": "904f41bf5e539c854cea8059af5a1070d0d111d06bd3c8ae5b31ffde0b458fe2",
          "runtimeFilesDigest": "2d52cd9073053426a522ce4fb85745902ca2f9482e61774b7c1fa6c44a68931d",
          "nativeLimitsDigest": "6d754d28ae58d5f825473b475db4efd7d267a365a40b26bcd9e75e7e88d0a30c"
        },
        "policy": {
          "maxProcesses": 4,
          "jobCommitLimitBytes": "1048576",
          "processCommitLimitBytes": "524288",
          "cpuRatePer10000": 2000,
          "wallTimeoutMs": 1000,
          "joinTimeoutMs": 500,
          "stdoutMaxBytes": "32768",
          "stderrMaxBytes": "1024"
        },
        "limits": {
          "maxMetadataBytes": 4096,
          "maxInputBytes": 16384,
          "maxOutputBytes": 16384,
          "maxItems": 8,
          "childMemoryBytes": 16777216,
          "maxProcesses": 4,
          "timeoutMs": 1000,
          "terminationWaitMs": 500,
          "parentInFlightBytes": 1048576
        }
      },
      "launchRef": "00000000-0000-4000-8000-00000000001e"
    }
  },
  "nativeBase64": "VE1OQVRWMQAAAAGZeyJ2ZXJzaW9uIjoxLCJqb2JJZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAxNSIsInRhc2siOiJERUNPREVfSU1BR0UiLCJ0YXNrVmVyc2lvbiI6Im5hdGl2ZS1wdXJlLXYxIiwicHJvZmlsZURpZ2VzdCI6IjIwMjFiN2MzNzI5OTBmNzk3ZTg2Y2IwZjg1OTMxZjY2MzcyZWRjMDQwMTM1MDM5YjBhNzQxYzE4MjdiMzQ3NWMiLCJtZXRhZGF0YSI6e30sImJsb2JzIjpbeyJpZCI6InNvdXJjZSIsImJ5dGVMZW5ndGgiOjE1LCJzaGEyNTYiOiJlZjJkZjBiNTM5YzZjMjNkZTBmNGNiZTQyNjQ4YzMwMWFlMGUyMmU4ODczNDBhNDU5OWZiNGVmNGUyNjc4ZTQ4In1dLCJpbnB1dERpZ2VzdCI6ImUwNjRjYzI2OTRiMzlhNTc3NjhjNjE1MjY5MjQ1YTdkY2U3M2FkMDU1Yzk0ZTI0NmU2M2JkNzQ5MGJkMzAwODIifWFhYWFhYWFhYWFhYWFhYQ==",
  "controlBase64": "AAAMjnsiYXR0ZW1wdElkIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDFjIiwiY29tbWFuZCI6IlBSRVBBUkUiLCJsYXVuY2hJZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwNCIsIm9yaWdpbkRpZ2VzdCI6ImQwNzdjNmRlNWI4ZmY2NDE2Njc4NDYzNWE2MDZlZWFjYTg3Y2E4NTdlYzAxMWEzMGZlNjgwOGZjMGZjMWViZDkiLCJwYXlsb2FkIjp7ImxhdW5jaFJlZiI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAxZSIsIm9yaWdpbiI6eyJhdXRob3JpdHkiOnsiYXBwQ29udGFpbmVyU2lkRGlnZXN0IjoiZTVmNWRhYWMxMzVhN2U2ODg3ZTlkYWRkZmY0NWZmMWFiMjgxN2Q1OTdkZmNmZjE1MGUxMjU2NzcwYTIyOGUwNCIsImF0dGVtcHRJZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAxYyIsImNoaWxkU2lkRGlnZXN0IjoiZDM1ZGQ4OWQ3YTNjNTcwYzk0MmRmNTRlNjJhMWFkOTdmMWExZGMwODBlOTFjY2UyOWUyNTAwNDAzYjlmYWQxMiIsImNvbnRyb2xsZXJJZCI6ImNvbnRyb2xsZXIiLCJjb250cm9sbGVySW5zdGFuY2VJZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAxZCIsImNvbnRyb2xsZXJTaWREaWdlc3QiOiIwM2Y3ODdiNDAyMTFkMTBhMmZjZTY2NmYzZWFmYjE1MmRhN2M0ZDI0NTg3NmQ5NjFmMTMwZjAyMzBiMjcyMGUwIiwiZW52aXJvbm1lbnREaWdlc3QiOiI3N2MxNDI4M2M1OGJiZjNkZTFlYzc1ZTFjNGQ1NTQ0NTIyZmUwNDM4YzA4NjlmNGZmZDZhN2VmMDkxZGE0ODM4IiwiaG9zdEVwb2NoSWQiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDIiLCJrZXlWZXJzaW9uIjoia2V5LXYxIiwibGF1bmNoSWQiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDQiLCJwb2xpY3lEaWdlc3QiOiJhNmRhZWY1NzI0YTA2M2I4ODU3YjE5NmE2YzNjNDljZWIxY2RkNGE1YzQ4MjQyMTczYThhYmM2YzBkZTRjODJjIiwic2Vzc2lvbklkIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAzIn0sImlkZW50aXR5Ijp7ImJhc2lzUmVmIjp7ImV2aWRlbmNlRGlnZXN0IjoiOTJlNTkwYzllZWZhYjI4ZThhNmNjZTUyNTQ2NjBlMzYwY2UxYzg1OWQ5NjUzNjI1MDI2M2MxMWRhZDg0MjVjNSIsImV2aWRlbmNlSWQiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMWIifSwiYmluZGluZyI6eyJhY2NvdW50SWQiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMTYiLCJjYXBhY2l0eVJlc2VydmF0aW9uSWQiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMTciLCJpbnB1dERpZ2VzdCI6ImUwNjRjYzI2OTRiMzlhNTc3NjhjNjE1MjY5MjQ1YTdkY2U3M2FkMDU1Yzk0ZTI0NmU2M2JkNzQ5MGJkMzAwODIiLCJqb2JJZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAxNSIsImtlcm5lbERpZ2VzdCI6IjBjZmE5NzI4YWExMjc4NjZhM2NjYWFkYzU3MWI5OTRhYTYyMmI0ZmQzYjg1YjQ4YjQ3YTcwZTMzOTFkMDQ1ODMiLCJwYXJlbnRJbnN0YW5jZUlkIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDE4IiwicHJvZmlsZURpZ2VzdCI6IjIwMjFiN2MzNzI5OTBmNzk3ZTg2Y2IwZjg1OTMxZjY2MzcyZWRjMDQwMTM1MDM5YjBhNzQxYzE4MjdiMzQ3NWMifSwiaW5wdXRFdmlkZW5jZURpZ2VzdCI6ImQ4OGE3Y2U1YTQ3ZDgyNmE2ZmE0NDYzYzk0MjNiMTc3YjBkZjY2MmNhNmExMjE5OTdlNTkxZjk0NGZhY2QzMzIiLCJpbnB1dEZpbmdlcnByaW50IjoiNDhhZWQyMzc0Y2VhNWYzYmJiZWUxYzg3NDI0MzliZTc1OGRjYzFlOTk5ZTBlM2YwZTAzYzFlZTgwZTM1NjVhMCIsImludGVudERpZ2VzdCI6IjNhNGMxNWU1MWEwZGZmNGE1NjFhMjk2NmU1YmQ3ZDQ5YjY5MTRmNDJmZjNjZDk1MDgzMmI0NzZlZTZhYzI1ZjgiLCJzb3VyY2VJbnB1dCI6eyJleGVjdXRpb25JZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAxOSIsImlucHV0RXZpZGVuY2VJZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAxYSIsInN0YWdlSW5wdXREaWdlc3QiOiJmMDEyMjk3M2EyMjhkZmVlMGMwZWQ1MTViY2E2ZWRmMjZhZDQ1NWNlYzYwNzIxMTdiYmIxZjcwNjMxODdiZTdlIn19LCJsaW1pdHMiOnsiY2hpbGRNZW1vcnlCeXRlcyI6MTY3NzcyMTYsIm1heElucHV0Qnl0ZXMiOjE2Mzg0LCJtYXhJdGVtcyI6OCwibWF4TWV0YWRhdGFCeXRlcyI6NDA5NiwibWF4T3V0cHV0Qnl0ZXMiOjE2Mzg0LCJtYXhQcm9jZXNzZXMiOjQsInBhcmVudEluRmxpZ2h0Qnl0ZXMiOjEwNDg1NzYsInRlcm1pbmF0aW9uV2FpdE1zIjo1MDAsInRpbWVvdXRNcyI6MTAwMH0sInBpbnMiOnsiYm9vdHN0cmFwRGlnZXN0IjoiMWRlYmYwZGQ1YWJhNDU3NDliOGZlOGNlOWUyOTZmNjAwOTA3ODI1YThjYTk5YTRiM2IzZThlZDk1ZWNhMGQwYSIsImV4ZWN1dGFibGVEaWdlc3QiOiJlMGM2NzQwNzAwZDZjZGFhYWQ5ZTcwMjlkMmQ5NWY3OTg2YTEzZTFhOWJjYTk0NzMyYmFhYWIyMDc4ZWIxZmUzIiwiaGVscGVyUnVudGltZURpZ2VzdCI6IjJkMGVkYzJmMDY1MGM1MjE4YTJjYmU2MDIyZTRiYWQyZjE0NmUwMTVjNDY1YTI5NzU0YWQ2NDA3YjA1NGQ2YjMiLCJoZWxwZXJTY3JpcHREaWdlc3QiOiI5MDRmNDFiZjVlNTM5Yzg1NGNlYTgwNTlhZjVhMTA3MGQwZDExMWQwNmJkM2M4YWU1YjMxZmZkZTBiNDU4ZmUyIiwibmF0aXZlTGltaXRzRGlnZXN0IjoiNmQ3NTRkMjhhZTU4ZDVmODI1NDczYjQ3NWRiNGVmZDdkMjY3YTM2NWE0MGIyNmJjZDllNzVlN2U4OGQwYTMwYyIsInJ1bnRpbWVGaWxlc0RpZ2VzdCI6IjJkNTJjZDkwNzMwNTM0MjZhNTIyY2U0ZmI4NTc0NTkwMmNhMmY5NDgyZTYxNzc0YjdjMWZhNmM0NGE2ODkzMWQifSwicG9saWN5Ijp7ImNwdVJhdGVQZXIxMDAwMCI6MjAwMCwiam9iQ29tbWl0TGltaXRCeXRlcyI6IjEwNDg1NzYiLCJqb2luVGltZW91dE1zIjo1MDAsIm1heFByb2Nlc3NlcyI6NCwicHJvY2Vzc0NvbW1pdExpbWl0Qnl0ZXMiOiI1MjQyODgiLCJzdGRlcnJNYXhCeXRlcyI6IjEwMjQiLCJzdGRvdXRNYXhCeXRlcyI6IjMyNzY4Iiwid2FsbFRpbWVvdXRNcyI6MTAwMH19fSwicmVxdWVzdElkIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMzIwIiwic2Vzc2lvbklkIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAzIiwidmVyc2lvbiI6MX0=",
  "captureDigest": "59652bdc734e5ba4c8bd37958c5de4633abf3de8c557938fb90284a722910098",
  "nativeDigest": "b8d2c1d0cb241831e2f321aad86644771053474216285c2e1316a0b61736d0eb",
  "controlDigest": "5694a99e485ced078c2cf2cb8e4a667bd9d6749b3716bb2d02bbd4fc0d4b3821"
}''')


class Memory:
    maxBytes = 8 * 1024 * 1024

    def __init__(self):
        self.used = 0
        self.peak = 0

    def available(self):
        return self.maxBytes - self.used

    def hold(self, count):
        if count < 0 or count > self.available():
            raise ValueError("MEMORY_LIMIT")
        self.used += count
        self.peak = max(self.peak, self.used)
        released = False

        def release():
            nonlocal released
            if released:
                raise AssertionError("DOUBLE_RELEASE")
            released = True
            self.used -= count
        return release


class Operation:
    def __init__(self, kind, handle=None, value=None):
        self.kind, self.handle = kind, handle
        self.result = None if value is None else {"state": "RETURNED", "value": value}
        self.cancelled = False
        self.finished = False
        self.size = None


class FakeSys:
    def __init__(self, peer):
        self.peer_value = peer
        self.listeners = {}
        self.incoming = {}
        self.reads = {}
        self.writes = {}
        self.ops = []
        self.closes = []
        self.next_raw = 0x5000
        self.partial = 65536
        self.delay_cancel = False
        self.delay_close = False
        self.fail_cancel = False
        self.stdio_partial = None
        self.events = []

    def listen(self, name, mode, acl):
        self.events.append(("listen", name, mode, copy.deepcopy(acl)))
        handle = object()
        self.listeners[name] = handle
        self.incoming[handle] = []
        return handle

    def accept(self, listener):
        return self.add(Operation("accept", listener))

    def read(self, handle, n):
        self.events.append(("read", handle, n))
        op = Operation("read", handle)
        op.size = n
        return self.add(op)

    def write(self, handle, data, offset):
        count = min(len(data) - offset, self.partial)
        self.writes.setdefault(handle, bytearray()).extend(data[offset:offset + count])
        self.events.append(("write", handle, bytes(data), offset))
        return self.add(Operation("write", handle, {"transferred": count}))

    def close(self, handle):
        self.events.append(("close", handle))
        self.closes.append(handle)
        return self.add(Operation("close", handle, None if self.delay_close else {"closed": True}))

    def cancel(self, op):
        self.events.append(("cancel", op))
        if self.fail_cancel:
            raise ValueError("CANCEL_RETURN_LOST")
        op.cancelled = True

    def poll(self, op):
        if op.finished:
            raise AssertionError("COMPLETION_REUSED")
        if op.result is None:
            queue = self.incoming.get(op.handle, []) if op.kind == "accept" else self.reads.get(op.handle, [])
            if op.kind in ("read", "accept") and queue:
                value = queue.pop(0)
                if op.kind == "read":
                    if value is None:
                        op.result = {"state": "RETURNED", "value": {"data": b"", "eof": True}}
                    else:
                        data = value[:op.size]
                        if len(value) > len(data):
                            queue.insert(0, value[len(data):])
                        op.result = {"state": "RETURNED", "value": {"data": data, "eof": False}}
                else:
                    op.result = {"state": "RETURNED", "value": value}
            elif op.cancelled and not self.delay_cancel:
                op.result = {"state": "FAILED", "code": "OP_CANCELLED"}
        if op.result is not None:
            op.finished = True
        return op.result

    def peer(self, handle):
        return copy.deepcopy(self.peer_value)

    def open_stdio(self):
        raw = list(range(self.next_raw + 1, self.next_raw + 7))
        self.next_raw += 6
        if self.stdio_partial is not None:
            error = ValueError("PARTIAL_STDIO")
            error.owned = raw[:self.stdio_partial]
            raise error
        self.raw_stdio = raw
        return {"childHandles": raw[:3], "owned": raw[3:]}

    def add(self, op):
        self.ops.append(op)
        return op

    def connect(self, name):
        handle = object()
        self.incoming[self.listeners[name]].append(handle)
        return handle

    def feed(self, handle, *packets):
        self.reads.setdefault(handle, []).extend(packets)


class RuntimeHarness:
    def __init__(self, case):
        self.case = case
        self.core = case.core
        old = types.ModuleType("w5a_old_fixtures")
        old.__file__ = str(OLD_TEST_PATH)
        with mock.patch.object(Path, "read_text", side_effect=lambda *a, **k: CORE_SOURCE):
            exec(compile(OLD_TEST_SOURCE, str(OLD_TEST_PATH), "exec"), old.__dict__)
        self.old = old
        self.capture, _, _ = old.capture_fixture()
        a = self.capture["origin"]["authority"]
        a.update(hostEpochId=ident(2), sessionId=ident(3), launchId=ident(4), controllerInstanceId=ident(6))
        self.sids = {1: ctypes.create_string_buffer(b"childSID"), 31: ctypes.create_string_buffer(b"appcnSID"),
                     25: ctypes.create_string_buffer(b"low-SID!")}
        a["childSidDigest"] = hashlib.sha256(b"childSID").hexdigest()
        a["appContainerSidDigest"] = hashlib.sha256(b"appcnSID").hexdigest()
        old.refresh_capture(self.capture)
        self.clock, self.ids, self.memory = old.FakeClock(), old.FakeIds(100000), Memory()
        self.ids.nonce = lambda: bytes.fromhex("22" * 32)
        self.bootstrap = {"version": 1, "hostEpochId": a["hostEpochId"], "environmentDigest": a["environmentDigest"],
            "controllerInstanceId": a["controllerInstanceId"], "endpointId": ident(1),
            "hostProcess": {"pid": 101, "creationFileTime100ns": "1", "windowsSessionId": 7},
            "controllerProcess": {"pid": 102, "creationFileTime100ns": "2", "windowsSessionId": 7},
            "hostSidDigest": "c" * 64, "controllerSidDigest": a["controllerSidDigest"], "key": bytes(range(32))}
        self.peer = {**self.bootstrap["controllerProcess"], "sidDigest": self.bootstrap["controllerSidDigest"]}
        self.sys = FakeSys(self.peer)
        self.registration = {"bootstrap": self.bootstrap,
            "launch": {"files": [{"id": "node", "path": r"C:\synthetic\child.exe", "bytes": 1, "sha256": "e" * 64, "role": "EXECUTABLE"}], "executableId": "node", "argv": ["synthetic-child"], "cwd": r"C:\synthetic",
                "environment": {"SYNTHETIC": "1"}, "token": 0x3100, "appContainerSid": ctypes.addressof(self.sids[31]),
                "expectedToken": {"childSidDigest": a["childSidDigest"], "appContainerSidDigest": a["appContainerSidDigest"],
                    "integritySidDigest": hashlib.sha256(b"low-SID!").hexdigest(), "capabilityCount": 0, "windowsSessionId": 7},
                "allowedPolicy": copy.deepcopy(self.capture["origin"]["policy"])},
            "bounds": {"maxControlBytes": 131072, "maxChunkBytes": 64, "streamHighWaterMarkBytes": 32,
                "maxQueuedBytes": 1048576, "maxInFlightBytes": 4194304, "maxRetainedRecords": 2,
                "handshakeMilliseconds": 100, "closeMilliseconds": 100, "maxPendingOperations": 32}}
        self.current = True
        self.driver_calls = []
        self.dll_calls = []
        self.create_result, self.last_error, self.signaled = 1, 0, False
        self.sets = {}
        self.auth_count = 0
        self.validation = types.SimpleNamespace(verify_registration=self.verify, authorize_capture=self.authorize,
            validate_current=lambda cap, digest: cap["originDigest"] if self.current else None,
            is_registration_current=lambda digest: self.current)
        self.ports = {"core": self.core, "makeDriver": self.make_driver, "sys": self.sys,
            "validation": self.validation, "clock": self.clock, "ids": self.ids, "memory": self.memory}
        self.runtime = case.runtime.create_windows_host_runtime(self.registration, self.ports)
        self.handle = None
        self.decoded = []
        self.control_cursor = 0
        self.request = 9000

    def verify(self, registration):
        descriptor = {"version": 1, "bootstrap": {k: v for k, v in registration["bootstrap"].items() if k != "key"},
            "launch": {k: v for k, v in registration["launch"].items() if k not in ("token", "appContainerSid")}, "bounds": registration["bounds"]}
        return hashlib.sha256(independent(descriptor)).hexdigest()

    def authorize(self, capture, digest):
        self.auth_count += 1
        return self.core.LaunchCapability(launch_ref=capture["launchRef"], origin_digest=capture["originDigest"],
            executable=r"C:\synthetic\child.exe", command_line="synthetic-child", directory=r"C:\synthetic",
            environment="SYNTHETIC=1\0\0", token=0x3100, appcontainer_sid=ctypes.addressof(self.sids[31]),
            windows_session_id=7, validate_current=lambda: capture["originDigest"] if self.current else None)

    def make_driver(self, core, resolver, clock, ids):
        self.driver_calls.append((core, resolver, clock, ids))
        class Ctypes:
            def __getattr__(inner, name):
                if name == "get_last_error":
                    return lambda: self.last_error
                if name == "set_last_error":
                    return lambda n: setattr(self, "last_error", n)
                return getattr(ctypes, name)
        def system(p):
            p._obj.architecture = 9
        def machine(p, pm, nm):
            pm._obj.value, nm._obj.value = 0, 0x8664
            return 1
        def session(pid, value):
            value._obj.value = 7
            return 1
        def token(handle, number, data, n, needed):
            needed._obj.value = 4 if number in (29, 12) else ctypes.sizeof(ctypes.c_void_p)
            if data is None:
                self.last_error = 122
                return 0
            if number in (29, 12):
                ctypes.cast(data, ctypes.POINTER(ctypes.c_uint32)).contents.value = 1 if number == 29 else 7
            else:
                ctypes.cast(data, ctypes.POINTER(ctypes.c_void_p)).contents.value = ctypes.addressof(self.sids[number])
            return 1
        def attributes(storage, count, flags, n):
            if storage is None:
                n._obj.value, self.last_error = 128, 122
                return 0
            return 1
        def create(*args):
            if not self.create_result:
                self.last_error = 5
                return 0
            p = args[-1]._obj
            p.hProcess, p.hThread, p.dwProcessId, p.dwThreadId = 0x2201, 0x2202, 42, 43
            return 1
        def times(process, created, exited, kernel, user):
            created._obj.low, created._obj.high = 5, 1
            return 1
        def set_limits(job, number, pointer, size):
            self.sets[number] = bytes(pointer._obj)
            return 1
        def query(job, number, pointer, size, returned):
            if number in self.sets:
                ctypes.memmove(ctypes.addressof(pointer._obj), self.sets[number], size)
            else:
                value = pointer._obj.BasicInfo if number == 8 else pointer._obj
                value.TotalProcesses, value.ActiveProcesses = 1, 0 if self.signaled else 1
            returned._obj.value = size
            return 1
        def member(p, j, out):
            out._obj.value = 1
            return 1
        def open_token(p, rights, out):
            out._obj.value = 0x3200
            return 1
        def code(p, out):
            out._obj.value = 0
            return 1
        def qpc(out):
            out._obj.value = self.clock.ticks
            return 1
        def hz(out):
            out._obj.value = int(self.clock.hz)
            return 1
        kernel = self.old.FakeDll(self.dll_calls, {"GetNativeSystemInfo": system, "IsWow64Process2": machine,
            "GetCurrentProcess": lambda: 100, "GetCurrentProcessId": lambda: 42, "ProcessIdToSessionId": session,
            "CreateJobObjectW": lambda *a: 0x2100, "SetInformationJobObject": set_limits,
            "QueryInformationJobObject": query, "InitializeProcThreadAttributeList": attributes,
            "UpdateProcThreadAttribute": lambda *a: 1, "DeleteProcThreadAttributeList": lambda *a: None,
            "GetProcessTimes": times, "CloseHandle": lambda *a: 1, "IsProcessInJob": member,
            "ResumeThread": lambda *a: 1, "WaitForSingleObject": lambda *a: 0 if self.signaled else 258,
            "GetExitCodeProcess": code, "TerminateJobObject": lambda *a: 1,
            "QueryPerformanceCounter": qpc, "QueryPerformanceFrequency": hz})
        advapi = self.old.FakeDll(self.dll_calls, {"GetTokenInformation": token, "IsValidSid": lambda *a: 1,
            "GetLengthSid": lambda *a: 8, "CreateProcessAsUserW": create, "OpenProcessToken": open_token})
        self.driver = core._CtypesWin32(Ctypes(), kernel, advapi, resolver, clock, ids)
        self.kernel, self.advapi = kernel, advapi
        return self.driver

    def private(self, kind, lane, body):
        value = {"version": 1, "domain": "trio-windows-broker-v1", "kind": kind,
                 "endpointId": self.bootstrap["endpointId"], "lane": lane, "body": body}
        value["mac"] = hmac.new(self.bootstrap["key"], independent(value), hashlib.sha256).hexdigest()
        raw = independent(value)
        return struct.pack(">I", len(raw)) + raw

    def run(self, count=1):
        for _ in range(count):
            self.runtime.poll()
            if self.handle is not None:
                raw = self.sys.writes.get(self.handle, bytearray())
                while len(raw) - self.control_cursor >= 4:
                    n = int.from_bytes(raw[self.control_cursor:self.control_cursor + 4], "big")
                    if len(raw) - self.control_cursor < n + 4:
                        break
                    self.decoded.append(json.loads(bytes(raw[self.control_cursor + 4:self.control_cursor + 4 + n])))
                    self.control_cursor += n + 4

    def until(self, predicate, count=1500):
        for _ in range(count):
            if predicate():
                return
            self.run()
        self.case.fail("runtime 진행이 완료되지 않았다: " + repr(self.runtime.view()))

    def handshake(self, attach=True):
        self.runtime.start()
        self.handle = self.sys.connect(CONTROL_NAME)
        self.sys.feed(self.handle, self.private("OPEN", "CONTROL", {"capture": self.capture,
            "controllerInstanceId": self.bootstrap["controllerInstanceId"], "clientNonce": "11" * 32}))
        self.until(lambda: any(v.get("kind") == "CHALLENGE" for v in self.decoded))
        self.body = copy.deepcopy(next(v["body"] for v in self.decoded if v.get("kind") == "CHALLENGE"))
        self.sys.feed(self.handle, self.private("AUTH", "CONTROL", self.body))
        self.until(lambda: any(v.get("kind") == "ACCEPT" for v in self.decoded))
        if attach:
            for lane in ("IN", "OUT", "ERR"):
                name = CONTROL_NAME[:-4] + "-" + ident(3) + "-" + ident(4) + "-" + self.capture["originDigest"][:16] + "-" + lane.lower()
                handle = self.sys.connect(name)
                setattr(self, lane.lower(), handle)
                self.sys.feed(handle, self.private("ATTACH", lane, self.body))
            self.until(lambda: bool(self.driver_calls))
        return self

    def send(self, command, payload):
        self.request += 1
        a = self.capture["origin"]["authority"]
        value = {"version": 1, "requestId": ident(self.request), "originDigest": self.capture["originDigest"],
            "attemptId": a["attemptId"], "sessionId": a["sessionId"], "launchId": a["launchId"],
            "command": command, "payload": payload}
        self.sys.feed(self.handle, self.core.encode_control(value))
        self.run(20)

    def events(self):
        return [v["payload"] for v in self.decoded if v.get("message") == "EVENT"]

    def ack(self, kind):
        self.until(lambda: any(e["event"]["kind"] == kind for e in self.events()))
        row = next(e for e in self.events() if e["event"]["kind"] == kind)
        self.send("ACK_EVENT", {"eventId": row["event"]["eventId"],
            "payloadDigest": row["event"]["payloadDigest"], "sourceDigest": row["sourceDigest"]})


class ContractTests(RuntimeTests):
    def test_factory_is_available_without_product_io(self):
        self.check_factory_is_available_without_product_io()

    def test_golden_address_and_private_hmac_match_literal(self):
        value = json.loads(GOLDEN_UNSIGNED)
        bootstrap = {"endpointId": ident(1), "hostEpochId": ident(2)}
        capture = {"originDigest": "a" * 64, "origin": {"authority": {"sessionId": ident(3), "launchId": ident(4)}}}
        self.assertEqual(self.runtime.pipe_name(bootstrap, None, "CONTROL"), CONTROL_NAME)
        self.assertEqual(self.runtime.pipe_name(bootstrap, capture, "IN"), IN_NAME)
        self.assertEqual(self.runtime.canonical_unsigned(dict(value, mac=GOLDEN_MAC)), GOLDEN_UNSIGNED)
        self.assertEqual(self.runtime.private_mac(bytes(range(32)), value), GOLDEN_MAC)
        self.assertEqual(hashlib.sha256(GOLDEN_UNSIGNED).hexdigest(), "6e8bb0961ad006a5f853126ecefe98456be4cc85abd6632051a3fcc1035e92b2")

    def test_factory_and_disabled_real_factory_are_pure(self):
        h = RuntimeHarness(self)
        self.assertEqual(h.runtime.view(), {"accepting": False, "activeSessions": 0, "retainedRecords": 0,
            "heldBytes": 0, "pendingOperations": 0, "unconfirmed": False})
        self.assertEqual(h.sys.events, [])
        self.assertEqual(h.driver_calls, [])
        with self.assertRaises(ValueError):
            self.runtime.create_real_windows_host_runtime(h.registration, h.validation)
        self.assertEqual(self.attempts, [])

    def test_only_four_authenticated_lanes_can_construct_real_actor(self):
        h = RuntimeHarness(self).handshake(attach=False)
        self.assertEqual(h.driver_calls, [])
        h.runtime.close()
        h.run(100)
        self.assertEqual(h.driver_calls, [])
        self.assertFalse(any(name == "CreateProcessAsUserW" for name, args in h.dll_calls))

    def test_handshake_prepares_real_core_and_same_driver_six_opaque_stdio(self):
        h = RuntimeHarness(self).handshake()
        self.assertIsInstance(h.runtime._actor, self.core.WindowsJobHost)
        h.send("PREPARE", {"origin": h.capture["origin"], "launchRef": h.capture["launchRef"]})
        h.ack("PRE_CREATE")
        handles = h.runtime._io.openStdio()
        self.assertEqual(len(handles["childHandles"] + handles["owned"]), 6)
        self.assertEqual(len(set(h.driver._handle(v, "PIPE") for v in handles["childHandles"] + handles["owned"])), 6)
        self.assertIs(h.runtime._io.driver, h.driver)
        self.assertEqual(len(h.driver_calls), 1)
        other = h.make_driver(self.core, h.driver.resolver, h.clock, h.ids)
        with self.assertRaises(self.core.HostError):
            other._handle(handles["childHandles"][0], "PIPE")

    def test_no_create_candidate_requires_original_parent_ack(self):
        h = RuntimeHarness(self).handshake()
        h.current = False
        h.send("PREPARE", {"origin": h.capture["origin"], "launchRef": h.capture["launchRef"]})
        h.run(50)
        self.assertFalse(any(v.get("message") == "FINAL_CANDIDATE" for v in h.decoded))
        self.assertFalse(any(name == "CreateProcessAsUserW" for name, args in h.dll_calls))





class LifecycleTests(RuntimeTests):
    def prepared(self, h=None):
        h = h or RuntimeHarness(self).handshake()
        h.send("PREPARE", {"origin": h.capture["origin"], "launchRef": h.capture["launchRef"]})
        h.ack("PRE_CREATE")
        h.ack("CREATE_ARMED")
        h.ack("CREATED_SUSPENDED")
        h.ack("PREPARED")
        return h

    def ready(self, h=None):
        h = self.prepared(h)
        for b in b"WAIT_V1\n":
            h.sys.feed(h.sys.raw_stdio[4], bytes([b]))
        h.ack("BOOTSTRAP_RESUMED")
        h.send("GRANT_GO", {"goGrantRef": {"jobId": h.capture["origin"]["identity"]["binding"]["jobId"], "rowDigest": "e" * 64}})
        h.ack("GO_AUTHORIZED")
        h.ack("GO_WRITE_ARMED")
        h.until(lambda: any(e["event"]["kind"] == "GO_WRITE" for e in h.events()))
        for b in b"READY_V1\n":
            h.sys.feed(h.sys.raw_stdio[4], bytes([b]))
        h.until(lambda: any(v.get("message") == "PROGRESS" and v["payload"]["bootstrap"] == "READY" for v in h.decoded))
        return h

    def ack_all(self, h):
        done = set()
        for _ in range(20):
            todo = [r for r in h.events() if r["event"]["eventId"] not in done]
            if not todo:
                return
            for row in todo:
                done.add(row["event"]["eventId"])
                h.send("ACK_EVENT", {"eventId": row["event"]["eventId"], "payloadDigest": row["event"]["payloadDigest"], "sourceDigest": row["sourceDigest"]})
        self.fail("원 ACK 처리가 끝나지 않았다")

    def finish(self, h):
        self.ack_all(h)
        self.assertFalse(any(v.get("message") == "FINAL_CANDIDATE" for v in h.decoded))
        parent = {"joinId": ident(800), "originDigest": h.capture["originDigest"], "digest": "f" * 64}
        h.send("PARENT_JOINED", parent)
        self.ack_all(h)
        h.until(lambda: any(v.get("message") == "FINAL_CANDIDATE" for v in h.decoded))
        candidate = next(v["payload"]["evidence"] for v in h.decoded if v.get("message") == "FINAL_CANDIDATE")
        wrapper = {"version": 1, "originDigest": h.capture["originDigest"], "evidence": candidate,
            "entries": [{"eventId": r["event"]["eventId"], "payloadDigest": r["event"]["payloadDigest"], "sourceDigest": r["sourceDigest"]} for r in h.events()],
            "parentJoinAck": parent}
        h.send("ACK_FINAL", {"recordId": ident(801), "digest": hashlib.sha256(independent(wrapper)).hexdigest()})
        h.until(lambda: any(v.get("message") == "FINALIZED" for v in h.decoded))
        h.runtime.close()
        h.until(lambda: h.runtime.join() is not None)
        return h.runtime.join()

    def test_markers_fragment_into_eight_and_nine_bytes_without_forwarding(self):
        h = self.ready()
        wait = next(e for e in h.events() if e["event"]["kind"] == "BOOTSTRAP_RESUMED")
        wait_fact = next(f for f in wait["source"]["facts"] if f["kind"] == "IO")
        ready_fact = next(v["payload"]["bootstrapFact"] for v in h.decoded if v.get("message") == "PROGRESS" and v["payload"]["bootstrap"] == "READY")
        self.assertEqual(wait_fact["bytesLength"], "8")
        self.assertEqual(wait_fact["sha256"], hashlib.sha256(b"WAIT_V1\n").hexdigest())
        self.assertEqual(ready_fact["bytesLength"], "9")
        self.assertNotEqual(wait_fact["callId"], ready_fact["callId"])
        raw = bytes(h.sys.writes[h.out])
        self.assertNotIn(b"WAIT_V1\n", raw)
        self.assertNotIn(b"READY_V1\n", raw)
        self.assertEqual(bytes(h.sys.writes[h.sys.raw_stdio[3]]), b"GO_V1\n")

    def test_marker_partial_eof_preserves_short_read_and_distinct_original_eof(self):
        h = self.prepared()
        h.sys.feed(h.sys.raw_stdio[4], b"WA", None)
        h.sys.feed(h.sys.raw_stdio[5], None)
        h.run(80)
        self.assertEqual(h.runtime._actor.failure, "WINDOWS_BOOTSTRAP_INVALID")
        eof = h.runtime._actor.eof["OUT"]
        self.assertEqual(eof["bytesLength"], "0")
        self.assertEqual(eof["sha256"], hashlib.sha256(b"").hexdigest())
        self.assertFalse(any(v.get("message") == "FINALIZED" for v in h.decoded))

    def test_both_no_child_paths_wait_for_parent_then_close_all_lanes(self):
        for mode in ("NOT_ATTEMPTED", "FAILED"):
            with self.subTest(mode=mode):
                h = RuntimeHarness(self).handshake()
                if mode == "NOT_ATTEMPTED":
                    def deny(*args):
                        raise self.core.HostError("PIN_DRIFT")
                    h.kernel.actions["GetNativeSystemInfo"] = deny
                else:
                    h.create_result = 0
                h.send("PREPARE", {"origin": h.capture["origin"], "launchRef": h.capture["launchRef"]})
                if mode == "FAILED":
                    h.ack("PRE_CREATE")
                    h.ack("CREATE_ARMED")
                h.until(lambda: any(e["event"]["kind"] == ("CREATE_NOT_ATTEMPTED" if mode == "NOT_ATTEMPTED" else "CREATE_FAILED") for e in h.events()))
                joined = self.finish(h)
                self.assertEqual(joined["end"], "EXPECTED", repr(joined))
                self.assertEqual(joined["records"][0]["phase"], "JOINED")
                self.assertEqual(joined["records"][0]["finalized"]["handles"], "CLOSED")
                self.assertEqual(h.runtime.view()["heldBytes"], 0)
                self.assertEqual(h.memory.used, 0)
                self.assertEqual(sum(n == "CreateProcessAsUserW" for n, a in h.dll_calls), 0 if mode == "NOT_ATTEMPTED" else 1)
                self.assertFalse(any(e["event"]["kind"] == "GO_WRITE" for e in h.events()))
                self.assertFalse(any(e["event"]["kind"] == "IO_JOINED" for e in h.events()))
                self.assertEqual(len(h.sys.closes), len(set(map(id, h.sys.closes))))

    def test_partial_write_full_input_and_close_ledger_remain_original(self):
        h = self.ready()
        h.sys.partial = 2
        h.sys.feed(getattr(h, "in"), b"input")
        h.until(lambda: bytes(h.sys.writes.get(h.sys.raw_stdio[3], b"")) == b"GO_V1\ninput")
        h.sys.feed(getattr(h, "in"), None)
        h.until(lambda: h.runtime._actor.input_closed is not None)
        handle = h.runtime._actor.stdio["owned"][0]
        io_fact = copy.deepcopy(h.runtime._actor.input_closed)
        win_fact = h.runtime._facade.closeOwned(handle)
        self.assertNotEqual(io_fact["callId"], win_fact["facts"][0]["callId"])
        self.assertEqual(io_fact["qpcTicks"], win_fact["facts"][0]["qpcTicks"])
        h.clock.ticks += 10
        self.assertEqual(h.runtime._facade.closeOwned(handle), win_fact)
        self.assertEqual(sum(n == "CloseHandle" and a[0] == h.sys.raw_stdio[3] for n, a in h.dll_calls), 1)

    def test_hidden_input_read_cancel_waits_completion_and_drops_late_bytes(self):
        h = self.ready()
        h.run(8)
        hidden = h.runtime._io._input
        self.assertIsNotNone(hidden)
        held = h.memory.used
        h.sys.delay_cancel = True
        h.signaled = True
        h.run(2)
        self.assertTrue(hidden.operation.cancelled)
        self.assertIsNone(h.runtime.join())
        self.assertGreaterEqual(h.memory.used, 64)
        h.sys.feed(getattr(h, "in"), b"late-secret")
        h.run(20)
        self.assertIsNone(h.runtime._io._input)
        self.assertNotIn(b"late-secret", bytes(h.sys.writes.get(h.sys.raw_stdio[3], b"")))
        self.assertGreater(held, 0)

    def test_full_original_actor_finishes_only_after_eof_parent_seal_and_transport_close(self):
        h = self.ready()
        h.sys.feed(h.sys.raw_stdio[4], b"native-frame", None)
        h.sys.feed(h.sys.raw_stdio[5], b"stderr", None)
        h.sys.feed(getattr(h, "in"), None)
        h.run(30)
        self.assertNotIn("IO_JOINED", [e["event"]["kind"] for e in h.events()])
        h.signaled = True
        h.run(30)
        self.assertIsNone(h.runtime.join())
        joined = self.finish(h)
        self.assertEqual(joined["end"], "EXPECTED", repr(joined))
        self.assertEqual(joined, h.runtime.join())
        self.assertEqual(h.runtime.view()["pendingOperations"], 0)
        self.assertEqual(h.memory.used, 0)
        self.assertTrue(bytes(h.sys.writes[h.out]).endswith(b"native-frame"))
        self.assertTrue(bytes(h.sys.writes[h.err]).endswith(b"stderr"))
        self.assertEqual(sum(n == "CreateProcessAsUserW" for n, a in h.dll_calls), 1)
        self.assertEqual(sum(n == "ResumeThread" for n, a in h.dll_calls), 1)

    def test_partial_stdio_failure_closes_unaccepted_raw_endpoints_once(self):
        h = RuntimeHarness(self).handshake()
        h.sys.stdio_partial = 2
        h.send("PREPARE", {"origin": h.capture["origin"], "launchRef": h.capture["launchRef"]})
        h.ack("PRE_CREATE")
        self.assertFalse(any(n == "CreateProcessAsUserW" for n, a in h.dll_calls))
        closes = [a[0] for n, a in h.dll_calls if n == "CloseHandle"]
        self.assertEqual(closes, [0x5001, 0x5002])
        self.assertIsNone(h.runtime.join())

    def test_close_return_lost_never_retries_raw_close_or_fakes_io_fact(self):
        h = self.ready()
        def missing(handle):
            raise self.core.HostError("CLOSE_RETURN_LOST")
        h.kernel.actions["CloseHandle"] = missing
        h.sys.feed(getattr(h, "in"), None)
        h.run(20)
        target = h.sys.raw_stdio[3]
        self.assertEqual(sum(n == "CloseHandle" and a[0] == target for n, a in h.dll_calls), 1)
        self.assertIsNone(h.runtime._actor.input_closed)
        h.run(20)
        self.assertEqual(sum(n == "CloseHandle" and a[0] == target for n, a in h.dll_calls), 1)
        self.assertIsNone(h.runtime.join())

    def test_explicit_real_factory_only_assembles_lazy_adapter(self):
        h = RuntimeHarness(self)
        h.registration["launch"]["files"] = [{"id": "core", "path": str(CORE_PATH), "bytes": len(CORE_SOURCE.encode("utf-8")),
            "sha256": hashlib.sha256(CORE_SOURCE.encode("utf-8")).hexdigest(), "role": "HOST_CORE"}]
        value = self.runtime.create_real_windows_host_runtime(h.registration, h.validation, enable_real=True)
        self.assertTrue(all(callable(getattr(value, name, None)) for name in ("start", "poll", "stopClaims", "close", "join", "view")))
        self.assertEqual(value.view()["pendingOperations"], 0)
        self.assertEqual(self.attempts, [])


class BoundaryTests(RuntimeTests):
    def attempt(self, mutate=None, raw=None):
        h = RuntimeHarness(self)
        h.runtime.start()
        h.handle = h.sys.connect(CONTROL_NAME)
        body = {"capture": copy.deepcopy(h.capture), "controllerInstanceId": h.bootstrap["controllerInstanceId"], "clientNonce": "11" * 32}
        if mutate:
            mutate(h, body)
        h.sys.feed(h.handle, raw if raw is not None else h.private("OPEN", "CONTROL", body))
        h.run(150)
        return h

    def test_wrong_mac_duplicate_keys_and_unknown_envelope_keys_create_nothing(self):
        for mode in ("MAC", "DUPLICATE", "EXTRA", "TUPLE", "NONCE"):
            with self.subTest(mode=mode):
                h = RuntimeHarness(self)
                body = {"capture": h.capture, "controllerInstanceId": h.bootstrap["controllerInstanceId"], "clientNonce": "11" * 32}
                wire = h.private("OPEN", "CONTROL", body)
                packet = json.loads(wire[4:])
                if mode == "MAC":
                    packet["mac"] = "0" * 64
                elif mode == "EXTRA":
                    packet["extra"] = 1
                elif mode == "TUPLE":
                    packet["endpointId"] = ident(99)
                elif mode == "NONCE":
                    body["clientNonce"] = h.bootstrap["key"].hex()
                    packet = json.loads(h.private("OPEN", "CONTROL", body)[4:])
                raw = independent(packet)
                if mode == "DUPLICATE":
                    raw = raw[:-1] + b',"version":1}'
                h.runtime.start()
                h.handle = h.sys.connect(CONTROL_NAME)
                h.sys.feed(h.handle, len(raw).to_bytes(4, "big") + raw)
                h.run(150)
                self.assertEqual(h.driver_calls, [])
                self.assertTrue(h.runtime.view()["unconfirmed"])
                self.assertIsNotNone(h.runtime.join())

    def test_os_peer_pid_reuse_sid_session_and_epoch_mismatches_create_nothing(self):
        for field, value in (("pid", 999), ("creationFileTime100ns", "999"), ("sidDigest", "f" * 64), ("windowsSessionId", 8)):
            with self.subTest(field=field):
                h = self.attempt(lambda h, b: h.sys.peer_value.update({field: value}))
                self.assertEqual(h.driver_calls, [])
                self.assertTrue(h.runtime.view()["unconfirmed"])
        h = self.attempt(lambda h, b: b["capture"]["origin"]["authority"].update(hostEpochId=ident(99)))
        self.assertEqual(h.driver_calls, [])

    def test_stop_claims_keeps_authenticated_cleanup_but_refuses_new_open(self):
        h = RuntimeHarness(self)
        h.runtime.start()
        h.runtime.stopClaims()
        h.handle = h.sys.connect(CONTROL_NAME)
        h.sys.feed(h.handle, h.private("OPEN", "CONTROL", {"capture": h.capture,
            "controllerInstanceId": h.bootstrap["controllerInstanceId"], "clientNonce": "11" * 32}))
        h.run(100)
        self.assertEqual(h.driver_calls, [])
        self.assertFalse(h.runtime.view()["accepting"])

    def test_factory_freezes_registration_and_rejects_getters_before_invocation(self):
        h = RuntimeHarness(self)
        h.bootstrap["endpointId"] = ident(99)
        h.runtime.start()
        self.assertIn(CONTROL_NAME, h.sys.listeners)
        touched = []
        class BadClock:
            @property
            def qpc(self):
                touched.append("getter")
                return lambda: "1"
            def frequency(self):
                return "1"
        ports = dict(h.ports, clock=BadClock())
        with self.assertRaises(ValueError):
            self.runtime.create_windows_host_runtime(h.registration, ports)
        self.assertEqual(touched, [])

    def test_native_budget_and_operation_cap_reject_before_syscall_and_release(self):
        h = RuntimeHarness(self).handshake()
        h.send("PREPARE", {"origin": h.capture["origin"], "launchRef": h.capture["launchRef"]})
        h.ack("PRE_CREATE")
        io_port = h.runtime._io
        used = h.memory.used
        h.memory.maxBytes = used
        before = len(h.sys.events)
        with self.assertRaises(ValueError):
            io_port.read("OUT", 64)
        self.assertEqual(len(h.sys.events), before)
        self.assertEqual(h.memory.used, used)
        h.memory.maxBytes = Memory.maxBytes

    def test_read_pending_owns_hidden_credit_and_does_not_restart_syscall(self):
        h = RuntimeHarness(self).handshake()
        h.send("PREPARE", {"origin": h.capture["origin"], "launchRef": h.capture["launchRef"]})
        h.ack("PRE_CREATE")
        target = h.sys.raw_stdio[4]
        io_port = h.runtime._io
        base = h.memory.used
        self.assertIsNone(io_port.read("OUT", 8))
        held = h.memory.used
        for _ in range(5):
            h.runtime._completed = set()
            self.assertIsNone(io_port.read("OUT", 8))
        self.assertGreater(held, base)
        self.assertEqual(h.memory.used, held)
        self.assertEqual(sum(e[0] == "read" and e[1] == target for e in h.sys.events), 1)
        self.assertIsNone(io_port.read("OUT", 7))
        self.assertEqual(h.memory.used, held)

    def test_close_waits_cancelled_accept_late_handle_and_actual_close(self):
        h = RuntimeHarness(self)
        h.sys.delay_cancel = True
        h.sys.delay_close = True
        h.runtime.start()
        h.runtime.close()
        h.run(5)
        held = h.memory.used
        self.assertGreater(held, 0)
        self.assertIsNone(h.runtime.join())
        late = h.sys.connect(CONTROL_NAME)
        h.run(5)
        self.assertIn(late, h.sys.closes)
        self.assertEqual(h.driver_calls, [])
        self.assertIsNone(h.runtime.join())
        for op in h.sys.ops:
            if op.kind == "close" and not op.finished:
                op.result = {"state": "RETURNED", "value": {"closed": True}}
        h.until(lambda: h.runtime.join() is not None)
        self.assertEqual(h.memory.used, 0)

    def test_cancel_failure_and_unconfirmed_completion_keep_ownership(self):
        for mode in ("CANCEL", "COMPLETION"):
            with self.subTest(mode=mode):
                h = RuntimeHarness(self)
                h.runtime.start()
                h.sys.delay_cancel = True
                if mode == "CANCEL":
                    h.sys.fail_cancel = True
                else:
                    h.sys.ops[0].result = {"state": "UNCONFIRMED", "code": "RETURN_LOST"}
                h.runtime.close()
                h.run(10)
                self.assertIsNone(h.runtime.join())
                self.assertTrue(h.runtime.view()["unconfirmed"])
                self.assertGreater(h.runtime.view()["heldBytes"], 0)

    def test_replayed_private_open_cannot_create_second_driver(self):
        h = RuntimeHarness(self).handshake()
        old = len(h.driver_calls)
        h.sys.feed(h.handle, h.private("OPEN", "CONTROL", {"capture": h.capture,
            "controllerInstanceId": h.bootstrap["controllerInstanceId"], "clientNonce": "11" * 32}))
        h.run(100)
        self.assertEqual(len(h.driver_calls), old)
        self.assertTrue(h.runtime.view()["unconfirmed"])
        self.assertFalse(any(n == "CreateProcessAsUserW" for n, a in h.dll_calls))

    def test_frame_prefix_cap_and_truncated_eof_fail_before_driver(self):
        for raw in (b"\0\2\0\1", b"\0\0\0\0", b"\0\0\0\x10{}"):
            with self.subTest(raw=raw):
                h = self.attempt(raw=raw)
                if raw.endswith(b"{}"):
                    h.sys.feed(h.handle, None)
                    h.run(10)
                self.assertEqual(h.driver_calls, [])
                self.assertTrue(h.runtime.view()["unconfirmed"])


class PinAuditTests(RuntimeTests):
    def test_unpinned_core_or_replaced_original_class_is_rejected(self):
        h = RuntimeHarness(self)
        unpinned = types.ModuleType("unverified_host")
        unpinned.__dict__.update(self.core.__dict__)
        with self.assertRaises(ValueError):
            self.runtime.create_windows_host_runtime(h.registration, dict(h.ports, core=unpinned))
        original = self.core.WindowsJobHost
        class Replacement:
            pass
        self.core.WindowsJobHost = Replacement
        try:
            with self.assertRaises(ValueError):
                self.runtime.create_windows_host_runtime(h.registration, h.ports)
        finally:
            self.core.WindowsJobHost = original

    def test_core_module_getattr_and_method_descriptor_are_never_invoked(self):
        h = RuntimeHarness(self)
        touched = []
        forged = types.ModuleType("forged")
        def dynamic(name):
            touched.append(name)
            return lambda *a: None
        forged.__getattr__ = dynamic
        with self.assertRaises(ValueError):
            self.runtime.create_windows_host_runtime(h.registration, dict(h.ports, core=forged))
        self.assertEqual(touched, [])

    def test_pending_read_with_smaller_credit_waits_without_new_fact_or_syscall(self):
        h = RuntimeHarness(self).handshake()
        h.send("PREPARE", {"origin": h.capture["origin"], "launchRef": h.capture["launchRef"]})
        h.ack("PRE_CREATE")
        port = h.runtime._io
        self.assertIsNone(port.read("OUT", 8))
        count, held = len(h.sys.events), h.memory.used
        self.assertIsNone(port.read("OUT", 7))
        self.assertEqual(len(h.sys.events), count)
        self.assertEqual(h.memory.used, held)


class LifetimeAuditTests(RuntimeTests):
    ack_all = LifecycleTests.ack_all
    def test_join_requires_close_and_small_records_do_not_enable_replayed_capture(self):
        h = RuntimeHarness(self).handshake()
        h.create_result = 0
        h.send("PREPARE", {"origin": h.capture["origin"], "launchRef": h.capture["launchRef"]})
        h.ack("PRE_CREATE")
        h.ack("CREATE_ARMED")
        self.ack_all(h)
        parent = {"joinId": ident(850), "originDigest": h.capture["originDigest"], "digest": "f" * 64}
        h.send("PARENT_JOINED", parent)
        self.ack_all(h)
        h.until(lambda: any(v.get("message") == "FINAL_CANDIDATE" for v in h.decoded))
        evidence = next(v["payload"]["evidence"] for v in h.decoded if v.get("message") == "FINAL_CANDIDATE")
        wrapper = {"version": 1, "originDigest": h.capture["originDigest"], "evidence": evidence,
            "entries": [{"eventId": r["event"]["eventId"], "payloadDigest": r["event"]["payloadDigest"], "sourceDigest": r["sourceDigest"]} for r in h.events()], "parentJoinAck": parent}
        h.send("ACK_FINAL", {"recordId": ident(851), "digest": hashlib.sha256(independent(wrapper)).hexdigest()})
        h.until(lambda: any(v.get("message") == "FINALIZED" for v in h.decoded))
        h.run(20)
        self.assertIsNone(h.runtime.join())
        self.assertEqual(h.runtime.view()["activeSessions"], 0)
        self.assertEqual(h.runtime.view()["retainedRecords"], 1)
        self.assertGreater(h.memory.used, h.runtime._budget.reserve, "소비 기록이 살아 있는 동안 제어 pool을 반환할 수 없다")
        old = len(h.driver_calls)
        h.handle = h.sys.connect(CONTROL_NAME)
        h.sys.feed(h.handle, h.private("OPEN", "CONTROL", {"capture": h.capture,
            "controllerInstanceId": h.bootstrap["controllerInstanceId"], "clientNonce": "33" * 32}))
        h.run(100)
        self.assertEqual(len(h.driver_calls), old)
        self.assertTrue(h.runtime.view()["unconfirmed"])

    def test_registration_digest_is_the_exact_descriptor_digest(self):
        h = RuntimeHarness(self)
        h.validation.verify_registration = lambda r: "0" * 64
        runtime = self.runtime.create_windows_host_runtime(h.registration, h.ports)
        with self.assertRaises(ValueError):
            runtime.start()
        self.assertEqual(h.sys.events, [])

    def test_memory_property_is_rejected_without_getter_side_effect(self):
        h = RuntimeHarness(self)
        touched = []
        class BadMemory:
            @property
            def maxBytes(self):
                touched.append("maxBytes")
                return 1000000
            def available(self):
                return 1000000
            def hold(self, n):
                return lambda: None
        with self.assertRaises(ValueError):
            self.runtime.create_windows_host_runtime(h.registration, dict(h.ports, memory=BadMemory()))
        self.assertEqual(touched, [])


class RealAdapterTests(RuntimeTests):
    def sdk(self, mode="PENDING"):
        h = RuntimeHarness(self)
        driver = h.make_driver(self.core, lambda *a: None, h.clock, h.ids)
        system = self.runtime._WindowsSys(h.bootstrap, h.registration["launch"], h.registration["bounds"])
        system.c, system.k, system.a = driver.c, h.kernel, h.advapi
        system.t = self.runtime._windows_types(driver.c)
        pending = {"ready": False, "cancelled": False}
        serial = [0x9000]
        def event(*args):
            serial[0] += 1
            return serial[0]
        def read(raw, buffer, n, transferred, overlapped):
            if mode == "IMMEDIATE":
                ctypes.memmove(buffer, b"abc", 3)
                transferred._obj.value = 3
                return 1
            pending["buffer"] = buffer
            h.last_error = 997
            return 0
        def completed(raw, overlapped, transferred, wait):
            if not pending["ready"]:
                h.last_error = 996
                return 0
            if pending["cancelled"]:
                h.last_error = 995
                return 0
            ctypes.memmove(pending["buffer"], b"abc", 3)
            transferred._obj.value = 3
            return 1
        def cancel(raw, overlapped):
            pending["cancelled"] = True
            return 1
        h.kernel.actions.update(CreateEventW=event, ReadFile=read, GetOverlappedResult=completed,
            CancelIoEx=cancel, WriteFile=lambda raw, buf, n, out, ov: setattr(out._obj, "value", n) or 1)
        pipe = self.runtime._Pipe(0x9900)
        system._live.append(pipe)
        return h, system, pipe, pending

    def test_real_adapter_pending_overlapped_buffer_and_event_survive_cancel_request(self):
        h, system, pipe, pending = self.sdk()
        operation = system.read(pipe, 4)
        self.assertIsNone(system.poll(operation))
        system.cancel(operation)
        self.assertIsNone(system.poll(operation))
        self.assertIsNotNone(operation.buffer)
        self.assertFalse(any(n == "CloseHandle" for n, a in h.dll_calls))
        pending["ready"] = True
        value = system.poll(operation)
        self.assertEqual(value, {"state": "FAILED", "code": "WINDOWS_IO_CANCELLED"})
        self.assertIsNone(operation.buffer)
        self.assertEqual(sum(n == "ReadFile" for n, a in h.dll_calls), 1)
        self.assertEqual(sum(n == "CloseHandle" for n, a in h.dll_calls), 1)

    def test_real_adapter_exact_transfer_and_actual_close_completion(self):
        h, system, pipe, pending = self.sdk("IMMEDIATE")
        op = system.read(pipe, 4)
        self.assertEqual(system.poll(op), {"state": "RETURNED", "value": {"data": b"abc", "eof": False}})
        write = system.write(pipe, b"abcd", 1)
        self.assertEqual(system.poll(write), {"state": "RETURNED", "value": {"transferred": 3}})
        close = system.close(pipe)
        self.assertEqual(system.poll(close), {"state": "RETURNED", "value": {"closed": True}})
        with self.assertRaises(ValueError):
            system.close(pipe)
        self.assertEqual(sum(n == "CloseHandle" and a[0] == pipe.raw for n, a in h.dll_calls), 1)

    def test_real_adapter_event_close_loss_keeps_buffer_and_unconfirmed_operation(self):
        h, system, pipe, pending = self.sdk("IMMEDIATE")
        h.kernel.actions["CloseHandle"] = lambda raw: 0
        operation = system.read(pipe, 4)
        value = system.poll(operation)
        self.assertEqual(value, {"state": "UNCONFIRMED", "code": "WINDOWS_EVENT_CLOSE_UNCONFIRMED"})
        self.assertIsNotNone(operation.buffer)
        self.assertFalse(operation.done)
        self.assertEqual(system.poll(operation)["state"], "UNCONFIRMED")
        self.assertEqual(sum(n == "CloseHandle" for n, a in h.dll_calls), 1)


class PartialStdioTests(RuntimeTests):
    def test_partial_internal_pending_stdio_cancels_then_closes_only_after_completion(self):
        h = RuntimeHarness(self).handshake()
        pending = Operation("read", 0x7001)
        h.sys.delay_cancel = True
        def partial():
            error = ValueError("INTERNAL_STDIO_PENDING")
            error.owned, error.pending = [0x7001, 0x7002], [pending]
            raise error
        h.sys.open_stdio = partial
        h.runtime.sys.open_stdio = partial
        h.send("PREPARE", {"origin": h.capture["origin"], "launchRef": h.capture["launchRef"]})
        h.ack("PRE_CREATE")
        self.assertFalse(any(n == "CloseHandle" and a[0] in (0x7001, 0x7002) for n, a in h.dll_calls))
        self.assertTrue(pending.cancelled)
        self.assertIsNone(h.runtime.join())
        pending.result = {"state": "FAILED", "code": "OP_CANCELLED"}
        h.run(20)
        self.assertEqual([a[0] for n, a in h.dll_calls if n == "CloseHandle" and a[0] in (0x7001, 0x7002)], [0x7001, 0x7002])
        self.assertFalse(any(n == "CreateProcessAsUserW" for n, a in h.dll_calls))


class LimitTests(RuntimeTests):
    def test_control_body_limit_n_minus_one_n_and_n_plus_one(self):
        for n in (131071, 131072, 131073):
            with self.subTest(n=n):
                h = RuntimeHarness(self)
                h.registration["bounds"]["maxChunkBytes"] = 65536
                h.runtime = self.runtime.create_windows_host_runtime(h.registration, h.ports)
                raw = h.private("OPEN", "CONTROL", {"capture": h.capture,
                    "controllerInstanceId": h.bootstrap["controllerInstanceId"], "clientNonce": "11" * 32})[4:]
                raw += b" " * (n - len(raw))
                h.runtime.start()
                h.handle = h.sys.connect(CONTROL_NAME)
                h.sys.feed(h.handle, n.to_bytes(4, "big") + raw)
                h.run(100)
                self.assertEqual(h.auth_count, 1 if n <= 131072 else 0)
                self.assertEqual(h.driver_calls, [])
                self.assertEqual(h.runtime.view()["unconfirmed"], n > 131072)

    def test_operation_cap_denies_thirty_third_before_sys_read(self):
        h = RuntimeHarness(self)
        h.runtime.start()
        for _ in range(31):
            handle = object()
            self.runtime._Operation(h.runtime, "read", handle, "OUT", 1, lambda handle=handle: h.runtime.sys.read(handle, 1))
        self.assertEqual(h.runtime.view()["pendingOperations"], 32)
        before = len(h.sys.events)
        with self.assertRaises(ValueError):
            self.runtime._Operation(h.runtime, "read", object(), "OUT", 1, lambda: h.runtime.sys.read(object(), 1))
        self.assertEqual(len(h.sys.events), before)
        self.assertEqual(h.runtime.view()["pendingOperations"], 32)

    def test_authenticated_u64_overflow_and_invalid_lane_reuse_create_nothing(self):
        for field, value in (("creationFileTime100ns", "18446744073709551616"), ("creationFileTime100ns", "01"), ("windowsSessionId", True)):
            with self.subTest(field=field, value=value):
                envelope = json.loads(GOLDEN_UNSIGNED)
                envelope["body"]["hostProcess"][field] = value
                with self.assertRaises(ValueError):
                    self.runtime.private_mac(bytes(range(32)), envelope)
        envelope = json.loads(GOLDEN_UNSIGNED)
        envelope["lane"] = "OUT"
        with self.assertRaises(ValueError):
            self.runtime.private_mac(bytes(range(32)), envelope)

    def test_server_nonce_reuse_or_registration_key_is_never_a_new_authority(self):
        for nonce in (bytes(range(32)), bytes.fromhex("11" * 32), b"short"):
            with self.subTest(nonce=nonce):
                h = RuntimeHarness(self)
                h.ids.nonce = lambda nonce=nonce: nonce
                h.runtime = self.runtime.create_windows_host_runtime(h.registration, h.ports)
                h.runtime.start()
                h.handle = h.sys.connect(CONTROL_NAME)
                h.sys.feed(h.handle, h.private("OPEN", "CONTROL", {"capture": h.capture,
                    "controllerInstanceId": h.bootstrap["controllerInstanceId"], "clientNonce": "11" * 32}))
                h.run(100)
                self.assertTrue(h.runtime.view()["unconfirmed"])
                self.assertEqual(h.driver_calls, [])


class LaunchBindingTests(RuntimeTests):
    def test_authorized_capability_cannot_change_registered_launch_fields(self):
        for field, value in (("executable", r"C:\outside\child.exe"), ("command_line", "different-argument"),
                             ("directory", r"C:\outside"), ("environment", "SECRET=outside\0\0"),
                             ("windows_session_id", 8), ("token", 0x9999)):
            with self.subTest(field=field):
                h = RuntimeHarness(self)
                original = h.validation.authorize_capture
                def authorize(capture, digest, field=field, value=value):
                    capability = original(capture, digest)
                    setattr(capability, field, value)
                    return capability
                h.validation.authorize_capture = authorize
                h.runtime = self.runtime.create_windows_host_runtime(h.registration, h.ports)
                h.runtime.start()
                h.handle = h.sys.connect(CONTROL_NAME)
                h.sys.feed(h.handle, h.private("OPEN", "CONTROL", {"capture": h.capture,
                    "controllerInstanceId": h.bootstrap["controllerInstanceId"], "clientNonce": "11" * 32}))
                h.run(100)
                self.assertEqual(h.driver_calls, [])
                self.assertTrue(h.runtime.view()["unconfirmed"])
                self.assertFalse(any(v.get("kind") == "CHALLENGE" for v in h.decoded))


class DeadlineTests(RuntimeTests):
    def test_close_deadline_keeps_pending_buffer_and_reports_unconfirmed(self):
        h = RuntimeHarness(self)
        h.sys.delay_cancel = True
        h.runtime.start()
        h.runtime.close()
        held = h.memory.used
        h.clock.ticks += 1000001
        h.run(2)
        self.assertIsNone(h.runtime.join())
        self.assertTrue(h.runtime.view()["unconfirmed"])
        self.assertEqual(h.memory.used, held)
        self.assertEqual(h.runtime._code, "WINDOWS_CLOSE_TIMEOUT")
        self.assertEqual(h.driver_calls, [])

    def test_stop_claims_before_start_never_reopens_admission(self):
        h = RuntimeHarness(self)
        h.runtime.stopClaims()
        with self.assertRaises(ValueError):
            h.runtime.start()
        self.assertEqual(h.sys.events, [])


class TokenAdapterTests(RuntimeTests):
    sdk = RealAdapterTests.sdk

    def test_real_token_readback_checks_zero_capabilities_integrity_session_and_admin(self):
        for mode in ("VALID", "CAPABILITIES", "ADMIN", "INTEGRITY", "SESSION"):
            with self.subTest(mode=mode):
                h, system, pipe, pending = self.sdk()
                original = h.advapi.actions["GetTokenInformation"]
                def token(handle, number, data, size, needed):
                    if number in (20, 30):
                        needed._obj.value = 4
                        if data is None:
                            h.last_error = 122
                            return 0
                        ctypes.cast(data, ctypes.POINTER(ctypes.c_uint32)).contents.value = int(
                            mode == "CAPABILITIES" and number == 30 or mode == "ADMIN" and number == 20)
                        return 1
                    result = original(handle, number, data, size, needed)
                    if data is not None and mode == "SESSION" and number == 12:
                        ctypes.cast(data, ctypes.POINTER(ctypes.c_uint32)).contents.value = 8
                    if data is not None and mode == "INTEGRITY" and number == 25:
                        ctypes.cast(data, ctypes.POINTER(ctypes.c_void_p)).contents.value = ctypes.addressof(h.sids[1])
                    return result
                h.advapi.actions["GetTokenInformation"] = token
                self.assertTrue(callable(getattr(system, "_verify_target_token", None)), "실제 target token readback이 없다")
                if mode == "VALID":
                    self.assertIsNone(system._verify_target_token())
                else:
                    with self.assertRaises(ValueError):
                        system._verify_target_token()
                self.assertFalse(any(n in ("CreateNamedPipeW", "CreateProcessAsUserW") for n, a in h.dll_calls))


class FinalFactTests(RuntimeTests):
    def test_failed_original_close_fact_is_cached_without_second_raw_call(self):
        h = RuntimeHarness(self).handshake()
        h.send("PREPARE", {"origin": h.capture["origin"], "launchRef": h.capture["launchRef"]})
        h.ack("PRE_CREATE")
        handle = h.runtime._actor.stdio["owned"][0]
        raw = h.driver._handle(handle, "PIPE")
        def failed(value):
            h.last_error = 5
            return 0
        h.kernel.actions["CloseHandle"] = failed
        first = h.runtime._facade.closeOwned(handle)
        self.assertEqual(first["facts"][0]["status"], "FAILED")
        self.assertEqual(first["facts"][0]["win32Error"], 5)
        h.clock.ticks += 1
        self.assertEqual(h.runtime._facade.closeOwned(handle), first)
        self.assertEqual(sum(n == "CloseHandle" and a[0] == raw for n, a in h.dll_calls), 1)


class PublicSurfaceTests(RuntimeTests):
    def test_runtime_exposes_only_the_six_approved_public_callables(self):
        h = RuntimeHarness(self)
        names = set()
        for name in dir(h.runtime):
            if not name.startswith("_") and callable(getattr(h.runtime, name)):
                names.add(name)
        self.assertEqual(names, {"start", "poll", "stopClaims", "close", "join", "view"})



class ControlPoolTests(RuntimeTests):
    ack_all = LifecycleTests.ack_all
    finish = LifecycleTests.finish

    def saturated(self):
        h = RuntimeHarness(self)
        h.memory.maxBytes = 2 * 1024 * 1024
        h.handshake()
        outside = h.memory.available()
        release = h.memory.hold(outside)
        self.addCleanup(release)
        self.assertEqual(h.memory.available(), 0)
        return h, outside

    def test_shared_owner_exhaustion_keeps_control_read_body_and_response_working(self):
        h, outside = self.saturated()
        before = len(h.decoded)
        h.send("QUERY", {})
        h.run(100)
        self.assertFalse(h.runtime.view()["unconfirmed"], "공동 owner가 찼을 때 제어 body/응답이 막혔다")
        self.assertGreater(len(h.decoded), before, "QUERY 원 응답이 전송되지 않았다")
        self.assertEqual(h.decoded[-1]["message"], "PROGRESS")
        before = len(h.sys.events)
        with self.assertRaises(ValueError):
            h.runtime._io.read("OUT", 8)
        self.assertEqual(len(h.sys.events), before, "data가 제어 pool을 사용했다")
        self.assertEqual(h.memory.available(), 0)

    def test_shared_owner_exhaustion_allows_a_new_control_read_operation(self):
        h, outside = self.saturated()
        frame = self.runtime._Frame(h.runtime, h.handle, "CONTROL")
        failure = None
        try:
            self.assertIsNone(frame.read())
        except ValueError as exc:
            failure = exc
        self.assertIsNone(failure, "원 owner 가용량 0에서 제어 read 예약이 실패했다")
        frame.cancel()
        h.runtime._completed = set()
        self.assertTrue(frame.drain())

    def test_shared_owner_exhaustion_keeps_no_child_ack_parent_and_final_cleanup_working(self):
        h, outside = self.saturated()
        def deny(*args):
            raise self.core.HostError("PIN_DRIFT")
        h.kernel.actions["GetNativeSystemInfo"] = deny
        h.send("PREPARE", {"origin": h.capture["origin"], "launchRef": h.capture["launchRef"]})
        self.assertFalse(h.runtime.view()["unconfirmed"], "제어 PREPARE/원 실패 응답이 막혔다")
        h.until(lambda: any(v.get("message") == "ERROR" and v["payload"]["code"] == "PIN_DRIFT" for v in h.decoded))
        joined = self.finish(h)
        self.assertEqual(joined["end"], "EXPECTED", repr(joined))
        self.assertEqual(h.runtime.view()["heldBytes"], 0)
        self.assertEqual(h.memory.used, outside)
        self.assertFalse(any(n == "CreateProcessAsUserW" for n, a in h.dll_calls))


class SdkFailureTests(RuntimeTests):
    sdk = RealAdapterTests.sdk

    def security_sdk(self, failure):
        h, system, pipe, pending = self.sdk()
        system._live.clear()
        h.sids[41] = ctypes.create_string_buffer(b"hostSID!")
        h.sids[42] = ctypes.create_string_buffer(b"ctrlSID!")
        h.bootstrap["hostSidDigest"] = hashlib.sha256(b"hostSID!").hexdigest()
        h.bootstrap["controllerSidDigest"] = hashlib.sha256(b"ctrlSID!").hexdigest()
        h.capture["origin"]["authority"]["controllerSidDigest"] = h.bootstrap["controllerSidDigest"]
        h.old.refresh_capture(h.capture)
        h.peer.update(sidDigest=h.bootstrap["controllerSidDigest"])
        groups = system.t["ONE_GROUP"]
        texts = {k: ctypes.create_unicode_buffer("S-1-5-" + str(k)) for k in (1, 25, 31, 41, 42)}
        acl = ctypes.create_string_buffer(b"\x02\x00\x08\x00\x00\x00\x00\x00")
        descriptor = ctypes.create_string_buffer(32)
        state = {"raw": [], "events": [], "refs": (texts, acl, descriptor), "lost": None}
        def token(handle, number, data, n, needed):
            raw = handle.value if hasattr(handle, "value") else handle
            size = ctypes.sizeof(groups) if number == 28 else ctypes.sizeof(ctypes.c_void_p) if number in (1, 25, 31) else 4
            needed._obj.value = size
            if data is None:
                h.last_error = 122
                return 0
            if number == 28:
                value = ctypes.cast(data, ctypes.POINTER(groups)).contents
                value.count, value.attributes = 1, 0xc0000000
                value.sid = ctypes.addressof(h.sids[42])
            elif number in (1, 25, 31):
                key = 41 if raw == 0x11065 else 42 if raw == 0x11066 else number
                ctypes.cast(data, ctypes.POINTER(ctypes.c_void_p)).contents.value = ctypes.addressof(h.sids[key])
            else:
                ctypes.cast(data, ctypes.POINTER(ctypes.c_uint32)).contents.value = 7 if number == 12 else int(number == 29 and raw == 0x3100)
            return 1
        def sid_text(pointer, out):
            key = next(k for k in texts if ctypes.string_at(pointer, 8) == h.sids[k].raw[:8])
            out._obj.value = ctypes.addressof(texts[key])
            return 1
        def convert(sddl, revision, out, length):
            out._obj.value, length._obj.value = ctypes.addressof(descriptor), 32
            return 1
        def dacl(desc, present, out, defaulted):
            present._obj.value, defaulted._obj.value, out._obj.value = 1, 0, ctypes.addressof(acl)
            return 1
        def security(raw, kind, flags, owner, group, dacl, sacl, out):
            if failure == "ACL":
                return 5
            owner._obj.value, out._obj.value = ctypes.addressof(h.sids[41]), ctypes.addressof(descriptor)
            return 0
        def create(*args):
            raw = 0xa000 + len(state["raw"]) + 1
            state["raw"].append(raw)
            return raw
        def event(*args):
            raw = 0xb000 + len(state["events"]) + 1
            state["events"].append(raw)
            return raw
        def connect(raw, overlap):
            state["lost"] = overlap._obj
            raise ValueError("SDK_RETURN_LOST")
        def times(process, created, exited, kernel, user):
            created._obj.value = 1 if process == 0x10065 else 2
            return 1
        h.kernel.actions.update(OpenProcess=lambda rights, inherit, pid: 0x10000 + pid,
            GetProcessTimes=times, GetCurrentProcessId=lambda: 101,
            CreateNamedPipeW=create, CreateFileW=create, CreateEventW=event,
            ConnectNamedPipe=connect, LocalFree=lambda *a: None,
            SetHandleInformation=lambda raw, mask, flags: 0 if failure == "INHERIT" else 1,
            CloseHandle=lambda raw: 0 if failure in ("ACL", "INHERIT") and raw in state["raw"] else 1)
        h.advapi.actions.update(GetTokenInformation=token, ConvertSidToStringSidW=sid_text,
            OpenProcessToken=lambda process, rights, out: setattr(out._obj, "value", process + 0x1000) or 1,
            ConvertStringSecurityDescriptorToSecurityDescriptorW=convert,
            GetSecurityInfo=security, GetSecurityDescriptorDacl=dacl,
            GetSecurityDescriptorControl=lambda desc, control, revision: setattr(control._obj, "value", 0x1000) or 1)
        h.runtime = self.runtime.create_windows_host_runtime(h.registration, h.ports)
        return h, system, state

    def test_sdk_listener_failed_acl_or_inherit_and_failed_close_keeps_join_and_credit(self):
        for failure in ("ACL", "INHERIT"):
            with self.subTest(failure=failure):
                h, system, state = self.security_sdk(failure)
                h.ports["sys"] = system
                h.runtime = self.runtime.create_windows_host_runtime(h.registration, h.ports)
                with self.assertRaises(ValueError):
                    h.runtime.start()
                self.assertEqual(len(state["raw"]), 1, "listener 실제 생성 전에 fixture가 실패했다")
                held = h.memory.used
                h.clock.ticks += 1000001
                h.run(50)
                self.assertIsNone(h.runtime.join(), "미확인 listener가 전체 join에서 사라졌다")
                self.assertGreater(held, 0, "미확인 listener의 소유 credit이 반환됐다")
                self.assertEqual(h.memory.used, held)
                self.assertEqual(sum(n == "CloseHandle" and a[0] == state["raw"][0] for n, a in h.dll_calls), 1)
                self.assertFalse(any(n == "CreateProcessAsUserW" for n, a in h.dll_calls))

    def test_sdk_listener_failed_acl_with_observed_close_finishes_without_second_close(self):
        h, system, state = self.security_sdk("ACL")
        system.k.actions["CloseHandle"] = lambda raw: 1
        h.ports["sys"] = system
        h.runtime = self.runtime.create_windows_host_runtime(h.registration, h.ports)
        with self.assertRaises(ValueError):
            h.runtime.start()
        h.until(lambda: h.runtime.join() is not None)
        self.assertEqual(h.runtime.join()["end"], "LOST")
        self.assertEqual(h.memory.used, 0)
        self.assertEqual(len(state["raw"]), 1)
        self.assertEqual(sum(n == "CloseHandle" and a[0] == state["raw"][0] for n, a in h.dll_calls), 1)

    def test_stdio_operation_credit_is_reserved_before_the_actual_sdk_creates_resources(self):
        h, system, state = self.security_sdk("STDIO")
        h.handshake()
        h.runtime.sys.open_stdio = system.open_stdio
        h.send("PREPARE", {"origin": h.capture["origin"], "launchRef": h.capture["launchRef"]})
        h.until(lambda: any(r["event"]["kind"] == "PRE_CREATE" for r in h.events()))
        release = h.memory.hold(h.memory.available())
        self.addCleanup(release)
        h.ack("PRE_CREATE")
        h.run(100)
        self.assertEqual(state["raw"], [], "stdio credit 확보 전에 원 SDK 자원이 생성됐다")
        self.assertEqual(state["events"], [])
        self.assertFalse(any(n == "CreateProcessAsUserW" for n, a in h.dll_calls))
        self.assertFalse(h.runtime.view()["unconfirmed"])

    def test_sdk_internal_stdio_accept_return_lost_keeps_original_event_and_parent_handles(self):
        h, system, state = self.security_sdk("STDIO")
        self.check_stdio_return_lost(h, system, state)

    def test_sdk_stdio_descriptor_free_failure_keeps_the_same_unconfirmed_operation(self):
        h, system, state = self.security_sdk("STDIO")
        system.k.actions["LocalFree"] = lambda value: 1 if state["lost"] is not None else None
        self.check_stdio_return_lost(h, system, state)

    def check_stdio_return_lost(self, h, system, state):
        h.handshake()
        old_poll, old_cancel = h.runtime.sys.poll, h.runtime.sys.cancel
        h.runtime.sys.open_stdio = system.open_stdio
        h.runtime.sys.poll = lambda op: system.poll(op) if type(op) is self.runtime._WinOp else old_poll(op)
        h.runtime.sys.cancel = lambda op: system.cancel(op) if type(op) is self.runtime._WinOp else old_cancel(op)
        h.send("PREPARE", {"origin": h.capture["origin"], "launchRef": h.capture["launchRef"]})
        h.ack("PRE_CREATE")
        self.assertEqual(len(state["raw"]), 2, "stdio accept 이전 fixture가 실패했다")
        self.assertEqual(len(state["events"]), 1)
        self.assertIsNotNone(state["lost"])
        h.runtime.close()
        h.clock.ticks += 1000001
        h.run(100)
        self.assertFalse(any(n == "CloseHandle" and a[0] in state["raw"] + state["events"] for n, a in h.dll_calls),
                         "반환 유실 accept의 실제 완료 전에 handle/event가 닫혔다")
        self.assertTrue(h.runtime._io.pending(), "stdio 반환 유실이 HostIo pending 장벽에서 사라졌다")
        self.assertIsNone(h.runtime.join())
        self.assertGreater(h.memory.used, h.runtime._budget.reserve)
        operations = [op for op in system._live if type(op) is self.runtime._WinOp]
        self.assertEqual(len(operations), 1)
        self.assertIs(operations[0].overlapped, state["lost"])
        self.assertIn(operations[0], [op.op for op in h.runtime._ops])
        self.assertFalse(any(n == "CreateProcessAsUserW" for n, a in h.dll_calls))




class ControlPoolLifetimeTests(RuntimeTests):
    def connected(self):
        h = RuntimeHarness(self)
        h.runtime.start()
        h.handle = h.sys.connect(CONTROL_NAME)
        h.until(lambda: "CONTROL" in h.runtime._frames)
        return h

    def test_insufficient_owner_rejects_pool_before_listener_or_accept(self):
        h = RuntimeHarness(self)
        h.memory.maxBytes = h.runtime._budget.reserve - 1
        with self.assertRaises(ValueError):
            h.runtime.start()
        h.run(5)
        self.assertEqual(h.sys.events, [])
        self.assertEqual(h.memory.used, 0)
        self.assertEqual(h.runtime.join()["end"], "LOST")

    def test_control_pool_spends_only_the_excess_from_owner_and_data_never_borrows_it(self):
        h = RuntimeHarness(self)
        h.runtime.start()
        budget = h.runtime._budget
        used = h.memory.used
        pool_used = budget._pool_used
        data = budget.hold(64)
        self.assertEqual(h.memory.used, used + 64)
        self.assertEqual(budget._pool_used, pool_used)
        control = budget.hold(budget.reserve - pool_used + 17, control=True)
        self.assertEqual(h.memory.used, used + 64 + 17)
        self.assertEqual(budget._pool_used, budget.reserve)
        control()
        data()
        self.assertEqual(h.memory.used, used)
        self.assertEqual(budget._pool_used, pool_used)
        h.runtime.close()
        h.until(lambda: h.runtime.join() is not None)
        self.assertEqual(h.memory.used, 0)

    def test_owner_hold_must_return_a_real_release_before_credit_is_recorded(self):
        h = RuntimeHarness(self)
        h.runtime.start()
        held = h.runtime.view()["heldBytes"]
        h.runtime.memory.hold = lambda count: None
        with self.assertRaises(ValueError) as caught:
            h.runtime._budget.hold(64)
        self.assertEqual(caught.exception.code, "WINDOWS_MEMORY_INVALID")
        self.assertEqual(h.runtime.view()["heldBytes"], held)

    def test_consumed_control_frame_loan_blocks_pool_release_until_consumer_finishes(self):
        h = self.connected()
        a = h.capture["origin"]["authority"]
        wire = self.core.encode_control({"version": 1, "requestId": ident(901), "originDigest": h.capture["originDigest"],
            **{k: a[k] for k in ("attemptId", "sessionId", "launchId")}, "command": "QUERY", "payload": {}})
        h.sys.feed(h.handle, wire)
        packet = None
        for _ in range(100):
            h.runtime._completed = set()
            packet = h.runtime._frames["CONTROL"].read()
            if packet is not None:
                break
        self.assertIsNotNone(packet)
        self.assertEqual(packet[0], wire)
        consumed = packet[1]
        packet = wire = None
        outside = h.memory.available()
        release = h.memory.hold(outside)
        self.addCleanup(release)
        h.runtime.close()
        h.run(50)
        self.assertIsNone(h.runtime.join(), "소비 중인 제어 frame의 pool이 조기 반환됐다")
        self.assertEqual(h.runtime.view()["pendingOperations"], 0)
        self.assertEqual(h.runtime.view()["heldBytes"], h.runtime._budget.reserve)
        self.assertEqual(h.memory.used, outside + h.runtime._budget.reserve)
        consumed()
        h.until(lambda: h.runtime.join() is not None)
        self.assertEqual(h.memory.used, outside)
        self.assertEqual(h.runtime.view()["heldBytes"], 0)

    def test_pending_control_write_read_cancel_and_actual_close_keep_pool_owned(self):
        h = self.connected()
        h.sys.delay_cancel = h.sys.delay_close = True
        calls = []
        def delayed(handle, data, offset):
            calls.append((handle, data, offset))
            return h.sys.add(Operation("write", handle))
        h.runtime.sys.write = delayed
        message = json.loads(GOLDEN_UNSIGNED) | {"mac": GOLDEN_MAC}
        h.runtime._send(message, private=True)
        h.run(2)
        h.runtime.close()
        held = h.memory.used
        h.run(50)
        self.assertIsNone(h.runtime.join())
        self.assertEqual(h.memory.used, held)
        self.assertEqual(len(calls), 1)
        h.sys.delay_cancel = False
        h.run(20)
        self.assertIsNone(h.runtime.join(), "실제 close 완료 전에 pool이 반환됐다")
        self.assertGreaterEqual(h.memory.used, h.runtime._budget.reserve)
        for op in h.sys.ops:
            if op.kind == "close" and op.result is None:
                op.result = {"state": "RETURNED", "value": {"closed": True}}
        h.until(lambda: h.runtime.join() is not None)
        self.assertEqual(h.memory.used, 0)


class FullWireGoldenTests(RuntimeTests):
    sdk = RealAdapterTests.sdk

    def test_full_capture_control_and_native_literals_match_original_codec_and_hashes(self):
        golden = FULL_WIRE_GOLDEN
        capture = golden["capture"]
        self.assertEqual(self.core.digest(capture), "59652bdc734e5ba4c8bd37958c5de4633abf3de8c557938fb90284a722910098")
        control = base64.b64decode(golden["controlBase64"], validate=True)
        self.assertEqual(hashlib.sha256(control).hexdigest(), "5694a99e485ced078c2cf2cb8e4a667bd9d6749b3716bb2d02bbd4fc0d4b3821")
        self.assertEqual(self.core.encode_control(golden["control"]), control)
        self.assertEqual(self.core.decode_control(control), golden["control"])
        self.assertEqual(golden["control"]["payload"], {"origin": capture["origin"], "launchRef": capture["launchRef"]})
        native = base64.b64decode(golden["nativeBase64"], validate=True)
        self.assertEqual(hashlib.sha256(native).hexdigest(), "b8d2c1d0cb241831e2f321aad86644771053474216285c2e1316a0b61736d0eb")
        self.assertEqual(native[:8], b"TMNATV1\0")
        size = int.from_bytes(native[8:12], "big")
        envelope = json.loads(native[12:12 + size])
        payload = native[12 + size:]
        self.assertEqual(envelope, {"version": 1, "jobId": "00000000-0000-4000-8000-000000000015", "task": "DECODE_IMAGE",
            "taskVersion": "native-pure-v1", "profileDigest": "2021b7c372990f797e86cb0f85931f66372edc040135039b0a741c1827b3475c",
            "metadata": {}, "blobs": [{"id": "source", "byteLength": 15, "sha256": "ef2df0b539c6c23de0f4cbe42648c301ae0e22e887340a4599fb4ef4e2678e48"}],
            "inputDigest": "e064cc2694b39a57768c615269245a7dce73ad055c94e246e63bd7490bd30082"})
        self.assertEqual(payload, b"a" * 15)
        self.assertEqual(hashlib.sha256(payload).hexdigest(), envelope["blobs"][0]["sha256"])
        self.assertEqual(envelope["inputDigest"], capture["frameInputDigest"])
        self.assertEqual(golden["captureDigest"], self.core.digest(capture))
        self.assertEqual(golden["controlDigest"], hashlib.sha256(control).hexdigest())
        self.assertEqual(golden["nativeDigest"], hashlib.sha256(native).hexdigest())

    def test_full_capture_and_prepare_wire_reach_the_original_runtime_actor_unchanged(self):
        h = RuntimeHarness(self)
        h.capture = copy.deepcopy(FULL_WIRE_GOLDEN["capture"])
        a = h.capture["origin"]["authority"]
        for key in ("hostEpochId", "environmentDigest", "controllerInstanceId", "controllerSidDigest"):
            h.bootstrap[key] = a[key]
        h.peer.update(sidDigest=a["controllerSidDigest"])
        h.registration["launch"]["expectedToken"].update(childSidDigest=a["childSidDigest"], appContainerSidDigest=a["appContainerSidDigest"])
        h.registration["launch"]["allowedPolicy"] = copy.deepcopy(h.capture["origin"]["policy"])
        h.runtime = self.runtime.create_windows_host_runtime(h.registration, h.ports)
        h.handshake()
        wire = base64.b64decode(FULL_WIRE_GOLDEN["controlBase64"], validate=True)
        h.sys.feed(h.handle, wire)
        h.until(lambda: any(r["event"]["kind"] == "PRE_CREATE" for r in h.events()))
        self.assertEqual(h.runtime._capture, FULL_WIRE_GOLDEN["capture"])
        self.assertEqual(h.runtime._actor.capture, FULL_WIRE_GOLDEN["capture"])
        self.assertEqual(h.runtime._actor.seen_commands["PREPARE"], FULL_WIRE_GOLDEN["control"]["payload"])
        self.assertFalse(h.runtime.view()["unconfirmed"])
        self.assertFalse(any(n == "CreateProcessAsUserW" for n, a in h.dll_calls))

    def test_actual_sdk_fake_dll_transfers_the_exact_golden_native_bytes(self):
        h, system, pipe, pending = self.sdk()
        h.ports["sys"] = system
        h.runtime = self.runtime.create_windows_host_runtime(h.registration, h.ports)
        h.runtime._budget.start()
        native = base64.b64decode(FULL_WIRE_GOLDEN["nativeBase64"], validate=True)
        written, position = bytearray(), [0]
        def write(raw, buffer, size, out, overlap):
            count = min(size, 7)
            written.extend(ctypes.string_at(buffer, count))
            out._obj.value = count
            return 1
        def read(raw, buffer, size, out, overlap):
            data = native[position[0]:position[0] + min(size, 11)]
            position[0] += len(data)
            ctypes.memmove(buffer, data, len(data))
            out._obj.value = len(data)
            return 1
        system.k.actions.update(WriteFile=write, ReadFile=read)
        writer = self.runtime._Write(h.runtime, pipe, "IN", native)
        for _ in range(1000):
            h.runtime._completed = set()
            if writer.poll() is True:
                break
        self.assertTrue(writer.done)
        self.assertEqual(bytes(written), native)
        received = bytearray()
        while len(received) < len(native):
            goal = min(h.runtime.bounds["maxChunkBytes"], len(native) - len(received))
            reader = self.runtime._Read(h.runtime, pipe, "OUT", goal)
            h.runtime._completed = set()
            packet = reader.poll(goal)
            self.assertIsNotNone(packet)
            self.assertEqual(packet["fact"]["sha256"], hashlib.sha256(packet["data"]).hexdigest())
            received.extend(reader.take()["data"])
        self.assertEqual(bytes(received), native)
        self.assertEqual(hashlib.sha256(received).hexdigest(), "b8d2c1d0cb241831e2f321aad86644771053474216285c2e1316a0b61736d0eb")
        self.assertEqual(h.runtime.view()["pendingOperations"], 0)
        self.assertTrue(h.runtime._budget.finish())
        self.assertEqual(h.memory.used, 0)
        self.assertFalse(any(n == "CreateProcessAsUserW" for n, a in h.dll_calls))


if __name__ == "__main__":
    unittest.main()
