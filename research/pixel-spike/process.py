"""像素动画探针素材处理。

固定切分 Codex 原图：六帧 3×2、四视图 4×1，不重画、不替换像素。
alpha>=128 只用于量测可见范围与平移；输出保留原始 alpha（含软边和低 alpha 噪点）。
"""

import hashlib
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

BASE = Path(__file__).resolve().parent
ASSETS = BASE / "assets"
OUTPUT = ASSETS / "processed"
FRAME_GRID, FRAME_CELL = (3, 2), 512
CANVAS, SCALE = 512, 0.5
OUT_CELL = int(CANVAS * SCALE)  # 256
BASELINE = 496  # 六帧可见底边最大 495，留 1px 余量
VISIBLE_ALPHA = 128
VIEW_COUNT, VIEW_CELL, VIEW_BASELINE = 4, 512, 750
# 四视图并非四等格：按实测可见列段之间的空隙切分，边界固定记录，避免尾巴被切到相邻格。
VIEW_BOUNDS = (0, 354, 780, 1153, 1536)
GIF_DELAY_MS = 120
CONTACT_BG, LABEL_COLOR = (58, 58, 62, 255), (235, 235, 235, 255)


def alpha_stats(image):
    hist = image.getchannel("A").histogram()
    total = image.width * image.height
    return {"zero": hist[0], "full": hist[255], "semi": total - hist[0] - hist[255],
            "zero_ratio": round(hist[0] / total, 4), "semi_ratio": round((total - hist[0] - hist[255]) / total, 4)}


def visible_mask(image, alpha_threshold=VISIBLE_ALPHA):
    return image.getchannel("A").point(lambda value: 255 if value >= alpha_threshold else 0)


def local_bbox(mask, box):
    bbox = mask.crop(box).getbbox()
    if bbox is None:
        raise ValueError(f"裁切区域 {box} 没有可见像素")
    return bbox


def changed_ratio(left, right, threshold=8):
    """同一不透明灰底合成后的 RGB 差异占比；仅描述可见变化，不作为质量通过阈值。"""
    backdrop = Image.new("RGBA", left.size, (58, 58, 62, 255))
    diff = ImageChops.difference(Image.alpha_composite(backdrop, left).convert("RGB"),
                                 Image.alpha_composite(backdrop, right).convert("RGB"))
    red, green, blue = diff.split()
    peak = ImageChops.lighter(ImageChops.lighter(red, green), blue)
    hist = peak.histogram()
    return round(sum(hist[threshold + 1:]) / (peak.width * peak.height), 4)


def input_meta(path):
    image = Image.open(path)
    return {"path": str(path.relative_to(BASE)), "size": list(image.size),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "alpha": alpha_stats(image.convert("RGBA"))}


def process_frames():
    source = Image.open(ASSETS / "idle-raw.png").convert("RGBA")
    mask = visible_mask(source)
    frames, aligned = [], []
    for index in range(FRAME_GRID[0] * FRAME_GRID[1]):
        column, row = index % FRAME_GRID[0], index // FRAME_GRID[0]
        box = (column * FRAME_CELL, row * FRAME_CELL, (column + 1) * FRAME_CELL, (row + 1) * FRAME_CELL)
        bbox = local_bbox(mask, box)
        # 脚部锚点：整格宽度取可见底边 20px，getbbox 的 x 即 512 格内坐标。
        feet = mask.crop((box[0], box[1] + bbox[3] - 20,
                          box[0] + FRAME_CELL, box[1] + bbox[3])).getbbox()
        anchor = (feet[0] + feet[2]) / 2
        offset_x = round(CANVAS / 2 - anchor)
        offset_y = BASELINE - bbox[3]
        cell = source.crop(box)
        canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        canvas.paste(cell, (offset_x, offset_y))
        scaled = canvas.resize((OUT_CELL, OUT_CELL), Image.Resampling.NEAREST)

        # 低 alpha 噪点随整格平移；记录被 512 画布边缘裁掉的像素数。
        noise_mask = cell.getchannel("A").point(lambda value: 255 if 0 < value < VISIBLE_ALPHA else 0)
        noise = noise_mask.histogram()[255]
        left, top = max(0, -offset_x), max(0, -offset_y)
        right, bottom = min(FRAME_CELL, CANVAS - offset_x), min(FRAME_CELL, CANVAS - offset_y)
        kept = noise_mask.crop((left, top, right, bottom)).histogram()[255] if left < right and top < bottom else 0

        visible_out = scaled.getchannel("A").point(lambda value: 255 if value >= VISIBLE_ALPHA else 0).getbbox()
        alpha_out = scaled.getchannel("A").point(lambda value: 255 if value > 0 else 0).getbbox()
        frames.append({
            "index": index,
            "source_cell": list(box),
            "visible_bbox": [box[0] + bbox[0], box[1] + bbox[1], box[0] + bbox[2], box[1] + bbox[3]],
            "offset": [offset_x, offset_y],
            "foot_anchor_source": round(box[0] + anchor, 2),
            "foot_anchor_output": round((anchor + offset_x) * SCALE, 2),
            "low_alpha": {"total": noise, "clipped": noise - kept},
            "alpha_source": alpha_stats(cell),
            "output_visible_bbox": list(visible_out),
            "output_alpha_bbox": list(alpha_out),
            "alpha_output": alpha_stats(scaled),
            "hash": hashlib.sha256(scaled.tobytes()).hexdigest()[:16],
        })
        aligned.append(scaled)

    atlas = Image.new("RGBA", (OUT_CELL * FRAME_GRID[0], OUT_CELL * FRAME_GRID[1]), (0, 0, 0, 0))
    for index, frame in enumerate(aligned):
        atlas.paste(frame, ((index % FRAME_GRID[0]) * OUT_CELL, (index // FRAME_GRID[0]) * OUT_CELL))
    atlas.save(OUTPUT / "atlas.png")
    summary = {
        "grid": list(FRAME_GRID), "cell_source": FRAME_CELL, "canvas": CANVAS, "scale": SCALE,
        "frame_size": OUT_CELL, "baseline_source": BASELINE, "baseline_output": BASELINE * SCALE,
        "atlas_size": list(atlas.size), "frames": frames,
        "distinct_hashes": len({frame["hash"] for frame in frames}),
        "adjacent_diff": [{"pair": [i, i + 1], "changed_ratio": changed_ratio(aligned[i], aligned[i + 1])}
                          for i in range(len(aligned) - 1)],
        "first_last_diff": changed_ratio(aligned[0], aligned[-1]),
        "diff_note": "changed_ratio 为相同不透明灰底合成后的可见 RGB 差异占比，仅作描述，不作为质量通过阈值。",
    }
    return aligned, summary


def process_views():
    source = Image.open(ASSETS / "views-raw.png").convert("RGBA")
    mask = visible_mask(source)
    sheet = Image.new("RGBA", (VIEW_CELL * VIEW_COUNT, source.height), (0, 0, 0, 0))
    records = []
    for index in range(VIEW_COUNT):
        box = (VIEW_BOUNDS[index], 0, VIEW_BOUNDS[index + 1], source.height)
        bbox = local_bbox(mask, box)
        offset_x = round(VIEW_CELL / 2 - (bbox[0] + bbox[2]) / 2)
        offset_y = VIEW_BASELINE - bbox[3]
        # 每个视图先落在独立透明 cell，再拼接，避免相邻格内容互相覆盖。
        sheet.paste(source.crop(box), (index * VIEW_CELL + offset_x, offset_y))
        segment_width = box[2] - box[0]
        records.append({
            "index": index, "cell": list(box), "segment_width": segment_width,
            "visible_bbox_global": [box[0] + bbox[0], bbox[1], box[0] + bbox[2], bbox[3]],
            "offset": [offset_x, offset_y],
            # 触边说明可见内容到达该视图的实测裁切边界。
            "edge_touch": {"left": bbox[0] == 0, "top": bbox[1] == 0,
                           "right": bbox[2] == segment_width, "bottom": bbox[3] == source.height},
        })
    sheet.save(OUTPUT / "views.png")
    return {"grid": [VIEW_COUNT, 1], "cell": [VIEW_CELL, source.height], "baseline": VIEW_BASELINE,
            "bounds": list(VIEW_BOUNDS), "note": "按实测空隙切分为四个独立 512×1024 透明格，再平移拼接；不缩放、不参与动画。",
            "views": records}


def save_contact(frames):
    margin, gap, label = 16, 8, 18
    width = OUT_CELL * FRAME_GRID[0] + gap * (FRAME_GRID[0] - 1) + margin * 2
    height = OUT_CELL * FRAME_GRID[1] + gap * (FRAME_GRID[1] - 1) + margin * 2 + label * FRAME_GRID[1]
    contact = Image.new("RGBA", (width, height), CONTACT_BG)
    draw = ImageDraw.Draw(contact)
    for index, frame in enumerate(frames):
        column, row = index % FRAME_GRID[0], index // FRAME_GRID[0]
        left = margin + column * (OUT_CELL + gap)
        top = margin + row * (OUT_CELL + gap + label)
        draw.text((left, top), f"F{index + 1}", fill=LABEL_COLOR)
        contact.alpha_composite(frame, (left, top + label))
    contact.save(OUTPUT / "contact.png")


def save_gif(frames):
    """GIF 只有二值透明：alpha>=128 不透明，其余透明，软边和低 alpha 噪点会丢失。"""
    converted = []
    for frame in frames:
        alpha = frame.getchannel("A")
        backdrop = Image.new("RGB", frame.size, (0, 0, 0))
        backdrop.paste(frame, mask=alpha.point(lambda value: 255 if value >= VISIBLE_ALPHA else 0))
        palette = backdrop.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
        palette.paste(255, mask=alpha.point(lambda value: 255 if value < VISIBLE_ALPHA else 0))
        converted.append(palette)
    converted[0].save(OUTPUT / "preview.gif", save_all=True, append_images=converted[1:],
                      duration=GIF_DELAY_MS, loop=0, transparency=255, disposal=2)


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    frames, animation = process_frames()
    views = process_views()
    save_contact(frames)
    save_gif(frames)
    measurements = {
        "inputs": {"idle": input_meta(ASSETS / "idle-raw.png"), "views": input_meta(ASSETS / "views-raw.png")},
        "visible_alpha_threshold": VISIBLE_ALPHA,
        "animation": animation,
        "views": views,
        "gif": {"duration_ms": GIF_DELAY_MS, "transparency_threshold": VISIBLE_ALPHA,
                "alpha_loss": "GIF 不支持半透明：alpha>=128 不透明、其余透明，软边和低 alpha 噪点丢失；PNG 图集为真实入口。"},
        "outputs": ["atlas.png", "views.png", "contact.png", "preview.gif", "measurements.json"],
    }
    (OUTPUT / "measurements.json").write_text(
        json.dumps(measurements, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"图集 {animation['atlas_size']}，六帧 hash 去重 {animation['distinct_hashes']} 个")
    print(f"相邻帧变化占比：{[item['changed_ratio'] for item in animation['adjacent_diff']]}")
    print(f"首尾帧变化占比：{animation['first_last_diff']}")


if __name__ == "__main__":
    main()
