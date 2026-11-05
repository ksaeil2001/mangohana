"""Pinned offline Hayai CPU recognition. No model selector, installer, or fallback.

Hayai is Apache-2.0; the pinned model/source manifests retain its license and card.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import struct
import sys
import types

MAX_TOKENS = 256


def import_local_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def isolated_hayai_runtime(config):
    script_root = Path(__file__).resolve().parent
    verifier = import_local_module("_mangohana_runtime_verifier", script_root / "verify_runtime.py")
    snapshot = verifier.verify_runtime(config["wheelRoot"], config["runtimeRoot"], config["runtimeFiles"])
    runtime = Path(config["runtimeRoot"]).resolve(strict=True)
    base = Path(sys.executable).resolve().parent
    forbidden = [name for name in ("torch", "transformers", "numpy", "PIL", "tokenizers", "safetensors")
                 if name in sys.modules]
    if forbidden:
        raise RuntimeError("Foreign model modules were loaded before isolation")
    sys.path[:] = [str(runtime), str(base / "python310.zip"), str(base), str(base / "Lib"), str(base / "DLLs")]
    sys.meta_path[:] = [finder for finder in sys.meta_path if type(finder).__module__ != "_distutils_hack"]
    for key, value in {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1",
                       "DO_NOT_TRACK": "1", "TOKENIZERS_PARALLELISM": "false"}.items():
        os.environ[key] = value
    import torch
    import transformers
    import numpy
    import PIL
    import tokenizers
    import safetensors
    import torch._C
    import numpy._core._multiarray_umath
    import PIL.Image
    import PIL._imaging
    import tokenizers.tokenizers
    import safetensors._safetensors_rust
    for module in (torch, transformers, numpy, PIL, tokenizers, safetensors, torch._C,
                   numpy._core._multiarray_umath, PIL._imaging, tokenizers.tokenizers,
                   safetensors._safetensors_rust):
        actual = Path(module.__file__).resolve(strict=True)
        if runtime not in actual.parents:
            raise RuntimeError("Unexpected module origin")
    versions = [(torch.__version__, "2.10.0+cpu"), (transformers.__version__, "4.57.6"),
                (numpy.__version__, "2.2.6"), (PIL.__version__, "12.1.0"),
                (tokenizers.__version__, "0.22.2"), (safetensors.__version__, "0.8.0")]
    if any(str(actual) != expected for actual, expected in versions) or torch.version.cuda is not None:
        raise RuntimeError("Expected pinned CPU runtime")
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    return verifier, snapshot


class CompletionTrackingTokenizer:
    """The pinned generator strips EOS/PAD; limit-sized cleaned IDs are incomplete."""
    def __init__(self, tokenizer, limit):
        self.tokenizer = tokenizer
        self.limit = limit
        self.complete = False

    def __getattr__(self, key):
        return getattr(self.tokenizer, key)

    def decode(self, ids, **kwargs):
        self.complete = len(ids) < self.limit
        return self.tokenizer.decode(ids, **kwargs)


def validate_hayai_loading_info(info, metadata):
    unused = {"decoder.ids_head.weight": [226, 512], "decoder.ids_norm.weight": [512]}
    if not isinstance(info, dict) or any(info.get(key) != [] for key in ("missing_keys", "mismatched_keys", "error_msgs")):
        raise RuntimeError("OCR weight/config mismatch")
    extras = info.get("unexpected_keys")
    if not isinstance(extras, list) or len(extras) != 2 or set(extras) != set(unused):
        raise RuntimeError("Unexpected OCR checkpoint tensors")
    for key, shape in unused.items():
        tensor = metadata.get(key)
        if not isinstance(tensor, dict) or tensor.get("shape") != shape or tensor.get("dtype") != "F32":
            raise RuntimeError("Unexpected training-only OCR head")


def hayai_tensor_metadata(path):
    with open(path, "rb") as handle:
        prefix = handle.read(8)
        if len(prefix) != 8:
            raise ValueError("Missing tensor header")
        length = struct.unpack("<Q", prefix)[0]
        if not 0 < length <= 16 * 1024 * 1024:
            raise ValueError("Tensor header limit")
        header = json.loads(handle.read(length))
    if not isinstance(header, dict):
        raise ValueError("Invalid tensor header")
    return header


class Hayai:
    def __init__(self, root, config):
        self.verifier, self.runtime_snapshot = isolated_hayai_runtime(config)
        import torch
        from transformers import PreTrainedTokenizerFast, Siglip2ImageProcessor
        package = types.ModuleType("_mangohana_hayai")
        package.__path__ = [str(root)]
        sys.modules[package.__name__] = package
        configuration = import_local_module(package.__name__ + ".configuration_hayai", root / "configuration_hayai.py")
        modeling = import_local_module(package.__name__ + ".modeling_hayai", root / "modeling_hayai.py")
        model_config = configuration.HayaiConfig(**json.loads((root / "config.json").read_text(encoding="utf-8")))
        model_config.vision_config = json.loads((root / "siglip/config.json").read_text(encoding="utf-8"))["vision_config"]
        self.model, info = modeling.HayaiModel.from_pretrained(
            str(root), config=model_config, local_files_only=True, use_safetensors=True,
            torch_dtype=torch.float32, output_loading_info=True)
        validate_hayai_loading_info(info, hayai_tensor_metadata(root / "model.safetensors"))
        self.model.eval()
        self.processor = Siglip2ImageProcessor.from_pretrained(str(root / "siglip"), local_files_only=True)
        self.tokenizer = PreTrainedTokenizerFast(tokenizer_file=str(root / "tokenizer.json"),
                                               bos_token="<bos>", eos_token="<eos>", pad_token="<pad>", unk_token="<unk>")

    def assert_ready(self):
        self.verifier.assert_unchanged(self.runtime_snapshot)
        if self.model.training or any(parameter.device.type != "cpu" for parameter in self.model.parameters()):
            raise RuntimeError("Expected CPU evaluation model")

    def recognize(self, image):
        import torch
        inputs = self.processor(images=[image], max_num_patches=384, return_tensors="pt")
        tokenizer = CompletionTrackingTokenizer(self.tokenizer, MAX_TOKENS)
        with torch.inference_mode():
            texts = self.model.generate(**inputs, tokenizer=tokenizer, max_new_tokens=MAX_TOKENS,
                                        dtype=torch.float32, use_cuda_graph=False)
        if not isinstance(texts, list) or len(texts) != 1 or not isinstance(texts[0], str):
            raise ValueError("Invalid model text")
        return {"text": texts[0], "complete": tokenizer.complete}
