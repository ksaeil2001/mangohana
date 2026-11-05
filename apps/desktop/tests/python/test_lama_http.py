"""합성 PNG와 임시 fake worker만 사용한다. 실제 모델/API는 호출하지 않는다.

실행: python -B -m unittest discover -s tests/python -p test_lama_http.py -v
"""

import base64
import hashlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from unittest.mock import patch
import zlib

from PIL import Image


MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "local-preview" / "lama_http.py"
SPEC = importlib.util.spec_from_file_location("test_local_lama_http", MODULE_PATH)
BRIDGE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = BRIDGE
SPEC.loader.exec_module(BRIDGE)


def png(image):
    target = io.BytesIO()
    image.save(target, format="PNG")
    return target.getvalue()


def request(image, mask):
    return json.dumps({"image": base64.b64encode(image).decode("ascii"),
                       "mask": base64.b64encode(mask).decode("ascii")}).encode("ascii")


def fixtures(mode="RGBA"):
    image = Image.new("RGBA", (11, 7))
    image.putdata([(x * 19 + y, y * 31 + x, (x * 7 + y * 23) % 256,
                    (x * 13 + y * 29) % 256)
                   for y in range(image.height) for x in range(image.width)])
    if mode == "RGB":
        image = image.convert("RGB")
    mask = Image.new("RGBA", image.size, (255, 255, 255, 255))
    # 직사각형의 비대칭 좌표로 극성·축 뒤바뀜을 검출한다.
    for point in ((8, 1), (9, 1), (8, 2)):
        mask.putpixel(point, (255, 255, 255, 0))
    return image, mask, request(png(image), png(mask))


def response(image, **changes):
    body = {"version": 1, "imagePngBase64": base64.b64encode(png(image)).decode("ascii"),
            "width": image.width, "height": image.height, "tiles": 1}
    body.update(changes)
    return json.dumps(body).encode("ascii")


FAKE_WORKER = textwrap.dedent('''\
    import base64
    import hashlib
    import io
    import json
    import os
    from pathlib import Path
    import sys
    import time
    from PIL import Image

    action = ACTION
    root = Path(__file__).parent
    root.joinpath("pid").write_text(str(os.getpid()), encoding="ascii")
    if action == "blocked_stdin":
        time.sleep(30)
    payload = json.loads(sys.stdin.buffer.read())
    assert set(payload) == {"version", "imageBase64", "maskBase64"}
    assert type(payload["version"]) is int and payload["version"] == 1
    assert len(sys.argv) == 3 and sys.argv[1] == "--model"
    assert Path(sys.argv[2]).is_absolute()
    assert set(key.upper() for key in os.environ) <= {"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH"}
    assert os.environ["PATH"] == str(Path(sys.executable).parent)
    image_bytes = base64.b64decode(payload["imageBase64"], validate=True)
    image = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    mask = Image.open(io.BytesIO(base64.b64decode(payload["maskBase64"], validate=True)))
    assert mask.mode == "L" and mask.size == image.size
    assert set(mask.getdata()) <= {0, 255}
    coordinates = [[x, y] for y in range(image.height) for x in range(image.width)
                   if mask.getpixel((x, y)) == 255]
    root.joinpath("capture.json").write_text(json.dumps({
        "imageSha256": hashlib.sha256(image_bytes).hexdigest(),
        "coordinates": coordinates, "argv": sys.argv,
        "environmentKeys": list(os.environ),
    }), encoding="ascii")
    root.joinpath("ready").write_bytes(b"1")
    if action == "sleep":
        time.sleep(30)
    if action == "fail":
        sys.stderr.write("MANAGED_LAMA_FAILED\\ncredential=fake-secret-do-not-log\\n")
        sys.exit(7)
    if action == "stdout_limit":
        sys.stdout.buffer.write(b"x" * (1024 * 1024))
        sys.stdout.buffer.flush()
        time.sleep(30)
    if action == "stderr_limit":
        sys.stderr.buffer.write(b"x" * (1024 * 1024))
        sys.stderr.buffer.flush()
        time.sleep(30)
    for x, y in coordinates:
        image.putpixel((x, y), (249, 3, 173, image.getpixel((x, y))[3]))
    if action == "outside":
        image.putpixel((0, 0), (255, 255, 255, image.getpixel((0, 0))[3]))
    if action == "alpha":
        image.putpixel((8, 1), (249, 3, 173, 255))
    if action == "dimensions":
        image = image.crop((0, 0, 10, 7))
    target = io.BytesIO()
    image.save(target, format="PNG")
    result = {"version": 1, "imagePngBase64": base64.b64encode(target.getvalue()).decode("ascii"),
              "width": image.width, "height": image.height, "tiles": 1}
    if action == "protocol":
        result["version"] = 2
    if action == "invalid_json":
        sys.stdout.write("private-worker-detail")
    else:
        sys.stdout.write(json.dumps(result))
    sys.stderr.write("safe fixture credential=fake-secret-do-not-log\\n")
''')


class ValidationTests(unittest.TestCase):
    def setUp(self):
        self.image, self.mask, self.raw = fixtures()

    def test_alpha_polarity_coordinates_and_exact_original_bytes(self):
        before = bytes(self.raw)
        prepared = BRIDGE.prepare_request(self.raw)
        worker = json.loads(prepared.worker_input)
        self.assertEqual(set(worker), {"version", "imageBase64", "maskBase64"})
        self.assertEqual(base64.b64decode(worker["imageBase64"]), png(self.image))
        self.assertEqual(prepared.source.tobytes(), self.image.tobytes())
        binary = Image.open(io.BytesIO(base64.b64decode(worker["maskBase64"])))
        self.assertEqual(binary.mode, "L")
        self.assertEqual(binary.size, (11, 7))
        self.assertEqual({(x, y) for y in range(7) for x in range(11)
                          if binary.getpixel((x, y))}, {(8, 1), (9, 1), (8, 2)})
        self.assertEqual(self.raw, before)

    def test_canvas_transparent_rgb_does_not_change_removal_coordinates(self):
        expected = BRIDGE.prepare_request(self.raw).remove.tobytes()
        for rgb in ((0, 0, 0), (255, 255, 255), (127, 31, 89)):
            with self.subTest(hidden_rgb=rgb):
                mask = self.mask.copy()
                for point in ((8, 1), (9, 1), (8, 2)):
                    mask.putpixel(point, (*rgb, 0))
                prepared = BRIDGE.prepare_request(request(png(self.image), png(mask)))
                self.assertEqual(prepared.remove.tobytes(), expected)

    def test_invalid_mask_alpha_rgb_mode_size_and_empty_are_rejected(self):
        for kind in ("semi", "gray", "rgb", "size", "empty"):
            with self.subTest(kind=kind):
                mask = self.mask.copy()
                if kind == "semi":
                    mask.putpixel((4, 5), (255, 255, 255, 128))
                elif kind == "gray":
                    mask.putpixel((8, 1), (127, 127, 127, 255))
                elif kind == "rgb":
                    mask = mask.convert("RGB")
                elif kind == "size":
                    mask = mask.crop((0, 0, 10, 7))
                else:
                    mask = Image.new("RGBA", self.image.size, "white")
                with self.assertRaises(BRIDGE.BridgeError) as caught:
                    BRIDGE.prepare_request(request(png(self.image), png(mask)))
                self.assertEqual(caught.exception.status, 400)

    def test_only_exact_json_fields_and_canonical_base64_are_accepted(self):
        valid = json.loads(self.raw)
        invalid = [b"", b"{", b"[]", b"null", b'{"image":"x","image":"y","mask":"z"}',
                   json.dumps({**valid, "path": "C:/private/image.png"}).encode(),
                   json.dumps({"image": valid["image"]}).encode()]
        for field in ("image", "mask"):
            for value in (None, 1, "", "!!!!", "AA=A", "AB==", "data:image/png;base64," + valid[field],
                          valid[field] + "\n", base64.b64encode(b"not an image").decode()):
                invalid.append(json.dumps({**valid, field: value}).encode())
        for raw in invalid:
            with self.subTest(raw=raw[:50]), self.assertRaises(BRIDGE.BridgeError):
                BRIDGE.prepare_request(raw)

    def test_size_limits_before_decode(self):
        with patch.object(BRIDGE, "MAX_BODY_BYTES", len(self.raw) - 1):
            with self.assertRaises(BRIDGE.BridgeError):
                BRIDGE.prepare_request(self.raw)
        with patch.object(BRIDGE, "MAX_IMAGE_BYTES", len(png(self.image)) - 1):
            with self.assertRaises(BRIDGE.BridgeError):
                BRIDGE.prepare_request(self.raw)
        with patch.object(BRIDGE, "MAX_PIXELS", 76):
            with self.assertRaises(BRIDGE.BridgeError):
                BRIDGE.prepare_request(self.raw)

    def test_oversize_png_header_rejected_before_load(self):
        data = bytearray(png(self.image))
        data[16:24] = struct.pack(">II", 4001, 4000)
        data[29:33] = struct.pack(">I", zlib.crc32(data[12:29]))
        raw = request(bytes(data), png(self.mask))
        with patch.object(Image.Image, "load", side_effect=AssertionError("must not decompress")):
            with self.assertRaises(BRIDGE.BridgeError):
                BRIDGE.prepare_request(raw)

    def test_truncated_image_and_animated_images_are_rejected(self):
        for bad in (png(self.image)[:45], b"bad image"):
            with self.assertRaises(BRIDGE.BridgeError):
                BRIDGE.prepare_request(request(bad, png(self.mask)))
        target = io.BytesIO()
        self.image.save(target, format="PNG", save_all=True,
                        append_images=[Image.new("RGBA", self.image.size, "black")])
        with self.assertRaises(BRIDGE.BridgeError):
            BRIDGE.prepare_request(request(target.getvalue(), png(self.mask)))

    def test_valid_result_retains_every_outside_pixel_and_all_alpha(self):
        prepared = BRIDGE.prepare_request(self.raw)
        result = self.image.copy()
        for point in ((8, 1), (9, 1), (8, 2)):
            result.putpixel(point, (249, 3, 173, result.getpixel(point)[3]))
        output, tiles = BRIDGE.validate_result(response(result), prepared)
        self.assertEqual(output, png(result))
        self.assertEqual(tiles, 1)

    def test_any_outside_pixel_or_alpha_change_is_error(self):
        prepared = BRIDGE.prepare_request(self.raw)
        for point, pixel in (((0, 0), (1, 0, 0, 0)), ((8, 1), (249, 3, 173, 255)),
                             ((0, 0), (0, 0, 0, 255))):
            changed = self.image.copy()
            changed.putpixel(point, pixel)
            with self.subTest(point=point, pixel=pixel), self.assertRaises(BRIDGE.BridgeError) as caught:
                BRIDGE.validate_result(response(changed), prepared)
            self.assertEqual(caught.exception.status, 502)

    def test_invalid_worker_response_shape_dimensions_and_png_are_errors(self):
        prepared = BRIDGE.prepare_request(self.raw)
        invalid = [b"not-json", b"[]", response(self.image.crop((0, 0, 10, 7))),
                   response(self.image, version=True), response(self.image, version=2),
                   response(self.image, width=7, height=11), response(self.image, tiles=0),
                   response(self.image, tiles=65), response(self.image, tiles=True),
                   response(self.image, extra="field"), response(self.image, imagePngBase64="YWJj"),
                   response(self.image.convert("RGB"))]
        for raw in invalid:
            with self.subTest(raw=raw[:40]), self.assertRaises(BRIDGE.BridgeError):
                BRIDGE.validate_result(raw, prepared)


class WorkerFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="trio-lama-bridge-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.worker = self.root / "fake_worker.py"
        self.model = self.root / "lama_fp32.onnx"
        self.model.write_bytes(b"synthetic model, never ONNX")
        self.set_action("ok")
        self.bridge = BRIDGE.LaMaBridge(Path(sys.executable), self.worker, self.model, self.root / "logs")
        self.image, self.mask, self.raw = fixtures()
        self.processes = []
        real_popen = subprocess.Popen

        def spawn(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            self.processes.append((process, args, kwargs))
            return process

        self.popen_patch = patch.object(BRIDGE.subprocess, "Popen", side_effect=spawn)
        self.popen_patch.start()
        self.addCleanup(self.popen_patch.stop)
        self.addCleanup(self.ensure_children_closed)

    def set_action(self, action):
        self.worker.write_text(FAKE_WORKER.replace("ACTION", repr(action)), encoding="utf-8")

    def ensure_children_closed(self):
        for process, _, _ in self.processes:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=3)
                self.fail("bridge left an owned child running")
            self.assertTrue(all(stream.closed for stream in (process.stdin, process.stdout, process.stderr)))

    def wait_for_file(self, name):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if (self.root / name).exists():
                return
            time.sleep(0.01)
        self.fail("fake worker did not reach " + name)

    def record(self):
        return {"requestId": "test-request", "calls": 0}


class WorkerTests(WorkerFixture):
    def test_real_subprocess_success_closes_stdin_and_all_io_without_credentials(self):
        record = self.record()
        before = {"worker": self.worker.read_bytes(), "model": self.model.read_bytes(), "request": self.raw}
        with patch.dict(os.environ, {"API_KEY": "fake-secret-do-not-log", "PYTHONPATH": "untrusted",
                                     "HTTP_PROXY": "http://fake-secret.invalid", "AWS_SECRET_ACCESS_KEY": "fake"}):
            output = self.bridge.inpaint(self.raw, lambda: False, record)
        result = Image.open(io.BytesIO(output))
        self.assertEqual(result.size, self.image.size)
        self.assertEqual(result.getchannel("A").tobytes(), self.image.getchannel("A").tobytes())
        self.assertNotEqual(result.getpixel((8, 1)), self.image.getpixel((8, 1)))
        for y in range(self.image.height):
            for x in range(self.image.width):
                if self.mask.getpixel((x, y))[3] == 255:
                    self.assertEqual(result.getpixel((x, y)), self.image.getpixel((x, y)))
        capture = json.loads((self.root / "capture.json").read_text())
        self.assertEqual(capture["coordinates"], [[8, 1], [9, 1], [8, 2]])
        self.assertEqual(capture["imageSha256"], hashlib.sha256(png(self.image)).hexdigest())
        process, args, kwargs = self.processes[0]
        self.assertFalse(kwargs["shell"])
        self.assertEqual(args[0], [sys.executable, "-I", "-B", str(self.worker), "--model", str(self.model)])
        self.assertEqual(kwargs["env"]["PATH"], str(Path(sys.executable).parent))
        if os.name == "nt":
            self.assertEqual(kwargs["creationflags"], subprocess.CREATE_NO_WINDOW)
        self.assertEqual(record["exit"], 0)
        self.assertTrue(record["close"])
        self.assertFalse(record["timeout"])
        self.assertEqual(record["calls"], 1)
        self.bridge.log(record)
        log = (self.root / "logs" / "lama-http.jsonl").read_text()
        for forbidden in ("fake-secret", "credential=", json.loads(self.raw)["image"], str(self.model)):
            self.assertNotIn(forbidden, log)
        self.assertEqual(before, {"worker": self.worker.read_bytes(), "model": self.model.read_bytes(),
                                  "request": self.raw})
        self.assertFalse(list(self.root.rglob("*.pyc")))
        self.assertIsNotNone(process.poll())

    def test_rgb_original_is_sent_unchanged_and_retains_opaque_alpha(self):
        image, _mask, raw = fixtures("RGB")
        output = self.bridge.inpaint(raw, lambda: False, self.record())
        result = Image.open(io.BytesIO(output))
        self.assertEqual(result.getchannel("A").getextrema(), (255, 255))
        capture = json.loads((self.root / "capture.json").read_text())
        self.assertEqual(capture["imageSha256"], hashlib.sha256(png(image)).hexdigest())

    def test_failed_worker_is_error_and_does_not_return_original(self):
        self.set_action("fail")
        record = self.record()
        with self.assertRaises(BRIDGE.BridgeError) as caught:
            self.bridge.inpaint(self.raw, lambda: False, record)
        self.assertEqual(caught.exception.status, 502)
        self.assertEqual(record["exit"], 7)
        self.assertTrue(record["close"])
        self.assertNotIn("fake-secret", str(caught.exception))

    def test_invalid_results_from_actual_subprocess_are_errors(self):
        for action in ("outside", "alpha", "dimensions", "protocol", "invalid_json"):
            with self.subTest(action=action):
                self.set_action(action)
                record = self.record()
                with self.assertRaises(BRIDGE.BridgeError) as caught:
                    self.bridge.inpaint(self.raw, lambda: False, record)
                self.assertEqual(caught.exception.code, "invalid_worker_result")
                self.assertTrue(record["close"])

    def test_timeout_kills_owned_child_waits_and_joins_io(self):
        self.set_action("sleep")
        record = self.record()
        with patch.object(BRIDGE, "WORKER_TIMEOUT_SECONDS", 0.8):
            with self.assertRaises(BRIDGE.BridgeError) as caught:
                self.bridge.inpaint(self.raw, lambda: False, record)
        self.assertEqual((caught.exception.status, caught.exception.code), (504, "worker_timeout"))
        self.assertTrue(record["timeout"])
        self.assertTrue(record["close"])
        self.assertIsNotNone(record["exit"])

    def test_cancel_kills_owned_child_waits_and_joins_io(self):
        self.set_action("sleep")
        cancelled = threading.Event()
        record, errors = self.record(), []

        def run():
            try:
                self.bridge.inpaint(self.raw, cancelled.is_set, record)
            except BRIDGE.BridgeError as error:
                errors.append(error)

        thread = threading.Thread(target=run)
        thread.start()
        self.wait_for_file("ready")
        cancelled.set()
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertEqual((errors[0].status, errors[0].code), (499, "client_disconnected"))
        self.assertTrue(record["cancelled"])
        self.assertTrue(record["close"])

    def test_timeout_also_closes_writer_when_child_never_reads_stdin(self):
        self.set_action("blocked_stdin")
        record = self.record()
        with patch.object(BRIDGE, "WORKER_TIMEOUT_SECONDS", 0.8):
            with self.assertRaises(BRIDGE.BridgeError):
                self.bridge._run_worker(b"x" * (1024 * 1024), lambda: False, record)
        self.assertTrue(record["timeout"])
        self.assertTrue(record["close"])

    def test_bounded_stdout_and_stderr_terminate_child(self):
        for action in ("stdout_limit", "stderr_limit"):
            with self.subTest(action=action):
                self.set_action(action)
                record = self.record()
                with patch.object(BRIDGE, "MAX_STDOUT_BYTES", 4096), \
                        patch.object(BRIDGE, "MAX_STDERR_BYTES", 4096):
                    with self.assertRaises(BRIDGE.BridgeError) as caught:
                        self.bridge.inpaint(self.raw, lambda: False, record)
                self.assertEqual(caught.exception.code, "worker_output_limit")
                self.assertLessEqual(record["stdoutBytes"], 4096)
                self.assertLessEqual(record["stderrBytes"], 4096)
                self.assertTrue(record["close"])

    def test_cancelled_before_call_and_invalid_inputs_never_spawn_worker(self):
        for raw, cancelled in ((self.raw, lambda: True), (b"{}", lambda: False)):
            with self.subTest(raw=raw[:10]), self.assertRaises(BRIDGE.BridgeError):
                self.bridge.inpaint(raw, cancelled, self.record())
        self.assertEqual(self.processes, [])

    def test_spawn_failure_returns_fixed_error(self):
        with patch.object(BRIDGE.subprocess, "Popen", side_effect=OSError("credential=fake-secret")):
            with self.assertRaises(BRIDGE.BridgeError) as caught:
                self.bridge.inpaint(self.raw, lambda: False, self.record())
        self.assertEqual(caught.exception.code, "worker_start_failed")
        self.assertNotIn("fake-secret", str(caught.exception))

    def test_pipe_close_error_does_not_return_success_after_zero_exit(self):
        spawn = BRIDGE.subprocess.Popen.side_effect

        def spawn_with_close_error(*args, **kwargs):
            process = spawn(*args, **kwargs)
            real_close = process.stdout.close

            def close_error():
                real_close()
                raise OSError("private-close-error")

            process.stdout.close = close_error
            return process

        record = self.record()
        with patch.object(BRIDGE.subprocess, "Popen", side_effect=spawn_with_close_error):
            with self.assertRaises(BRIDGE.BridgeError) as caught:
                self.bridge.inpaint(self.raw, lambda: False, record)
        self.assertEqual(caught.exception.code, "worker_io_failed")
        self.assertTrue(record["close"])
        self.assertNotIn("private-close-error", str(caught.exception))

    def test_unconfirmed_io_join_is_error_and_prevents_further_children(self):
        real_thread = threading.Thread

        class UnconfirmedReader(real_thread):
            def is_alive(self):
                # 실제 join은 수행하되 종료 확인 불가 상태를 주입한다.
                return super().is_alive() or (self.name == "lama-stdout" and self.ident is not None)

        record = self.record()
        with patch.object(BRIDGE.threading, "Thread", UnconfirmedReader), \
                patch.object(BRIDGE, "WORKER_TIMEOUT_SECONDS", 0.8):
            with self.assertRaises(BRIDGE.BridgeError) as caught:
                self.bridge.inpaint(self.raw, lambda: False, record)
        self.assertEqual((caught.exception.status, caught.exception.code), (502, "worker_cleanup_failed"))
        self.assertFalse(record["close"])
        with self.assertRaises(BRIDGE.BridgeError) as unavailable:
            self.bridge.inpaint(self.raw, lambda: False, self.record())
        self.assertEqual(unavailable.exception.status, 503)
        self.assertEqual(len(self.processes), 1)


class HTTPTests(WorkerFixture):
    def setUp(self):
        super().setUp()
        self.server = BRIDGE.LaMaHTTPServer(self.bridge, 0)
        self.server_thread = threading.Thread(target=self.server.serve_forever,
                                              kwargs={"poll_interval": 0.02})
        self.server_thread.start()
        self.addCleanup(self.close_server)

    def close_server(self):
        self.bridge.stopping.set()
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(timeout=5)
        self.assertFalse(self.server_thread.is_alive())

    def http(self, method, path="/inpaint", body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        self.addCleanup(connection.close)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()

    def test_get_and_head_health_200_loopback_without_worker(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        for method in ("GET", "HEAD"):
            status, headers, data = self.http(method)
            self.assertEqual(status, 200)
            self.assertEqual(headers["Content-Type"], "application/json")
            self.assertEqual(data, b"" if method == "HEAD" else b'{"status":"ok"}')
        self.assertEqual(self.processes, [])

    def test_http_success_returns_validated_png_and_safe_audit_record(self):
        status, headers, data = self.http("POST", body=self.raw, headers={"Content-Type": "application/json"})
        self.assertEqual((status, headers["Content-Type"]), (200, "image/png"))
        self.assertEqual(len(data), int(headers["Content-Length"]))
        image = Image.open(io.BytesIO(data))
        self.assertEqual(image.getpixel((8, 1)), (249, 3, 173, self.image.getpixel((8, 1))[3]))
        self.wait_for_log()
        record = json.loads((self.bridge.log_dir / "lama-http.jsonl").read_text().splitlines()[-1])
        self.assertEqual(record["status"], 200)
        self.assertEqual(len(record["requestId"]), 32)
        self.assertEqual(record["calls"], 1)
        self.assertTrue(record["close"])
        self.assertEqual(record["imageSha256"], hashlib.sha256(png(self.image)).hexdigest())

    def wait_for_log(self):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            path = self.bridge.log_dir / "lama-http.jsonl"
            if path.exists() and path.read_text().endswith("\n"):
                return
            time.sleep(0.01)
        self.fail("request log missing")

    def test_http_shape_body_limit_paths_and_decode_errors_never_spawn(self):
        cases = [
            ("/else", self.raw, {"Content-Type": "application/json"}, 404),
            ("/inpaint?path=C:/private", self.raw, {"Content-Type": "application/json"}, 404),
            ("/inpaint", self.raw, {"Content-Type": "text/plain"}, 400),
            ("/inpaint", self.raw, {"Content-Type": "application/json", "Transfer-Encoding": "chunked"}, 400),
            ("/inpaint", self.raw, {"Content-Type": "application/json", "Content-Encoding": "gzip"}, 400),
            ("/inpaint", b"{}", {"Content-Type": "application/json"}, 400),
            ("/inpaint", b'{"image":"abc","mask":"abc","path":"secret"}',
             {"Content-Type": "application/json"}, 400),
            ("/inpaint", b"", {"Content-Type": "application/json"}, 413),
            ("/inpaint", b"", {"Content-Type": "application/json", "Content-Length": str(BRIDGE.MAX_BODY_BYTES + 1)}, 413),
        ]
        for path, body, headers, expected in cases:
            with self.subTest(path=path, headers=headers):
                status, response_headers, data = self.http("POST", path, body, headers)
                self.assertEqual(status, expected)
                self.assertEqual(response_headers["Content-Type"], "application/json")
                self.assertNotIn(b"secret", data)
                self.assertNotIn(b"image/png", data)
        self.assertEqual(self.processes, [])

    def test_response_releases_processing_lock_before_slow_audit_log(self):
        entered, release = threading.Event(), threading.Event()
        real_log = self.bridge.log

        def slow_log(record):
            if not entered.is_set():
                entered.set()
                release.wait(timeout=5)
            real_log(record)

        with patch.object(self.bridge, "log", side_effect=slow_log):
            try:
                first = self.http("POST", body=b"{}", headers={"Content-Type": "application/json"})
                self.assertEqual(first[0], 400)
                self.assertTrue(entered.wait(timeout=3))
                second = self.http("POST", body=b"{}", headers={"Content-Type": "application/json"})
                self.assertEqual(second[0], 400)
            finally:
                release.set()
        self.assertEqual(self.processes, [])

    def test_invalid_content_lengths_and_incomplete_body_are_rejected(self):
        for length_header, data in ((b"", b""), (b"Content-Length: -1\r\n", b""),
                                    (b"Content-Length: text\r\n", b""),
                                    (b"Content-Length: 2\r\nContent-Length: 2\r\n", b"{}"),
                                    (b"Content-Length: 10\r\n", b"{}")):
            with self.subTest(length_header=length_header):
                connection = socket.create_connection(self.server.server_address, timeout=5)
                self.addCleanup(connection.close)
                connection.sendall(b"POST /inpaint HTTP/1.1\r\nHost: localhost\r\n"
                                   b"Content-Type: application/json\r\n" + length_header + b"\r\n" + data)
                connection.shutdown(socket.SHUT_WR)
                received = http.client.HTTPResponse(connection)
                received.begin()
                self.assertEqual(received.status, 400)
                self.assertIn("error", json.loads(received.read()))
                received.close()
        self.assertEqual(self.processes, [])

    def test_http_body_read_timeout_is_error_without_child(self):
        with patch.object(BRIDGE, "HTTP_IO_TIMEOUT_SECONDS", 0.1):
            connection = socket.create_connection(self.server.server_address, timeout=5)
            self.addCleanup(connection.close)
            connection.sendall(b"POST /inpaint HTTP/1.1\r\nHost: localhost\r\n"
                               b"Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{")
            received = http.client.HTTPResponse(connection)
            received.begin()
            self.assertEqual(received.status, 408)
            self.assertEqual(json.loads(received.read())["error"], "http_timeout")
            received.close()
        self.assertEqual(self.processes, [])

    def test_http_worker_failure_timeout_invalid_result_never_return_original(self):
        for action, expected in (("fail", 502), ("outside", 502), ("sleep", 504)):
            with self.subTest(action=action):
                self.set_action(action)
                with patch.object(BRIDGE, "WORKER_TIMEOUT_SECONDS", 0.8):
                    status, headers, data = self.http("POST", body=self.raw,
                                                     headers={"Content-Type": "application/json"})
                self.assertEqual(status, expected)
                self.assertEqual(headers["Content-Type"], "application/json")
                self.assertNotEqual(data, png(self.image))
                self.assertNotIn(b"fake-secret", data)
                self.assertNotIn(b"private-worker-detail", data)

    def test_http_client_disconnect_terminates_owned_child_and_records_close(self):
        self.set_action("sleep")
        connection = socket.create_connection(self.server.server_address, timeout=5)
        connection.sendall(b"POST /inpaint HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n"
                           + ("Content-Length: %d\r\n\r\n" % len(self.raw)).encode() + self.raw)
        self.wait_for_file("ready")
        connection.close()
        self.wait_for_log()
        record = json.loads((self.bridge.log_dir / "lama-http.jsonl").read_text().splitlines()[-1])
        self.assertEqual(record["reason"], "client_disconnected")
        self.assertTrue(record["close"])
        self.assertTrue(record["cancelled"])
        self.assertIsNotNone(self.processes[0][0].poll())

    def test_single_request_lock_and_health_remains_available(self):
        self.set_action("sleep")
        connection = socket.create_connection(self.server.server_address, timeout=5)
        connection.sendall(b"POST /inpaint HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n"
                           + ("Content-Length: %d\r\n\r\n" % len(self.raw)).encode() + self.raw)
        self.wait_for_file("ready")
        status, _, data = self.http("POST", body=self.raw, headers={"Content-Type": "application/json"})
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(data)["error"], "worker_busy")
        self.assertEqual(self.http("HEAD")[0], 200)
        self.assertEqual(len(self.processes), 1)
        connection.close()

    def test_port_collision_does_not_launch_or_kill_any_process(self):
        with self.assertRaises(OSError):
            BRIDGE.LaMaHTTPServer(self.bridge, self.server.server_port)
        self.assertEqual(self.processes, [])
        self.assertEqual(self.http("GET")[0], 200)


if __name__ == "__main__":
    unittest.main()
