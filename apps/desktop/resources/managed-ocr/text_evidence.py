"""Fixed two-input MangaCTC evidence, never a replacement for Hayai text.

Preprocessing follows Kellenok/PP-OCRv6_manga c94f4a2 (Apache-2.0).
The CTC mean is selected nonblank timestep confidence, not text probability.
Only the caller's context PNG is used; no artifact imports or filesystem crops.
"""
import hashlib
import io
import math
import unicodedata

RULE_VERSION = 1
MODEL_ID = "Kellenok/PP-OCRv6_manga"
REVISION = "c94f4a20677f1ba0c90625bccf42ea980f24e2f4"
REC_PIN = {"path": "rec/manga_rec_v0.2.onnx", "size": 21167540,
           "sha256": "de12c84c63e62c80339e882e675983d886670dcb6f0147e1ed041afd6fa81888"}
DICT_PIN = {"path": "ppocrv6_dict.txt", "size": 74947,
            "sha256": "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d"}
PADDINGS = (0.08, 0.5)
MAX_PIXELS = 16_000_000
MAX_IMAGE_BYTES = 16 * 1024 * 1024
# ORT float32 softmax rounding tolerance; logits are never silently normalized.
ROW_SUM_RTOL = 1e-4
ROW_SUM_ATOL = 1e-5
# The same Unicode trim set as JavaScript String.trim() at the TS boundary.
TRIM_CHARACTERS = " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def decision(inputs):
    texts = [item["text"] for item in inputs]
    prefix = 0
    for left, right in zip(*texts):
        if left != right:
            break
        prefix += 1
    shortest = min(map(len, texts))
    ratio = prefix / shortest if shortest else 0.0
    if not all(texts):
        reason = "empty-decode"
    elif any(item["mean"] < 0.6 for item in inputs):
        reason = "low-mean"
    elif ratio < 0.6:
        reason = "unstable-prefix"
    else:
        reason = "accepted"
    return {"commonPrefixRatio": ratio, "accepted": reason == "accepted", "reason": reason}


def validate_geometry(quad, bbox):
    if not isinstance(bbox, dict) or set(bbox) != {"x", "y", "width", "height"}:
        raise ValueError("Invalid text context bbox")
    if any(type(bbox[key]) is not int or bbox[key] < (1 if key in ("width", "height") else 0)
           or bbox[key] > MAX_PIXELS for key in bbox) or bbox["width"] * bbox["height"] > MAX_PIXELS:
        raise ValueError("Invalid text context dimensions")
    if not isinstance(quad, list) or len(quad) != 4:
        raise ValueError("Invalid text evidence quad")
    local = []
    for point in quad:
        if not isinstance(point, dict) or set(point) != {"x", "y"}:
            raise ValueError("Invalid text evidence point")
        if any(type(point[key]) not in (int, float) or not math.isfinite(point[key]) for key in ("x", "y")):
            raise ValueError("Nonfinite text evidence point")
        x, y = point["x"] - bbox["x"], point["y"] - bbox["y"]
        if not 0 <= x <= bbox["width"] or not 0 <= y <= bbox["height"]:
            raise ValueError("Text evidence quad outside context")
        local.append((x, y))
    # Ordered TL/TR/BR/BL, strictly convex and nondegenerate. Do not repair quads.
    for i in range(4):
        a, b, c = local[i], local[(i + 1) % 4], local[(i + 2) % 4]
        if (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= 0:
            raise ValueError("Invalid text evidence quad order or area")
    return local


def rectify(image, points, padding):
    from PIL import Image
    width = max(1, round(max(math.dist(points[0], points[1]), math.dist(points[2], points[3]))))
    height = max(1, round(max(math.dist(points[0], points[3]), math.dist(points[1], points[2]))))
    px, py = 0.08 * width, padding * min(width, height)
    ex = ((points[1][0] - points[0][0]) / width, (points[1][1] - points[0][1]) / width)
    ey = ((points[3][0] - points[0][0]) / height, (points[3][1] - points[0][1]) / height)
    expanded = [(p[0] + sx * ex[0] * px + sy * ey[0] * py,
                 p[1] + sx * ex[1] * px + sy * ey[1] * py)
                for p, sx, sy in zip(points, (-1, 1, 1, -1), (-1, -1, 1, 1))]
    size = (round(width + 2 * px), round(height + 2 * py))
    if min(size) < 1 or size[0] * size[1] > MAX_PIXELS:
        raise ValueError("Text evidence rectification too large")
    # PIL QUAD expects TL/BL/BR/TR. Sample actual surrounding pixels, with white
    # only outside the supplied context (which main clamps to the original page).
    coordinates = [value for index in (0, 3, 2, 1) for value in expanded[index]]
    crop = image.transform(size, Image.Transform.QUAD, coordinates, Image.Resampling.BICUBIC,
                           fillcolor=(255, 255, 255))
    return crop


def model_input(crop):
    import numpy as np
    from PIL import Image
    rotation = 90 if crop.height > crop.width else 0
    if rotation:
        crop = crop.transpose(Image.Transpose.ROTATE_90)
    natural = round(48 * crop.width / crop.height)
    width = max(16, min(2400 if natural > 2000 else 640, natural))
    resized = crop.resize((width, 48), Image.Resampling.BILINEAR)
    png = io.BytesIO()
    resized.save(png, format="PNG")
    bgr = np.asarray(resized, dtype=np.float32)[:, :, ::-1] / 255.0
    tensor = np.ascontiguousarray(((bgr - 0.5) / 0.5).transpose(2, 0, 1)[None], dtype="<f4")
    return tensor, {"rotation": rotation, "width": width, "height": 48,
                    "inputPngSha256": hashlib.sha256(png.getvalue()).hexdigest(),
                    "tensorSha256": hashlib.sha256(tensor.tobytes(order="C")).hexdigest()}


def decode_probabilities(output, vocab):
    import numpy as np
    if not isinstance(output, np.ndarray) or output.dtype != np.dtype("float32") or output.ndim != 3 \
            or output.shape[0] != 1 or not 0 < output.shape[1] <= 8192 or output.shape[2] != len(vocab):
        raise ValueError("Unexpected text evidence tensor")
    if not np.isfinite(output).all() or output.min() < 0 or output.max() > 1 \
            or not np.allclose(output.sum(axis=-1), 1.0, rtol=ROW_SUM_RTOL, atol=ROW_SUM_ATOL):
        raise ValueError("Invalid text evidence probabilities")
    probabilities = output[0]
    ids = np.argmax(probabilities, axis=-1)
    text, scores, previous = [], [], None
    for timestep, value in enumerate(ids):
        index = int(value)
        # Repeated CTC labels use their FIRST timestep, including for the mean.
        if index and index != previous:
            text.append(vocab[index])
            scores.append(float(probabilities[timestep, index]))
        previous = index
    text = unicodedata.normalize("NFKC", "".join(text)).strip(TRIM_CHARACTERS)
    if len(text) > 8192 or any(ord(char) < 32 or 0x7f <= ord(char) <= 0x9f or 0xd800 <= ord(char) <= 0xdfff for char in text):
        raise ValueError("Invalid text evidence decode")
    return {"text": text, "mean": sum(scores) / len(scores) if scores else 0.0}


class MangaTextVerifier:
    def __init__(self, model_path, dictionary_path):
        import onnxruntime as ort
        self.vocab = [""] + dictionary_path.read_text(encoding="utf-8").splitlines() + [" "]
        if len(self.vocab) < 3 or any(not token for token in self.vocab[1:-1]):
            raise ValueError("Invalid text evidence dictionary")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(model_path), options, providers=["CPUExecutionProvider"])
        self.assert_ready()
        self.input = self.session.get_inputs()[0].name

    def assert_ready(self):
        if self.session.get_providers() != ["CPUExecutionProvider"]:
            raise ValueError("Expected CPU text verifier")
        inputs, outputs = self.session.get_inputs(), self.session.get_outputs()
        if len(inputs) != 1 or len(outputs) != 1:
            raise ValueError("Unexpected text verifier inputs or outputs")
        for node, expected in ((inputs[0], (1, 3, 48, None)), (outputs[0], (1, None, len(self.vocab)))):
            if node.type != "tensor(float)" or not isinstance(node.shape, list) or len(node.shape) != len(expected):
                raise ValueError("Unexpected text verifier tensor metadata")
            for actual, fixed in zip(node.shape, expected):
                if type(actual) is int:
                    if actual <= 0 or fixed is not None and actual != fixed:
                        raise ValueError("Unexpected text verifier tensor dimensions")
                elif actual is not None and (not isinstance(actual, str) or not actual):
                    raise ValueError("Unexpected text verifier dynamic dimensions")

    def verify(self, image_bytes, candidate_id, source_quad, bbox):
        from PIL import Image
        if not isinstance(candidate_id, str) or not 0 < len(candidate_id) <= 256 \
                or any(ord(char) < 32 or 0x7f <= ord(char) <= 0x9f or 0xd800 <= ord(char) <= 0xdfff for char in candidate_id):
            raise ValueError("Invalid text evidence candidate")
        points = validate_geometry(source_quad, bbox)
        if not isinstance(image_bytes, bytes) or not 0 < len(image_bytes) <= MAX_IMAGE_BYTES:
            raise ValueError("Invalid text context PNG bytes")
        with Image.open(io.BytesIO(image_bytes)) as opened:
            if opened.format != "PNG" or opened.size != (bbox["width"], bbox["height"]) or getattr(opened, "n_frames", 1) != 1:
                raise ValueError("Text context PNG dimensions differ from bbox")
            opened.load()
            image = opened.convert("RGB")
        inputs = []
        for padding in PADDINGS:
            crop = rectify(image, points, padding)
            tensor, evidence = model_input(crop)
            outputs = self.session.run(None, {self.input: tensor})
            if not isinstance(outputs, list) or len(outputs) != 1:
                raise ValueError("Unexpected text evidence output count")
            inputs.append({"padding": padding, "rectifiedSize": {"width": crop.width, "height": crop.height},
                           **evidence, **decode_probabilities(outputs[0], self.vocab)})
        return {"candidateId": candidate_id, "role": "text-presence-gate", "ruleVersion": RULE_VERSION,
                "modelId": MODEL_ID, "revision": REVISION, "component": "rec",
                "recSha256": REC_PIN["sha256"], "dictSha256": DICT_PIN["sha256"],
                "sourceQuadPx": source_quad, "cropBboxPx": bbox,
                "inputContextPngSha256": hashlib.sha256(image_bytes).hexdigest(),
                "inputs": inputs, **decision(inputs), "complete": True}
