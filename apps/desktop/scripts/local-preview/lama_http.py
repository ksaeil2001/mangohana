"""기존 오프라인 LaMa worker를 앱의 로컬 HTTP adapter에 연결한다.

설치·모델 다운로드·원본 파일 쓰기는 하지 않는다. 경로는 Main이 CLI로만
지정하며, 요청은 이미지와 앱의 흰색/이진 알파 마스크만 받는다.
"""

import argparse
import base64
from dataclasses import dataclass
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import threading
import time
import uuid
import warnings

from PIL import Image, ImageChops


MAX_BODY_BYTES = 32 * 1024 * 1024
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_STDOUT_BYTES = 32 * 1024 * 1024
MAX_STDERR_BYTES = 64 * 1024
MAX_PIXELS = 16_000_000
MAX_SIDE = 32_768
WORKER_TIMEOUT_SECONDS = 55.0
CLEANUP_TIMEOUT_SECONDS = 3.0
HTTP_IO_TIMEOUT_SECONDS = 10.0


class BridgeError(Exception):
    """외부에 반환해도 되는 고정 오류 코드만 보관한다."""

    def __init__(self, status, code):
        super().__init__(code)
        self.status = status
        self.code = code


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_key")
        result[key] = value
    return result


def _invalid_constant(_value):
    raise ValueError("invalid_constant")


def _json(raw):
    return json.loads(raw.decode("utf-8"), object_pairs_hook=_object,
                      parse_constant=_invalid_constant)


def _base64(value):
    if (not isinstance(value, str) or not value or len(value) % 4
            or len(value) > 4 * ((MAX_IMAGE_BYTES + 2) // 3)):
        raise ValueError("invalid_base64")
    data = base64.b64decode(value, validate=True)
    if (not data or len(data) > MAX_IMAGE_BYTES
            or base64.b64encode(data).decode("ascii") != value):
        raise ValueError("invalid_base64")
    return data


def _image(data, formats, modes):
    # 헤더 크기를 먼저 검사하고 EXIF 회전은 적용하지 않는다. 마스크는
    # 실제 디코딩 좌표를 가리킨다. 기존 Pillow만 사용한다.
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(data), formats=formats) as image:
            width, height = image.size
            if (not 0 < width <= MAX_SIDE or not 0 < height <= MAX_SIDE
                    or width * height > MAX_PIXELS
                    or getattr(image, "n_frames", 1) != 1 or image.mode not in modes):
                raise ValueError("invalid_image")
            image.load()
            return image.copy()


@dataclass(frozen=True)
class PreparedRequest:
    source: Image.Image
    remove: Image.Image
    worker_input: bytes
    image_sha256: str
    mask_sha256: str


def prepare_request(raw):
    try:
        if not raw or len(raw) > MAX_BODY_BYTES:
            raise ValueError("body_limit")
        body = _json(raw)
        if not isinstance(body, dict) or set(body) != {"image", "mask"}:
            raise ValueError("invalid_request")
        image_bytes, mask_bytes = _base64(body["image"]), _base64(body["mask"])
        source = _image(image_bytes, ["PNG", "JPEG", "WEBP"], ("RGB", "RGBA"))
        mask = _image(mask_bytes, ["PNG"], ("RGBA",))
        if mask.size != source.size:
            raise ValueError("invalid_mask")
        alpha = mask.getchannel("A")
        if any(alpha.histogram()[1:255]):
            raise ValueError("nonbinary_alpha")
        # Canvas PNG는 alpha=0 픽셀의 보이지 않는 RGB를 0으로 정규화한다.
        # 제거 좌표는 이진 alpha만 소유한다. 보존 픽셀의 흰 RGB는 계속 검사한다.
        white = Image.new("RGB", mask.size, "white")
        if any(ImageChops.multiply(channel, alpha).getbbox() is not None
               for channel in ImageChops.difference(mask.convert("RGB"), white).split()):
            raise ValueError("invalid_preserved_rgb")
        # 앱: alpha=0 제거, 흰색 RGB + alpha=255 보존.
        # worker: 불투명 L PNG의 검정 보존, 흰색 제거. 추측 분기는 없다.
        remove = ImageChops.invert(alpha)
        if remove.getbbox() is None:
            raise ValueError("empty_mask")
        target = io.BytesIO()
        remove.save(target, format="PNG")
        worker_input = json.dumps({
            "version": 1,
            "imageBase64": body["image"],
            "maskBase64": base64.b64encode(target.getvalue()).decode("ascii"),
        }, separators=(",", ":"), allow_nan=False).encode("ascii")
        if len(worker_input) > MAX_BODY_BYTES:
            raise ValueError("worker_input_limit")
        return PreparedRequest(source.convert("RGBA"), remove, worker_input,
                               hashlib.sha256(image_bytes).hexdigest(),
                               hashlib.sha256(mask_bytes).hexdigest())
    except (ValueError, TypeError, KeyError, OSError,
            Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise BridgeError(400, "invalid_image_or_mask") from None


def validate_result(raw, prepared):
    try:
        response = _json(raw)
        if (not isinstance(response, dict)
                or set(response) != {"version", "imagePngBase64", "width", "height", "tiles"}
                or type(response["version"]) is not int or response["version"] != 1
                or type(response["width"]) is not int or type(response["height"]) is not int
                or (response["width"], response["height"]) != prepared.source.size
                or type(response["tiles"]) is not int or not 1 <= response["tiles"] <= 64):
            raise ValueError("invalid_worker_response")
        png = _base64(response["imagePngBase64"])
        result = _image(png, ["PNG"], ("RGBA",))
        if result.size != prepared.source.size:
            raise ValueError("result_size")
        if ImageChops.difference(result.getchannel("A"),
                                 prepared.source.getchannel("A")).getbbox() is not None:
            raise ValueError("result_alpha")
        preserve = ImageChops.invert(prepared.remove)
        difference = ImageChops.difference(result.convert("RGB"), prepared.source.convert("RGB"))
        if any(ImageChops.multiply(channel, preserve).getbbox() is not None
               for channel in difference.split()):
            raise ValueError("outside_mask_changed")
        return png, response["tiles"]
    except (ValueError, TypeError, KeyError, OSError,
            Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise BridgeError(502, "invalid_worker_result") from None


def worker_environment(python):
    # 허용된 OS 경로만 상속한다. PATH도 부모의 값을 복사하지 않는다.
    env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "TEMP", "TMP")
           if key in os.environ}
    env["PATH"] = str(python.parent)
    return env


class LaMaBridge:
    def __init__(self, python, worker, model, log_dir, tile_wrapper=None):
        paths = tuple(Path(value) for value in (python, worker, model))
        if any(not path.is_absolute() or not path.is_file() for path in paths):
            raise ValueError("invalid_main_paths")
        self.python, self.worker, self.model = paths
        self.tile_wrapper = Path(tile_wrapper) if tile_wrapper is not None else None
        if self.tile_wrapper is not None and (not self.tile_wrapper.is_absolute() or not self.tile_wrapper.is_file()):
            raise ValueError("invalid_tile_wrapper")
        self.log_dir = Path(log_dir)
        if not self.log_dir.is_absolute():
            raise ValueError("invalid_log_directory")
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.log_lock = threading.Lock()
        self.stopping = threading.Event()
        self.unsafe_cleanup = threading.Event()

    def log(self, record):
        # 요청 본문, 이미지, stderr 원문, 경로, 환경, 예외 문자열은 기록하지 않는다.
        line = json.dumps({"time": round(time.time(), 3), **record},
                          separators=(",", ":"), allow_nan=False)
        with self.log_lock:
            with (self.log_dir / "lama-http.jsonl").open("a", encoding="utf-8") as target:
                target.write(line + "\n")

    def inpaint(self, raw, cancelled, record):
        if self.unsafe_cleanup.is_set() or self.stopping.is_set():
            raise BridgeError(503, "worker_unavailable")
        prepared = prepare_request(raw)
        record.update(imageSha256=prepared.image_sha256, maskSha256=prepared.mask_sha256)
        output = self._run_worker(prepared.worker_input, cancelled, record)
        png, tiles = validate_result(output, prepared)
        if cancelled() or self.stopping.is_set():
            raise BridgeError(499, "client_disconnected")
        record.update(resultSha256=hashlib.sha256(png).hexdigest(), tiles=tiles)
        return png

    def _run_worker(self, payload, cancelled, record):
        if cancelled() or self.stopping.is_set():
            raise BridgeError(499, "client_disconnected")
        deadline = time.monotonic() + WORKER_TIMEOUT_SECONDS
        options = {}
        if os.name == "nt":
            # Python의 windowsHide: 콘솔 창을 만들지 않는다.
            options["creationflags"] = subprocess.CREATE_NO_WINDOW
        try:
            command = [str(self.python), "-I", "-B"]
            command += ([str(self.tile_wrapper), "--worker", str(self.worker)]
                        if self.tile_wrapper is not None else [str(self.worker)])
            command += ["--model", str(self.model)]
            process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                bufsize=0, shell=False, close_fds=True, cwd=str(self.python.parent),
                env=worker_environment(self.python), **options)
        except OSError:
            raise BridgeError(502, "worker_start_failed") from None
        record.update(calls=1, pid=process.pid)
        stdout, stderr = bytearray(), bytearray()
        overflow = threading.Event()
        io_failed = threading.Event()

        def close_pipe(stream):
            try:
                stream.close()
            except OSError:
                io_failed.set()

        def read_pipe(stream, buffer, limit):
            try:
                while True:
                    chunk = stream.read(64 * 1024)
                    if not chunk:
                        break
                    remaining = limit - len(buffer)
                    buffer.extend(chunk[:remaining])
                    if len(chunk) > remaining:
                        overflow.set()
            except OSError:
                io_failed.set()
            finally:
                close_pipe(stream)

        def write_input():
            try:
                data = memoryview(payload)
                while data:
                    written = process.stdin.write(data[:64 * 1024])
                    if not written:
                        raise OSError("stdin_closed")
                    data = data[written:]
            except OSError:
                io_failed.set()
            finally:
                close_pipe(process.stdin)

        threads = [
            threading.Thread(target=write_input, name="lama-stdin", daemon=True),
            threading.Thread(target=read_pipe, args=(process.stdout, stdout, MAX_STDOUT_BYTES),
                             name="lama-stdout", daemon=True),
            threading.Thread(target=read_pipe, args=(process.stderr, stderr, MAX_STDERR_BYTES),
                             name="lama-stderr", daemon=True),
        ]
        reason = None
        try:
            for thread in threads:
                thread.start()
            while True:
                if cancelled() or self.stopping.is_set():
                    reason = "client_disconnected"
                    break
                if overflow.is_set():
                    reason = "worker_output_limit"
                    break
                if io_failed.is_set():
                    reason = "worker_io_failed"
                    break
                if time.monotonic() >= deadline:
                    reason = "worker_timeout"
                    break
                if process.poll() is not None and not any(thread.is_alive() for thread in threads):
                    break
                time.sleep(0.02)
        finally:
            cleanup_deadline = time.monotonic() + CLEANUP_TIMEOUT_SECONDS
            if process.poll() is None:
                try:
                    process.kill()  # 이 요청이 생성한 자식만 종료한다.
                except OSError:
                    pass
            try:
                process.wait(timeout=max(0.001, cleanup_deadline - time.monotonic()))
            except (subprocess.TimeoutExpired, OSError):
                pass
            for thread in threads:
                if thread.ident is not None:
                    thread.join(timeout=max(0, cleanup_deadline - time.monotonic()))
            closed = (process.poll() is not None and not any(thread.is_alive() for thread in threads)
                      and all(stream.closed for stream in (process.stdin, process.stdout, process.stderr)))
            record.update(exit=process.returncode, close=closed, timeout=reason == "worker_timeout",
                          cancelled=reason == "client_disconnected", stdoutBytes=len(stdout),
                          stderrBytes=len(stderr), stderrReason=(
                              "MANAGED_LAMA_FAILED" if bytes(stderr).strip() == b"MANAGED_LAMA_FAILED"
                              else "worker_diagnostic" if stderr else "none"))
            if not closed:
                self.unsafe_cleanup.set()
        if not closed:
            raise BridgeError(502, "worker_cleanup_failed")
        # 마지막 poll 직후 reader가 종료된 경우에도 상한/입출력 실패를 확인한다.
        if reason is None and overflow.is_set():
            reason = "worker_output_limit"
        if reason is None and io_failed.is_set():
            reason = "worker_io_failed"
        if reason is not None:
            status = 504 if reason == "worker_timeout" else 499 if reason == "client_disconnected" else 502
            raise BridgeError(status, reason)
        if process.returncode != 0:
            raise BridgeError(502, "worker_failed")
        return bytes(stdout)


def client_disconnected(connection):
    # HTTP 응답을 기다리는 동안 EOF/RST를 감시한다. 요청 데이터는 소비하지 않는다.
    try:
        readable, _, _ = select.select([connection], [], [], 0)
        return bool(readable) and connection.recv(1, socket.MSG_PEEK) == b""
    except OSError:
        return True


class LaMaHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = False

    def __init__(self, bridge, port):
        self.bridge = bridge
        # 주소는 CLI나 요청에서 받지 않는다. 포트 충돌 시 bind 오류로 종료한다.
        super().__init__(("127.0.0.1", port), LaMaHandler)

    def handle_error(self, _request, _client_address):
        self.bridge.log({"event": "handler_failed", "reason": "http_io_failed"})


class LaMaHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "LaMaLocal"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(HTTP_IO_TIMEOUT_SECONDS)

    def log_message(self, _format, *args):
        pass  # 기본 access log는 임의 URL/요청 문자열을 포함할 수 있다.

    def _reply(self, status, body, content_type="application/json"):
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status, code):
        self._reply(status, json.dumps({"error": code}, separators=(",", ":")).encode("ascii"))

    def send_error(self, code, message=None, explain=None):
        self._error(code, "invalid_http_request")

    def do_GET(self):
        if self.path != "/inpaint":
            self._error(404, "not_found")
            return
        self._reply(200, b'{"status":"ok"}')

    do_HEAD = do_GET

    def do_POST(self):
        bridge = self.server.bridge
        record = {"event": "inpaint", "requestId": uuid.uuid4().hex, "calls": 0}
        try:
            if self.path != "/inpaint":
                raise BridgeError(404, "not_found")
            if not bridge.lock.acquire(blocking=False):
                raise BridgeError(503, "worker_busy")
            try:
                if (self.headers.get_all("Transfer-Encoding") or self.headers.get_all("Content-Encoding")
                        or self.headers.get_content_type() != "application/json"):
                    raise BridgeError(400, "invalid_http_body")
                lengths = self.headers.get_all("Content-Length", [])
                if (len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdecimal()
                        or len(lengths[0]) > 10):
                    raise BridgeError(400, "invalid_content_length")
                length = int(lengths[0])
                if not 0 < length <= MAX_BODY_BYTES:
                    raise BridgeError(413, "body_limit")
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise BridgeError(400, "incomplete_body")
                png = bridge.inpaint(raw, lambda: client_disconnected(self.connection), record)
            finally:
                # 응답 이후의 로그 I/O가 다음 정상 요청을 busy로 만들지 않는다.
                bridge.lock.release()
            self._reply(200, png, "image/png")
            record["status"] = 200
        except BridgeError as error:
            record.update(status=error.status, reason=error.code)
            try:
                self._error(error.status, error.code)
            except OSError:
                pass
        except (TimeoutError, socket.timeout):
            record.update(status=408, reason="http_timeout")
            try:
                self._error(408, "http_timeout")
            except OSError:
                pass
        except OSError:
            record.update(status=499, reason="http_io_failed")
        except Exception:
            record.update(status=500, reason="bridge_failed")
            try:
                self._error(500, "bridge_failed")
            except OSError:
                pass
        finally:
            bridge.log(record)


def main(argv=None):
    parser = argparse.ArgumentParser(description="기존 LaMa CPU worker용 로컬 HTTP 연결")
    parser.add_argument("--python", required=True, type=Path)
    parser.add_argument("--worker", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--tile-wrapper", type=Path)
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--log-dir", required=True, type=Path)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("port는 1~65535여야 합니다.")
    try:
        bridge = LaMaBridge(args.python, args.worker, args.model, args.log_dir, args.tile_wrapper)
        server = LaMaHTTPServer(bridge, args.port)
    except (OSError, ValueError):
        parser.exit(1, "로컬 LaMa 시작 실패: 경로와 포트 사용 여부를 확인하세요.\n")
    bridge.log({"event": "listening", "port": server.server_port})
    try:
        server.serve_forever(poll_interval=0.1)
    except KeyboardInterrupt:
        pass
    finally:
        bridge.stopping.set()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
