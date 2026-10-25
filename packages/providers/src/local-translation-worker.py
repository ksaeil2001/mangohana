"""Pinned, offline ja -> ko CPU worker; explicit LINE v1 or whole BLOCK v2."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys

MAX_INPUT_BYTES = 131072
MAX_INPUT_TOKENS = 256
MAX_NEW_TOKENS = 128


def closed(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError("INPUT_CONTRACT_INVALID")
    return value


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("DUPLICATE_JSON_KEY")
        value[key] = item
    return value


def verify_files(files, model_path):
    for pin in files:
        closed(pin, ("path", "sha256", "bytesLength"))
        file = Path(pin["path"])
        if not file.is_absolute() or file.is_symlink() or model_path not in file.resolve().parents:
            raise ValueError("MODEL_PATH_INVALID")
        if not file.is_file() or file.stat().st_size != pin["bytesLength"]:
            raise ValueError("MODEL_FILE_PIN_INVALID")
        sha = hashlib.sha256()
        with file.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                sha.update(block)
        if sha.hexdigest() != pin["sha256"]:
            raise ValueError("MODEL_FILE_PIN_INVALID")
    names = {Path(pin["path"]).name for pin in files}
    if not {"model.safetensors", "config.json", "vocab.json", "sentencepiece.bpe.model"}.issubset(names):
        raise ValueError("SAFETENSORS_REQUIRED")


def emit(value):
    # ASCII JSON preserves Unicode values through Windows' legacy console encodings.
    sys.stdout.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def verified_origins(dependency_roots):
    # stdlib is allowed; third-party modules may come only from the pinned roots.
    for module in tuple(sys.modules.values()):
        origin = getattr(module, "__file__", None)
        if origin is None:
            continue
        path = Path(origin).resolve()
        if any(part.lower() in ("site-packages", "dist-packages") for part in path.parts):
            if not any(root == path or root in path.parents for root in dependency_roots):
                raise ValueError("DEPENDENCY_ORIGIN_INVALID")


def main():
    request = None
    started = False
    items = []
    hook = None
    dll_handles = []
    phase = "INPUT_VALIDATION"
    block_mode = False
    generation_count = 0
    try:
        encoded = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if not encoded or len(encoded) > MAX_INPUT_BYTES:
            raise ValueError("INPUT_BYTES_LIMIT")
        request = json.loads(encoded.decode("utf-8"), object_pairs_hook=unique_object)
        keys = ("version", "executionId", "inputFingerprint", "consumptionDigest", "modelPath", "modelFiles", "dependencyRoots", "threads", "sourceLanguage", "targetLanguage", "maxInputTokens", "maxNewTokens", "items")
        block_mode = isinstance(request, dict) and request.get("version") == 2
        closed(request, keys + ("promptContract", "translationUnit") if block_mode else keys)
        if block_mode and (request["promptContract"] != "local-m2m100-whole-block-v2" or request["translationUnit"] != "BLOCK"):
            raise ValueError("INPUT_CONTRACT_INVALID")
        if request["version"] not in (1, 2) or request["threads"] != 2 or request["sourceLanguage"] != "ja" or request["targetLanguage"] != "ko" or request["maxInputTokens"] != MAX_INPUT_TOKENS or request["maxNewTokens"] != MAX_NEW_TOKENS:
            raise ValueError("INPUT_CONTRACT_INVALID")
        if not isinstance(request["items"], list) or not 1 <= len(request["items"]) <= 32:
            raise ValueError("ITEM_COUNT_INVALID")
        seen = set()
        for item in request["items"]:
            closed(item, ("regionId", "sourceText"))
            if not isinstance(item["regionId"], str) or item["regionId"] in seen or not isinstance(item["sourceText"], str) or not item["sourceText"].strip():
                raise ValueError("ITEM_INVALID")
            seen.add(item["regionId"])
        if os.environ.get("HF_HUB_OFFLINE") != "1" or os.environ.get("TRANSFORMERS_OFFLINE") != "1":
            raise ValueError("OFFLINE_REQUIRED")
        model_path = Path(request["modelPath"]).resolve(strict=True)
        phase = "MODEL_PIN_VALIDATION"
        verify_files(request["modelFiles"], model_path)
        sys.path[:] = [path for path in sys.path if not any(part.lower() in ("site-packages", "dist-packages") for part in Path(path).parts)]
        dependency_roots = []
        for root in reversed(request["dependencyRoots"]):
            dependency = Path(root).resolve(strict=True)
            if not dependency.is_dir():
                raise ValueError("DEPENDENCY_ROOT_INVALID")
            sys.path.insert(0, str(dependency))
            dependency_roots.append(dependency)
            torch_lib = dependency / "torch" / "lib"
            if os.name == "nt" and torch_lib.is_dir():
                dll_handles.append(os.add_dll_directory(str(torch_lib)))

        # No pickle fallback, Auto class, download, remote code, GPU or subprocess API.
        phase = "DEPENDENCY_IMPORT"
        import torch
        import transformers
        import sentencepiece
        import tokenizers
        import safetensors
        from transformers import M2M100ForConditionalGeneration, M2M100Tokenizer
        for module in (torch, transformers, sentencepiece, tokenizers, safetensors):
            origin = Path(module.__file__).resolve()
            if not any(root in origin.parents for root in dependency_roots):
                raise ValueError("DEPENDENCY_ORIGIN_INVALID")
        verified_origins(dependency_roots)
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        torch.manual_seed(0)
        torch.use_deterministic_algorithms(True)
        phase = "TOKENIZER_LOAD"
        tokenizer = M2M100Tokenizer.from_pretrained(str(model_path), local_files_only=True, trust_remote_code=False, src_lang="ja")
        phase = "MODEL_LOAD"
        model = M2M100ForConditionalGeneration.from_pretrained(str(model_path), local_files_only=True, trust_remote_code=False, use_safetensors=True, torch_dtype=torch.float32)
        model.to("cpu")
        model.eval()
        phase = "INPUT_ENCODING"
        encoded_items = []
        for item in request["items"]:
            tensor = tokenizer(item["sourceText"], return_tensors="pt", truncation=False)
            count = int(tensor["input_ids"].shape[1])
            if count > MAX_INPUT_TOKENS:
                raise ValueError("INPUT_TOKEN_LIMIT")
            if block_mode:
                parts = [item["sourceText"]]
                encoded_lines = [(0, tensor)]
            else:
                parts = re.split(r"(\r\n|\r|\n)", item["sourceText"])
                encoded_lines = []
                for index in range(0, len(parts), 2):
                    if parts[index].strip():
                        line = tokenizer(parts[index], return_tensors="pt", truncation=False)
                        if int(line["input_ids"].shape[1]) > MAX_INPUT_TOKENS:
                            raise ValueError("INPUT_TOKEN_LIMIT")
                        encoded_lines.append((index, line))
            encoded_items.append((item, parts, encoded_lines, count))
        verified_origins(dependency_roots)

        def inference_entered(_module, _inputs):
            nonlocal started
            if not started:
                started = True
                emit({"kind": "START", "version": 1, "executionId": request["executionId"], "inputFingerprint": request["inputFingerprint"], "consumptionDigest": request["consumptionDigest"], "pid": os.getpid(), "source": "MODEL_FORWARD_ENTERED"})

        hook = model.register_forward_pre_hook(inference_entered)
        phase = "MODEL_GENERATION"
        with torch.inference_mode():
            for item, parts, encoded_lines, input_count in encoded_items:
                output_count = 0
                for index, tensor in encoded_lines:
                    remaining = MAX_NEW_TOKENS - output_count
                    if remaining <= 2:
                        raise ValueError("OUTPUT_TOKEN_LIMIT")
                    generation_count += 1
                    generated = model.generate(**tensor, forced_bos_token_id=tokenizer.get_lang_id("ko"), max_new_tokens=remaining, do_sample=False, num_beams=1, return_dict_in_generate=True)
                    if generated.sequences.shape[0] != 1:
                        raise ValueError("OUTPUT_COUNT_INVALID")
                    ids = generated.sequences[0].tolist()
                    line_count = len(ids) - 1
                    # A forced EOS at the length cap still means truncation, never success.
                    if line_count <= 0 or line_count >= remaining:
                        raise ValueError("OUTPUT_TOKEN_LIMIT")
                    if ids[-1] != tokenizer.eos_token_id:
                        raise ValueError("EOS_INCOMPLETE")
                    text = tokenizer.decode(ids, skip_special_tokens=True)
                    if not text.strip():
                        # Optional bounded facts; diagnostic failure cannot change the original result.
                        try:
                            diagnostic = {
                                "regionId": item["regionId"] if re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", item["regionId"]) else None,
                                "unit": "BLOCK" if block_mode else "LINE",
                                "lineIndex": index // 2,
                                "inputTokenCount": int(tensor["input_ids"].shape[1]),
                                "outputTokenCount": line_count,
                                "eosCompleted": ids[-1] == tokenizer.eos_token_id,
                                "targetLanguageTokenPresent": tokenizer.get_lang_id("ko") in ids,
                                "nonSpecialCount": sum(token_id not in tokenizer.all_special_ids for token_id in ids),
                                "decodedLength": len(text),
                                "trimmedLength": len(text.strip()),
                            }
                            sys.stderr.write(json.dumps(diagnostic, ensure_ascii=True, separators=(",", ":")) + "\n")
                            sys.stderr.flush()
                        except Exception:
                            pass
                        raise ValueError("EMPTY_TRANSLATION")
                    if not block_mode and ("\r" in text or "\n" in text):
                        raise ValueError("OUTPUT_LINE_BREAK_INVALID")
                    output_count += line_count
                    parts[index] = text
                items.append({"regionId": item["regionId"], "targetText": "".join(parts), "inputTokenCount": input_count, "outputTokenCount": output_count, "eosCompleted": True})
        if not started or len(items) != len(request["items"]):
            raise ValueError("INFERENCE_OR_OUTPUT_UNCONFIRMED")
        phase = "RESULT_PIN_VALIDATION"
        verify_files(request["modelFiles"], model_path)
        verified_origins(dependency_roots)
        emit({"kind": "REPLY", "version": 1, "executionId": request["executionId"], "inputFingerprint": request["inputFingerprint"], "consumptionDigest": request["consumptionDigest"], "outcome": "SUCCESS", "started": started, "reason": "EOS_COMPLETE", "items": items, **({"generationCount": generation_count} if block_mode else {})})
        return 0
    except Exception as error:
        if isinstance(request, dict) and all(key in request for key in ("executionId", "inputFingerprint", "consumptionDigest")):
            reason = str(error) if isinstance(error, ValueError) and str(error).isupper() and str(error).replace("_", "").isalnum() and len(str(error)) <= 100 else "LOCAL_WORKER_FAILURE"
            # Only closed phase names and exception class are diagnostic; never exception text.
            error_class = type(error).__name__
            if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", error_class):
                error_class = "Exception"
            sys.stderr.write(json.dumps({"phase": phase, "errorClass": error_class}, ensure_ascii=True) + "\n")
            sys.stderr.flush()
            emit({"kind": "REPLY", "version": 1, "executionId": request["executionId"], "inputFingerprint": request["inputFingerprint"], "consumptionDigest": request["consumptionDigest"], "outcome": "FAILURE", "started": started, "reason": reason, "items": items, **({"generationCount": generation_count} if block_mode else {})})
            return 0
        return 2
    finally:
        if hook is not None:
            hook.remove()
        for handle in dll_handles:
            handle.close()


if __name__ == "__main__":
    raise SystemExit(main())
