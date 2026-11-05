"""동일 LaMa 모델을 격리된 DirectML 환경에서 비교하는 검증 worker."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys


def validate_dml_session(session):
    if session.get_providers() != ['DmlExecutionProvider', 'CPUExecutionProvider']:
        raise ValueError('INVALID_DML_PROVIDER')
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
    args = parser.parse_args()
    if not args.worker.is_absolute() or not args.model.is_absolute():
        parser.error('Main 소유 절대 경로가 필요합니다.')
    spec = importlib.util.spec_from_file_location('unchanged_lama_for_dml', args.worker)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    tile_spec = importlib.util.spec_from_file_location('same_compact_plan', Path(__file__).with_name('lama_worker.py'))
    tile_module = importlib.util.module_from_spec(tile_spec)
    tile_spec.loader.exec_module(tile_module)
    if worker.TILE != 512 or worker.HALO != 32 or worker.CORE != 448:
        raise ValueError('INCOMPATIBLE_WORKER_GEOMETRY')

    def create_session(model):
        import onnxruntime as ort
        if 'DmlExecutionProvider' not in ort.get_available_providers():
            raise ValueError('DML_UNAVAILABLE')
        ort.disable_telemetry_events()
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
        options.enable_mem_pattern = False
        options.enable_cpu_mem_arena = False
        options.log_severity_level = 4
        options.enable_profiling = True
        options.profile_file_prefix = str(Path(sys.executable).parent / 'lama-dml-profile')
        session = ort.InferenceSession(model, sess_options=options,
            providers=[('DmlExecutionProvider', {'device_id': 0}), 'CPUExecutionProvider'])
        session.disable_fallback()
        validate_dml_session(session)
        return session

    actual_process = worker.process_tiles

    def process_tiles(session, *values):
        try:
            return actual_process(session, *values)
        finally:
            profile = Path(session.end_profiling())
            events = json.loads(profile.read_text(encoding='utf8'))
            counts = {}
            for event in events:
                provider = event.get('args', {}).get('provider')
                if provider:
                    counts[provider] = counts.get(provider, 0) + 1
            sys.stderr.write(json.dumps({'runtime': 'DirectML/CPU comparison', 'profile': str(profile), 'kernelEvents': counts}) + '\n')
            if not counts.get('DmlExecutionProvider'):
                raise ValueError('DML_EXECUTION_NOT_PROVEN')

    worker.create_session = create_session
    worker.plan_tiles = lambda mask: tile_module.compact_tiles(mask, worker.CORE, worker.MAX_TILES)
    worker.process_tiles = process_tiles
    sys.argv = [str(args.worker), '--model', str(args.model)]
    return worker.main()


if __name__ == '__main__':
    raise SystemExit(main())
