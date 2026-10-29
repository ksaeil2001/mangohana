"""TRIO Production OCR sidecar.

The process owns exactly two inference stages:
PP-OCRv6_medium_det detection and Baberu ONNX recognition. It reads NDJSON
requests from stdin and writes NDJSON responses to stdout. Model selection,
language routing, networking, and fallback providers are intentionally absent.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import importlib.metadata
import io
import json
import sys
import traceback
import unicodedata
from pathlib import Path
from typing import Any


PROTOCOL_VERSION = 1
DETECTOR_MODEL_ID = "PaddlePaddle/PP-OCRv6_medium_det"
DETECTOR_REVISION = "8e0f56fb2ef86b461d99cfc7ac5c137738985f61"
RECOGNIZER_MODEL_ID = "genshiai-daichi/baberu-ocr"
RECOGNIZER_REVISION = "d9cc13153e9a1cd8fdfa3b7b1cc329da2020aeae"
MAX_IMAGE_BYTES = 100 * 1024 * 1024


class ProductionOcrRuntime:
    def __init__(self, pack_root: Path) -> None:
        self.pack_root = pack_root.resolve(strict=True)
        self._detector: Any | None = None
        self._recognizer: BaberuOnnxOCR | None = None

    def detect(self, image_bytes: bytes) -> dict[str, Any]:
        image = decode_image(image_bytes)
        if self._detector is None:
            with contextlib.redirect_stdout(sys.stderr):
                from paddleocr import TextDetection

                self._detector = TextDetection(
                    model_name="PP-OCRv6_medium_det",
                    model_dir=str(self.pack_root / "detector"),
                    device="cpu",
                    engine="paddle_static",
                    enable_hpi=False,
                    use_tensorrt=False,
                    enable_mkldnn=False,
                )

        import numpy as np

        with contextlib.redirect_stdout(sys.stderr):
            outputs = list(self._detector.predict(np.asarray(image), batch_size=1))
        if len(outputs) != 1:
            raise RuntimeError("PP-OCRv6_medium_det returned an unexpected result count")
        result = outputs[0].json
        if isinstance(result, str):
            result = json.loads(result)
        payload = result.get("res", result) if isinstance(result, dict) else None
        if not isinstance(payload, dict):
            raise RuntimeError("PP-OCRv6_medium_det returned an invalid result")
        polygons = to_plain_list(payload.get("dt_polys"))
        scores = to_plain_list(payload.get("dt_scores"))
        if not isinstance(polygons, list) or not isinstance(scores, list) or len(polygons) != len(scores):
            raise RuntimeError("PP-OCRv6_medium_det omitted polygons or scores")
        detections = []
        for index, (quad, score) in enumerate(zip(polygons, scores, strict=True), start=1):
            detections.append({
                "detectionId": f"det-{index:04d}",
                "quad": quad,
                "score": float(score),
            })
        return {
            "operation": "detect",
            "imageWidth": image.width,
            "imageHeight": image.height,
            "detections": detections,
        }

    def recognize(self, image_bytes: bytes) -> dict[str, Any]:
        image = decode_image(image_bytes)
        if self._recognizer is None:
            self._recognizer = BaberuOnnxOCR(
                self.pack_root / "recognizer" / "onnx",
                self.pack_root / "recognizer" / "tokenizer",
            )
        return {"operation": "recognize", "text": self._recognizer(image)}

    def probe(self) -> dict[str, Any]:
        return {
            "operation": "probe",
            "protocolVersion": PROTOCOL_VERSION,
            "detector": {
                "modelId": DETECTOR_MODEL_ID,
                "revision": DETECTOR_REVISION,
                "device": "cpu",
            },
            "recognizer": {
                "modelId": RECOGNIZER_MODEL_ID,
                "revision": RECOGNIZER_REVISION,
                "executionProvider": "CPUExecutionProvider",
            },
            "packages": {
                "paddlepaddle": package_version("paddlepaddle"),
                "paddleocr": package_version("paddleocr"),
                "onnxruntime": package_version("onnxruntime"),
                "numpy": package_version("numpy"),
                "pillow": package_version("Pillow"),
            },
        }


def package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError as error:
        raise RuntimeError(f"Required runtime package is missing: {name}") from error


def decode_image(image_bytes: bytes):
    from PIL import Image

    if not image_bytes or len(image_bytes) > MAX_IMAGE_BYTES:
        raise ValueError("Image payload is empty or exceeds the size limit")
    image = Image.open(io.BytesIO(image_bytes))
    image.load()
    return image.convert("RGB")


def to_plain_list(value: Any) -> Any:
    return value.tolist() if hasattr(value, "tolist") else value


def preprocess(image):
    import numpy as np
    from PIL import Image

    mean = np.array([0.485, 0.456, 0.406], np.float32)
    std = np.array([0.229, 0.224, 0.225], np.float32)
    resized = image.convert("RGB").resize((224, 224), Image.Resampling.BICUBIC)
    values = (np.asarray(resized, np.float32) / 255.0 - mean) / std
    return values.transpose(2, 0, 1)[None]


class Vocab:
    def __init__(self, vocab_json: Path) -> None:
        charset = json.loads(vocab_json.read_text(encoding="utf-8"))
        if not isinstance(charset, list) or not all(isinstance(character, str) for character in charset):
            raise RuntimeError("Baberu vocabulary is invalid")
        self.id_to_character = {0: "", 1: "", 2: "", 3: ""}
        for index, character in enumerate(charset):
            self.id_to_character[index + 4] = character
        self.bos = 1
        self.eos = 2
        self.content_ids = {
            index + 4
            for index, character in enumerate(charset)
            if len(character) == 1
            and character not in "ーｰ〜~"
            and unicodedata.category(character)[0] in "LN"
        }

    def decode(self, token_ids: list[int]) -> str:
        return "".join(self.id_to_character.get(token_id, "") for token_id in token_ids if token_id >= 4)


class BaberuOnnxOCR:
    def __init__(self, onnx_dir: Path, tokenizer_dir: Path) -> None:
        import onnxruntime as ort

        session_options = ort.SessionOptions()
        session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

        def create_session(path: Path):
            return ort.InferenceSession(
                str(path),
                session_options,
                providers=["CPUExecutionProvider"],
            )

        self.vision = create_session(onnx_dir / "vision_fp16.onnx")
        self.prefill = create_session(onnx_dir / "decoder_prefill_int8.onnx")
        self.step = create_session(onnx_dir / "decoder_step_int8.onnx")
        self.vocab = Vocab(tokenizer_dir / "vocab.json")

    def __call__(
        self,
        image,
        max_new_tokens: int = 128,
        repetition_penalty: float = 1.2,
        max_content_run: int = 12,
    ) -> str:
        import numpy as np

        past_names = [f"past_k{index}" for index in range(6)] + [f"past_v{index}" for index in range(6)]
        vision_embeds = self.vision.run(["vision_embeds"], {"pixel_values": preprocess(image)})[0]
        output = self.prefill.run(None, {
            "vision_embeds": vision_embeds,
            "input_ids": np.array([[self.vocab.bos]], np.int64),
        })
        logits = output[0][0, -1].astype(np.float64)
        present = output[1:]
        sequence = [self.vocab.bos]
        tokens: list[int] = []
        position = vision_embeds.shape[1] + 1

        for _ in range(max_new_tokens):
            if repetition_penalty != 1.0:
                for token_id in set(sequence):
                    score = logits[token_id]
                    logits[token_id] = score * repetition_penalty if score < 0 else score / repetition_penalty
            if max_content_run and tokens and tokens[-1] in self.vocab.content_ids:
                last = tokens[-1]
                run = 0
                for token_id in reversed(tokens):
                    if token_id != last:
                        break
                    run += 1
                if run >= max_content_run:
                    logits[last] = -np.inf

            next_token = int(np.argmax(logits))
            if next_token == self.vocab.eos:
                break
            tokens.append(next_token)
            sequence.append(next_token)
            if len(tokens) >= max_new_tokens:
                break
            feed = {
                "input_ids": np.array([[next_token]], np.int64),
                "position_ids": np.array([[position]], np.int64),
            }
            feed.update({name: tensor for name, tensor in zip(past_names, present, strict=True)})
            output = self.step.run(None, feed)
            logits = output[0][0, -1].astype(np.float64)
            present = output[1:]
            position += 1

        return self.vocab.decode(tokens)


def parse_request(line: str) -> tuple[str, str, bytes | None]:
    request = json.loads(line)
    if not isinstance(request, dict):
        raise ValueError("Request must be an object")
    request_id = request.get("requestId")
    operation = request.get("operation")
    if not isinstance(request_id, str) or not request_id:
        raise ValueError("Request identity is required")
    if request.get("protocolVersion") != PROTOCOL_VERSION:
        raise ValueError("Unsupported Production OCR protocol version")
    expected_keys = {"requestId", "protocolVersion", "operation"}
    if operation in {"detect", "recognize"}:
        expected_keys.add("imageBase64")
    if set(request) != expected_keys:
        raise ValueError("Production OCR request contains unsupported fields")
    if operation == "probe":
        return request_id, operation, None
    if operation not in {"detect", "recognize"} or not isinstance(request.get("imageBase64"), str):
        raise ValueError("Unsupported Production OCR operation")
    try:
        image_bytes = base64.b64decode(request["imageBase64"], validate=True)
    except (ValueError, TypeError) as error:
        raise ValueError("Image payload is not valid base64") from error
    return request_id, operation, image_bytes


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def serve(runtime: ProductionOcrRuntime) -> None:
    for line in sys.stdin:
        request_id = "unknown"
        try:
            request_id, operation, image_bytes = parse_request(line)
            if operation == "probe":
                response = runtime.probe()
            elif operation == "detect" and image_bytes is not None:
                response = runtime.detect(image_bytes)
            elif operation == "recognize" and image_bytes is not None:
                response = runtime.recognize(image_bytes)
            else:
                raise ValueError("Unsupported Production OCR operation")
            emit({"requestId": request_id, **response})
        except Exception as error:  # The protocol must turn every runtime failure into one typed response.
            traceback.print_exc(file=sys.stderr)
            emit({
                "requestId": request_id,
                "operation": "error",
                "code": "PRODUCTION_OCR_RUNTIME_FAILED",
                "message": str(error),
            })


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pack-root", required=True)
    arguments = parser.parse_args()
    serve(ProductionOcrRuntime(Path(arguments.pack_root)))


if __name__ == "__main__":
    main()
