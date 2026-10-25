"""Bounded, offline CTD -> MangaOCR worker. Every result remains AI_PROPOSED.

The numerical detector/crop recipe is reused from this project's existing local
detect-fixed12-v2.py and recognize-fixed12.py validation scripts. No GPL upstream
pipeline, mask refinement, renderer or grouping implementation is copied here.
Model weights and runtime libraries retain their separate license provenance.
This worker does not decide which text to remove or where Korean text should fit.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import time

MAX_INPUT_BYTES = 131072
MAX_SOURCE_BYTES = 32 * 1024 * 1024
MAX_SOURCE_PIXELS = 16 * 1024 * 1024
MAX_REGIONS = 20
MODEL_NAMES = frozenset((
    "config.json", "preprocessor_config.json", "pytorch_model.bin",
    "special_tokens_map.json", "tokenizer_config.json", "vocab.txt",
))
HASH = re.compile(r"[0-9a-f]{64}\Z")
UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z")


def require(condition, code):
    if not condition:
        raise ValueError(code)


def closed(value, keys, optional=()):
    require(isinstance(value, dict), "INPUT_CONTRACT_INVALID")
    require(set(keys) <= set(value) <= set(keys) | set(optional), "INPUT_CONTRACT_INVALID")
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def strict_json(raw):
    return json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object,
                      parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("JSON_NUMBER_INVALID")))


def integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def hash_string(value):
    return isinstance(value, str) and HASH.fullmatch(value) is not None


def below(root, candidate):
    return candidate != root and root in candidate.parents


def absolute_path(value, code, existing=True):
    require(isinstance(value, str) and 0 < len(value) <= 4096 and "\0" not in value, code)
    require(not value.startswith(("\\\\", "//")), code)
    candidate = Path(value)
    require(candidate.is_absolute(), code)
    # Reject symlinks and Windows junction/reparse paths, including parent redirects.
    for item in (candidate, *candidate.parents):
        if item.exists() or item.is_symlink():
            info = item.lstat()
            require(not stat.S_ISLNK(info.st_mode) and
                    not (getattr(info, "st_file_attributes", 0) &
                         getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)), code)
    resolved = candidate.resolve(strict=existing)
    return resolved


def verify_pin(pin, maximum=1024 * 1024 * 1024):
    closed(pin, ("path", "sha256"), ("bytesLength",))
    require(hash_string(pin["sha256"]), "FILE_PIN_INVALID")
    file = absolute_path(pin["path"], "FILE_PATH_INVALID")
    require(file.is_file() and 0 < file.stat().st_size <= maximum, "FILE_PIN_INVALID")
    if "bytesLength" in pin:
        require(integer(pin["bytesLength"], 1, maximum) and
                file.stat().st_size == pin["bytesLength"], "FILE_PIN_INVALID")
    actual = hashlib.sha256()
    with file.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            actual.update(block)
    require(actual.hexdigest() == pin["sha256"], "FILE_PIN_INVALID")
    return file


def box_valid(box, width, height):
    return (isinstance(box, list) and len(box) == 4 and
            all(type(point) is int for point in box) and
            0 <= box[0] < box[2] <= width and 0 <= box[1] < box[3] <= height)


def preflight(request):
    require(isinstance(request, dict) and type(request.get("version")) is int and
            request["version"] in (1, 2), "INPUT_IDENTITY_INVALID")
    closed(request, (
        "version", "executionId", "inputFingerprint", "configDigest", "source",
        "detector", "ocr", "dependencyRoots", "outputDirectory", "ownedTempRoot",
        "maxRegions", "threads", "maxNewTokens", "cropPadding",
    ) + (("expectedRegions",) if request["version"] == 1 else ()))
    require(
            isinstance(request["executionId"], str) and UUID.fullmatch(request["executionId"]) and
            hash_string(request["inputFingerprint"]) and hash_string(request["configDigest"]),
            "INPUT_IDENTITY_INVALID")
    require(type(request["threads"]) is int and request["threads"] == 4 and
            type(request["maxNewTokens"]) is int and request["maxNewTokens"] == 100 and
            type(request["cropPadding"]) is int and request["cropPadding"] == 3,
            "SETTINGS_INVALID")
    require(integer(request["maxRegions"], 1, MAX_REGIONS), "REGION_LIMIT_INVALID")
    source = closed(request["source"], ("path", "sha256", "width", "height", "page") +
                    (("pageLineageId", "originalAssetId", "bytesLength") if request["version"] == 2 else ()))
    require(integer(source["width"], 1, 8192) and integer(source["height"], 1, 8192) and
            source["width"] * source["height"] <= MAX_SOURCE_PIXELS and
            isinstance(source["page"], str) and 0 < len(source["page"]) <= 256 and
            not any(ord(char) < 32 for char in source["page"]), "SOURCE_CONTRACT_INVALID")
    if request["version"] == 2:
        require(isinstance(source["pageLineageId"], str) and UUID.fullmatch(source["pageLineageId"]) and
                isinstance(source["originalAssetId"], str) and UUID.fullmatch(source["originalAssetId"]) and
                source["page"] == source["pageLineageId"] and isinstance(source["bytesLength"], str) and
                re.fullmatch(r"[1-9][0-9]*", source["bytesLength"]) and
                0 < int(source["bytesLength"]) <= MAX_SOURCE_BYTES, "SOURCE_CONTRACT_INVALID")
    source_file = verify_pin({"path": source["path"], "sha256": source["sha256"],
                             **({"bytesLength": int(source["bytesLength"])} if request["version"] == 2 else {})}, MAX_SOURCE_BYTES)
    detector_file = verify_pin(request["detector"])
    model = closed(request["ocr"], ("directory", "files"))
    model_directory = absolute_path(model["directory"], "MODEL_PATH_INVALID")
    require(model_directory.is_dir() and isinstance(model["files"], list) and
            len(model["files"]) == len(MODEL_NAMES), "MODEL_FILES_INVALID")
    models = {}
    for pin in model["files"]:
        candidate_name = Path(pin.get("path", "")).name if isinstance(pin, dict) else ""
        file = verify_pin(pin, 1024 * 1024 * 1024 if candidate_name == "pytorch_model.bin" else 4 * 1024 * 1024)
        require(file.parent == model_directory and file.name in MODEL_NAMES and
                file.name not in models, "MODEL_FILES_INVALID")
        models[file.name] = pin
    require(set(models) == MODEL_NAMES, "MODEL_FILES_INVALID")
    # Fixed classes load only these pinned files; a directory's HF .cache metadata is not a model input.
    for file in model_directory.iterdir():
        require(not file.is_file() or file.name in MODEL_NAMES, "UNPINNED_MODEL_FILE")
    config = strict_json(Path(models["config.json"]["path"]).read_bytes())
    require(isinstance(config, dict) and config.get("model_type") == "vision-encoder-decoder" and
            isinstance(config.get("encoder"), dict) and config["encoder"].get("model_type") == "vit" and
            isinstance(config.get("decoder"), dict) and config["decoder"].get("model_type") == "bert" and
            not any(part.get("auto_map") for part in (config, config["encoder"], config["decoder"])),
            "MODEL_CLASS_INVALID")
    tokenizer = strict_json(Path(models["tokenizer_config.json"]["path"]).read_bytes())
    require(isinstance(tokenizer, dict) and tokenizer.get("tokenizer_class") == "BertJapaneseTokenizer" and
            not tokenizer.get("auto_map"), "TOKENIZER_CLASS_INVALID")
    regions = request.get("expectedRegions", [])
    if request["version"] == 1:
        verify_expected_regions(regions, source["width"], source["height"], request["maxRegions"])
    roots = request["dependencyRoots"]
    require(isinstance(roots, list) and 1 <= len(roots) <= 8, "DEPENDENCY_ROOT_INVALID")
    dependencies = [absolute_path(root, "DEPENDENCY_ROOT_INVALID") for root in roots]
    require(all(root.is_dir() for root in dependencies) and len(set(dependencies)) == len(dependencies),
            "DEPENDENCY_ROOT_INVALID")
    owner = absolute_path(request["ownedTempRoot"], "OWNED_ROOT_INVALID")
    require(owner.is_dir(), "OWNED_ROOT_INVALID")
    output = absolute_path(request["outputDirectory"], "OUTPUT_PATH_INVALID", existing=False)
    require(below(owner, output) and output.parent.is_dir(), "OUTPUT_PATH_INVALID")
    require(not output.exists() or (output.is_dir() and not any(output.iterdir())), "OUTPUT_NOT_EMPTY")
    for file in (source_file, detector_file, model_directory, *dependencies):
        require(file != output and not below(output, file), "INPUT_OUTPUT_OVERLAP")
    return {"source": source_file, "detector": detector_file, "models": models,
            "modelDirectory": model_directory, "dependencies": dependencies, "output": output}


def verify_expected_regions(regions, width, height, maximum):
    require(isinstance(regions, list) and 1 <= len(regions) <= maximum, "REGION_LIMIT_INVALID")
    ids, orders = set(), set()
    for region in regions:
        closed(region, ("id", "box", "readingOrder", "orientation"))
        require(isinstance(region["id"], str) and re.fullmatch(r"ctd-[0-9]{2,3}", region["id"]) and
                region["id"] not in ids and box_valid(region["box"], width, height) and
                integer(region["readingOrder"], 0, 1000000) and region["readingOrder"] not in orders and
                region["orientation"] in ("HORIZONTAL", "VERTICAL"), "EXPECTED_REGION_INVALID")
        ids.add(region["id"])
        orders.add(region["readingOrder"])


def verify_detected_regions(blocks, expected, maximum, invalid):
    require(not invalid, "DETECTOR_GEOMETRY_INVALID")
    require(len(blocks) <= maximum, "DETECTED_REGION_LIMIT")
    actual = {block["id"]: block["box"] for block in blocks}
    captured = {region["id"]: region["box"] for region in expected}
    require(len(actual) == len(blocks) and actual == captured, "DETECTOR_EXPECTED_REGION_MISMATCH")


def derive_detected_placements(blocks, width, height, maximum, invalid):
    """Deterministic AI proposals from actual boxes, not a panel-order oracle.

    Kept pure so the limit, geometry and tie rules can be checked without model
    imports. Detector identities are preserved; nothing is truncated or dropped.
    """
    require(integer(maximum, 1, MAX_REGIONS) and isinstance(blocks, list), "REGION_LIMIT_INVALID")
    require(not invalid, "DETECTOR_GEOMETRY_INVALID")
    require(len(blocks) <= maximum, "DETECTED_REGION_LIMIT")
    identities = set()
    for block in blocks:
        require(isinstance(block, dict) and isinstance(block.get("id"), str) and
                re.fullmatch(r"ctd-[0-9]{2,3}", block["id"]) and block["id"] not in identities and
                box_valid(block.get("box"), width, height), "DETECTOR_GEOMETRY_INVALID")
        identities.add(block["id"])
    ordered = sorted(blocks, key=lambda block: (
        block["box"][1], -block["box"][2], block["box"][0], block["box"][3], block["id"]))
    placements = []
    for index, block in enumerate(ordered):
        left, top, right, bottom = block["box"]
        column_width, column_height = right - left, bottom - top
        signals = ["ASPECT_RATIO_ORIENTATION_NOT_OCR_OR_SCRIPT"]
        if 4 * column_height <= 5 * column_width and 5 * column_height >= 4 * column_width:
            signals.append("ORIENTATION_AMBIGUOUS")
        placements.append({"id": block["id"], "box": list(block["box"]), "readingOrder": index,
                           "orientation": "VERTICAL" if column_height > column_width else "HORIZONTAL",
                           "reviewSignals": signals})
    return placements


def emit(value):
    # ASCII transport keeps Unicode text stable through Windows console encodings.
    sys.stdout.write(json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def fresh_json(file, value):
    with file.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False, indent=2)
        stream.write("\n")


def output_pin(file):
    return {"path": str(file), "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
            "bytesLength": file.stat().st_size}


def save_png(file, image):
    with file.open("xb") as stream:
        image.save(stream, format="PNG")


def verified_origins(dependencies):
    for module in tuple(sys.modules.values()):
        origin = getattr(module, "__file__", None)
        if origin is None:
            continue
        path = Path(origin).resolve()
        if any(part.lower() in ("site-packages", "dist-packages") for part in path.parts):
            require(any(root == path or root in path.parents for root in dependencies),
                    "DEPENDENCY_ORIGIN_INVALID")


def main():
    request, prepared, output = None, None, None
    detector_calls, recognition_calls, completed = 0, 0, []
    dll_handles = []
    phase = "INPUT_VALIDATION"
    entered_at = time.time()
    try:
        require(len(sys.argv) == 1, "ARGV_INVALID")
        require(sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode,
                "ISOLATED_RUNTIME_REQUIRED")
        encoded = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        require(0 < len(encoded) <= MAX_INPUT_BYTES, "INPUT_BYTES_LIMIT")
        request = strict_json(encoded)
        prepared = preflight(request)
        output = prepared["output"]
        if not output.exists():
            output.mkdir()
        fresh_json(output / "intent.json", {
            "version": 1, "kind": "ACTUAL_LOCAL_CTD_MANGA_OCR", "request": request,
            "automaticRetry": False, "hostCost": {"status": "UNKNOWN", "actualUsd": None},
            "qualityPass": False,
        })
        os.environ.update({
            "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
            "HF_HUB_DISABLE_TELEMETRY": "1", "TOKENIZERS_PARALLELISM": "false",
            "HF_HOME": str(Path(request["ownedTempRoot"]) / "offline-hf-cache"), "CUDA_VISIBLE_DEVICES": "",
            "OMP_NUM_THREADS": "4", "MKL_NUM_THREADS": "4",
        })
        sys.path[:] = [entry for entry in sys.path if not any(
            part.lower() in ("site-packages", "dist-packages") for part in Path(entry).parts)]
        for root in reversed(prepared["dependencies"]):
            sys.path.insert(0, str(root))
            torch_lib = root / "torch" / "lib"
            if os.name == "nt" and torch_lib.is_dir():
                dll_handles.append(os.add_dll_directory(str(torch_lib)))
        phase = "DETECTOR_DEPENDENCY_IMPORT"
        import cv2
        import numpy as np
        from PIL import Image
        for module in (cv2, np, sys.modules["PIL"]):
            origin = Path(module.__file__).resolve()
            require(any(root in origin.parents for root in prepared["dependencies"]),
                    "DEPENDENCY_ORIGIN_INVALID")
        verified_origins(prepared["dependencies"])
        phase = "SOURCE_DECODE"
        source_bytes = prepared["source"].read_bytes()
        require(hashlib.sha256(source_bytes).hexdigest() == request["source"]["sha256"], "SOURCE_PIN_CHANGED")
        with Image.open(io.BytesIO(source_bytes)) as opened:
            require(opened.size == (request["source"]["width"], request["source"]["height"]) and
                    getattr(opened, "n_frames", 1) == 1, "SOURCE_DIMENSIONS_INVALID")
            image = np.asarray(opened.convert("RGB")).copy()
        height, width = image.shape[:2]
        size = 1024
        ratio = min(size / width, size / height)
        resized_width, resized_height = round(width * ratio), round(height * ratio)
        resized = cv2.resize(image, (resized_width, resized_height), interpolation=cv2.INTER_LINEAR)
        padded = cv2.copyMakeBorder(resized, 0, size - resized_height, 0, size - resized_width,
                                   cv2.BORDER_CONSTANT, value=(0, 0, 0))
        cv2.setNumThreads(4)
        phase = "DETECTOR_LOAD"
        load_start = time.perf_counter()
        net = cv2.dnn.readNetFromONNX(str(prepared["detector"]))
        detector_load_ms = (time.perf_counter() - load_start) * 1000
        net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
        net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
        net.setInput(cv2.dnn.blobFromImage(padded, scalefactor=1 / 255, size=(size, size), swapRB=False))
        names = net.getUnconnectedOutLayersNames()
        phase = "DETECTOR_FORWARD"
        emit({"version": 1, "kind": "START", "executionId": request["executionId"],
              "inputFingerprint": request["inputFingerprint"], "configDigest": request["configDigest"],
              "pid": os.getpid(), "source": "DETECTOR_FORWARD_ENTERED"})
        detector_calls += 1
        inference_start = time.perf_counter()
        values = net.forward(names)
        detector_ms = (time.perf_counter() - inference_start) * 1000
        require(all(np.isfinite(value).all() for value in values), "DETECTOR_OUTPUT_INVALID")
        with (output / "ctd-raw.npz").open("xb") as stream:
            np.savez_compressed(stream, **{str(name): value for name, value in zip(names, values)})
        predictions = [value for value in values if value.ndim == 3 and value.shape[0] == 1 and value.shape[2] > 5]
        masks = [value for value in values if value.ndim == 4 and value.shape[:2] == (1, 1)]
        require(len(predictions) == 1 and len(masks) == 1, "DETECTOR_OUTPUT_SHAPE_INVALID")
        prediction = predictions[0][0]
        require(len(prediction) <= 100000, "DETECTOR_CANDIDATE_LIMIT")
        rows = prediction[prediction[:, 4] > 0.4].copy()
        objectness_count = len(rows)
        classes = np.argmax(rows[:, 5:], axis=1)
        confidence = rows[:, 4] * rows[:, 5:][np.arange(len(rows)), classes]
        keep = confidence > 0.4
        rows, classes, confidence = rows[keep], classes[keep], confidence[keep]
        require(bool(np.all((confidence >= 0) & (confidence <= 1))), "DETECTOR_CONFIDENCE_INVALID")
        boxes = np.empty((len(rows), 4), np.float64)
        boxes[:, :2] = rows[:, :2] - rows[:, 2:4] / 2
        boxes[:, 2:] = rows[:, :2] + rows[:, 2:4] / 2
        selected = []
        for class_id in np.unique(classes):
            ids = np.where(classes == class_id)[0]
            local_boxes = [[float(boxes[index, 0]), float(boxes[index, 1]),
                            float(boxes[index, 2] - boxes[index, 0]),
                            float(boxes[index, 3] - boxes[index, 1])] for index in ids]
            chosen = cv2.dnn.NMSBoxes(local_boxes, [float(confidence[index]) for index in ids], 0.4, 0.35)
            selected.extend(int(ids[int(index)]) for index in np.asarray(chosen).reshape(-1))
        # Confidence sorting gives detector identities only. It never supplies reading order.
        selected = sorted(selected, key=lambda index: -confidence[index])
        blocks, invalid = [], []
        for index, selected_index in enumerate(selected):
            mapped = boxes[selected_index] * np.array([
                width / resized_width, height / resized_height, width / resized_width, height / resized_height])
            mapped[[0, 2]] = np.clip(mapped[[0, 2]], 0, width)
            mapped[[1, 3]] = np.clip(mapped[[1, 3]], 0, height)
            box = [int(value) for value in mapped]
            block = {"id": f"ctd-{index + 1:02}", "box": box,
                     "confidence": float(confidence[selected_index]), "class": int(classes[selected_index])}
            if not box_valid(box, width, height):
                invalid.append({**block, "reason": "CLIPPED_OR_INTEGER_BOX_EMPTY"})
            else:
                blocks.append(block)
        mask = masks[0][0, 0]
        require(mask.shape == (1024, 1024) and mask.min() >= 0 and mask.max() <= 1,
                "SEGMENTATION_OUTPUT_INVALID")
        probability = cv2.resize(mask[:resized_height, :resized_width], (width, height), interpolation=cv2.INTER_LINEAR)
        raw_mask = (probability > 0.3).astype(np.uint8)
        dilated = cv2.dilate(raw_mask, np.ones((3, 3), np.uint8))
        probability_file, raw_mask_file, dilated_file = (
            output / "ctd-probability.png", output / "ctd-mask-raw.png", output / "ctd-mask-dilate1.png")
        save_png(probability_file, Image.fromarray(np.rint(probability * 255).astype(np.uint8)))
        save_png(raw_mask_file, Image.fromarray(raw_mask * 255))
        save_png(dilated_file, Image.fromarray(dilated * 255))
        detector_file = output / "detector-result.json"
        fresh_json(detector_file, {
            "state": "ACTUAL_LOCAL_DETECTOR_OBSERVED", "page": request["source"]["page"],
            "source": {"file": str(prepared["source"]), "sha256": request["source"]["sha256"],
                       "width": width, "height": height,
                       **({key: request["source"][key] for key in
                           ("pageLineageId", "originalAssetId", "bytesLength")} if request["version"] == 2 else {})},
            "modelSha256": request["detector"]["sha256"], "opencv": cv2.__version__,
            "numpy": np.__version__, "python": sys.version, "threads": 4,
            "loadMs": detector_load_ms, "inferenceMs": detector_ms,
            "preprocess": {"inputSize": 1024, "rgb": True, "resized": [resized_width, resized_height],
                           "padRight": 1024 - resized_width, "padBottom": 1024 - resized_height,
                           "padLeft": 0, "padTop": 0, "contentOrigin": [0, 0],
                           "mapRatio": [width / resized_width, height / resized_height]},
            "outputs": [{"name": str(name), "shape": list(value.shape)} for name, value in zip(names, values)],
            "postprocess": {"confidence": 0.4, "nms": 0.35, "classDependent": True,
                            "groupOutputExecuted": False, "linePolygonsExecuted": False,
                            "officialRefineMaskExecuted": False, "segmentationThreshold": 0.3,
                            "dilationRadius": 1},
            "filtering": {"candidateRows": len(prediction), "objectnessRejected": len(prediction) - objectness_count,
                          "confidenceRejected": objectness_count - len(rows), "nmsSuppressed": len(rows) - len(selected),
                          "postNmsCandidates": len(selected), "invalidGeometry": invalid,
                          "semanticExclusionExecuted": False, "regionsTruncated": 0,
                          "reasons": ["OBJECTNESS_THRESHOLD", "CLASS_CONFIDENCE_THRESHOLD", "CLASS_DEPENDENT_NMS"]},
            "blocks": blocks, "maskPixelsRaw": int(raw_mask.sum()),
            "maskPixelsDilated": int(dilated.sum()), "providerCalls": detector_calls,
            "humanGroundTruth": False, "readingOrderQuality": None, "localizationIoU": None,
            "maskRemovalApproved": False, "typesetAreaDerived": False, "qualityPass": False,
        })
        phase = "EXPECTED_REGION_BINDING"
        if request["version"] == 1:
            verify_detected_regions(blocks, request["expectedRegions"], request["maxRegions"], invalid)
            ordered_placements = request["expectedRegions"]
            placement_authority = "CAPTURED_AI_PROPOSAL_NOT_HUMAN_GROUND_TRUTH"
        else:
            phase = "DETECTED_PLACEMENT_DERIVATION"
            ordered_placements = derive_detected_placements(blocks, width, height, request["maxRegions"], invalid)
            placement_authority = "DETERMINISTIC_BOX_GEOMETRY_AI_PROPOSAL"
        placements = {region["id"]: region for region in ordered_placements}
        detector_pin = output_pin(detector_file)
        if request["version"] == 2:
            placement_file = output / "ordered-placements.json"
            fresh_json(placement_file, {
                "version": 2, "algorithm": "BOX_TOP_THEN_RIGHT_V1", "authority": placement_authority,
                "source": request["source"], "detectorSha256": detector_pin["sha256"],
                "placements": ordered_placements,
                "reviewSignals": ["NAIVE_BOX_ORDER_NO_PANEL_ANALYSIS", "ASPECT_RATIO_ORIENTATION_NOT_OCR_OR_SCRIPT"] +
                                 (["ZERO_DETECTIONS_REQUIRES_REVIEW"] if not blocks else []),
                "humanGroundTruth": False, "qualityPass": False,
            })
        if blocks:
            phase = "OCR_DEPENDENCY_IMPORT"
            import torch
            import transformers
            from transformers import ViTImageProcessor, BertJapaneseTokenizer, VisionEncoderDecoderModel
            for module in (torch, transformers):
                origin = Path(module.__file__).resolve()
                require(any(root in origin.parents for root in prepared["dependencies"]),
                        "DEPENDENCY_ORIGIN_INVALID")
            verified_origins(prepared["dependencies"])
            torch.set_num_threads(4)
            torch.manual_seed(0)
            phase = "OCR_MODEL_LOAD"
            model_load_start = time.perf_counter()
            model_path = str(prepared["modelDirectory"])
            processor = ViTImageProcessor.from_pretrained(model_path, local_files_only=True, trust_remote_code=False)
            tokenizer = BertJapaneseTokenizer.from_pretrained(model_path, local_files_only=True, trust_remote_code=False)
            model = VisionEncoderDecoderModel.from_pretrained(
                model_path, local_files_only=True, trust_remote_code=False, weights_only=True).to("cpu").eval()
            model_load_ms = (time.perf_counter() - model_load_start) * 1000
            fresh_json(output / "runtime.json", {
                "python": sys.version, "opencv": cv2.__version__, "numpy": np.__version__,
                "torch": torch.__version__, "transformers": transformers.__version__,
                "ocrModelLoadMs": model_load_ms, "modelLoads": 1,
                "settings": {"maxNewTokens": 100, "cropPaddingPx": 3, "cpuThreads": 4,
                             "doSample": False, "localFilesOnly": True, "weightsOnly": True, "device": "cpu"},
                "modelPins": request["ocr"]["files"], "humanGroundTruth": False,
            })
        else:
            fresh_json(output / "runtime.json", {
                "state": "OCR_SKIPPED_ZERO_DETECTIONS", "modelLoads": 0,
                "recognitionCalls": 0, "humanGroundTruth": False, "qualityPass": False,
            })
        for block in blocks:
            phase = "OCR_CROP"
            left, top, right, bottom = block["box"]
            crop_box = [max(0, left - 3), max(0, top - 3), min(width, right + 3), min(height, bottom + 3)]
            crop = Image.fromarray(image).crop(crop_box)
            crop_file = output / (block["id"] + "-crop.png")
            save_png(crop_file, crop)
            crop_pin = output_pin(crop_file)
            fresh_json(output / (block["id"] + "-intent.json"), {
                "page": request["source"]["page"], "id": block["id"], "detectorBox": block["box"],
                "cropBox": crop_box, "cropSha256": crop_pin["sha256"], "sourceSha256": request["source"]["sha256"],
                "detectorSha256": detector_pin["sha256"],
                "modelSha256": prepared["models"]["pytorch_model.bin"]["sha256"],
                "readingOrder": placements[block["id"]]["readingOrder"],
                "orientation": placements[block["id"]]["orientation"],
                "readingOrderAuthority": placement_authority,
            })
            pixels = processor(crop.convert("L").convert("RGB"), return_tensors="pt").pixel_values
            phase = "OCR_GENERATION"
            recognition_calls += 1
            require(recognition_calls <= request["maxRegions"], "RECOGNITION_CALL_LIMIT")
            call_start = time.perf_counter()
            with torch.inference_mode():
                generated = model.generate(pixels, max_new_tokens=100, do_sample=False)
            require(generated.ndim == 2 and generated.shape[0] == 1, "OCR_OUTPUT_SHAPE_INVALID")
            raw_text = tokenizer.decode(generated[0], skip_special_tokens=True)
            require(isinstance(raw_text, str) and len(raw_text) <= 10000, "OCR_TEXT_INVALID")
            text = "".join(raw_text.split())
            result_file = output / (block["id"] + "-result.json")
            fresh_json(result_file, {
                "page": request["source"]["page"], "id": block["id"], "detectorBox": block["box"],
                "cropBox": crop_box, "cropSha256": crop_pin["sha256"], "sourceSha256": request["source"]["sha256"],
                "detectorSha256": detector_pin["sha256"],
                "modelSha256": prepared["models"]["pytorch_model.bin"]["sha256"],
                "raw": raw_text, "text": text, "tokenIds": generated[0].tolist(),
                "tokenCount": int(generated.shape[-1]), "atTokenLimit": bool(generated.shape[-1] >= 101),
                "emptyText": not bool(text), "wallMs": (time.perf_counter() - call_start) * 1000,
                "status": "AI_PROPOSED", "readingOrder": placements[block["id"]]["readingOrder"],
                "orientation": placements[block["id"]]["orientation"],
                "readingOrderAuthority": placement_authority,
                **({"placementReviewSignals": placements[block["id"]]["reviewSignals"]} if request["version"] == 2 else {}),
                "selectionDecision": "UNREVIEWED_NOT_AUTOMATICALLY_EXCLUDED",
                "humanGroundTruth": False, "qualityPass": False,
            })
            completed.append({"record": output_pin(result_file), "crop": crop_pin})
        phase = "POST_EXECUTION_PIN_VALIDATION"
        preflight_files = [request["detector"], *request["ocr"]["files"],
                           {"path": request["source"]["path"], "sha256": request["source"]["sha256"]}]
        for pin in preflight_files:
            verify_pin(pin, MAX_SOURCE_BYTES if pin["path"] == request["source"]["path"] else 1024 * 1024 * 1024)
        verified_origins(prepared["dependencies"])
        require(detector_calls == 1 and recognition_calls == len(blocks) and len(completed) == len(blocks),
                "EXECUTION_COUNT_UNCONFIRMED")
        fresh_json(output / "summary.json", {
            "version": 1, "state": "ACTUAL_LOCAL_CTD_MANGA_OCR_COMPLETED_QUALITY_UNREVIEWED",
            "detectorCalls": detector_calls, "recognitionCalls": recognition_calls,
            "recognitionsCompleted": len(completed), "modelLoads": 1 if blocks else 0,
            "enteredAtUnixSeconds": entered_at, "completedAtUnixSeconds": time.time(),
            "regionsExcludedAfterDetection": 0, "externalImageTransfer": 0, "paidCalls": 0,
            "automaticRetry": False, "hostCost": {"status": "UNKNOWN", "actualUsd": None},
            "readingOrderAuthority": placement_authority,
            "humanGroundTruth": False, "qualityPass": False,
        })
        files = sorted(output.iterdir(), key=lambda file: file.name)
        require(all(file.is_file() and not file.is_symlink() for file in files), "UNEXPECTED_OUTPUT_ENTRY")
        manifest_file = output / "manifest.json"
        fresh_json(manifest_file, {
            "version": request["version"], "executionId": request["executionId"],
            "inputFingerprint": request["inputFingerprint"], "configDigest": request["configDigest"],
            "page": request["source"]["page"], "source": request["source"],
            "detector": detector_pin, "recognitions": completed,
            "masks": [output_pin(raw_mask_file), output_pin(dilated_file)],
            "segmentationProbability": output_pin(probability_file),
            "outputs": [output_pin(file) for file in files],
            "detectorCalls": detector_calls, "recognitionCalls": recognition_calls,
            **({"readingOrder": request["expectedRegions"]} if request["version"] == 1 else
               {"orderedPlacements": output_pin(placement_file)}),
            "humanGroundTruth": False, "qualityPass": False,
        })
        emit({"version": 1, "kind": "REPLY", "executionId": request["executionId"],
              "inputFingerprint": request["inputFingerprint"], "configDigest": request["configDigest"],
              "outcome": "SUCCESS", "manifest": output_pin(manifest_file),
              "detectorCalls": detector_calls, "recognitionCalls": recognition_calls,
              "reason": "ALL_OUTPUTS_SAVED_QUALITY_UNREVIEWED"})
        return 0
    except Exception as error:
        reason = (str(error) if isinstance(error, ValueError) and
                  re.fullmatch(r"[A-Z][A-Z0-9_]{0,99}", str(error)) else "LOCAL_OCR_WORKER_FAILURE")
        error_class = type(error).__name__
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", error_class):
            error_class = "Exception"
        diagnostic = {"phase": phase, "errorClass": error_class, "reason": reason,
                      "detectorCalls": detector_calls, "recognitionCalls": recognition_calls,
                      "recognitionsCompleted": len(completed)}
        sys.stderr.write(json.dumps(diagnostic, ensure_ascii=True, separators=(",", ":")) + "\n")
        sys.stderr.flush()
        if output is not None:
            try:
                fresh_json(output / "failure.json", {
                    "version": 1, "state": "FAILED_NO_AUTOMATIC_RETRY", **diagnostic,
                    "partialOutputs": [output_pin(file) for file in sorted(output.iterdir(), key=lambda item: item.name)
                                       if file.is_file() and not file.is_symlink()],
                    "automaticRetry": False, "hostCost": {"status": "UNKNOWN", "actualUsd": None},
                    "humanGroundTruth": False, "qualityPass": False,
                })
            except Exception:
                # A secondary persistence failure is visible without replacing the original failure.
                sys.stderr.write('{"phase":"FAILURE_PERSISTENCE","reason":"FAILURE_RECORD_UNCONFIRMED"}\n')
                sys.stderr.flush()
        if (isinstance(request, dict) and isinstance(request.get("executionId"), str) and
                UUID.fullmatch(request["executionId"]) and hash_string(request.get("inputFingerprint")) and
                hash_string(request.get("configDigest"))):
            emit({"version": 1, "kind": "REPLY", "executionId": request["executionId"],
                  "inputFingerprint": request["inputFingerprint"], "configDigest": request["configDigest"],
                  "outcome": "FAILURE", "manifest": None, "detectorCalls": detector_calls,
                  "recognitionCalls": recognition_calls, "reason": reason})
            return 0
        return 2
    finally:
        for handle in dll_handles:
            handle.close()


if __name__ == "__main__":
    raise SystemExit(main())
