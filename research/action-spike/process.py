"""多动作探针素材处理。

固定切分 Codex 新原图：4列2行，wave/alert 各四帧；idle 使用已有的 3×2 六帧图集。
只做统一尺度、平移和 NEAREST 导出，不重画、不抠背景；alpha<128 的低 alpha 像素随整格保留。
"""

import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw

BASE = Path(__file__).resolve().parent
ASSETS = BASE / "assets"
OUTPUT = ASSETS / "processed"
SOURCE = ASSETS / "actions-raw.png"
IDLE_ATLAS = ASSETS / "idle-atlas.png"
GRID, CELL, IDLE_GRID = (4, 2), (384, 512), (3, 2)
VISIBLE_ALPHA, CANVAS, FEET_BOTTOM, FOOT_BAND = 128, 256, 248, 20
CONTACT_BG, LABEL_COLOR = (58, 58, 62, 255), (235, 235, 235, 255)


def visible_mask(image):
    return image.getchannel("A").point(lambda value: 255 if value >= VISIBLE_ALPHA else 0)


def alpha_stats(image):
    hist = image.getchannel("A").histogram()
    return {"zero": hist[0], "full": hist[255],
            "semi": image.width * image.height - hist[0] - hist[255]}


def clip_frames(count, y, durations):
    return [{"x": index * CANVAS, "y": y, "duration": durations[index]}
            for index in range(count)]


def process_frames():
    source = Image.open(SOURCE).convert("RGBA")
    if source.size != (CELL[0] * GRID[0], CELL[1] * GRID[1]):
        raise ValueError(f"原图尺寸 {source.size}，与 {GRID} 格 {CELL} 不符")
    mask = visible_mask(source)
    idle = Image.open(IDLE_ATLAS).convert("RGBA")
    if idle.size != (CANVAS * IDLE_GRID[0], CANVAS * IDLE_GRID[1]):
        raise ValueError(f"idle 图集尺寸 {idle.size} 不是 {IDLE_GRID} 格 {CANVAS} 画布")
    idle_bbox = visible_mask(idle).crop((0, 0, CANVAS, CANVAS)).getbbox()
    if idle_bbox is None:
        raise ValueError("idle 第一帧没有可见像素")
    target_height = idle_bbox[3] - idle_bbox[1]
    if not 218 <= target_height <= 230:
        raise ValueError(f"idle 第一帧可见高度 {target_height}px 偏离约 224px，先报告再处理")

    boxes = [(column * CELL[0], row * CELL[1], (column + 1) * CELL[0], (row + 1) * CELL[1])
             for row in range(GRID[1]) for column in range(GRID[0])]
    bboxes = []
    for box in boxes:
        bbox = mask.crop(box).getbbox()
        if bbox is None:
            raise ValueError(f"格 {box} 没有可见像素")
        # 触边说明内容可能侵入相邻格；不裁切，直接报告并停止导出。
        if bbox[0] == 0 or bbox[1] == 0 or bbox[2] == CELL[0] or bbox[3] == CELL[1]:
            raise ValueError(f"格 {box} 可见像素触及格边 {bbox}，可能侵入相邻格，先报告")
        bboxes.append(bbox)

    neutral = bboxes[0]
    scale = target_height / (neutral[3] - neutral[1])
    frames, records = [], []
    for index, (box, bbox) in enumerate(zip(boxes, bboxes)):
        cell = source.crop(box)
        scaled_cell = cell.resize((round(CELL[0] * scale), round(CELL[1] * scale)),
                                  Image.Resampling.NEAREST)
        scaled_mask = visible_mask(scaled_cell)
        scaled_bbox = scaled_mask.getbbox()
        if scaled_bbox is None:
            raise ValueError(f"第 {index} 帧缩放后没有可见像素")
        feet = scaled_mask.crop((0, scaled_bbox[3] - FOOT_BAND, scaled_cell.width,
                                 scaled_bbox[3])).getbbox()
        offset = (round(CANVAS / 2 - (feet[0] + feet[2]) / 2),
                  FEET_BOTTOM - scaled_bbox[3])
        # paste 前按高 alpha bbox 校验位置；Pillow 会静默裁掉越界像素，事后查 bbox 无法发现。
        if (offset[0] + scaled_bbox[0] < 0 or offset[1] + scaled_bbox[1] < 0
                or offset[0] + scaled_bbox[2] > CANVAS
                or offset[1] + scaled_bbox[3] > CANVAS):
            raise ValueError(f"第 {index} 帧高 alpha 可见范围越出 {CANVAS} 画布，paste 会裁切，先报告")
        canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        canvas.paste(scaled_cell, offset)
        canvas_mask = visible_mask(canvas)
        visible_out = canvas_mask.getbbox()
        # 源格取可见底边 20px 的水平中心；x 相对整格记录。
        source_feet = mask.crop((box[0], box[1] + bbox[3] - FOOT_BAND,
                                 box[0] + CELL[0], box[1] + bbox[3])).getbbox()
        foot_anchor = (source_feet[0] + source_feet[2]) / 2
        # 导出脚底中心按最终画面的可见底边 20px 实测，不拿源格锚点乘 scale 推算。
        output_feet = canvas_mask.crop((0, visible_out[3] - FOOT_BAND, CANVAS,
                                        visible_out[3])).getbbox()
        foot_anchor_output = (output_feet[0] + output_feet[2]) / 2

        frames.append(canvas)
        records.append({
            "index": index,
            "clip": "wave" if index < GRID[0] else "alert",
            "source_bbox": [box[0] + bbox[0], box[1] + bbox[1],
                            box[0] + bbox[2], box[1] + bbox[3]],
            "offset": list(offset),
            "foot_anchor_source_cell": round(foot_anchor, 2),
            "foot_anchor_output": round(foot_anchor_output, 2),
            "alpha_output": alpha_stats(canvas),
            "output_visible_bbox": list(visible_out),
            "hash": hashlib.sha256(canvas.tobytes()).hexdigest()[:16],
        })

    atlas = Image.new("RGBA", (CANVAS * GRID[0], CANVAS * GRID[1]), (0, 0, 0, 0))
    for index, frame in enumerate(frames):
        atlas.paste(frame, ((index % GRID[0]) * CANVAS, (index // GRID[0]) * CANVAS))
    atlas.save(OUTPUT / "action-atlas.png")
    summary = {
        "grid": list(GRID), "source_cell": list(CELL), "canvas": CANVAS,
        "scale": round(scale, 6),
        "scale_rule": "以新动作第一 neutral 可见高度对齐 idle 第一帧可见高度，八帧共用",
        "neutral_height_source": neutral[3] - neutral[1],
        "target_height": target_height, "idle_reference_bbox": list(idle_bbox),
        "feet_bottom": FEET_BOTTOM, "visible_alpha_threshold": VISIBLE_ALPHA,
        "atlas_size": list(atlas.size),
        "boundary_check": "八帧可见 bbox 均未触及格边，未发现侵入相邻格",
        "frames": records, "distinct_hashes": len({record["hash"] for record in records}),
    }
    return frames, summary


def build_clips():
    idle_frames = [{"x": (index % IDLE_GRID[0]) * CANVAS,
                    "y": (index // IDLE_GRID[0]) * CANVAS, "duration": 150}
                   for index in range(IDLE_GRID[0] * IDLE_GRID[1])]
    action_atlas = "assets/processed/action-atlas.png"
    return {"frame_size": CANVAS, "clips": {
        "idle": {"atlas": "assets/idle-atlas.png", "loop": True, "frames": idle_frames},
        "wave": {"atlas": action_atlas, "loop": False,
                 "frames": clip_frames(4, 0, [600] * 4)},
        "alert": {"atlas": action_atlas, "loop": False,
                  "frames": clip_frames(4, CANVAS, [200, 250, 250, 200])},
    }}


def save_contact(frames):
    margin, gap, label = 12, 6, 16
    width = CANVAS * GRID[0] + gap * (GRID[0] - 1) + margin * 2
    height = CANVAS * GRID[1] + gap * (GRID[1] - 1) + margin * 2 + label * GRID[1]
    contact = Image.new("RGBA", (width, height), CONTACT_BG)
    draw = ImageDraw.Draw(contact)
    for index, frame in enumerate(frames):
        column, row = index % GRID[0], index // GRID[0]
        left = margin + column * (CANVAS + gap)
        top = margin + row * (CANVAS + gap + label)
        draw.text((left, top), f"{'W' if row == 0 else 'A'}{column + 1}", fill=LABEL_COLOR)
        contact.alpha_composite(frame, (left, top + label))
    contact.save(OUTPUT / "contact.png")


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    frames, summary = process_frames()
    save_contact(frames)
    (OUTPUT / "clips.json").write_text(
        json.dumps(build_clips(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary["inputs"] = {
        "actions_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "idle_atlas_sha256": hashlib.sha256(IDLE_ATLAS.read_bytes()).hexdigest(),
    }
    (OUTPUT / "measurements.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"scale={summary['scale']} target_height={summary['target_height']} "
          f"atlas={summary['atlas_size']} frames={len(summary['frames'])} "
          f"distinct_hashes={summary['distinct_hashes']}")
    print(summary["boundary_check"])


if __name__ == "__main__":
    main()
