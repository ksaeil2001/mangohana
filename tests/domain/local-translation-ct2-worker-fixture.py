"""Stdlib-only fake CT2/SPM qualification. Never loads a native library or model."""
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
spec = importlib.util.spec_from_file_location("ct2_candidate_worker_fixture", HERE.parent.parent / "packages" / "providers" / "src" / "local-translation-ct2-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def pin(path):
    encoded = path.read_bytes()
    return {"path": str(path), "sha256": hashlib.sha256(encoded).hexdigest(), "bytesLength": len(encoded)}


class Ct2WorkerFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix="ct2-native-zero-")).resolve()
        cls.model = cls.root / "fake-converted-model"
        cls.deps = cls.root / "deps" / "site-packages"
        cls.resources = cls.root / "fake-resources"
        for directory in (cls.model, cls.deps, cls.resources):
            directory.mkdir(parents=True)
        cls.source_vocab = ["<unk>", "<s>", "</s>", "▁入力"] + ["source_fixture_" + str(i) for i in range(4, 32000)]
        cls.target_vocab = ["<unk>", "<s>", "</s>", "▁로컬", "▁", "▁다른"] + ["target_fixture_" + str(i) for i in range(6, 32000)]
        cls.model_bytes = {
            "model.bin": b"FAKE_FIXTURE_ONLY_NOT_A_NATIVE_MODEL",
            "config.json": json.dumps({"add_source_eos": True, "add_source_bos": False, "eos_token": "</s>"}).encode(),
            "source_vocabulary.json": json.dumps(cls.source_vocab, ensure_ascii=False).encode(),
            "target_vocabulary.json": json.dumps(cls.target_vocab, ensure_ascii=False).encode(),
        }
        scripts = HERE / "fixtures" / "ct2"
        cls.resource_bytes = {
            "source.spm": b"FAKE_SOURCE_SPM_NO_NATIVE_IMPORT",
            "target.spm": b"FAKE_TARGET_SPM_NO_NATIVE_IMPORT",
            "preprocess.sh": (scripts / "preprocess.sh").read_bytes(),
            "postprocess.sh": (scripts / "postprocess.sh").read_bytes(),
        }
        for module_name in ("ctranslate2", "sentencepiece"):
            directory = cls.deps / module_name
            directory.mkdir()
            (directory / "__init__.py").write_bytes(b"# FAKE MODULE ORIGIN ONLY\n")

    def setUp(self):
        for name, encoded in self.model_bytes.items():
            (self.model / name).write_bytes(encoded)
        for name, encoded in self.resource_bytes.items():
            (self.resources / name).write_bytes(encoded)
        self.state = {"mode": "OK", "encoded": [], "calls": [], "constructors": [], "callback_returns": []}
        self.request = {
            "version": 2, "executionId": "fixture-execution", "inputFingerprint": "a" * 64,
            "consumptionDigest": "b" * 64, "modelPath": str(self.model),
            "modelFiles": [pin(self.model / name) for name in self.model_bytes],
            "dependencyRoots": [str(self.deps)], "threads": 2, "sourceLanguage": "ja", "targetLanguage": "ko",
            "maxInputTokens": 256, "maxNewTokens": 128, "promptContract": worker.PROMPT,
            "translationUnit": "BLOCK", "ownedTempRoot": str(self.root),
            "ct2Resources": {
                "sourceSentencePiece": pin(self.resources / "source.spm"),
                "targetSentencePiece": pin(self.resources / "target.spm"),
                "preprocess": pin(self.resources / "preprocess.sh"),
                "postprocess": pin(self.resources / "postprocess.sh"),
            },
            "normalization": {"contract": worker.NORMALIZATION, "preprocessSha256": worker.PREPROCESS_SHA, "postprocessSha256": worker.POSTPROCESS_SHA},
            "items": [{"regionId": "region-4", "sourceText": "…ぅ", "normalizedSourceText": "...ぅ"}],
        }
        fixture = self
        ct2 = types.ModuleType("ctranslate2")
        ct2.__file__ = str(self.deps / "ctranslate2" / "__init__.py")
        ct2.get_supported_compute_types = lambda device: {"float32"} if device == "cpu" else set()

        class Translator:
            device = "cpu"
            compute_type = "float32"
            model_is_loaded = True

            def __init__(self, model_path, **kwargs):
                fixture.assertEqual(model_path, str(fixture.model))
                fixture.assertEqual(kwargs, {"device": "cpu", "compute_type": "float32", "inter_threads": 1, "intra_threads": 2, "max_queued_batches": 1})
                fixture.state["constructors"].append(kwargs)

            def translate_batch(self, sources, **kwargs):
                fixture.state["calls"].append(sources)
                callback = kwargs.pop("callback")
                fixture.assertEqual(kwargs, {"beam_size": 1, "num_hypotheses": 1, "min_decoding_length": 0, "max_decoding_length": 128, "max_input_length": 0, "sampling_topk": 1, "return_end_token": True})
                fixture.assertEqual(len(sources), 1)
                mode = fixture.state["mode"]
                if mode == "BEFORE_CALLBACK":
                    raise RuntimeError("PRIVATE_ERROR_TEXT_MUST_NOT_LEAK")
                if mode == "SECOND_GENERATION_ERROR" and len(fixture.state["calls"]) == 2:
                    raise RuntimeError("PRIVATE_ERROR_TEXT_MUST_NOT_LEAK")
                ids = [3, 2]
                if mode == "FIRST_EOS":
                    ids = [2]
                elif mode == "WHITESPACE_ONLY":
                    ids = [4, 2]
                elif mode == "IS_LAST_WITHOUT_EOS":
                    ids = [3]
                elif mode == "OUTPUT_CAP":
                    ids = [3] * 127 + [2]
                elif mode == "EARLY_EOS":
                    ids = [2, 3, 2]
                tokens = [fixture.target_vocab[token_id] for token_id in ids]
                if mode != "NO_CALLBACK":
                    for index, (token, token_id) in enumerate(zip(tokens, ids)):
                        step = types.SimpleNamespace(step=index, token=token, token_id=token_id, batch_id=0, hypothesis_id=0, is_last=index == len(tokens) - 1)
                        if mode == "EOS_IS_LAST_FALSE":
                            step.is_last = False
                        if mode in ("CALLBACK_TOKEN_MISMATCH", "SWALLOWED_CALLBACK_ERROR") and index == 0:
                            step.token_id = 5
                        if mode == "CALLBACK_STEP_MISMATCH" and index == 0:
                            step.step = 1
                        try:
                            returned = callback(step)
                            fixture.assertIs(returned, False)
                            fixture.state["callback_returns"].append(returned)
                        except Exception:
                            if mode == "SWALLOWED_CALLBACK_ERROR":
                                break
                            raise
                if mode == "AFTER_CALLBACK":
                    raise RuntimeError("PRIVATE_ERROR_TEXT_MUST_NOT_LEAK")
                if mode == "RESULT_MISMATCH":
                    tokens = [fixture.target_vocab[5], "</s>"]
                if mode == "PIN_CHANGED":
                    (fixture.model / "model.bin").write_bytes(b"CHANGED_FAKE_MODEL_PIN")
                if mode == "RESOURCE_PIN_CHANGED":
                    (fixture.resources / "source.spm").write_bytes(b"CHANGED_FAKE_SPM_PIN")
                if mode == "ORIGIN_CHANGED":
                    ct2.__file__ = str(fixture.root.parent / "outside" / "site-packages" / "ctranslate2" / "__init__.py")
                if mode == "RESULT_NONE":
                    return None
                return [types.SimpleNamespace(hypotheses=[tokens])]

        ct2.Translator = Translator
        spm = types.ModuleType("sentencepiece")
        spm.__file__ = str(self.deps / "sentencepiece" / "__init__.py")

        class SentencePieceProcessor:
            def __init__(self, *, model_file):
                fixture.assertIn(model_file, [str(fixture.resources / "source.spm"), str(fixture.resources / "target.spm")])
                self.vocab = fixture.source_vocab if Path(model_file).name == "source.spm" else fixture.target_vocab

            def get_piece_size(self):
                return len(self.vocab)

            def id_to_piece(self, index):
                if fixture.state["mode"] == "SPM_ORDER_MISMATCH" and self.vocab is fixture.source_vocab and index == 3:
                    return "WRONG_FIXTURE_TOKEN"
                return self.vocab[index]

            def encode(self, text, **kwargs):
                fixture.assertEqual(kwargs, {"out_type": str, "add_bos": False, "add_eos": False})
                fixture.state["encoded"].append(text)
                if fixture.state["mode"] == "INPUT_CAP":
                    return [fixture.source_vocab[3]] * 256
                if fixture.state["mode"] == "INPUT_AT_CAP":
                    return [fixture.source_vocab[3]] * 255
                return [fixture.source_vocab[3]] if text else []

        spm.SentencePieceProcessor = SentencePieceProcessor
        self.modules = {"ctranslate2": ct2, "sentencepiece": spm}

    def run_worker(self, encoded=None, stdout=None):
        if encoded is None:
            encoded = json.dumps(self.request, ensure_ascii=False).encode()
        stdin = io.TextIOWrapper(io.BytesIO(encoded), encoding="utf-8")
        stdout = stdout or io.StringIO()
        stderr = io.StringIO()
        with patch.dict(sys.modules, self.modules), patch.dict(os.environ, {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}), patch.object(sys, "stdin", stdin), patch.object(sys, "stdout", stdout), patch.object(sys, "stderr", stderr), patch.object(sys, "path", list(sys.path)):
            code = worker.main()
        raw = stdout.getvalue()
        messages = [json.loads(line) for line in raw.splitlines()]
        return code, messages, raw, stderr.getvalue()

    def assert_unknown(self, mode, has_start):
        self.state["mode"] = mode
        code, messages, _, diagnostic = self.run_worker()
        self.assertEqual(code, 2)
        self.assertEqual([message["kind"] for message in messages], ["START"] if has_start else [])
        self.assertEqual(len(self.state["calls"]), 1)
        self.assertNotIn("PRIVATE_ERROR_TEXT_MUST_NOT_LEAK", diagnostic)
        self.assertNotIn("…ぅ", diagnostic)
        self.assertEqual(set(json.loads(diagnostic)), {"phase", "errorClass"})

    def test_import_is_inert(self):
        self.assertNotIn("ctranslate2", worker.__dict__)
        self.assertNotIn("sentencepiece", worker.__dict__)
        self.assertEqual(self.state["calls"], [])

    def test_archive_normalizer_literal_order_and_control_policy(self):
        vectors = [
            ("  …ぅ  ", "...ぅ"),
            ("１１２３４５６７８９０", '""234567890'),
            ("A\u2060B\u200bC\ufeffD", "A B C D"),
            (" A\tB\r\n C\r D \n\n E ", "A B\nC D\n\nE"),
            ("，。  、”“∶：？《》）！（；１」「．   ～’…━〈〉【】％", ',. ,""::?"")!(;""". ~\'...-<>[]%'),
            ("ｶﾞ①Ａ\u00a0B", "ｶﾞ①Ａ\u00a0B"),
        ]
        for source, expected in vectors:
            with self.subTest(source=ascii(source)):
                self.assertEqual(worker.normalize_source(source), expected)
        self.assertEqual(worker.postprocess(["▁로컬", "▁번역"]), " 로컬 번역")
        self.assertEqual(worker.postprocess(["A B", "▁C"]), "AB C")

    def test_original_region4_one_greedy_generation_and_real_callback_start(self):
        code, messages, raw, diagnostic = self.run_worker()
        self.assertEqual(code, 0)
        self.assertEqual(diagnostic, "")
        self.assertEqual([message["kind"] for message in messages], ["START", "REPLY"])
        start, reply = messages
        self.assertEqual(start["source"], "DECODE_STEP_OBSERVED")
        self.assertEqual(start["pid"], os.getpid())
        for name in ("executionId", "inputFingerprint", "consumptionDigest"):
            self.assertEqual(start[name], self.request[name])
            self.assertEqual(reply[name], self.request[name])
        self.assertEqual(reply["version"], 1)
        self.assertEqual(reply["outcome"], "SUCCESS")
        self.assertEqual(reply["generationCount"], 1)
        self.assertEqual(reply["items"], [{"regionId": "region-4", "targetText": " 로컬", "inputTokenCount": 2, "outputTokenCount": 2, "eosCompleted": True}])
        self.assertEqual(self.state["encoded"], ["...ぅ"])
        self.assertEqual(self.state["callback_returns"], [False, False])
        self.assertTrue(raw.isascii())

    def test_whole_page11_order_has_exactly11_generations_and_one_start(self):
        self.request["items"] = [{"regionId": "r" + str(index), "sourceText": "入力" + str(index), "normalizedSourceText": "入力" + str(index)} for index in range(11)]
        code, messages, _, _ = self.run_worker()
        self.assertEqual(code, 0)
        self.assertEqual([message["kind"] for message in messages], ["START", "REPLY"])
        self.assertEqual(messages[-1]["generationCount"], 11)
        self.assertEqual([item["regionId"] for item in messages[-1]["items"]], ["r" + str(index) for index in range(11)])
        self.assertEqual(self.state["encoded"], ["入力" + str(index) for index in range(11)])
        self.assertEqual(len(self.state["calls"]), 11)

    def test_call_entered_error_does_not_claim_start(self):
        self.assert_unknown("BEFORE_CALLBACK", False)

    def test_after_callback_error_keeps_start_and_no_reply(self):
        self.assert_unknown("AFTER_CALLBACK", True)

    def test_result_without_any_callback_is_unknown(self):
        self.assert_unknown("NO_CALLBACK", False)

    def test_native_result_mismatch_is_unknown(self):
        self.assert_unknown("RESULT_MISMATCH", True)

    def test_missing_native_result_is_unknown(self):
        self.assert_unknown("RESULT_NONE", True)

    def test_callback_token_id_mismatch_is_unknown(self):
        self.assert_unknown("CALLBACK_TOKEN_MISMATCH", False)

    def test_callback_noncontiguous_step_is_unknown(self):
        self.assert_unknown("CALLBACK_STEP_MISMATCH", False)

    def test_engine_swallowing_callback_exception_remains_unknown(self):
        self.assert_unknown("SWALLOWED_CALLBACK_ERROR", False)

    def test_callback_start_wire_exception_emits_no_success_reply(self):
        class BrokenStartSink(io.StringIO):
            def write(self, text):
                if json.loads(text)["kind"] == "START":
                    raise RuntimeError("PRIVATE_ERROR_TEXT_MUST_NOT_LEAK")
                return super().write(text)
        code, messages, _, diagnostic = self.run_worker(stdout=BrokenStartSink())
        self.assertEqual(code, 2)
        self.assertEqual(messages, [])
        self.assertEqual(len(self.state["calls"]), 1)
        self.assertNotIn("PRIVATE_ERROR_TEXT_MUST_NOT_LEAK", diagnostic)

    def test_pin_change_after_engine_return_is_unknown(self):
        self.assert_unknown("PIN_CHANGED", True)

    def test_tokenizer_pin_change_after_engine_return_is_unknown(self):
        self.assert_unknown("RESOURCE_PIN_CHANGED", True)

    def test_dependency_origin_change_after_engine_return_is_unknown(self):
        self.assert_unknown("ORIGIN_CHANGED", True)

    def test_first_eos_at_min0_and_whitespace_output_fail_without_repair(self):
        for mode in ("FIRST_EOS", "WHITESPACE_ONLY"):
            with self.subTest(mode=mode):
                self.state["mode"] = mode
                code, messages, _, _ = self.run_worker()
                self.assertEqual(code, 0)
                self.assertEqual([message["kind"] for message in messages], ["START", "REPLY"])
                self.assertEqual(messages[-1]["reason"], "EMPTY_TRANSLATION")
                self.assertEqual(messages[-1]["outcome"], "FAILURE")
                self.assertEqual(messages[-1]["items"], [])
                self.assertEqual(messages[-1]["generationCount"], 1)
                self.assertEqual(len(self.state["calls"]), 1)
                self.state["calls"].clear()

    def test_is_last_without_actual_eos_is_failure(self):
        self.state["mode"] = "IS_LAST_WITHOUT_EOS"
        code, messages, _, _ = self.run_worker()
        self.assertEqual(code, 0)
        self.assertEqual(messages[-1]["reason"], "EOS_INCOMPLETE")
        self.assertEqual(messages[-1]["outcome"], "FAILURE")

    def test_actual_eos_id_succeeds_even_if_is_last_false(self):
        self.state["mode"] = "EOS_IS_LAST_FALSE"
        code, messages, _, _ = self.run_worker()
        self.assertEqual(code, 0)
        self.assertEqual(messages[-1]["outcome"], "SUCCESS")

    def test_early_eos_and_length_cap_fail_without_filling(self):
        for mode, reason in (("EARLY_EOS", "EOS_INCOMPLETE"), ("OUTPUT_CAP", "OUTPUT_TOKEN_LIMIT")):
            with self.subTest(mode=mode):
                self.state["mode"] = mode
                code, messages, _, _ = self.run_worker()
                self.assertEqual(code, 0)
                self.assertEqual(messages[-1]["outcome"], "FAILURE")
                self.assertEqual(messages[-1]["reason"], reason)
                self.assertEqual(messages[-1]["items"], [])

    def test_source_cap_includes_converter_eos_without_truncation(self):
        self.state["mode"] = "INPUT_CAP"
        code, messages, _, _ = self.run_worker()
        self.assertEqual(code, 0)
        self.assertEqual([message["kind"] for message in messages], ["REPLY"])
        self.assertEqual(messages[-1]["reason"], "INPUT_TOKEN_LIMIT")
        self.assertFalse(messages[-1]["started"])
        self.assertEqual(messages[-1]["generationCount"], 0)
        self.assertEqual(self.state["calls"], [])
        self.assertEqual(self.state["constructors"], [])
        self.state["mode"] = "INPUT_AT_CAP"
        code, messages, _, _ = self.run_worker()
        self.assertEqual(code, 0)
        self.assertEqual(messages[-1]["outcome"], "SUCCESS")
        self.assertEqual(messages[-1]["items"][0]["inputTokenCount"], 256)

    def test_normalization_mismatch_and_extra_request_field_prevent_import(self):
        for change in ("normalization", "extra"):
            with self.subTest(change=change):
                if change == "normalization":
                    self.request["items"][0]["normalizedSourceText"] = "INVENTED_NFKC"
                else:
                    self.request["items"][0]["normalizedSourceText"] = "...ぅ"
                    self.request["forcedMinimum"] = 1
                code, messages, _, _ = self.run_worker()
                self.assertEqual(code, 0)
                self.assertFalse(messages[-1]["started"])
                self.assertEqual(self.state["encoded"], [])
                self.assertEqual(self.state["calls"], [])

    def test_spm_order_mismatch_blocks_generation(self):
        self.state["mode"] = "SPM_ORDER_MISMATCH"
        code, messages, _, _ = self.run_worker()
        self.assertEqual(code, 0)
        self.assertEqual(messages[-1]["reason"], "TOKENIZER_VOCABULARY_ORDER_MISMATCH")
        self.assertEqual(self.state["calls"], [])

    def test_unsupported_source_or_target_eos_config_blocks_generation(self):
        for config in ({"add_source_eos": False, "add_source_bos": False, "eos_token": "</s>"}, {"add_source_eos": True, "add_source_bos": False, "eos_token": "forced-fixture-token"}):
            with self.subTest(config=config):
                path = self.model / "config.json"
                path.write_text(json.dumps(config), encoding="utf-8")
                self.request["modelFiles"] = [pin(self.model / name) for name in self.model_bytes]
                code, messages, _, _ = self.run_worker()
                self.assertEqual(code, 0)
                self.assertEqual(messages[-1]["reason"], "MODEL_EOS_CONFIGURATION_UNSUPPORTED")
                self.assertFalse(messages[-1]["started"])
                self.assertEqual(self.state["calls"], [])

    def test_missing_converted_file_and_wrong_normalizer_pin_hold(self):
        self.request["modelFiles"] = self.request["modelFiles"][:-1]
        code, messages, _, _ = self.run_worker()
        self.assertEqual(code, 0)
        self.assertEqual(messages[-1]["reason"], "CONVERTED_FILES_REQUIRED")
        self.assertEqual(self.state["calls"], [])
        self.request["modelFiles"] = [pin(self.model / name) for name in self.model_bytes]
        self.request["ct2Resources"]["preprocess"]["sha256"] = "0" * 64
        code, messages, _, _ = self.run_worker()
        self.assertEqual(code, 0)
        self.assertEqual(messages[-1]["reason"], "NORMALIZER_OR_TOKENIZER_FILES_INVALID")
        self.assertEqual(self.state["calls"], [])

    def test_second_generation_error_does_not_apply_completed_partial_items(self):
        self.request["items"].append({"regionId": "r2", "sourceText": "次", "normalizedSourceText": "次"})
        self.state["mode"] = "SECOND_GENERATION_ERROR"
        code, messages, _, _ = self.run_worker()
        self.assertEqual(code, 2)
        self.assertEqual([message["kind"] for message in messages], ["START"])
        self.assertEqual(len(self.state["calls"]), 2)

    def test_ascii_protocol_works_with_cp949_stdout(self):
        class Cp949Sink(io.StringIO):
            def write(self, text):
                text.encode("cp949", errors="strict")
                return super().write(text)
        code, messages, raw, _ = self.run_worker(stdout=Cp949Sink())
        self.assertEqual(code, 0)
        self.assertEqual(messages[-1]["items"][0]["targetText"], " 로컬")
        self.assertTrue(raw.isascii())

    def test_input_bytes_cap_and_duplicate_json_keys_remain_prestart(self):
        code, messages, _, _ = self.run_worker(encoded=b"a" * (worker.MAX_INPUT_BYTES + 1))
        self.assertEqual(code, 2)
        self.assertEqual(messages, [])
        code, messages, _, _ = self.run_worker(encoded=b'{"version":2,"version":2}')
        self.assertEqual(code, 2)
        self.assertEqual(messages, [])
        self.assertEqual(self.state["calls"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
