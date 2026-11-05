"""SimpleNamespace 메타데이터만으로 CUDA 세션 검증 함수를 검사한다.

실행: python -B -m unittest discover -s tests/python -p test_lama_cuda.py -v
실제 onnxruntime, 모델, GPU, 네트워크는 사용하지 않는다.
worker SHA, 픽셀 유한성·마스크 밖 보존과 GPU 추론 성공은 검증하지 않는다.
"""

import importlib.util
from itertools import product
from pathlib import Path
from types import SimpleNamespace
import unittest


MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "local-preview" / "lama_cuda.py"
SPEC = importlib.util.spec_from_file_location("test_local_lama_cuda", MODULE_PATH)
CUDA = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CUDA)


def metadata(name, channels, batch=1):
    return SimpleNamespace(name=name, type="tensor(float)", shape=[batch, channels, 512, 512])


def session(*, providers=None, inputs=None, outputs=None):
    if providers is None:
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    if inputs is None:
        inputs = [metadata("image", 3), metadata("mask", 1)]
    if outputs is None:
        outputs = [metadata("output", 3)]
    return SimpleNamespace(
        get_providers=lambda: providers,
        get_inputs=lambda: inputs,
        get_outputs=lambda: outputs,
    )


class CudaSessionMetadataTests(unittest.TestCase):
    def test_accepts_cuda_cpu_fp32_512_metadata(self):
        CUDA.validate_cuda_session(session())

    def test_accepts_symbolic_batch_for_both_inputs_and_output(self):
        CUDA.validate_cuda_session(session(
            inputs=[metadata("image", 3, "batch"), metadata("mask", 1, "batch")],
            outputs=[metadata("output", 3, "batch")],
        ))

    def test_accepts_mixed_fixed_and_symbolic_batch_metadata(self):
        for image_batch, mask_batch, output_batch in product((1, "batch"), repeat=3):
            if image_batch == mask_batch == output_batch:
                continue  # 모두 고정이거나 모두 동적인 경우는 위 테스트에서 확인한다.
            with self.subTest(image=image_batch, mask=mask_batch, output=output_batch):
                CUDA.validate_cuda_session(session(
                    inputs=[metadata("image", 3, image_batch), metadata("mask", 1, mask_batch)],
                    outputs=[metadata("output", 3, output_batch)],
                ))

    def test_accepts_inputs_in_either_order(self):
        CUDA.validate_cuda_session(session(inputs=[metadata("mask", 1), metadata("image", 3)]))

    def test_rejects_cpu_only_fallback(self):
        with self.assertRaisesRegex(ValueError, "^INVALID_CUDA_PROVIDER$"):
            CUDA.validate_cuda_session(session(providers=["CPUExecutionProvider"]))

    def test_rejects_missing_reordered_extra_and_other_providers(self):
        for providers in (
            [],
            ["CUDAExecutionProvider"],
            ["CPUExecutionProvider", "CUDAExecutionProvider"],
            ["DmlExecutionProvider", "CPUExecutionProvider"],
            ["TensorrtExecutionProvider", "CPUExecutionProvider"],
            ["CUDAExecutionProvider", "DmlExecutionProvider"],
            ["CUDAExecutionProvider", "CPUExecutionProvider", "DmlExecutionProvider"],
            ["CUDAExecutionProvider", "CPUExecutionProvider", "CPUExecutionProvider"],
        ):
            with self.subTest(providers=providers):
                with self.assertRaisesRegex(ValueError, "^INVALID_CUDA_PROVIDER$"):
                    CUDA.validate_cuda_session(session(providers=providers))

    def test_rejects_wrong_input_cardinality(self):
        for names in ((), ("image",), ("mask",), ("image", "mask", "extra")):
            with self.subTest(names=names):
                inputs = [metadata(name, 1 if name == "mask" else 3) for name in names]
                with self.assertRaisesRegex(ValueError, "^INVALID_INPUT_METADATA$"):
                    CUDA.validate_cuda_session(session(inputs=inputs))

    def test_rejects_unknown_or_case_changed_input_names(self):
        for index, name in product(range(2), ("", "extra", "Image", "Mask")):
            with self.subTest(index=index, name=name):
                candidate = session()
                candidate.get_inputs()[index].name = name
                with self.assertRaisesRegex(ValueError, "^INVALID_INPUT_METADATA$"):
                    CUDA.validate_cuda_session(candidate)

    def test_rejects_duplicate_input_names(self):
        for name, channels in (("image", 3), ("mask", 1)):
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, "^INVALID_INPUT_METADATA$"):
                    CUDA.validate_cuda_session(session(inputs=[metadata(name, channels), metadata(name, channels)]))

    def test_rejects_non_fp32_input_dtypes(self):
        for index, dtype in product(range(2), ("tensor(float16)", "tensor(double)", "tensor(uint8)", "float32")):
            with self.subTest(index=index, dtype=dtype):
                candidate = session()
                candidate.get_inputs()[index].type = dtype
                with self.assertRaisesRegex(ValueError, "^INVALID_INPUT_METADATA$"):
                    CUDA.validate_cuda_session(candidate)

    def test_rejects_invalid_input_batches(self):
        for index, batch in product(range(2), (0, 2, -1, None, "N", "1", "")):
            with self.subTest(index=index, batch=batch):
                candidate = session()
                candidate.get_inputs()[index].shape[0] = batch
                with self.assertRaisesRegex(ValueError, "^INVALID_INPUT_METADATA$"):
                    CUDA.validate_cuda_session(candidate)

    def test_rejects_wrong_input_rank(self):
        for index, shape in product(range(2), ([], [3, 512, 512], [1, 3, 512, 512, 1])):
            with self.subTest(index=index, shape=shape):
                candidate = session()
                candidate.get_inputs()[index].shape = shape
                with self.assertRaisesRegex(ValueError, "^INVALID_INPUT_METADATA$"):
                    CUDA.validate_cuda_session(candidate)

    def test_rejects_wrong_input_channels_or_layout(self):
        for index, shape in (
            (0, [1, 1, 512, 512]), (0, [1, 4, 512, 512]),
            (1, [1, 3, 512, 512]), (1, [1, 4, 512, 512]),
            (0, [1, 512, 512, 3]), (1, [1, 512, 512, 1]),
        ):
            with self.subTest(index=index, shape=shape):
                candidate = session()
                candidate.get_inputs()[index].shape = shape
                with self.assertRaisesRegex(ValueError, "^INVALID_INPUT_METADATA$"):
                    CUDA.validate_cuda_session(candidate)

    def test_rejects_wrong_or_dynamic_input_spatial_dimensions(self):
        for index, axis, size in product(range(2), (2, 3), (0, 256, 513, None, "size")):
            with self.subTest(index=index, axis=axis, size=size):
                candidate = session()
                candidate.get_inputs()[index].shape[axis] = size
                with self.assertRaisesRegex(ValueError, "^INVALID_INPUT_METADATA$"):
                    CUDA.validate_cuda_session(candidate)

    def test_rejects_wrong_output_cardinality(self):
        for outputs in ([], [metadata("output", 3), metadata("extra", 3)]):
            with self.subTest(count=len(outputs)):
                with self.assertRaisesRegex(ValueError, "^INVALID_OUTPUT_METADATA$"):
                    CUDA.validate_cuda_session(session(outputs=outputs))

    def test_rejects_wrong_output_name(self):
        for name in ("", "image", "Output", "other"):
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, "^INVALID_OUTPUT_METADATA$"):
                    CUDA.validate_cuda_session(session(outputs=[metadata(name, 3)]))

    def test_rejects_non_fp32_output_dtypes(self):
        for dtype in ("tensor(float16)", "tensor(double)", "tensor(uint8)", "float32"):
            with self.subTest(dtype=dtype):
                candidate = session()
                candidate.get_outputs()[0].type = dtype
                with self.assertRaisesRegex(ValueError, "^INVALID_OUTPUT_METADATA$"):
                    CUDA.validate_cuda_session(candidate)

    def test_rejects_invalid_output_batches(self):
        for batch in (0, 2, -1, None, "N", "1", ""):
            with self.subTest(batch=batch):
                with self.assertRaisesRegex(ValueError, "^INVALID_OUTPUT_METADATA$"):
                    CUDA.validate_cuda_session(session(outputs=[metadata("output", 3, batch)]))

    def test_rejects_wrong_output_rank(self):
        for shape in ([], [3, 512, 512], [1, 3, 512, 512, 1]):
            with self.subTest(shape=shape):
                candidate = session()
                candidate.get_outputs()[0].shape = shape
                with self.assertRaisesRegex(ValueError, "^INVALID_OUTPUT_METADATA$"):
                    CUDA.validate_cuda_session(candidate)

    def test_rejects_wrong_output_channels_or_layout(self):
        for shape in ([1, 1, 512, 512], [1, 4, 512, 512], [1, 512, 512, 3]):
            with self.subTest(shape=shape):
                candidate = session()
                candidate.get_outputs()[0].shape = shape
                with self.assertRaisesRegex(ValueError, "^INVALID_OUTPUT_METADATA$"):
                    CUDA.validate_cuda_session(candidate)

    def test_rejects_wrong_or_dynamic_output_spatial_dimensions(self):
        for axis, size in product((2, 3), (0, 256, 513, None, "size")):
            with self.subTest(axis=axis, size=size):
                candidate = session()
                candidate.get_outputs()[0].shape[axis] = size
                with self.assertRaisesRegex(ValueError, "^INVALID_OUTPUT_METADATA$"):
                    CUDA.validate_cuda_session(candidate)


if __name__ == "__main__":
    unittest.main()
