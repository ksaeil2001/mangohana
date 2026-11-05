"""기존 worker를 바꾸지 않고 함수·타일 시간을 기록하는 로컬 진단 wrapper."""
import argparse
import importlib.util
import json
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--worker', required=True)
parser.add_argument('--model', required=True)
args = parser.parse_args()
spec = importlib.util.spec_from_file_location('profiled_existing_lama', args.worker)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
started = time.perf_counter()


def log(phase, **values):
    sys.stderr.write(json.dumps({'phase': phase, 'elapsedSeconds': time.perf_counter() - started, **values}) + '\n')
    sys.stderr.flush()


class TimedSession:
    def __init__(self, actual):
        self.actual = actual
        self.count = 0

    def run(self, *values, **options):
        self.count += 1
        began = time.perf_counter()
        log('tile-start', tile=self.count)
        result = self.actual.run(*values, **options)
        log('tile-end', tile=self.count, seconds=time.perf_counter() - began)
        return result


for name in ('read_request', 'decode_images', 'plan_tiles', 'verify_model', 'create_session', 'process_tiles', 'encode_response'):
    original = getattr(worker, name)

    def wrap(*values, _name=name, _original=original, **options):
        began = time.perf_counter()
        log(_name + '-start')
        result = _original(*values, **options)
        log(_name + '-end', seconds=time.perf_counter() - began,
            **({'tiles': len(result)} if _name == 'plan_tiles' else {}))
        return TimedSession(result) if _name == 'create_session' else result

    setattr(worker, name, wrap)

sys.argv = [args.worker, '--model', args.model]
sys.exit(worker.main())
