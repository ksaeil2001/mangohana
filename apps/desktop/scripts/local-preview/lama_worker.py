"""설치된 LaMa 추론 코드는 보존하고 일반 마스크의 타일 분할만 선택한다."""
import argparse
import importlib.util
from pathlib import Path
import sys

import numpy as np


def compact_tiles(mask, core=448, max_tiles=64):
    if (not isinstance(mask, np.ndarray) or mask.dtype != np.bool_ or mask.ndim != 2
            or not mask.size or mask.size > 16_000_000 or not mask.any()
            or type(core) is not int or core < 1 or type(max_tiles) is not int or max_tiles < 1):
        raise ValueError('INVALID_MASK')
    height, width = mask.shape
    integral = np.zeros((height + 1, width + 1), dtype=np.int32)
    np.cumsum(mask, axis=0, dtype=np.int32, out=integral[1:, 1:])
    np.cumsum(integral[1:, 1:], axis=1, dtype=np.int32, out=integral[1:, 1:])

    def axis(length, prefix):
        boundaries = [0, *range(prefix or core, length, core), length]
        return list(zip(boundaries[:-1], boundaries[1:]))

    def tiles(x_prefix, y_prefix):
        result = []
        for top, bottom in axis(height, y_prefix):
            for left, right in axis(width, x_prefix):
                count = (int(integral[bottom, right]) - int(integral[top, right])
                         - int(integral[bottom, left]) + int(integral[top, left]))
                if count:
                    result.append((left, top, right - left, bottom - top))
        return result

    # 동점에서는 원래 격자를 유지한다. 첫·끝 core도 페이지 내부의 분할이다.
    best = tiles(0, 0)
    for x_prefix in range(0, core, max(1, core // 8)):
        for y_prefix in range(0, core, max(1, core // 8)):
            candidate = tiles(x_prefix, y_prefix)
            if len(candidate) < len(best):
                best = candidate
    if len(best) > max_tiles:
        raise ValueError('TILE_LIMIT')
    return best


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--worker', required=True, type=Path)
    parser.add_argument('--model', required=True, type=Path)
    args = parser.parse_args()
    if not args.worker.is_absolute() or not args.model.is_absolute():
        parser.error('Main 소유의 절대 경로가 필요합니다.')
    spec = importlib.util.spec_from_file_location('existing_local_lama_worker', args.worker)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    if worker.TILE != 512 or worker.HALO != 32 or worker.CORE != 448:
        raise ValueError('INCOMPATIBLE_WORKER_GEOMETRY')
    worker.plan_tiles = lambda mask: compact_tiles(mask, worker.CORE, worker.MAX_TILES)
    sys.argv = [str(args.worker), '--model', str(args.model)]
    return worker.main()


if __name__ == '__main__':
    raise SystemExit(main())
