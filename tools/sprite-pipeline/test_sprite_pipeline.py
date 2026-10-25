#!/usr/bin/env python3
"""sprite-pipeline 的局部构造测试；不依赖尚未就绪的真实角色素材。"""

import hashlib
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

from sprite_pipeline import SpritePipelineError, process_sprite_sheet

CELL = 64
BOXES = [(24, 20, 16, 30), (22, 14, 20, 36), (26, 26, 12, 24), (23, 18, 18, 32)]
DURATIONS = [100, 120, 80, 140]

def make_sheet(path, boxes, cell=CELL):
    sheet = Image.new("RGBA", (cell * 2, cell * 2), (0, 0, 0, 0))
    draw = ImageDraw.Draw(sheet)
    for index, box in enumerate(boxes):
        if box is None:
            continue
        x, y, width, height = box
        left, top = (index % 2) * cell + x, (index // 2) * cell + y
        draw.rectangle((left, top, left + width - 1, top + height - 1),
                       fill=(200, 60, 80, 255))
    sheet.save(path)
    return path

def output_foot(image):
    """按导出帧底部 12% alpha 范围读取实际脚中点，而不是整体 bbox 中心。"""
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    band_height = max(1, round((bbox[3] - bbox[1]) * 0.12))
    band_bbox = alpha.crop((0, bbox[3] - band_height, image.width, bbox[3])).getbbox()
    return (band_bbox[0] + band_bbox[2]) / 2, bbox[3]

class SpritePipelineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source = make_sheet(self.root / "sheet.png", BOXES)
        self.output = self.root / "out"

    def tearDown(self):
        self.tmp.cleanup()

    def run_tool(self, source=None, output=None, **overrides):
        options = {"columns": 2, "rows": 2, "frame_size": (32, 32),
                   "durations_ms": DURATIONS, "loop": False}
        options.update(overrides)
        return process_sprite_sheet(source or self.source, output or self.output, **options)

    def test_slices_scales_and_is_idempotent(self):
        original = self.source.read_bytes()
        manifest = self.run_tool()
        self.assertEqual(manifest["source"]["sha256"], hashlib.sha256(original).hexdigest())
        self.assertEqual(self.source.read_bytes(), original)
        self.assertAlmostEqual(manifest["spec"]["scale"], 16 / 36, places=5)
        self.assertIsNone(manifest["spec"]["neutral_height"])
        self.assertEqual(manifest["frame_durations_ms"], DURATIONS)
        self.assertFalse(manifest["loop"])
        self.assertEqual([frame["scaled_size"] for frame in manifest["frames"]],
                         [{"width": 7, "height": 13}, {"width": 9, "height": 16},
                          {"width": 5, "height": 11}, {"width": 8, "height": 14}])
        for frame in manifest["frames"]:
            with Image.open(self.output / frame["file"]) as image:
                self.assertEqual((image.size, image.mode), ((32, 32), "RGBA"))
        for name in ("atlas.png", "contact-sheet-light.png",
                     "contact-sheet-dark.png", "manifest.json"):
            self.assertTrue((self.output / name).is_file())
        first = {path.name: path.read_bytes() for path in self.output.iterdir()}
        self.run_tool()
        second = {path.name: path.read_bytes() for path in self.output.iterdir()}
        self.assertEqual(first, second)

    def test_neutral_height_shared_scale_and_bounds(self):
        manifest = self.run_tool(neutral_height=12)
        self.assertEqual(manifest["spec"]["neutral_height"], 12)
        self.assertAlmostEqual(manifest["spec"]["scale"], 0.4, places=6)
        self.assertEqual([frame["scaled_size"] for frame in manifest["frames"]],
                         [{"width": 6, "height": 12}, {"width": 8, "height": 14},
                          {"width": 5, "height": 10}, {"width": 7, "height": 13}])
        self.assertEqual(manifest["frames"][0]["scaled_size"]["height"], 12)
        for frame in manifest["frames"]:
            ratio = frame["scaled_size"]["height"] / frame["source_bbox"]["height"]
            self.assertAlmostEqual(ratio, 0.4, delta=0.03)
        self.assertEqual({(f["source_foot_anchor"]["x"], f["source_foot_anchor"]["y"],
                           f["output_foot_anchor"]["x"], f["output_foot_anchor"]["y"])
                          for f in manifest["frames"]}, {(32, 50, 16, 24)})

        with self.assertRaises(SpritePipelineError) as caught:
            self.run_tool(neutral_height=20, output=self.root / "too-tall")
        self.assertIn("neutral-height", str(caught.exception))
        self.assertFalse((self.root / "too-tall").exists())

    def test_rejects_empty_cell(self):
        source = make_sheet(self.root / "empty.png", [BOXES[0], None, BOXES[2], BOXES[3]])
        with self.assertRaises(SpritePipelineError) as caught:
            self.run_tool(source=source, output=self.root / "empty-out")
        self.assertIn("为空", str(caught.exception))

    def test_rejects_edge_touching_cell(self):
        source = make_sheet(self.root / "edge.png", [(0, 20, 16, 30)] + BOXES[1:])
        with self.assertRaises(SpritePipelineError) as caught:
            self.run_tool(source=source, output=self.root / "edge-out")
        self.assertIn("边界", str(caught.exception))

    def test_tail_changes_do_not_move_feet(self):
        sheet = Image.new("RGBA", (CELL * 2, CELL * 2), (0, 0, 0, 0))
        draw = ImageDraw.Draw(sheet)
        tails = [None, ("right", 12), ("left", 12), ("right", 10)]
        for index, tail in enumerate(tails):
            left, top = (index % 2) * CELL, (index // 2) * CELL
            draw.rectangle((left + 24, top + 10, left + 39, top + 49),
                           fill=(200, 60, 80, 255))
            if tail:
                direction, length = tail
                x = left + 40 if direction == "right" else left + 24 - length
                draw.rectangle((x, top + 38, x + length - 1, top + 42),
                               fill=(120, 60, 200, 255))
        source = self.root / "tails.png"
        sheet.save(source)

        manifest = self.run_tool(source=source, output=self.root / "tails-out")
        frames = manifest["frames"]
        self.assertEqual({(f["source_foot_anchor"]["x"], f["output_foot_anchor"]["x"],
                           f["output_foot_anchor"]["y"]) for f in frames}, {(32, 16, 24)})

        feet, lefts, rights = [], [], []
        for frame in frames:
            with Image.open(self.root / "tails-out" / frame["file"]) as image:
                bbox = image.getchannel("A").getbbox()
                feet.append(output_foot(image))
            lefts.append(bbox[0])
            rights.append(bbox[2])
            self.assertGreaterEqual(bbox[0], 8)
            self.assertGreaterEqual(bbox[1], 8)
            self.assertLessEqual(bbox[2], 24)
            self.assertLessEqual(bbox[3], 24)
        self.assertTrue(all(abs(x - 16) <= 1 for x, _ in feet))
        self.assertLessEqual(max(x for x, _ in feet) - min(x for x, _ in feet), 1)
        self.assertGreater(rights[1], rights[3])
        self.assertGreater(rights[3], rights[0])
        self.assertLess(lefts[2], lefts[0])

if __name__ == "__main__":
    unittest.main()
