#!/usr/bin/env python3
"""sprite-pipeline 的局部构造测试；不依赖尚未就绪的真实角色素材。"""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

from sprite_pipeline import SpritePipelineError, process_sprite_sheet

CELL = 64
BOXES = [(24, 20, 16, 30), (22, 14, 20, 36), (26, 26, 12, 24), (23, 18, 18, 32)]
DURATIONS = [100, 120, 80, 140]
SIT_DURATIONS = [300, 150, 160, 180, 180, 180, 200, 600]

def make_explicit_sheet(path):
    sheet = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    draw = ImageDraw.Draw(sheet)
    for left, top, right, bottom in [
        (20, 10, 39, 59), (79, 20, 108, 64),
        (10, 77, 49, 116), (84, 80, 103, 119),
    ]:
        draw.rectangle((left, top, right, bottom), fill=(200, 60, 80, 255))
    sheet.save(path)
    return path

def make_regions(path, regions, columns=2, rows=2, source_sha256=None):
    content = {"columns": columns, "rows": rows, "regions": regions}
    if source_sha256 is not None:
        content["sourceSha256"] = source_sha256
    path.write_text(json.dumps(content, ensure_ascii=False), encoding="utf-8")
    return path

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

    def test_explicit_regions_and_anchor_are_hand_calculable(self):
        source = make_explicit_sheet(self.root / "explicit.png")
        regions = [
            {"x": 0, "y": 0, "width": 60, "height": 70,
             "anchor": {"x": 30, "y": 50}},
            {"x": 64, "y": 0, "width": 60, "height": 70,
             "anchor": {"x": 30, "y": 55}},
            {"x": 0, "y": 72, "width": 60, "height": 56,
             "anchor": {"x": 30, "y": 20}},
            {"x": 64, "y": 72, "width": 60, "height": 56,
             "anchor": {"x": 30, "y": 30}},
        ]
        config = make_regions(self.root / "regions.json", regions)
        original = source.read_bytes()
        manifest = self.run_tool(
            source=source, output=self.root / "explicit-out",
            frame_size=(40, 40), padding=4, neutral_height=20, regions_json=config)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(manifest["source"]["sha256"], hashlib.sha256(original).hexdigest())
        self.assertEqual(manifest["spec"]["anchor_mode"], "explicit-region-anchor")
        self.assertAlmostEqual(manifest["spec"]["scale"], 0.4, places=6)
        self.assertEqual(manifest["spec"]["output_ground_anchor"], {"x": 20, "y": 26})
        expected = [
            ({"width": 8, "height": 20}, {"x": 16, "y": 10}),
            ({"width": 12, "height": 18}, {"x": 14, "y": 12}),
            ({"width": 16, "height": 16}, {"x": 12, "y": 20}),
            ({"width": 8, "height": 16}, {"x": 16, "y": 17}),
        ]
        for frame, (size, paste) in zip(manifest["frames"], expected):
            self.assertEqual(frame["scaled_size"], size)
            self.assertEqual(frame["paste"], paste)
            self.assertEqual(frame["output_ground_anchor"], {"x": 20, "y": 26})
            with Image.open(self.root / "explicit-out" / frame["file"]) as image:
                self.assertEqual(image.getchannel("A").getbbox(),
                                 (paste["x"], paste["y"],
                                  paste["x"] + size["width"], paste["y"] + size["height"]))
        self.assertEqual(manifest["frames"][2]["source_anchor"], {"x": 30, "y": 92})
        self.assertEqual(manifest["frames"][2]["source_region"],
                         {"x": 0, "y": 72, "width": 60, "height": 56})
        self.assertEqual(manifest["spec"]["regions_config"]["content"]["regions"], regions)
        with self.assertRaises(SpritePipelineError) as caught:
            self.run_tool(
                source=source, output=self.root / "explicit-too-tall",
                frame_size=(40, 40), padding=4, neutral_height=40,
                regions_json=config)
        self.assertIn("安全容量", str(caught.exception))
        self.assertFalse((self.root / "explicit-too-tall").exists())

    def test_explicit_regions_reject_invalid_configs(self):
        source = make_explicit_sheet(self.root / "invalid-regions.png")
        base = [
            {"x": 0, "y": 0, "width": 60, "height": 70,
             "anchor": {"x": 30, "y": 50}},
            {"x": 64, "y": 0, "width": 60, "height": 70,
             "anchor": {"x": 30, "y": 55}},
            {"x": 0, "y": 72, "width": 60, "height": 56,
             "anchor": {"x": 30, "y": 20}},
            {"x": 64, "y": 72, "width": 60, "height": 56,
             "anchor": {"x": 30, "y": 30}},
        ]
        cases = {
            "count": base[:3],
            "overlap": [dict(base[0]), {**base[1], "x": 50}, base[2], base[3]],
            "bounds": [base[0], base[1], base[2], {**base[3], "x": 120, "width": 20}],
            "edge": [{**base[0], "x": 20, "width": 20, "height": 50}, base[1], base[2], base[3]],
            "anchor": [{**base[0], "anchor": {"x": 60, "y": 50}}, base[1], base[2], base[3]],
            "empty": [base[0], base[1], base[2],
                      {"x": 126, "y": 0, "width": 2, "height": 2,
                       "anchor": {"x": 1, "y": 1}}],
        }
        for name, regions in cases.items():
            with self.subTest(name=name):
                config = make_regions(self.root / f"bad-{name}.json", regions)
                with self.assertRaises(SpritePipelineError):
                    self.run_tool(
                        source=source, output=self.root / f"bad-{name}-out",
                        frame_size=(40, 40), neutral_height=20, regions_json=config)
                self.assertFalse((self.root / f"bad-{name}-out").exists())
        config = make_regions(
            self.root / "bad-hash.json", base,
            source_sha256="0" * 64)
        with self.assertRaises(SpritePipelineError) as caught:
            self.run_tool(
                source=source, output=self.root / "bad-hash-out",
                frame_size=(40, 40), neutral_height=20, regions_json=config)
        self.assertIn("SHA-256", str(caught.exception))

    def test_real_sit_v2_explicit_export_is_complete(self):
        root = Path(__file__).resolve().parents[2]
        source = root / "assets/characters/rin/source/sit-pixel-v2.png"
        config = root / "tools/sprite-pipeline/data/rin-sit-v2-regions.json"
        original = source.read_bytes()
        manifest = self.run_tool(
            source=source, output=self.root / "sit-v2",
            columns=4, rows=2, frame_size=(320, 384), neutral_height=298,
            durations_ms=SIT_DURATIONS, loop=False, regions_json=config)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(manifest["source"]["sha256"], hashlib.sha256(original).hexdigest())
        self.assertEqual(len(manifest["frames"]), 8)
        self.assertEqual(manifest["frame_durations_ms"], SIT_DURATIONS)
        self.assertFalse(manifest["loop"])
        self.assertEqual(manifest["spec"]["anchor_mode"], "explicit-region-anchor")
        self.assertEqual(manifest["spec"]["output_ground_anchor"], {"x": 160, "y": 370})
        self.assertAlmostEqual(manifest["spec"]["scale"], 298 / 427, places=6)
        self.assertEqual(manifest["frames"][0]["scaled_size"]["height"], 298)
        self.assertLess(manifest["frames"][7]["scaled_size"]["height"], 298)
        for frame in manifest["frames"]:
            self.assertEqual(frame["output_ground_anchor"], {"x": 160, "y": 370})
            self.assertEqual(frame["source_region"]["width"], 384)
            self.assertAlmostEqual(
                frame["scaled_size"]["width"] / frame["source_bbox"]["width"],
                manifest["spec"]["scale"], delta=0.01)
            self.assertAlmostEqual(
                frame["scaled_size"]["height"] / frame["source_bbox"]["height"],
                manifest["spec"]["scale"], delta=0.01)
            with Image.open(self.root / "sit-v2" / frame["file"]) as image:
                self.assertEqual(image.size, (320, 384))
                bbox = image.getchannel("A").getbbox()
                self.assertGreaterEqual(bbox[0], 8)
                self.assertGreaterEqual(bbox[1], 8)
                self.assertLessEqual(bbox[2], 312)
                self.assertLessEqual(bbox[3], 376)
        for name in ("atlas.png", "contact-sheet-light.png", "contact-sheet-dark.png"):
            self.assertTrue((self.root / "sit-v2" / name).is_file())


if __name__ == "__main__":
    unittest.main()
