"""Standard-library fixtures. All torch/tokenizer/model objects are deterministic fakes."""
from contextlib import nullcontext
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("local_translation_worker_fixture_target", HERE.parent.parent / "packages" / "providers" / "src" / "local-translation-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class Tensor:
    def __init__(self, count, ids=None, source_text=None):
        self.shape = (1, count)
        self.ids = ids
        self.source_text = source_text

    def __getitem__(self, _index):
        return self

    def tolist(self):
        return self.ids


class WorkerFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix="trio-local-translation-python-fixture-"))
        cls.model_root = cls.root / "model"
        cls.model_root.mkdir()
        cls.dep_root = cls.root / "deps" / "site-packages"
        cls.dep_root.mkdir(parents=True)
        cls.pins = []
        for name in ("model.safetensors", "config.json", "vocab.json", "sentencepiece.bpe.model"):
            file = cls.model_root / name
            file.write_bytes(b"PINNED_FIXTURE_NOT_A_MODEL")
            cls.pins.append({"path": str(file), "sha256": hashlib.sha256(file.read_bytes()).hexdigest(), "bytesLength": file.stat().st_size})

    def setUp(self):
        self.state = {"generations": 0, "hook": None, "eos": True, "empty": False, "force_cap": False, "first_large": False, "generation_limits": [], "encoded_texts": [], "generated_texts": []}
        state = self.state
        fixture = self

        class Tokenizer:
            eos_token_id = 2

            @classmethod
            def from_pretrained(cls, _path, **kwargs):
                fixture.assertEqual(kwargs, {"local_files_only": True, "trust_remote_code": False, "src_lang": "ja"})
                return cls()

            def __call__(self, text, **kwargs):
                fixture.assertEqual(kwargs, {"return_tensors": "pt", "truncation": False})
                state["encoded_texts"].append(text)
                return {"input_ids": Tensor(len(text) + 2, source_text=text)}

            def get_lang_id(self, language):
                fixture.assertEqual(language, "ko")
                return 10

            def decode(self, _ids, **kwargs):
                fixture.assertTrue(kwargs["skip_special_tokens"])
                return " " if state["empty"] else state.get("decoded_text", "로컬")

        class Model:
            @classmethod
            def from_pretrained(cls, _path, **kwargs):
                fixture.assertTrue(kwargs["local_files_only"])
                fixture.assertFalse(kwargs["trust_remote_code"])
                fixture.assertTrue(kwargs["use_safetensors"])
                if state.get("model_load_error"):
                    raise RuntimeError("PRIVATE_EXCEPTION_TEXT_MUST_NOT_BE_LOGGED")
                return cls()

            def to(self, device):
                fixture.assertEqual(device, "cpu")

            def eval(self):
                pass

            def register_forward_pre_hook(self, hook):
                state["hook"] = hook
                return types.SimpleNamespace(remove=lambda: None)

            def generate(self, **kwargs):
                fixture.assertFalse(kwargs["do_sample"])
                fixture.assertEqual(kwargs["num_beams"], 1)
                state["generations"] += 1
                state["generation_limits"].append(kwargs["max_new_tokens"])
                state["generated_texts"].append(kwargs["input_ids"].source_text)
                state["hook"](self, ())
                count = kwargs["max_new_tokens"] if state["force_cap"] or state["first_large"] and state["generations"] > 1 else 70 if state["first_large"] else 6
                ids = [1] + [10] * (count - 1) + [2 if state["eos"] else 99]
                return types.SimpleNamespace(sequences=Tensor(count + 1, ids))

        self.modules = {}
        for name in ("torch", "transformers", "sentencepiece", "tokenizers", "safetensors"):
            module = types.ModuleType(name)
            module.__file__ = str(self.dep_root / name / "__init__.py")
            self.modules[name] = module
        torch = self.modules["torch"]
        torch.set_num_threads = lambda threads: self.assertEqual(threads, 2)
        torch.set_num_interop_threads = lambda threads: self.assertEqual(threads, 1)
        torch.manual_seed = lambda seed: self.assertEqual(seed, 0)
        torch.use_deterministic_algorithms = lambda enabled: self.assertTrue(enabled)
        torch.float32 = "fake_float32"
        torch.inference_mode = nullcontext
        self.modules["transformers"].M2M100Tokenizer = Tokenizer
        self.modules["transformers"].M2M100ForConditionalGeneration = Model

    def run_worker(self, texts, block=False, prompt_contract="local-m2m100-whole-block-v2", translation_unit="BLOCK"):
        request = {"version": 1, "executionId": "fixture-execution", "inputFingerprint": "1" * 64, "consumptionDigest": "2" * 64,
                   "modelPath": str(self.model_root), "modelFiles": self.pins, "dependencyRoots": [str(self.dep_root)], "threads": 2,
                   "sourceLanguage": "ja", "targetLanguage": "ko", "maxInputTokens": 256, "maxNewTokens": 128,
                   "items": [{"regionId": str(index), "sourceText": text} for index, text in enumerate(texts)]}
        if block:
            request.update({"version": 2, "promptContract": prompt_contract, "translationUnit": translation_unit})
        stdout = io.StringIO()
        stderr = io.StringIO()
        stdin = types.SimpleNamespace(buffer=io.BytesIO(json.dumps(request, ensure_ascii=False).encode("utf-8")))
        with patch.dict(sys.modules, self.modules), patch.dict(os.environ, {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}), patch.object(sys, "stdin", stdin), patch.object(sys, "stdout", stdout), patch.object(sys, "stderr", stderr), patch.object(sys, "path", list(sys.path)):
            result = worker.main()
        self.stderr = stderr.getvalue()
        self.assertEqual(result, 0)
        return [json.loads(line) for line in stdout.getvalue().splitlines()]

    def test_import_is_inert(self):
        self.assertEqual(self.state["generations"], 0)

    def test_wire_json_preserves_unicode_with_windows_stdout_encoding(self):
        payload = {"targetText": "한국어 日本語 🧪", "sourceText": "…ぅ\n次の行"}
        buffer = io.BytesIO()
        stdout = io.TextIOWrapper(buffer, encoding="cp949", errors="strict", newline="\n")
        try:
            with patch.object(sys, "stdout", stdout):
                worker.emit(payload)
            stdout.flush()
            wire = buffer.getvalue()
            self.assertTrue(wire.isascii())
            self.assertEqual(json.loads(wire.decode("utf-8")), payload)
            self.assertEqual(wire.count(b"\n"), 1)
        finally:
            stdout.detach()

    def test_line_and_blank_positions_preserved(self):
        messages = self.run_worker(["あいう\n \nえお\r\n"])
        self.assertEqual([value["kind"] for value in messages], ["START", "REPLY"])
        self.assertEqual(messages[-1]["outcome"], "SUCCESS")
        self.assertEqual(messages[-1]["items"][0]["targetText"], "로컬\n \n로컬\r\n")
        self.assertEqual(messages[-1]["items"][0]["outputTokenCount"], 12)
        self.assertEqual(self.state["generations"], 2)

    def test_original_region_token_limit_precedes_any_generation(self):
        messages = self.run_worker(["あ" * 255])
        self.assertEqual(messages[-1]["reason"], "INPUT_TOKEN_LIMIT")
        self.assertFalse(messages[-1]["started"])
        self.assertEqual(self.state["generations"], 0)

    def test_eos_incomplete_is_failure(self):
        self.state["eos"] = False
        reply = self.run_worker(["あいう"])[-1]
        self.assertEqual(reply["outcome"], "FAILURE")
        self.assertEqual(reply["reason"], "EOS_INCOMPLETE")
        self.assertEqual(reply["items"], [])

    def test_forced_eos_at_generation_cap_is_failure(self):
        self.state["force_cap"] = True
        reply = self.run_worker(["あいう"])[-1]
        self.assertEqual(reply["reason"], "OUTPUT_TOKEN_LIMIT")
        self.assertEqual(reply["items"], [])

    def test_region_sum_caps_next_line_generation(self):
        self.state["first_large"] = True
        reply = self.run_worker(["あいう\nえお"])[-1]
        self.assertEqual(self.state["generation_limits"], [128, 58])
        self.assertEqual(reply["reason"], "OUTPUT_TOKEN_LIMIT")
        self.assertEqual(reply["items"], [])

    def test_empty_result_is_failure(self):
        self.state["empty"] = True
        reply = self.run_worker(["あいう"])[-1]
        self.assertEqual(reply["reason"], "EMPTY_TRANSLATION")

    def test_generic_failure_diagnostic_excludes_exception_text(self):
        self.state["model_load_error"] = True
        reply = self.run_worker(["あいう"])[-1]
        self.assertEqual(reply["reason"], "LOCAL_WORKER_FAILURE")
        self.assertFalse(reply["started"])
        self.assertEqual(reply["items"], [])
        self.assertEqual(self.state["generations"], 0)
        self.assertEqual(json.loads(self.stderr), {"phase": "MODEL_LOAD", "errorClass": "RuntimeError"})
        self.assertNotIn("PRIVATE_EXCEPTION", self.stderr)

    def test_dependency_origin_outside_roots_is_failure_before_generation(self):
        self.modules["torch"].__file__ = str(self.root / "outside" / "site-packages" / "torch" / "__init__.py")
        reply = self.run_worker(["あいう"])[-1]
        self.assertEqual(reply["reason"], "DEPENDENCY_ORIGIN_INVALID")
        self.assertFalse(reply["started"])
        self.assertEqual(self.state["generations"], 0)


    def test_block_uses_one_verbatim_region_tensor_and_preserves_model_output_newlines(self):
        source = "あいう\n \nえお\r\n"
        target = "한국어\r\n원모델\n\n값 "
        self.state["decoded_text"] = target
        messages = self.run_worker([source], block=True)
        self.assertEqual([value["kind"] for value in messages], ["START", "REPLY"])
        self.assertEqual(messages[-1]["outcome"], "SUCCESS")
        self.assertEqual(messages[-1]["items"][0]["targetText"], target)
        self.assertEqual(messages[-1]["items"][0]["inputTokenCount"], len(source) + 2)
        self.assertEqual(self.state["encoded_texts"], [source])
        self.assertEqual(self.state["generated_texts"], [source])
        self.assertEqual(self.state["generation_limits"], [128])
        self.assertEqual(messages[-1]["generationCount"], 1)

    def test_block_generates_once_per_region_in_original_order(self):
        texts = ["あいう\nえお", "かき\r\nくけ"]
        messages = self.run_worker(texts, block=True)
        reply = messages[-1]
        self.assertEqual(reply["outcome"], "SUCCESS")
        self.assertEqual([item["regionId"] for item in reply["items"]], ["0", "1"])
        self.assertEqual(self.state["encoded_texts"], texts)
        self.assertEqual(self.state["generated_texts"], texts)
        self.assertEqual(self.state["generations"], 2)
        self.assertEqual(reply["generationCount"], 2)
        self.assertEqual(len([value for value in messages if value["kind"] == "START"]), 1)

    def test_unknown_block_contract_or_unit_rejects_before_generation(self):
        for contract, unit in (("unknown-v3", "BLOCK"), ("local-m2m100-whole-block-v2", "LINE")):
            with self.subTest(contract=contract, unit=unit):
                reply = self.run_worker(["あいう\nえお"], block=True, prompt_contract=contract, translation_unit=unit)[-1]
                self.assertEqual(reply["outcome"], "FAILURE")
                self.assertEqual(reply["reason"], "INPUT_CONTRACT_INVALID")
                self.assertFalse(reply["started"])
                self.assertEqual(self.state["generations"], 0)

    def test_whole_block_bound_precedes_every_generation_without_truncation(self):
        source = "あ" * 200 + "\n" + "い" * 100
        reply = self.run_worker(["短文", source], block=True)[-1]
        self.assertEqual(reply["reason"], "INPUT_TOKEN_LIMIT")
        self.assertFalse(reply["started"])
        self.assertEqual(self.state["generations"], 0)

    def test_block_eos_empty_and_generation_cap_are_still_failures(self):
        for flag, value, reason in (("eos", False, "EOS_INCOMPLETE"), ("empty", True, "EMPTY_TRANSLATION"), ("force_cap", True, "OUTPUT_TOKEN_LIMIT")):
            with self.subTest(flag=flag):
                self.setUp()
                self.state[flag] = value
                reply = self.run_worker(["あいう\nえお"], block=True)[-1]
                self.assertEqual(reply["outcome"], "FAILURE")
                self.assertEqual(reply["reason"], reason)
                self.assertTrue(reply["started"])
                self.assertEqual(reply["items"], [])

    def test_v1_model_newline_is_still_invalid_without_block_contract(self):
        self.state["decoded_text"] = "모델\n줄"
        reply = self.run_worker(["あいう"])[-1]
        self.assertEqual(reply["outcome"], "FAILURE")
        self.assertEqual(reply["reason"], "OUTPUT_LINE_BREAK_INVALID")


if __name__ == "__main__":
    unittest.main(verbosity=2)
