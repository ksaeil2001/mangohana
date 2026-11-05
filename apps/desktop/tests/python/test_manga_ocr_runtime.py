"""Synthetic assets/fake models only. No model execution, network, or user images."""
import base64
import contextlib
import csv
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
import zipfile

RESOURCES = Path(__file__).resolve().parents[2] / "resources" / "managed-ocr"
TEST_IMPORT_PATH = list(sys.path)


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, RESOURCES / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


VERIFIER = load_module("test_manga_verifier", "verify_runtime.py")
SIDECAR = load_module("test_manga_sidecar", "manga_ocr.py")
RECOGNITION = load_module("test_hayai_recognition", "recognize.py")
TEXT_EVIDENCE = load_module("test_manga_text_evidence", "text_evidence.py")


class VerifiedAssetsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="trio-manga-ocr-unit-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.wheels = self.root / "wheels"
        self.runtime = self.root / "runtime"
        self.model = self.root / "model"
        for path in (self.wheels, self.runtime, self.model):
            path.mkdir()

    def wheel(self, contents=None, edit_record=None):
        if contents is None:
            contents = {"sample_pkg/__init__.py": b"raise RuntimeError('never import fixture')\n",
                        "sample_pkg/data.bin": b"\x00\x01\x02rawbytes"}
        record_name = "sample_pkg-1.0.dist-info/RECORD"
        rows = [[name, "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode(), str(len(data))]
                for name, data in contents.items()]
        rows.append([record_name, "", ""])
        if edit_record:
            edit_record(rows)
        record = io.StringIO(newline="")
        csv.writer(record, lineterminator="\n").writerows(rows)
        all_files = {**contents, record_name: record.getvalue().encode()}
        path = self.wheels / "sample_pkg-1.0-py3-none-any.whl"
        with zipfile.ZipFile(path, "w") as archive:
            for name, data in all_files.items():
                archive.writestr(name, data)
                # Test-only extraction of these explicit synthetic entries.
                if ".." not in Path(name).parts:
                    target = self.runtime / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
        data = path.read_bytes()
        return {"path": path.name, "url": "https://example.invalid/fixture.whl",
                "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}

    def verify(self, pin):
        return VERIFIER.verify_runtime(self.wheels, self.runtime, [pin])

    def model_pin(self, name="model.bin", data=b"synthetic-model"):
        path = self.model / name
        path.write_bytes(data)
        return {"path": name, "url": "https://example.invalid/fixture.bin",
                "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}

    def test_verifier_checks_all_extracted_bytes_without_importing_or_writing(self):
        pin = self.wheel()
        before = {str(path): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        snapshot = self.verify(pin)
        VERIFIER.assert_unchanged(snapshot)
        after = {str(path): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        self.assertEqual(before, after)
        self.assertNotIn("sample_pkg", sys.modules)
        self.assertFalse(list(self.root.rglob("*.pyc")))

    def test_wheel_hash_mismatch_and_record_hash_mismatch_are_rejected(self):
        pin = self.wheel()
        with self.assertRaisesRegex(ValueError, "wheel hash"):
            self.verify({**pin, "sha256": "0" * 64})
        pin = self.wheel(edit_record=lambda rows: rows[0].__setitem__(1, "sha256=" + "A" * 43))
        with self.assertRaisesRegex(ValueError, "RECORD hash"):
            self.verify(pin)

    def test_extract_tamper_is_rejected_even_when_original_wheel_still_matches(self):
        pin = self.wheel()
        path = self.runtime / "sample_pkg/data.bin"
        path.write_bytes(b"\xff" * path.stat().st_size)
        with self.assertRaisesRegex(ValueError, "target hash"):
            self.verify(pin)

    def test_missing_unknown_and_empty_directory_entries_are_rejected(self):
        pin = self.wheel()
        path = self.runtime / "sample_pkg/data.bin"
        data = path.read_bytes()
        path.unlink()
        with self.assertRaisesRegex(ValueError, "missing target"):
            self.verify(pin)
        path.write_bytes(data)
        unknown = self.runtime / "unexpected.py"
        unknown.write_bytes(b"unverified code")
        with self.assertRaisesRegex(ValueError, "unknown target"):
            self.verify(pin)
        unknown.unlink()
        (self.runtime / "empty-unknown").mkdir()
        with self.assertRaisesRegex(ValueError, "unknown target"):
            self.verify(pin)

    def test_extracted_hardlinks_and_reparse_points_are_rejected(self):
        pin = self.wheel()
        source = self.runtime / "sample_pkg/data.bin"
        link = self.root / "hardlink.bin"
        os.link(source, link)
        with self.assertRaisesRegex(ValueError, "hard linked"):
            self.verify(pin)
        link.unlink()
        # Simulate Windows reparse metadata without needing symlink privileges.
        original = Path.lstat

        def reparse(path):
            info = original(path)
            if path == source:
                return types.SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400)
            return info

        with patch.object(Path, "lstat", reparse), self.assertRaisesRegex(ValueError, "reparse"):
            self.verify(pin)

    def test_verified_snapshot_rejects_same_size_edit_with_restored_mtime(self):
        pin = self.wheel()
        snapshot = self.verify(pin)
        path = self.runtime / "sample_pkg/data.bin"
        before = path.stat()
        path.write_bytes(b"\xff" * before.st_size)
        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
        with self.assertRaisesRegex(ValueError, "verified asset"):
            VERIFIER.assert_unchanged(snapshot)

    def test_unknown_wheel_and_path_traversal_are_rejected(self):
        pin = self.wheel()
        (self.wheels / "unknown.whl").write_bytes(b"unknown")
        with self.assertRaisesRegex(ValueError, "wheelhouse"):
            self.verify(pin)
        for path in ("../escape.py", "pkg/CON.py", "pkg/file.py.", "pkg/FILE:stream", "pkg\\other.py"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                VERIFIER.safe_parts(path)

    def test_model_hash_size_and_post_verification_tamper_are_rejected(self):
        pin = self.model_pin()
        root, snapshot = SIDECAR.verify_model_tree(VERIFIER, self.model, [pin])
        self.assertEqual(root, self.model)
        VERIFIER.assert_unchanged(snapshot)
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            SIDECAR.verify_model_tree(VERIFIER, self.model, [{**pin, "sha256": "0" * 64}])
        with self.assertRaisesRegex(ValueError, "size mismatch"):
            SIDECAR.verify_model_tree(VERIFIER, self.model, [{**pin, "size": pin["size"] + 1}])
        (self.model / "model.bin").write_bytes(b"tampered-model")
        with self.assertRaisesRegex(ValueError, "verified asset"):
            VERIFIER.assert_unchanged(snapshot)

    def test_unknown_model_code_and_duplicate_manifest_are_rejected(self):
        pin = self.model_pin()
        with self.assertRaisesRegex(ValueError, "collision"):
            SIDECAR.verify_model_tree(VERIFIER, self.model, [pin, pin])
        (self.model / "unverified_model.py").write_bytes(b"must never run")
        with self.assertRaisesRegex(ValueError, "unknown model"):
            SIDECAR.verify_model_tree(VERIFIER, self.model, [pin])

    def test_text_assets_are_verified_before_session_and_snapshots_reject_tampering(self):
        root = self.root / "manga-c94f4a20"
        (root / "rec").mkdir(parents=True)
        rec_path, dict_path = root / "rec/manga_rec_v0.2.onnx", root / "ppocrv6_dict.txt"
        rec_path.write_bytes(b"synthetic-ctc-model")
        dict_path.write_bytes("字\nあ\n".encode())
        rec_pin = {"path": "rec/manga_rec_v0.2.onnx", "size": rec_path.stat().st_size,
                   "sha256": hashlib.sha256(rec_path.read_bytes()).hexdigest()}
        dict_pin = {"path": "ppocrv6_dict.txt", "size": dict_path.stat().st_size,
                    "sha256": hashlib.sha256(dict_path.read_bytes()).hexdigest()}
        detector_path = self.model / "manga_det_v0.2.onnx"
        detector_path.write_bytes(b"synthetic-detector")
        real_verify = SIDECAR.verify_model_file
        events = []

        def verify(verifier, path, pin):
            events.append(path.name)
            if path == detector_path:
                pin = {"size": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            return real_verify(verifier, path, pin)

        def fake_model(*args):
            self.assertIn("manga_rec_v0.2.onnx", events)
            self.assertIn("ppocrv6_dict.txt", events)
            events.append("session")
            return types.SimpleNamespace(assert_ready=lambda: None)

        model_id, revision, digest, _ = SIDECAR.IDENTITIES["manga-detection"]
        config = {"profile": "manga-detection", "modelId": model_id, "revision": revision,
                  "modelPath": str(detector_path), "modelFile": {"size": 1816954, "sha256": digest},
                  "textEvidence": {"ruleVersion": 1, "component": "rec", "modelId": model_id, "revision": revision,
                                   "modelRoot": str(root), "modelFile": rec_pin, "dictionaryFile": dict_pin}}
        with patch.object(SIDECAR, "load_local", return_value=TEXT_EVIDENCE), \
             patch.object(TEXT_EVIDENCE, "REC_PIN", rec_pin), patch.object(TEXT_EVIDENCE, "DICT_PIN", dict_pin), \
             patch.object(SIDECAR, "verify_model_file", side_effect=verify), \
             patch.object(SIDECAR, "signed_detector_runtime", lambda *args: None), \
             patch.object(SIDECAR, "MangaDetector", side_effect=fake_model), \
             patch.object(TEXT_EVIDENCE, "MangaTextVerifier", side_effect=fake_model):
            def fresh():
                sidecar = object.__new__(SIDECAR.Sidecar)
                sidecar.verifier = VERIFIER
                sidecar.pack_root = "unused"
                sidecar.configuration = None
                return sidecar

            sidecar = fresh()
            sidecar.initialize(config)
            self.assertEqual(sidecar.identity["recSha256"], rec_pin["sha256"])
            self.assertEqual(sidecar.identity["dictSha256"], dict_pin["sha256"])
            self.assertEqual(sidecar.identity["ruleVersion"], 1)
            sidecar.handle({"protocolVersion": 1, "operation": "probe", "configuration": config})
            for pin_key in ("modelFile", "dictionaryFile"):
                invalid = {**config, "textEvidence": {**config["textEvidence"], pin_key: {**config["textEvidence"][pin_key], "sha256": "0" * 64}}}
                with self.subTest(pin_key=pin_key), self.assertRaisesRegex(ValueError, "evidence pin"):
                    fresh().initialize(invalid)
            for path in (rec_path, dict_path):
                original = Path.lstat

                def reparse(candidate):
                    info = original(candidate)
                    return types.SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400) if candidate == path else info

                with self.subTest(reparse=path.name), patch.object(Path, "lstat", reparse), self.assertRaisesRegex(ValueError, "reparse"):
                    fresh().initialize(config)
            for path in (rec_path, dict_path):
                content = path.read_bytes()
                path.write_bytes(b"x" * len(content))
                with self.subTest(path=path.name), self.assertRaisesRegex(ValueError, "verified asset"):
                    sidecar.handle({"protocolVersion": 1, "operation": "probe", "configuration": config})
                with self.assertRaisesRegex(ValueError, "hash mismatch"):
                    fresh().initialize(config)
                path.write_bytes(content)
                path.unlink()
                with self.assertRaises(FileNotFoundError):
                    fresh().initialize(config)
                path.write_bytes(content)
            # Fresh replacement workers must hash both files again.
            fresh().initialize(config)
            self.assertGreaterEqual(events.count("ppocrv6_dict.txt"), 3)


class HayaiBoundaryTests(unittest.TestCase):
    def info(self):
        return {"missing_keys": [], "unexpected_keys": ["decoder.ids_head.weight", "decoder.ids_norm.weight"],
                "mismatched_keys": [], "error_msgs": []}

    def metadata(self):
        return {"decoder.ids_head.weight": {"shape": [226, 512], "dtype": "F32"},
                "decoder.ids_norm.weight": {"shape": [512], "dtype": "F32"}}

    def test_only_exact_two_unused_training_tensors_are_allowed(self):
        RECOGNITION.validate_hayai_loading_info(self.info(), self.metadata())
        for key in ("missing_keys", "mismatched_keys", "error_msgs", "unexpected_keys"):
            info = self.info()
            info[key].append("unreviewed.weight")
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                RECOGNITION.validate_hayai_loading_info(info, self.metadata())
        for extras in ([], ["decoder.ids_head.weight"], ["decoder.ids_head.weight"] * 2):
            with self.subTest(extras=extras), self.assertRaises(RuntimeError):
                RECOGNITION.validate_hayai_loading_info({**self.info(), "unexpected_keys": extras}, self.metadata())

    def test_training_shapes_and_dtype_must_match(self):
        for key in self.metadata():
            for tensor in ({"shape": [225, 512], "dtype": "F32"}, {"shape": [512], "dtype": "F16"}, None):
                metadata = {**self.metadata(), key: tensor}
                with self.subTest(key=key, tensor=tensor), self.assertRaises(RuntimeError):
                    RECOGNITION.validate_hayai_loading_info(self.info(), metadata)

    def test_max_length_or_no_decode_is_incomplete(self):
        tokenizer = types.SimpleNamespace(decode=lambda ids, **kwargs: "字" * len(ids))
        tracking = RECOGNITION.CompletionTrackingTokenizer(tokenizer, 4)
        self.assertFalse(tracking.complete)
        tracking.decode([1, 2, 3, 4])
        self.assertFalse(tracking.complete)
        tracking.decode([1, 2, 3])
        self.assertTrue(tracking.complete)

    def test_each_fresh_runtime_verifies_before_any_package_import(self):
        calls = []

        def reject(*args):
            calls.append(args)
            raise ValueError("synthetic runtime hash mismatch")

        verifier = types.SimpleNamespace(verify_runtime=reject)
        imports = []
        original_import = __import__

        def observe(name, *args, **kwargs):
            if name.split(".")[0] in ("torch", "transformers", "numpy", "PIL", "tokenizers", "safetensors"):
                imports.append(name)
                raise AssertionError("Unverified model import")
            return original_import(name, *args, **kwargs)

        with patch.object(RECOGNITION, "import_local_module", return_value=verifier), patch("builtins.__import__", side_effect=observe):
            for _ in range(2):
                with self.assertRaisesRegex(ValueError, "runtime hash mismatch"):
                    RECOGNITION.isolated_hayai_runtime({"wheelRoot": "unused", "runtimeRoot": "unused", "runtimeFiles": []})
        self.assertEqual(len(calls), 2)
        self.assertEqual(imports, [])


class SidecarProtocolTests(unittest.TestCase):
    def sidecar(self):
        sidecar = object.__new__(SIDECAR.Sidecar)
        sidecar.pack_root = "unused"
        sidecar.configuration = None
        sidecar.snapshot = {}
        sidecar.verifier = types.SimpleNamespace(assert_unchanged=lambda snapshot: None)
        return sidecar

    def test_every_new_process_initializes_and_probes_before_first_actual_request(self):
        for operation, profile in (("detect", "manga-detection"), ("recognize", "hayai"), ("verify-text", "manga-detection")):
            events = []
            config = {"profile": profile}

            def initialize(sidecar, value):
                events.append("verify/init/probe")
                sidecar.configuration = value
                sidecar.identity = {"modelId": "verified-fake"}
                sidecar.model = types.SimpleNamespace(assert_ready=lambda: events.append("ready"),
                    detect=lambda image: events.append("detect") or {"detections": [], "complete": True},
                    recognize=lambda image: events.append("recognize") or {"text": "字", "complete": True})
                sidecar.text_verifier = types.SimpleNamespace(assert_ready=lambda: None,
                    verify=lambda *args: events.append("verify-text") or {"accepted": False, "complete": True})

            with patch.object(SIDECAR.Sidecar, "initialize", initialize), patch.object(SIDECAR, "decode_image", return_value="synthetic"), \
                 patch.object(SIDECAR, "decode_image_bytes", return_value=b"synthetic"):
                for _ in range(2):
                    sidecar = self.sidecar()
                    result = sidecar.handle({"protocolVersion": 1, "operation": operation, "configuration": config})
                    self.assertEqual(result["modelId"], "verified-fake")
                self.assertEqual(events, ["verify/init/probe", "ready", operation] * 2)
                with self.assertRaisesRegex(ValueError, "configuration changed"):
                    sidecar.handle({"protocolVersion": 1, "operation": operation, "configuration": {**config, "extra": "changed"}})

    def test_wrong_profile_identity_or_pin_fails_before_model_initialization(self):
        sidecar = self.sidecar()
        for config in (None, {"profile": "baberu"}, {"profile": "hayai", "modelId": "other"},
                       {"profile": "manga-detection", "modelId": SIDECAR.IDENTITIES["manga-detection"][0],
                        "revision": SIDECAR.IDENTITIES["manga-detection"][1], "modelFile": {"size": 1816954, "sha256": "0" * 64}}):
            with self.subTest(config=config), self.assertRaises(ValueError):
                sidecar.initialize(config)
            self.assertIsNone(sidecar.configuration)

    def test_protocol_version_must_be_integer_one_before_initialization(self):
        for version in (True, 1.0, "1", None, 2):
            sidecar = self.sidecar()
            with self.subTest(version=version), self.assertRaisesRegex(ValueError, "protocol"):
                sidecar.handle({"protocolVersion": version, "configuration": {"profile": "manga-detection"}})
            self.assertIsNone(sidecar.configuration)

    def test_gate_forwards_original_geometry_and_checks_snapshot_after_inference(self):
        sidecar = self.sidecar()
        sidecar.configuration = {"profile": "manga-detection"}
        sidecar.identity = {"modelId": "verified-fake"}
        events = []
        sidecar.verifier.assert_unchanged = lambda snapshot: events.append("snapshot")
        sidecar.model = types.SimpleNamespace(assert_ready=lambda: events.append("detector-ready"))
        quad = [{"x": 120, "y": 220}] * 4
        bbox = {"x": 100, "y": 200, "width": 100, "height": 100}

        def verify(data, candidate_id, source_quad, crop_bbox):
            self.assertEqual((data, candidate_id, source_quad, crop_bbox), (b"synthetic", "candidate", quad, bbox))
            events.append("verify")
            return {"accepted": False, "complete": True}

        sidecar.text_verifier = types.SimpleNamespace(assert_ready=lambda: events.append("ctc-ready"), verify=verify)
        request = {"protocolVersion": 1, "operation": "verify-text", "configuration": sidecar.configuration,
                   "candidateId": "candidate", "sourceQuadPx": quad, "cropBboxPx": bbox}
        with patch.object(SIDECAR, "decode_image_bytes", return_value=b"synthetic"):
            self.assertFalse(sidecar.handle(request)["accepted"])
            self.assertEqual(events, ["snapshot", "detector-ready", "ctc-ready", "verify", "snapshot"])
            checks = iter((None, ValueError("verified asset changed")))

            def check(snapshot):
                error = next(checks)
                if error:
                    raise error

            sidecar.verifier.assert_unchanged = check
            with self.assertRaisesRegex(ValueError, "verified asset"):
                sidecar.handle(request)

    def test_failed_init_never_publishes_ready_configuration(self):
        sidecar = self.sidecar()
        model_id, revision, digest, _ = SIDECAR.IDENTITIES["hayai"]
        config = {"profile": "hayai", "modelId": model_id, "revision": revision, "modelRoot": "unused",
                  "modelFiles": [{"path": "model.safetensors", "sha256": digest, "size": 627709088}]}
        with patch.object(SIDECAR, "verify_model_tree", return_value=(Path("unused"), {})), \
             patch.object(SIDECAR, "load_local", return_value=types.SimpleNamespace(Hayai=lambda *args: (_ for _ in ()).throw(RuntimeError("init failed")))):
            with self.assertRaisesRegex(RuntimeError, "init failed"):
                sidecar.initialize(config)
        self.assertIsNone(sidecar.configuration)

    def test_stdout_contains_only_ndjson_even_when_model_prints(self):
        class FakeSidecar:
            def __init__(self, root):
                print("fake initialization noise")

            def handle(self, request):
                print("fake model noise")
                return {"operation": request["operation"], "protocolVersion": 1, "text": "こんにちは", "complete": True}

        request = {"requestId": "synthetic-1", "operation": "recognize", "protocolVersion": 1}
        output = io.StringIO()
        stderr = io.StringIO()
        with patch.object(SIDECAR, "Sidecar", FakeSidecar), contextlib.redirect_stderr(stderr):
            code = SIDECAR.serve("unused", io.BytesIO((json.dumps(request) + "\n").encode()), output)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue()), {**request, "text": "こんにちは", "complete": True})
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertIn("fake initialization noise", stderr.getvalue())
        self.assertIn("fake model noise", stderr.getvalue())

    def test_malformed_request_and_private_exception_do_not_echo_payloads(self):
        fake = types.SimpleNamespace(handle=lambda request: (_ for _ in ()).throw(ValueError("private-path-and-image")))
        cases = [b"[]\n", b"{bad json}\n", b'{"requestId":"synthetic-1"}\n']
        for raw in cases:
            output = io.StringIO()
            stderr = io.StringIO()
            with self.subTest(raw=raw), patch.object(SIDECAR, "Sidecar", return_value=fake), contextlib.redirect_stderr(stderr):
                self.assertEqual(SIDECAR.serve("unused", io.BytesIO(raw), output), 1)
                response = json.loads(output.getvalue())
                self.assertEqual(response["operation"], "error")
                self.assertNotIn("private-path-and-image", output.getvalue() + stderr.getvalue())


class SignedDetectorImportTests(unittest.TestCase):
    def test_only_signed_legacy_or_standard_library_origins_are_accepted(self):
        # Fake package objects exercise path selection/origin checks without ORT,
        # cv2, NumPy, Pillow, Torch, or any real model being loaded.
        for layout in ("lib", "runtime/lib", "runtime/Lib/site-packages"):
            with self.subTest(layout=layout), tempfile.TemporaryDirectory(prefix="trio-signed-import-unit-") as temporary:
                pack = Path(temporary) / "signed-pack"
                base = pack / "runtime"
                libraries = pack.joinpath(*layout.split("/"))
                base.mkdir(parents=True)
                libraries.mkdir(parents=True, exist_ok=True)
                module_file = libraries / "synthetic_module.py"
                module_file.write_bytes(b"must never execute")
                external_file = Path(temporary) / "untrusted.py"
                external_file.write_bytes(b"must never execute")
                roots = {name: types.SimpleNamespace(__file__=str(module_file))
                         for name in ("numpy", "onnxruntime", "cv2", "pyclipper", "PIL")}
                roots["numpy"]._core = types.SimpleNamespace(_multiarray_umath=types.SimpleNamespace(__file__=str(module_file)))
                roots["onnxruntime"].capi = types.SimpleNamespace(onnxruntime_pybind11_state=types.SimpleNamespace(__file__=str(module_file)))
                roots["pyclipper"]._pyclipper = types.SimpleNamespace(__file__=str(module_file))
                roots["PIL"].Image = types.SimpleNamespace(__file__=str(module_file))
                roots["PIL"]._imaging = types.SimpleNamespace(__file__=str(module_file))
                original_import = __import__

                def fake_import(name, *args, **kwargs):
                    if name.split(".")[0] in roots:
                        return roots[name.split(".")[0]]
                    return original_import(name, *args, **kwargs)

                with patch.object(sys, "executable", str(base / "python.exe")), patch.object(sys, "path", list(sys.path)), \
                     patch("builtins.__import__", side_effect=fake_import):
                    SIDECAR.signed_detector_runtime(pack, VERIFIER)
                    self.assertIn(str(libraries), sys.path)
                    roots["cv2"].__file__ = str(external_file)
                    with self.assertRaisesRegex(ValueError, "module origin"):
                        SIDECAR.signed_detector_runtime(pack, VERIFIER)


class TextEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Ordinary CPU array/Pillow work on generated pixels only. Never import
        # onnxruntime or construct a real session; the inference boundary is fake.
        with patch.object(sys, "path", TEST_IMPORT_PATH):
            import numpy as np
            from PIL import Image
        cls.np, cls.Image = np, Image

    def setUp(self):
        self.vocab = [""] + list(dict.fromkeys("霊体復元あいカア文字𠮷うえabcdeXYＡ\ufeff")) + [" "]
        self.quad = [{"x": 120, "y": 220}, {"x": 140, "y": 220}, {"x": 140, "y": 280}, {"x": 120, "y": 280}]
        self.bbox = {"x": 100, "y": 200, "width": 100, "height": 100}
        data = io.BytesIO()
        self.Image.new("RGB", (100, 100), "white").save(data, format="PNG")
        self.png = data.getvalue()

    def probabilities(self, text, score):
        ids = [self.vocab.index(char) for char in text] or [0]
        rows = []
        for index in ids:
            row = self.np.full(len(self.vocab), (1 - score) / (len(self.vocab) - 1), dtype=self.np.float32)
            row[index] = score
            rows.append(row)
        return self.np.array([rows])

    def verifier(self, texts=("復元", "復元"), means=(0.9, 0.9)):
        value = object.__new__(TEXT_EVIDENCE.MangaTextVerifier)
        value.vocab, value.input = self.vocab, "fake-input"
        outputs = iter(self.probabilities(text, mean) for text, mean in zip(texts, means))
        self.tensors = []

        def run(_, inputs):
            self.tensors.append(inputs["fake-input"].copy())
            return [next(outputs)]

        value.session = types.SimpleNamespace(run=run)
        return value

    def verify(self, texts=("復元", "復元"), means=(0.9, 0.9)):
        return self.verifier(texts, means).verify(self.png, "synthetic-candidate", self.quad, self.bbox)

    def test_five_observed_shapes_and_unicode_prefix_and_threshold_boundaries(self):
        cases = [(('霊体復元あ', '霊体復元い'), (.909, .808), True, 4/5, "accepted"),
                 (('霊', '霊'), (.979, .926), True, 1, "accepted"),
                 (('復元あ', '復元い'), (.778, .605), True, 2/3, "accepted"),
                 (('カ', 'ア'), (.249, .411), False, 0, "low-mean"),
                 (('文字', ''), (.9, .99), False, 0, "empty-decode"),
                 (('𠮷あい', '𠮷うえ'), (.9, .9), False, 1/3, "unstable-prefix"),
                 (('abcde', 'abcXY'), (.6, .6), True, .6, "accepted"),
                 (('abcde', 'XXabcde'), (.9, .9), False, 0, "unstable-prefix"),
                 (('字', '字'), (.6, .59999), False, 1, "low-mean")]
        for texts, means, accepted, ratio, reason in cases:
            with self.subTest(texts=texts, means=means):
                result = self.verify(texts, means)
                self.assertEqual((result["accepted"], result["commonPrefixRatio"], result["reason"]), (accepted, ratio, reason))
                self.assertEqual([item["padding"] for item in result["inputs"]], [.08, .5])
                self.assertEqual(result["sourceQuadPx"], self.quad)
                self.assertEqual(result["cropBboxPx"], self.bbox)
                self.assertEqual(result["inputContextPngSha256"], hashlib.sha256(self.png).hexdigest())
                self.assertEqual([item["rectifiedSize"] for item in result["inputs"]], [{"width": 23, "height": 63}, {"width": 23, "height": 80}])
                self.assertEqual([(item["rotation"], item["width"], item["height"]) for item in result["inputs"]], [(90, 131, 48), (90, 167, 48)])
                for item, tensor in zip(result["inputs"], self.tensors):
                    self.assertEqual(item["tensorSha256"], hashlib.sha256(tensor.tobytes(order="C")).hexdigest())
                    self.assertRegex(item["inputPngSha256"], r"^[a-f0-9]{64}$")

    def test_first_timestep_repeats_and_blank_reset_and_nfkc_trim(self):
        a = self.probabilities("Ａ", .7)[0, 0]
        repeated = self.probabilities("Ａ", .99)[0, 0]
        blank = self.np.zeros(len(self.vocab), self.np.float32)
        blank[0] = 1
        output = self.np.array([[a, repeated, blank, a]])
        result = TEXT_EVIDENCE.decode_probabilities(output, self.vocab)
        self.assertEqual(result["text"], "AA")
        self.assertAlmostEqual(result["mean"], .7, places=6)
        self.assertEqual(self.verify((" Ａ ", "Ａ"))["inputs"][0]["text"], "A")
        self.assertEqual(self.verify(("\ufeffＡ\ufeff", "Ａ"))["inputs"][0]["text"], "A")

    def test_invalid_probability_tensors_raise_instead_of_false(self):
        valid = self.probabilities("字", .9)
        cases = [valid[0], valid[:, :0], self.np.repeat(valid, 2, axis=0), valid[:, :, :-1], valid.astype(self.np.int32),
                 valid.astype(self.np.float16), valid.astype(self.np.float64),
                 self.np.full_like(valid, self.np.nan), self.np.full_like(valid, self.np.inf),
                 self.np.full_like(valid, -0.01), self.np.full_like(valid, 1.01), valid * .5]
        for output in cases:
            with self.subTest(shape=output.shape), self.assertRaises(ValueError):
                TEXT_EVIDENCE.decode_probabilities(output, self.vocab)
        value = self.verifier()
        value.session = types.SimpleNamespace(run=lambda *args: [])
        with self.assertRaisesRegex(ValueError, "output count"):
            value.verify(self.png, "synthetic", self.quad, self.bbox)

    def test_crop_dimensions_and_finite_inside_ordered_quad_are_mandatory(self):
        cases = [(self.quad, {**self.bbox, "width": 99}),
                 (self.quad, {**self.bbox, "x": 100.5}),
                 ([{**self.quad[0], "x": float('nan')}] + self.quad[1:], self.bbox),
                 ([{**self.quad[0], "x": 99}] + self.quad[1:], self.bbox),
                 ([self.quad[0]] * 4, self.bbox), (self.quad[::-1], self.bbox),
                 ([self.quad[i] for i in (0, 2, 1, 3)], self.bbox)]
        for quad, bbox in cases:
            with self.subTest(quad=quad, bbox=bbox), self.assertRaises(ValueError):
                self.verifier().verify(self.png, "synthetic", quad, bbox)
        for candidate in ("", "x" * 257, "private\nidentity", "\ud800"):
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                self.verifier().verify(self.png, candidate, self.quad, self.bbox)

    def test_rectification_samples_surrounding_pixels_and_only_outside_is_white(self):
        image = self.Image.new("RGB", (20, 20), "red")
        points = [(0, 0), (4, 0), (4, 12), (0, 12)]
        crop = TEXT_EVIDENCE.rectify(image, points, .5)
        pixels = set(map(tuple, self.np.asarray(crop).reshape(-1, 3)))
        self.assertIn((255, 255, 255), pixels)
        self.assertIn((255, 0, 0), pixels)
        # A shifted context represents the same original quad in local pixels.
        local = TEXT_EVIDENCE.validate_geometry(self.quad, self.bbox)
        self.assertEqual(local, [(20, 20), (40, 20), (40, 80), (20, 80)])

    def test_ccw_rotation_bgr_norm_png_and_tensor_hashes_and_official_width_caps(self):
        image = self.Image.new("RGB", (3, 9), "blue")
        for x in range(3):
            for y in range(3):
                image.putpixel((x, y), (255, 0, 0))
        tensor, evidence = TEXT_EVIDENCE.model_input(image)
        self.assertEqual(evidence["rotation"], 90)
        self.np.testing.assert_array_equal(tensor[0, :, 24, 0], [-1, -1, 1])
        self.np.testing.assert_array_equal(tensor[0, :, 24, -1], [1, -1, -1])
        png = io.BytesIO()
        image.transpose(self.Image.Transpose.ROTATE_90).resize((144, 48), self.Image.Resampling.BILINEAR).save(png, format="PNG")
        self.assertEqual(evidence["inputPngSha256"], hashlib.sha256(png.getvalue()).hexdigest())
        for size, width in (((200, 10), 640), ((500, 10), 2400), ((1, 1), 48)):
            with self.subTest(size=size):
                tensor, evidence = TEXT_EVIDENCE.model_input(self.Image.new("RGB", size, "white"))
                self.assertEqual(tensor.shape, (1, 3, 48, width))
                self.assertEqual(evidence["width"], width)

    def test_cpu_and_model_metadata_are_checked_without_running_a_model(self):
        value = self.verifier()
        node = lambda shape, kind="tensor(float)": types.SimpleNamespace(shape=shape, type=kind, name="fake")
        inputs, outputs = [node([1, 3, 48, "width"])], [node([1, "steps", len(self.vocab)])]
        providers = ["CPUExecutionProvider"]
        value.session = types.SimpleNamespace(get_providers=lambda: providers, get_inputs=lambda: inputs, get_outputs=lambda: outputs)
        value.assert_ready()
        for shape in ([1, 1, 48, "width"], [1, 3, 32, "width"], [2, 3, 48, "width"], [1, 3, 48, -1]):
            inputs[0] = node(shape)
            with self.subTest(shape=shape), self.assertRaises(ValueError):
                value.assert_ready()
        inputs[0] = node([1, 3, 48, "width"])
        outputs[0] = node([1, "steps", len(self.vocab) - 1])
        with self.assertRaises(ValueError):
            value.assert_ready()
        outputs[0] = node([1, "steps", len(self.vocab)])
        providers.append("CUDAExecutionProvider")
        with self.assertRaises(ValueError):
            value.assert_ready()

    def test_constructor_uses_only_fixed_cpu_ort_and_dictionary_without_inference(self):
        calls = []
        node = lambda shape: types.SimpleNamespace(name="fake-input", type="tensor(float)", shape=shape)
        session = types.SimpleNamespace(get_providers=lambda: ["CPUExecutionProvider"],
            get_inputs=lambda: [node([1, 3, 48, "width"])], get_outputs=lambda: [node([1, "steps", 4])])
        options = types.SimpleNamespace()

        def create_session(path, session_options, providers):
            calls.append((path, providers, session_options.intra_op_num_threads, session_options.inter_op_num_threads))
            return session

        fake_ort = types.SimpleNamespace(SessionOptions=lambda: options, InferenceSession=create_session)
        with tempfile.TemporaryDirectory(prefix="trio-fake-ctc-constructor-") as temporary, patch.dict(sys.modules, {"onnxruntime": fake_ort}):
            root = Path(temporary)
            (root / "dictionary.txt").write_text("字\nあ\n", encoding="utf-8")
            model = TEXT_EVIDENCE.MangaTextVerifier(root / "not-a-model.onnx", root / "dictionary.txt")
            self.assertEqual(model.vocab, ["", "字", "あ", " "])
            self.assertEqual(calls, [(str(root / "not-a-model.onnx"), ["CPUExecutionProvider"], 4, 1)])

    def test_accept_and_reject_evidence_are_both_preserved_as_clean_ndjson(self):
        for texts in (("復元", "復元"), ("復元", "")):
            result = self.verify(texts)
            fake = types.SimpleNamespace(handle=lambda request: {**result, "operation": "verify-text", "protocolVersion": 1})
            request = {"requestId": "synthetic-gate", "operation": "verify-text", "protocolVersion": 1}
            output = io.StringIO()
            with patch.object(SIDECAR, "Sidecar", return_value=fake):
                self.assertEqual(SIDECAR.serve("unused", io.BytesIO((json.dumps(request) + "\n").encode()), output), 0)
            evidence = json.loads(output.getvalue())
            self.assertEqual(evidence["inputs"], result["inputs"])
            self.assertEqual(evidence["accepted"], bool(texts[1]))
            self.assertEqual(evidence["recSha256"], TEXT_EVIDENCE.REC_PIN["sha256"])
            self.assertEqual(evidence["dictSha256"], TEXT_EVIDENCE.DICT_PIN["sha256"])
            self.assertEqual(evidence["ruleVersion"], 1)
            self.assertEqual(len(output.getvalue().splitlines()), 1)


if __name__ == "__main__":
    unittest.main()
