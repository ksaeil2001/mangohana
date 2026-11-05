"""같은 LaMa FP32 모델·타일 계획의 NVIDIA 실행 비교. CPU 재시도 없음."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys


def validate_cuda_session(session):
    if session.get_providers() != ['CUDAExecutionProvider', 'CPUExecutionProvider']:
        raise ValueError('INVALID_CUDA_PROVIDER')
    expected = {'image': [3, 512, 512], 'mask': [1, 512, 512]}
    inputs = session.get_inputs()
    if len(inputs) != 2 or {item.name for item in inputs} != set(expected):
        raise ValueError('INVALID_INPUT_METADATA')
    for item in inputs:
        if (item.type != 'tensor(float)' or len(item.shape) != 4
                or item.shape[0] not in (1, 'batch') or item.shape[1:] != expected[item.name]):
            raise ValueError('INVALID_INPUT_METADATA')
    outputs = session.get_outputs()
    if (len(outputs) != 1 or outputs[0].name != 'output' or outputs[0].type != 'tensor(float)'
            or len(outputs[0].shape) != 4 or outputs[0].shape[0] not in (1, 'batch')
            or outputs[0].shape[1:] != [3, 512, 512]):
        raise ValueError('INVALID_OUTPUT_METADATA')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--worker', required=True, type=Path)
    parser.add_argument('--model', required=True, type=Path)
    parser.add_argument('--profile', action='store_true')
    args = parser.parse_args()
    if not args.worker.is_absolute() or not args.model.is_absolute():
        parser.error('Main 소유 절대 경로가 필요합니다.')
    spec = importlib.util.spec_from_file_location('unchanged_lama_for_cuda', args.worker)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    tile_spec = importlib.util.spec_from_file_location('same_compact_plan', Path(__file__).with_name('lama_worker.py'))
    tile_module = importlib.util.module_from_spec(tile_spec)
    tile_spec.loader.exec_module(tile_module)
    if worker.TILE != 512 or worker.HALO != 32 or worker.CORE != 448:
        raise ValueError('INCOMPATIBLE_WORKER_GEOMETRY')
    dll_handles = []

    def create_session(model):
        import onnxruntime as ort
        if ort.__version__ != '1.23.2' or 'CUDAExecutionProvider' not in ort.get_available_providers():
            raise ValueError('PINNED_CUDA_RUNTIME_UNAVAILABLE')
        ort.disable_telemetry_events()
        # cuDNN은 초기 DLL 외의 engine DLL도 추론 중 지연 로드한다.
        # 이 worker 프로세스의 격리 site-packages만 추가한다. 전역 PATH는 쓰지 않는다.
        nvidia_root = Path(ort.__file__).resolve().parents[1] / 'nvidia'
        bins = sorted(directory for directory in nvidia_root.glob('*/bin') if directory.is_dir())
        if not bins:
            raise ValueError('PINNED_NVIDIA_DLLS_UNAVAILABLE')
        for directory in bins:
            dll_handles.append(os.add_dll_directory(str(directory)))
        os.environ['PATH'] = os.pathsep.join([*(str(directory) for directory in bins), os.environ.get('PATH', '')])
        ort.preload_dlls(directory='')
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
        options.enable_mem_pattern = False
        options.enable_cpu_mem_arena = False
        options.log_severity_level = 4
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        options.add_session_config_entry('session.inter_op.allow_spinning', '0')
        options.enable_profiling = args.profile
        if args.profile:
            options.profile_file_prefix = str(Path(sys.executable).parent / 'lama-cuda-profile')
        session = ort.InferenceSession(model, sess_options=options, providers=[('CUDAExecutionProvider', {
            'device_id': 0, 'gpu_mem_limit': 2 * 1024 * 1024 * 1024,
            'arena_extend_strategy': 'kSameAsRequested', 'cudnn_conv_algo_search': 'HEURISTIC',
            'cudnn_conv_use_max_workspace': '0', 'use_tf32': '0',
        }), 'CPUExecutionProvider'])
        session.disable_fallback()
        validate_cuda_session(session)
        sys.stderr.write(json.dumps({'runtime': 'CUDA/CPU', 'providers': session.get_providers(), 'profiling': args.profile}) + '\n')
        return session

    actual_process = worker.process_tiles

    def process_tiles(session, *values):
        if not args.profile:
            return actual_process(session, *values)
        try:
            return actual_process(session, *values)
        finally:
            profile = Path(session.end_profiling())
            counts = {}
            for event in json.loads(profile.read_text(encoding='utf8')):
                provider = event.get('args', {}).get('provider')
                if provider:
                    counts[provider] = counts.get(provider, 0) + 1
            sys.stderr.write(json.dumps({'runtime': 'CUDA/CPU comparison', 'profile': str(profile), 'kernelEvents': counts}) + '\n')
            if not counts.get('CUDAExecutionProvider'):
                raise ValueError('CUDA_EXECUTION_NOT_PROVEN')

    worker.create_session = create_session
    worker.plan_tiles = lambda mask: tile_module.compact_tiles(mask, worker.CORE, worker.MAX_TILES)
    worker.process_tiles = process_tiles
    sys.argv = [str(args.worker), '--model', str(args.model)]
    return worker.main()


if __name__ == '__main__':
    raise SystemExit(main())
