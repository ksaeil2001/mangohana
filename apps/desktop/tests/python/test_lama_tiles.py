import importlib.util
from pathlib import Path
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location('compact_lama', Path(__file__).resolve().parents[2] / 'scripts/local-preview/lama_worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class CompactTileTests(unittest.TestCase):
    def test_grid_boundary_work_is_reduced_without_dropping_pixels(self):
        mask = np.zeros((24, 24), dtype=bool)
        mask[7:9, 7:9] = True
        tiles = worker.compact_tiles(mask, core=8)
        self.assertEqual(len(tiles), 1)
        left, top, width, height = tiles[0]
        self.assertTrue(mask[top:top + height, left:left + width].sum() == 4)

    def test_ties_keep_original_grid(self):
        mask = np.ones((16, 16), dtype=bool)
        self.assertEqual(worker.compact_tiles(mask, core=8), [(0, 0, 8, 8), (8, 0, 8, 8), (0, 8, 8, 8), (8, 8, 8, 8)])

    def test_random_masks_remain_covered_once_with_bounded_nonoverlapping_cores(self):
        rng = np.random.default_rng(9421)
        for height, width in ((19, 31), (2, 9), (27, 3), (43, 53)):
            for _ in range(4):
                mask = rng.random((height, width)) > 0.94
                mask[0, 0] = mask[-1, -1] = True
                coverage = np.zeros(mask.shape, dtype=np.uint8)
                tiles = worker.compact_tiles(mask, core=8, max_tiles=100)
                baseline = sum(mask[y:y + 8, x:x + 8].any() for y in range(0, height, 8) for x in range(0, width, 8))
                self.assertLessEqual(len(tiles), baseline)
                for left, top, core_width, core_height in tiles:
                    self.assertTrue(0 <= left < width and 0 <= top < height)
                    self.assertTrue(0 < core_width <= 8 and 0 < core_height <= 8)
                    self.assertTrue(left + core_width <= width and top + core_height <= height)
                    coverage[top:top + core_height, left:left + core_width] += 1
                self.assertTrue(np.all(coverage <= 1))
                self.assertTrue(np.all(coverage[mask] == 1))

    def test_empty_nonbinary_and_excessive_tile_masks_are_rejected(self):
        for mask in (np.zeros((4, 4), dtype=bool), np.ones((4, 4), dtype=np.uint8), np.ones(3, dtype=bool)):
            with self.assertRaises(ValueError):
                worker.compact_tiles(mask)
        with self.assertRaisesRegex(ValueError, 'TILE_LIMIT'):
            worker.compact_tiles(np.ones((16, 16), dtype=bool), core=8, max_tiles=3)


if __name__ == '__main__':
    unittest.main()
