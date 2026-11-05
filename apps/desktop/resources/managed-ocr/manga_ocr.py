"""Two fixed offline OCR profiles over the Production OCR NDJSON transport.

Manga DB postprocessing follows Kellenok/PP-OCRv6_manga c94f4a2 (Apache-2.0).
The signed base pack is read-only; Hayai dependencies never enter its process.
"""
import sys

# The embedded signed interpreter can enable site in its _pth. Narrow imports to
# stdlib before loading either profile; -I alone does not remove site-packages.
_base = sys.base_prefix
_version = "{}.{}".format(*sys.version_info[:2])
if sys.platform == "win32":
    sys.path[:] = [_base + "/python" + _version.replace(".", "") + ".zip",
                   _base + "/Lib", _base + "/DLLs", _base]
else:
    sys.path[:] = [_base + "/lib/python" + _version, _base + "/lib/python" + _version + "/lib-dynload"]

import argparse
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import logging
import os
from pathlib import Path

MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_PIXELS = 16_000_000
MAX_REQUEST_BYTES = 24 * 1024 * 1024
IDENTITIES = {
    "manga-detection": ("Kellenok/PP-OCRv6_manga", "c94f4a20677f1ba0c90625bccf42ea980f24e2f4",
                        "d132078c46e292b226fb5a2ca52a7612ad319262dfdf493e7d8e3be435295978", "CPUExecutionProvider"),
    "hayai": ("JustANormalTinkerer/hayai-ocr-v2.5-nova", "2803d0dc005fa4396ab1e7c5a472d2c450a247f7",
              "ac63cd177c5b68bd91e18dd4408e0400461c7cf19f484b0da1643e232d1ffc3a", "torch-cpu")
}


def load_local(name, filename):
    path = Path(__file__).resolve().parent / filename
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def verify_model_file(verifier, path, pin):
    verifier.require(isinstance(pin, dict) and type(pin.get("size")) is int and 0 < pin["size"] < 2 * 1024 ** 3
                     and isinstance(pin.get("sha256"), str) and verifier._SHA.fullmatch(pin["sha256"]), "invalid model pin")
    first = verifier.checked_stat(path)
    verifier.require(first.st_size == pin["size"], "model size mismatch")
    with open(path, "rb") as handle:
        verifier.require(verifier.identity(first) == verifier.identity(os.fstat(handle.fileno())), "model handle changed")
        fingerprint = verifier.handle_identity(handle)
        digest = hashlib.sha256()
        size = 0
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            verifier.require(size <= pin["size"], "model grew while hashing")
            digest.update(chunk)
        verifier.require(size == pin["size"] and digest.hexdigest() == pin["sha256"], "model hash mismatch")
        verifier.require(fingerprint == verifier.handle_identity(handle), "model changed while hashing")
        verifier.require(verifier.identity(first) == verifier.identity(verifier.checked_stat(path)), "model identity changed")
    return False, verifier.identity(first), fingerprint


def verify_model_tree(verifier, root, files):
    root = verifier.checked_root(str(root))
    verifier.require(isinstance(files, list) and 0 < len(files) <= 32, "invalid model manifest")
    expected = {}
    paths = {}
    for pin in files:
        verifier.require(isinstance(pin, dict), "invalid model manifest entry")
        name = pin.get("path")
        verifier.claim_path(paths, name, False)
        expected[name] = pin
    snapshot = {}
    found = set()

    def visit(directory, prefix=""):
        first = verifier.identity(verifier.checked_stat(directory, True))
        for child in directory.iterdir():
            name = prefix + child.name
            entry = paths.get(name.casefold())
            verifier.require(entry is not None and entry[0] == name, "unknown model entry")
            if entry[1]:
                visit(child, name + "/")
            else:
                snapshot[child] = verify_model_file(verifier, child, expected[name])
                found.add(name)
        verifier.require(first == verifier.identity(verifier.checked_stat(directory, True)), "model directory changed")
        snapshot[directory] = (True, first, None)

    visit(root)
    verifier.require(found == set(expected), "missing model file")
    verifier.assert_unchanged(snapshot)
    return root, snapshot


def decode_image_bytes(encoded):
    if not isinstance(encoded, str) or len(encoded) > MAX_IMAGE_BYTES * 4 // 3 + 8:
        raise ValueError("Invalid image encoding size")
    data = base64.b64decode(encoded, validate=True)
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ValueError("Invalid image size")
    return data


def decode_image(encoded):
    from PIL import Image
    image = Image.open(io.BytesIO(decode_image_bytes(encoded)))
    if image.width < 1 or image.height < 1 or image.width * image.height > MAX_PIXELS:
        raise ValueError("Invalid raster size")
    image.load()
    return image.convert("RGB")


def signed_detector_runtime(pack_root, verifier):
    base = verifier.checked_root(str(Path(sys.executable).parent))
    pack = verifier.checked_root(str(pack_root))
    verifier.require(base.parent == pack, "interpreter is outside signed pack")
    # Only signed-pack paths: legacy lib and the standard site-packages layout.
    libraries = [path for path in (pack / "lib", base / "lib", base / "Lib" / "site-packages") if path.is_dir()]
    verifier.require(bool(libraries), "signed detector libraries are missing")
    for path in libraries:
        verifier.checked_root(str(path))
    forbidden = ("numpy", "PIL", "onnxruntime", "cv2", "pyclipper", "torch", "transformers")
    verifier.require(not any(name in sys.modules for name in forbidden), "foreign detector modules already loaded")
    sys.path[:] = [str(path) for path in libraries] + [str(base / "python310.zip"), str(base), str(base / "Lib"), str(base / "DLLs")]
    import numpy
    import onnxruntime
    import cv2
    import pyclipper
    import PIL.Image
    import PIL._imaging
    import numpy._core._multiarray_umath
    import onnxruntime.capi.onnxruntime_pybind11_state
    import pyclipper._pyclipper
    for module in (numpy, onnxruntime, cv2, pyclipper, PIL.Image, PIL._imaging,
                   numpy._core._multiarray_umath, onnxruntime.capi.onnxruntime_pybind11_state, pyclipper._pyclipper):
        actual = Path(module.__file__).resolve(strict=True)
        verifier.require(any(root in actual.parents for root in libraries), "unexpected signed module origin")


class MangaDetector:
    def __init__(self, model_path):
        import onnxruntime as ort
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(model_path), options, providers=["CPUExecutionProvider"])
        self.assert_ready()
        inputs = self.session.get_inputs()
        if len(inputs) != 1:
            raise ValueError("Unexpected detector inputs")
        self.input = inputs[0].name

    def assert_ready(self):
        if self.session.get_providers() != ["CPUExecutionProvider"]:
            raise ValueError("Expected CPU detector")

    def detect(self, image):
        import cv2
        import numpy as np
        import pyclipper
        # Upstream uses BGR, while Hayai consumes RGB in its separate process.
        source = np.asarray(image)[:, :, ::-1].copy()
        height, width = source.shape[:2]
        ratio = 960.0 / max(height, width)
        rh = max(round(height * ratio / 32) * 32, 32)
        rw = max(round(width * ratio / 32) * 32, 32)
        values = cv2.resize(source, (rw, rh)).astype(np.float32) / 255.0
        values = (values - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)
        outputs = self.session.run(None, {self.input: values.transpose(2, 0, 1)[None]})
        if not outputs or outputs[0].shape != (1, 1, rh, rw):
            raise ValueError("Unexpected detector tensor")
        pred = outputs[0][0, 0]
        if not np.isfinite(pred).all() or pred.min() < 0 or pred.max() > 1:
            raise ValueError("Invalid detector probabilities")
        contours, _ = cv2.findContours((pred > 0.15).astype(np.uint8) * 255, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        detections = []
        for contour in contours:
            points = contour.squeeze(1)
            if points.ndim != 2 or len(points) < 4:
                continue
            xmin, ymin = np.maximum(points.min(axis=0), 0)
            xmax, ymax = np.minimum(points.max(axis=0), [rw - 1, rh - 1])
            mask = np.zeros((ymax - ymin + 1, xmax - xmin + 1), np.uint8)
            cv2.fillPoly(mask, [(points - [xmin, ymin]).astype(np.int32)], 1)
            score = float(cv2.mean(pred[ymin:ymax + 1, xmin:xmax + 1], mask)[0])
            if score < 0.25:
                continue
            area = cv2.contourArea(points)
            perimeter = cv2.arcLength(points, True)
            if area <= 0 or perimeter <= 0:
                continue
            offset = pyclipper.PyclipperOffset()
            offset.AddPath(points.tolist(), pyclipper.JT_ROUND, pyclipper.ET_CLOSEDPOLYGON)
            expanded = offset.Execute(area * 1.4 / perimeter)
            if len(expanded) != 1 or not expanded[0]:
                continue
            rect = cv2.minAreaRect(np.array(expanded[0], np.float32))
            if min(rect[1]) < 3:
                continue
            box = cv2.boxPoints(rect)
            box[:, 0] = np.clip(np.round(box[:, 0] / rw * width), 0, width)
            box[:, 1] = np.clip(np.round(box[:, 1] / rh * height), 0, height)
            by_x = sorted(box.tolist(), key=lambda point: point[0])
            left = sorted(by_x[:2], key=lambda point: point[1])
            right = sorted(by_x[2:], key=lambda point: point[1])
            quad = [left[0], right[0], right[1], left[1]]
            if max(point[0] for point in quad) <= min(point[0] for point in quad) or max(point[1] for point in quad) <= min(point[1] for point in quad):
                continue
            detections.append({"detectionId": f"{len(detections) + 1:04d}", "quad": quad, "score": score})
        return {"imageWidth": width, "imageHeight": height, "detections": detections, "complete": True}


class Sidecar:
    def __init__(self, pack_root):
        self.pack_root = pack_root
        self.configuration = None
        self.model = None
        self.text_verifier = None
        self.snapshot = None
        self.identity = None
        self.verifier = load_local("_mangohana_asset_verifier", "verify_runtime.py")

    def initialize(self, config):
        if not isinstance(config, dict) or config.get("profile") not in IDENTITIES:
            raise ValueError("Unsupported OCR profile")
        model_id, revision, sha256, provider = IDENTITIES[config["profile"]]
        if config.get("modelId") != model_id or config.get("revision") != revision:
            raise ValueError("Unexpected model identity")
        if config["profile"] == "manga-detection":
            pin = config.get("modelFile")
            if not isinstance(pin, dict) or pin.get("sha256") != sha256 or pin.get("size") != 1816954:
                raise ValueError("Unexpected detector pin")
            path = Path(config["modelPath"])
            self.verifier.checked_root(str(path.parent))
            snapshot = {path: verify_model_file(self.verifier, path, pin)}
            text_evidence = load_local("_mangohana_text_evidence", "text_evidence.py")
            evidence_config = config.get("textEvidence")
            if not isinstance(evidence_config, dict) or evidence_config.get("ruleVersion") != text_evidence.RULE_VERSION \
                    or type(evidence_config.get("ruleVersion")) is not int or evidence_config.get("component") != "rec" \
                    or evidence_config.get("modelId") != model_id or evidence_config.get("revision") != revision:
                raise ValueError("Unexpected text evidence identity")
            for key, expected_pin in (("modelFile", text_evidence.REC_PIN), ("dictionaryFile", text_evidence.DICT_PIN)):
                actual_pin = evidence_config.get(key)
                if not isinstance(actual_pin, dict) or any(actual_pin.get(key) != value for key, value in expected_pin.items()) \
                        or type(actual_pin.get("size")) is not int:
                    raise ValueError("Unexpected text evidence pin")
            root = self.verifier.checked_root(evidence_config.get("modelRoot"))
            if root.name != "manga-" + revision[:8]:
                raise ValueError("Unexpected text evidence root")
            model_path = root / text_evidence.REC_PIN["path"]
            dictionary_path = root / text_evidence.DICT_PIN["path"]
            self.verifier.checked_root(str(model_path.parent))
            for directory in (root, model_path.parent):
                snapshot[directory] = (True, self.verifier.identity(self.verifier.checked_stat(directory, True)), None)
            snapshot[model_path] = verify_model_file(self.verifier, model_path, text_evidence.REC_PIN)
            snapshot[dictionary_path] = verify_model_file(self.verifier, dictionary_path, text_evidence.DICT_PIN)
            signed_detector_runtime(self.pack_root, self.verifier)
            model = MangaDetector(path)
            text_verifier = text_evidence.MangaTextVerifier(model_path, dictionary_path)
        else:
            files = config.get("modelFiles")
            if not isinstance(files, list) or not any(isinstance(pin, dict) and pin.get("path") == "model.safetensors"
                                                    and pin.get("sha256") == sha256 and pin.get("size") == 627709088 for pin in files):
                raise ValueError("Unexpected Hayai pin")
            root, snapshot = verify_model_tree(self.verifier, config["modelRoot"], files)
            recognition = load_local("_mangohana_hayai_recognition", "recognize.py")
            model = recognition.Hayai(root, config)
        # Commit the fixed configuration only after verification and CPU probe.
        self.verifier.assert_unchanged(snapshot)
        model.assert_ready()
        if config["profile"] == "manga-detection":
            text_verifier.assert_ready()
            self.text_verifier = text_verifier
        self.snapshot = snapshot
        self.model = model
        self.configuration = config
        self.identity = {"protocolVersion": 1, "profile": config["profile"], "modelId": model_id,
                         "revision": revision, "modelSha256": sha256, "device": "cpu", "executionProvider": provider}
        if config["profile"] == "manga-detection":
            self.identity.update({"recSha256": text_evidence.REC_PIN["sha256"],
                                  "dictSha256": text_evidence.DICT_PIN["sha256"], "ruleVersion": text_evidence.RULE_VERSION})

    def handle(self, request):
        if not isinstance(request, dict) or type(request.get("protocolVersion")) is not int or request.get("protocolVersion") != 1:
            raise ValueError("Unsupported OCR protocol")
        config = request.get("configuration")
        if self.configuration is None:
            self.initialize(config)
        elif config != self.configuration:
            raise ValueError("Fixed OCR configuration changed")
        self.verifier.assert_unchanged(self.snapshot)
        self.model.assert_ready()
        if config["profile"] == "manga-detection":
            self.text_verifier.assert_ready()
        operation = request.get("operation")
        if operation == "probe":
            result = {}
        elif operation == "detect" and config["profile"] == "manga-detection":
            result = self.model.detect(decode_image(request.get("imageBase64")))
        elif operation == "verify-text" and config["profile"] == "manga-detection":
            result = self.text_verifier.verify(decode_image_bytes(request.get("imageBase64")),
                                               request.get("candidateId"), request.get("sourceQuadPx"), request.get("cropBboxPx"))
            self.verifier.assert_unchanged(self.snapshot)
        elif operation == "recognize" and config["profile"] == "hayai":
            result = self.model.recognize(decode_image(request.get("imageBase64")))
            if not isinstance(result.get("text"), str) or len(result["text"]) > 8192 or type(result.get("complete")) is not bool:
                raise ValueError("Invalid recognition result")
        else:
            raise ValueError("Unsupported OCR operation")
        return {**result, **self.identity, "operation": operation}


def serve(pack_root, input_stream=None, output_stream=None):
    input_stream = input_stream if input_stream is not None else sys.stdin.buffer
    output_stream = output_stream if output_stream is not None else sys.stdout
    logging.basicConfig(stream=sys.stderr)
    for key in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
        os.environ[key] = "4"
    with contextlib.redirect_stdout(sys.stderr):
        sidecar = Sidecar(pack_root)
    while True:
        line = input_stream.readline(MAX_REQUEST_BYTES + 1)
        if not line:
            return 0
        request_id = None
        try:
            if len(line) > MAX_REQUEST_BYTES or not line.endswith(b"\n"):
                raise ValueError("Invalid request size")
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("Invalid request")
            request_id = request.get("requestId")
            if not isinstance(request_id, str) or not 0 < len(request_id) <= 80:
                raise ValueError("Invalid request identity")
            with contextlib.redirect_stdout(sys.stderr):
                response = sidecar.handle(request)
        except Exception as error:
            # Never echo paths, image payloads, texts, or package/model contents.
            print(type(error).__name__, file=sys.stderr)
            response = {"operation": "error", "protocolVersion": 1, "code": "MANGA_OCR_RUNTIME_FAILED"}
            output_stream.write(json.dumps({**response, "requestId": request_id}) + "\n")
            output_stream.flush()
            return 1
        output_stream.write(json.dumps({**response, "requestId": request_id}, ensure_ascii=False) + "\n")
        output_stream.flush()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--pack-root", required=True)
    args = parser.parse_args()
    try:
        sys.exit(serve(args.pack_root))
    except Exception as error:
        print(type(error).__name__, file=sys.stderr)
        sys.exit(1)
