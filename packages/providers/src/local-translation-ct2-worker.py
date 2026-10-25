"""One pinned Helsinki/CT2 whole-block bundle; offline CPU2 fp32, no repair/retry."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import unicodedata

MAX_INPUT_BYTES = 131072
MAX_INPUT_TOKENS = 256
MAX_NEW_TOKENS = 128
PROMPT = "local-helsinki-jpn-kor-whole-block-ct2-v1"
NORMALIZATION = "helsinki-opus-preprocess-20220915-v1"
PREPROCESS_SHA = "b07987a34cc3fc3b2addbd82aa90a5b4fdbee37c80065ddb20fbdd0fb4fa7754"
POSTPROCESS_SHA = "039cec87f6d037fa216e918f3b0a7d4fd46517e54f4d422e73e0b4d6fc27ac0d"


def closed(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError("INPUT_CONTRACT_INVALID")
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def safe_path(value, root):
    path = Path(value)
    if not path.is_absolute() or root not in path.parents:
        raise ValueError("MODEL_PATH_INVALID")
    for parent in (path, *path.parents):
        info = parent.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("MODEL_PATH_INVALID")
    return path


def verify_files(files, root):
    for expected in files:
        closed(expected, ("path", "sha256", "bytesLength"))
        path = safe_path(expected["path"], root)
        if type(expected["bytesLength"]) is not int or expected["bytesLength"] <= 0 or not re.fullmatch(r"[0-9a-f]{64}", expected["sha256"]):
            raise ValueError("MODEL_FILE_PIN_INVALID")
        if not path.is_file() or path.stat().st_size != expected["bytesLength"]:
            raise ValueError("MODEL_FILE_PIN_INVALID")
        h = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                h.update(block)
        if h.hexdigest() != expected["sha256"]:
            raise ValueError("MODEL_FILE_PIN_INVALID")


def normalize_source(source):
    # Port the archive's literal sed then Perl order; do not correct １ -> quote.
    replacements = [("，", ","), ("。", ". "), ("、", ","), ("”", '"'), ("“", '"'), ("∶", ":"), ("：", ":"), ("？", "?"), ("《", '"'), ("》", '"'), ("）", ")"), ("！", "!"), ("（", "("), ("；", ";"), ("１", '"'), ("」", '"'), ("「", '"'), ("０", "0"), ("３", "3"), ("２", "2"), ("５", "5"), ("６", "6"), ("９", "9"), ("７", "7"), ("８", "8"), ("４", "4"), ("．", ". "), ("～", "~"), ("’", "'"), ("…", "..."), ("━", "-"), ("〈", "<"), ("〉", ">"), ("【", "["), ("】", "]"), ("％", "%")]
    result = source
    for source_char, target_char in replacements:
        result = re.sub(source_char + " *", target_char, result) if source_char in ("。", "．") else result.replace(source_char, target_char)
    result = "".join(" " if char != "\n" and unicodedata.category(char).startswith("C") else char for char in result)
    result = re.sub("[\u2060\u200b\ufeff]", "", result)
    result = re.sub(" +", " ", result)
    return "\n".join(line.strip(" ") for line in result.split("\n"))


def postprocess(tokens):
    # Exact postprocess.sh: remove ASCII separators, then replace SPM ▁ with space.
    return " ".join(tokens).replace(" ", "").replace("▁", " ")


def verified_origins(roots):
    for module in tuple(sys.modules.values()):
        origin = getattr(module, "__file__", None)
        if origin is None:
            continue
        path = Path(origin).resolve()
        if any(part.lower() in ("site-packages", "dist-packages") for part in path.parts) and not any(root == path or root in path.parents for root in roots):
            raise ValueError("DEPENDENCY_ORIGIN_INVALID")


def read_json(path, cap):
    with path.open("rb") as stream:
        encoded = stream.read(cap + 1)
    if len(encoded) > cap:
        raise ValueError("MODEL_METADATA_BYTES_LIMIT")
    return json.loads(encoded.decode("utf-8"), object_pairs_hook=unique_object)


def main():
    request = None
    started = False
    call_entered = False
    engine_returned = True
    callback_failed = False
    items = []
    generation_count = 0
    phase = "INPUT_VALIDATION"
    try:
        encoded = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if not encoded or len(encoded) > MAX_INPUT_BYTES:
            raise ValueError("INPUT_BYTES_LIMIT")
        request = json.loads(encoded.decode("utf-8"), object_pairs_hook=unique_object)
        closed(request, ("version", "executionId", "inputFingerprint", "consumptionDigest", "modelPath", "modelFiles", "dependencyRoots", "threads", "sourceLanguage", "targetLanguage", "maxInputTokens", "maxNewTokens", "items", "promptContract", "translationUnit", "ownedTempRoot", "ct2Resources", "normalization"))
        if request["version"] != 2 or request["promptContract"] != PROMPT or request["translationUnit"] != "BLOCK" or request["threads"] != 2 or request["sourceLanguage"] != "ja" or request["targetLanguage"] != "ko" or request["maxInputTokens"] != MAX_INPUT_TOKENS or request["maxNewTokens"] != MAX_NEW_TOKENS:
            raise ValueError("INPUT_CONTRACT_INVALID")
        normalization = closed(request["normalization"], ("contract", "preprocessSha256", "postprocessSha256"))
        if normalization != {"contract": NORMALIZATION, "preprocessSha256": PREPROCESS_SHA, "postprocessSha256": POSTPROCESS_SHA}:
            raise ValueError("NORMALIZER_CONTRACT_INVALID")
        if not isinstance(request["items"], list) or not 1 <= len(request["items"]) <= 32:
            raise ValueError("ITEM_COUNT_INVALID")
        seen = set()
        for item in request["items"]:
            closed(item, ("regionId", "sourceText", "normalizedSourceText"))
            if not isinstance(item["regionId"], str) or item["regionId"] in seen or not isinstance(item["sourceText"], str) or not item["sourceText"].strip():
                raise ValueError("ITEM_INVALID")
            if item["normalizedSourceText"] != normalize_source(item["sourceText"]):
                raise ValueError("NORMALIZED_SOURCE_MISMATCH")
            seen.add(item["regionId"])
        if os.environ.get("HF_HUB_OFFLINE") != "1" or os.environ.get("TRANSFORMERS_OFFLINE") != "1":
            raise ValueError("OFFLINE_REQUIRED")
        root = Path(request["ownedTempRoot"])
        if not root.is_absolute() or not root.is_dir() or root.resolve() != root or root.is_symlink():
            raise ValueError("OWNED_TEMP_ROOT_INVALID")
        model_path = safe_path(request["modelPath"], root)
        if not model_path.is_dir():
            raise ValueError("MODEL_PATH_INVALID")
        phase = "MODEL_PIN_VALIDATION"
        verify_files(request["modelFiles"], model_path)
        model_pins = {str(Path(p["path"]).relative_to(model_path)): p for p in request["modelFiles"]}
        if not {"model.bin", "config.json", "source_vocabulary.json", "target_vocabulary.json"}.issubset(model_pins):
            raise ValueError("CONVERTED_FILES_REQUIRED")
        resources = closed(request["ct2Resources"], ("sourceSentencePiece", "targetSentencePiece", "preprocess", "postprocess"))
        if resources["preprocess"]["sha256"] != PREPROCESS_SHA or resources["postprocess"]["sha256"] != POSTPROCESS_SHA or len({pin["path"] for pin in resources.values()}) != 4:
            raise ValueError("NORMALIZER_OR_TOKENIZER_FILES_INVALID")
        verify_files(list(resources.values()), root)
        model_config = read_json(model_path / "config.json", 65536)
        if model_config.get("add_source_eos") is not True or model_config.get("add_source_bos") is not False or model_config.get("eos_token") != "</s>":
            raise ValueError("MODEL_EOS_CONFIGURATION_UNSUPPORTED")
        source_vocab = read_json(model_path / "source_vocabulary.json", 4 * 1024 * 1024)
        target_vocab = read_json(model_path / "target_vocabulary.json", 4 * 1024 * 1024)
        if any(not isinstance(vocab, list) or len(vocab) != 32000 or any(not isinstance(t, str) for t in vocab) or len(set(vocab)) != len(vocab) for vocab in (source_vocab, target_vocab)):
            raise ValueError("MODEL_VOCABULARY_INVALID")
        eos_token = model_config["eos_token"]
        if eos_token not in target_vocab:
            raise ValueError("TARGET_EOS_REQUIRED")
        eos_id = target_vocab.index(eos_token)
        sys.path[:] = [p for p in sys.path if not any(part.lower() in ("site-packages", "dist-packages") for part in Path(p).parts)]
        dependency_roots = []
        if not isinstance(request["dependencyRoots"], list) or not request["dependencyRoots"]:
            raise ValueError("DEPENDENCY_ROOT_INVALID")
        for value in reversed(request["dependencyRoots"]):
            path = safe_path(value, root)
            if not path.is_dir():
                raise ValueError("DEPENDENCY_ROOT_INVALID")
            sys.path.insert(0, str(path))
            dependency_roots.append(path)
        phase = "DEPENDENCY_IMPORT"
        import ctranslate2
        import sentencepiece
        for module in (ctranslate2, sentencepiece):
            if not any(root in Path(module.__file__).resolve().parents for root in dependency_roots):
                raise ValueError("DEPENDENCY_ORIGIN_INVALID")
        verified_origins(dependency_roots)
        phase = "TOKENIZER_LOAD"
        source_spm = sentencepiece.SentencePieceProcessor(model_file=resources["sourceSentencePiece"]["path"])
        target_spm = sentencepiece.SentencePieceProcessor(model_file=resources["targetSentencePiece"]["path"])
        if source_spm.get_piece_size() != 32000 or target_spm.get_piece_size() != 32000:
            raise ValueError("TOKENIZER_VOCABULARY_INVALID")
        # Actual converted-vocab/SPM order must agree, not just token counts.
        if any(source_spm.id_to_piece(i) != source_vocab[i] or target_spm.id_to_piece(i) != target_vocab[i] for i in range(32000)):
            raise ValueError("TOKENIZER_VOCABULARY_ORDER_MISMATCH")
        phase = "INPUT_ENCODING"
        encoded_items = []
        for item in request["items"]:
            pieces = source_spm.encode(item["normalizedSourceText"], out_type=str, add_bos=False, add_eos=False)
            count = len(pieces) + 1  # Converter adds the source EOS itself.
            if not pieces or count > MAX_INPUT_TOKENS:
                raise ValueError("INPUT_TOKEN_LIMIT")
            encoded_items.append((item, pieces, count))
        phase = "MODEL_LOAD"
        if "float32" not in ctranslate2.get_supported_compute_types("cpu"):
            raise ValueError("CPU_FLOAT32_UNSUPPORTED")
        translator = ctranslate2.Translator(str(model_path), device="cpu", compute_type="float32", inter_threads=1, intra_threads=2, max_queued_batches=1)
        if translator.device != "cpu" or translator.compute_type != "float32" or not translator.model_is_loaded:
            raise ValueError("CPU_FLOAT32_MODEL_REQUIRED")
        verified_origins(dependency_roots)
        for item, pieces, input_count in encoded_items:
            observed_tokens = []
            observed_ids = []

            def decode_step(step):
                nonlocal started, callback_failed
                try:
                    if type(step.step) is not int or step.step != len(observed_tokens) or type(step.token_id) is not int or not 0 <= step.token_id < len(target_vocab) or step.token != target_vocab[step.token_id] or type(step.batch_id) is not int or step.batch_id != 0 or type(step.hypothesis_id) is not int or step.hypothesis_id != 0 or len(observed_tokens) >= MAX_NEW_TOKENS:
                        raise ValueError("DECODE_STEP_INVALID")
                    if not started:
                        started = True
                        emit({"kind": "START", "version": 1, "executionId": request["executionId"], "inputFingerprint": request["inputFingerprint"], "consumptionDigest": request["consumptionDigest"], "pid": os.getpid(), "source": "DECODE_STEP_OBSERVED"})
                    observed_tokens.append(step.token)
                    observed_ids.append(step.token_id)
                    return False  # The official callback's false means continue.
                except Exception:
                    callback_failed = True
                    raise

            phase = "MODEL_GENERATION"
            generation_count += 1
            call_entered = True
            engine_returned = False
            result = translator.translate_batch([pieces], beam_size=1, num_hypotheses=1, min_decoding_length=0, max_decoding_length=MAX_NEW_TOKENS, max_input_length=0, sampling_topk=1, return_end_token=True, callback=decode_step)
            engine_returned = True
            if callback_failed or not observed_tokens:
                raise ValueError("DECODE_CALLBACK_UNCONFIRMED")
            if not isinstance(result, list) or len(result) != 1 or getattr(result[0], "hypotheses", None) != [observed_tokens]:
                raise ValueError("DECODE_RESULT_UNCONFIRMED")
            output_count = len(observed_tokens)
            if output_count >= MAX_NEW_TOKENS:
                raise ValueError("OUTPUT_TOKEN_LIMIT")
            # is_last is never EOS evidence; actual final token AND vocabulary ID are.
            if observed_tokens[-1] != eos_token or observed_ids[-1] != eos_id or eos_token in observed_tokens[:-1]:
                raise ValueError("EOS_INCOMPLETE")
            text = postprocess(observed_tokens[:-1])
            if not text.strip():
                raise ValueError("EMPTY_TRANSLATION")
            items.append({"regionId": item["regionId"], "targetText": text, "inputTokenCount": input_count, "outputTokenCount": output_count, "eosCompleted": True})
        phase = "RESULT_PIN_VALIDATION"
        verify_files(request["modelFiles"], model_path)
        verify_files(list(resources.values()), root)
        verified_origins(dependency_roots)
        if not started or generation_count != len(request["items"]) or len(items) != len(request["items"]):
            raise ValueError("INFERENCE_OR_OUTPUT_UNCONFIRMED")
        emit({"kind": "REPLY", "version": 1, "executionId": request["executionId"], "inputFingerprint": request["inputFingerprint"], "consumptionDigest": request["consumptionDigest"], "outcome": "SUCCESS", "started": True, "reason": "EOS_COMPLETE", "items": items, "generationCount": generation_count})
        return 0
    except Exception as error:
        error_class = type(error).__name__
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", error_class):
            error_class = "Exception"
        sys.stderr.write(json.dumps({"phase": phase, "errorClass": error_class}, ensure_ascii=True) + "\n")
        sys.stderr.flush()
        # Entering translate_batch is not start proof. Engine/callback uncertainty,
        # pin changes and result mismatch remain nonzero/no REPLY, hence UNKNOWN.
        unknown = callback_failed or call_entered and not engine_returned or phase == "RESULT_PIN_VALIDATION" or isinstance(error, ValueError) and str(error) in ("DECODE_CALLBACK_UNCONFIRMED", "DECODE_RESULT_UNCONFIRMED")
        if unknown:
            return 2
        if isinstance(request, dict) and all(key in request for key in ("executionId", "inputFingerprint", "consumptionDigest")):
            reason = str(error) if isinstance(error, ValueError) and re.fullmatch(r"[A-Z0-9_]{1,100}", str(error)) else "LOCAL_WORKER_FAILURE"
            emit({"kind": "REPLY", "version": 1, "executionId": request["executionId"], "inputFingerprint": request["inputFingerprint"], "consumptionDigest": request["consumptionDigest"], "outcome": "FAILURE", "started": started, "reason": reason, "items": items, "generationCount": generation_count})
            return 0
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
