#!/usr/bin/env python3
"""固定网格 spritesheet 切帧、统一缩放与脚底中点对齐。

脚锚取每格底部 12% 区域透明 alpha 主体的水平中点，适用于双脚着地的
站立素材；尾巴低垂进入底部带、趴卧或道具低于脚时不适用，未来用显式
锚点另行支持。

只处理素材：不重绘、不补画、不自动染色，也不提供播放器。空格、网格
越界或主体触到格子边界时直接报错，由 Codex 检查源图后决定。
"""

import argparse
import hashlib
import io
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

DEFAULT_DURATIONS_MS = [650, 180, 250, 80, 110, 80, 180, 350]
FOOT_BAND_RATIO = 0.12
DEFAULT_PADDING = 8
CHECKER_TILE, CONTACT_MARGIN, CONTACT_GAP, LABEL_HEIGHT = 8, 12, 10, 18

class SpritePipelineError(Exception):
    """源图或参数不符合约定；不静默修正。"""

def positive_int(value: str) -> int:
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError(f"需要正整数，收到 {value!r}")
    return number

def non_negative_int(value: str) -> int:
    number = int(value)
    if number < 0:
        raise argparse.ArgumentTypeError(f"需要非负整数，收到 {value!r}")
    return number

def parse_frame_size(value: str) -> tuple[int, int]:
    try:
        width, height = (int(part) for part in value.lower().split("x"))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("frame-size 应为 WIDTHxHEIGHT，例如 256x256") from exc
    if width <= 0 or height <= 0:
        raise argparse.ArgumentTypeError("frame-size 需要正整数")
    return width, height

def parse_durations_ms(value: str) -> list[int]:
    try:
        durations = [int(part) for part in value.split(",")]
    except ValueError as exc:
        raise argparse.ArgumentTypeError("帧时长需为逗号分隔的毫秒整数") from exc
    if not durations or min(durations) <= 0:
        raise argparse.ArgumentTypeError("帧时长必须是正整数毫秒")
    return durations

def load_source(source: Path) -> tuple[Image.Image, str]:
    data = source.read_bytes()
    with Image.open(io.BytesIO(data)) as opened:
        if opened.mode not in ("RGBA", "LA"):
            raise SpritePipelineError(
                f"源图需要透明通道（RGBA/LA），当前模式为 {opened.mode}")
        sheet = opened.convert("RGBA")
    return sheet, hashlib.sha256(data).hexdigest()

def analyze_cells(sheet: Image.Image, columns: int, rows: int,
                  cell_size: tuple[int, int], alpha_threshold: int) -> list[dict]:
    """逐格检查主体边界；低于阈值的 alpha 视为背景，其余原值保留。"""
    cell_width, cell_height = cell_size
    cells = []
    for index in range(columns * rows):
        column, row = index % columns, index // columns
        cell = sheet.crop((column * cell_width, row * cell_height,
                           (column + 1) * cell_width, (row + 1) * cell_height))
        alpha = cell.getchannel("A").point(
            lambda value: value if value > alpha_threshold else 0)
        bbox = alpha.getbbox()
        if bbox is None:
            raise SpritePipelineError(f"第 {index} 格（第 {row + 1} 行第 {column + 1} 列）为空")

        left, top, right, bottom = bbox
        edges = {"左": left == 0, "上": top == 0, "右": right == cell_width, "下": bottom == cell_height}
        touched = [name for name, hit in edges.items() if hit]
        if touched:
            raise SpritePipelineError(
                f"第 {index} 格（第 {row + 1} 行第 {column + 1} 列）主体触到格子边界"
                f"（{'、'.join(touched)}），可能跨格；请检查源图网格与边距")

        cleaned = cell.copy()
        cleaned.putalpha(alpha)
        band_height = max(1, round((bbox[3] - bbox[1]) * FOOT_BAND_RATIO))
        band = alpha.crop((0, bbox[3] - band_height, cell_width, bbox[3]))
        band_bbox = band.getbbox()
        foot_x = (band_bbox[0] + band_bbox[2]) / 2
        cells.append({"index": index, "row": row, "column": column,
                      "image": cleaned, "bbox": bbox, "foot_x": foot_x})
    return cells

def load_regions_config(path: Path, columns: int, rows: int) -> dict:
    """读取显式帧区域配置；结构、数量、越界、重叠和锚点都在导出前拒绝。"""
    path = Path(path)
    try:
        raw = path.read_bytes()
        data = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SpritePipelineError(f"regions 配置无法读取或解析：{path}") from exc
    if not isinstance(data, dict):
        raise SpritePipelineError("regions 配置顶层必须是对象")
    if data.get("columns") != columns or data.get("rows") != rows:
        raise SpritePipelineError(
            f"regions 配置网格 {data.get('columns')}x{data.get('rows')} "
            f"与命令行 {columns}x{rows} 不一致")
    regions = data.get("regions")
    if not isinstance(regions, list):
        raise SpritePipelineError("regions 配置必须包含 regions 数组")
    if len(regions) != columns * rows:
        raise SpritePipelineError(
            f"regions 数量 {len(regions)} 与帧数 {columns * rows} 不一致")

    normalized = []
    for index, entry in enumerate(regions):
        if not isinstance(entry, dict):
            raise SpritePipelineError(f"第 {index} 个 region 必须是对象")
        values = []
        for key in ("x", "y", "width", "height"):
            value = entry.get(key)
            if not isinstance(value, int) or isinstance(value, bool):
                raise SpritePipelineError(f"第 {index} 个 region 的 {key} 必须是整数")
            values.append(value)
        x, y, width, height = values
        if x < 0 or y < 0 or width <= 0 or height <= 0:
            raise SpritePipelineError(f"第 {index} 个 region 必须非空且不越界")
        anchor = entry.get("anchor")
        if not isinstance(anchor, dict):
            raise SpritePipelineError(f"第 {index} 个 region 缺少 anchor")
        anchor_x, anchor_y = anchor.get("x"), anchor.get("y")
        if (
            not isinstance(anchor_x, int) or isinstance(anchor_x, bool)
            or not isinstance(anchor_y, int) or isinstance(anchor_y, bool)
        ):
            raise SpritePipelineError(
                f"第 {index} 个 region 的 anchor x/y 必须是整数")
        if not (0 <= anchor_x < width and 0 <= anchor_y < height):
            raise SpritePipelineError(
                f"第 {index} 个 region 的 anchor 不在区域内部")
        normalized.append({
            "x": x, "y": y, "width": width, "height": height,
            "anchor": {"x": anchor_x, "y": anchor_y},
        })

    for left_index, left in enumerate(normalized):
        for right_index in range(left_index + 1, len(normalized)):
            right = normalized[right_index]
            if (
                left["x"] < right["x"] + right["width"]
                and right["x"] < left["x"] + left["width"]
                and left["y"] < right["y"] + right["height"]
                and right["y"] < left["y"] + left["height"]
            ):
                raise SpritePipelineError(
                    f"第 {left_index} 与第 {right_index} 个 region 重叠")

    return {
        "path": str(path),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "content": data,
        "regions": normalized,
    }

def analyze_regions(sheet: Image.Image, config: dict,
                    alpha_threshold: int) -> list[dict]:
    """按显式区域裁切；区域外的像素不参与，区域内的主体不可触边。"""
    sheet_width, sheet_height = sheet.size
    cells = []
    for index, region in enumerate(config["regions"]):
        x, y = region["x"], region["y"]
        width, height = region["width"], region["height"]
        if x + width > sheet_width or y + height > sheet_height:
            raise SpritePipelineError(f"第 {index} 个 region 超出源图范围")
        cell = sheet.crop((x, y, x + width, y + height))
        alpha = cell.getchannel("A").point(
            lambda value: value if value > alpha_threshold else 0)
        bbox = alpha.getbbox()
        if bbox is None:
            raise SpritePipelineError(f"第 {index} 个显式区域为空")
        left, top, right, bottom = bbox
        edges = {"左": left == 0, "上": top == 0, "右": right == width, "下": bottom == height}
        touched = [name for name, hit in edges.items() if hit]
        if touched:
            raise SpritePipelineError(
                f"第 {index} 个显式区域主体触到区域边界"
                f"（{'、'.join(touched)}），请调整 region，不得裁切主体")
        cleaned = cell.copy()
        cleaned.putalpha(alpha)
        cells.append({
            "index": index,
            "row": index // config["content"]["columns"],
            "column": index % config["content"]["columns"],
            "image": cleaned,
            "bbox": bbox,
            "anchor": region["anchor"],
            "region": region,
        })
    return cells

def explicit_layout(cells: list[dict], frame_size: tuple[int, int], padding: int,
                   neutral_height: int | None) -> tuple[float, dict]:
    """以显式 anchor 计算全套统一 scale 与固定输出地面锚；上下容量都按 anchor 计算。"""
    frame_width, frame_height = frame_size
    anchor_x = frame_width // 2
    capacities = (anchor_x - padding, frame_width - padding - anchor_x,
                  frame_height - 2 * padding)
    if min(capacities) <= 0:
        raise SpritePipelineError("padding 过大或画布过小，无法保留安全边距")

    max_left = max(max(0, cell["anchor"]["x"] - cell["bbox"][0]) for cell in cells)
    max_right = max(max(0, cell["bbox"][2] - cell["anchor"]["x"]) for cell in cells)
    max_above = max(max(0, cell["anchor"]["y"] - cell["bbox"][1]) for cell in cells)
    max_below = max(max(0, cell["bbox"][3] - cell["anchor"]["y"]) for cell in cells)
    if neutral_height is not None:
        first_height = cells[0]["bbox"][3] - cells[0]["bbox"][1]
        scale = neutral_height / first_height
    else:
        scale = min(
            capacities[0] / max_left if max_left else float("inf"),
            capacities[1] / max_right if max_right else float("inf"),
            capacities[2] / (max_above + max_below) if max_above + max_below else float("inf"),
        )

    if (
        max_left * scale > capacities[0]
        or max_right * scale > capacities[1]
        or (max_above + max_below) * scale > capacities[2]
    ):
        raise SpritePipelineError(
            "显式 anchor 在给定 frame-size/padding/neutral-height 下超出安全容量；"
            "请调整画布、padding 或 neutral-height，不得裁切")
    anchor_y = round(frame_height - padding - max_below * scale)
    return scale, {"x": anchor_x, "y": anchor_y}

def build_explicit_frame(cell: dict, scale: float, frame_size: tuple[int, int],
                         padding: int, output_anchor: dict):
    """按显式 anchor 平移主体；anchor 以下的脚/尾巴像素也保留在画布内。"""
    frame_width, frame_height = frame_size
    left, top, right, bottom = cell["bbox"]
    width = max(1, round((right - left) * scale))
    height = max(1, round((bottom - top) * scale))
    subject = cell["image"].crop(cell["bbox"]).resize(
        (width, height), Image.Resampling.NEAREST)
    x = output_anchor["x"] - round((cell["anchor"]["x"] - left) * scale)
    y = output_anchor["y"] - round((cell["anchor"]["y"] - top) * scale)
    if (
        x < padding or y < padding
        or x + width > frame_width - padding
        or y + height > frame_height - padding
    ):
        raise SpritePipelineError(
            f"第 {cell['index']} 个显式区域在 anchor={output_anchor} 下越界；"
            "请调整 region、anchor 或安全容量")
    canvas = Image.new("RGBA", frame_size, (0, 0, 0, 0))
    canvas.alpha_composite(subject, (x, y))
    return canvas, {"width": width, "height": height}, {"x": x, "y": y}, output_anchor

def common_scale(cells: list[dict], frame_size: tuple[int, int], padding: int,
                 neutral_height: int | None = None) -> float:
    """所有帧共用一个 scale；指定 neutral_height 时按第0帧主体高度定 scale。"""
    anchor_x = frame_size[0] // 2
    capacities = (anchor_x - padding, frame_size[0] - padding - anchor_x,
                  frame_size[1] - 2 * padding)
    if min(capacities) <= 0:
        raise SpritePipelineError("padding 过大或画布过小，无法保留安全边距")
    if neutral_height is not None:
        first_height = cells[0]["bbox"][3] - cells[0]["bbox"][1]
        scale = neutral_height / first_height
        for cell in cells:
            left, top, right, bottom = cell["bbox"]
            width = max(1, round((right - left) * scale))
            height = max(1, round((bottom - top) * scale))
            x = anchor_x - round((cell["foot_x"] - left) * scale)
            y = frame_size[1] - padding - height
            if x < padding or y < padding or x + width > frame_size[0] - padding:
                raise SpritePipelineError(
                    f"neutral-height={neutral_height} 时第 {cell['index']} 格超出安全留边；"
                    "请增大 frame-size 或减小 padding/neutral-height")
        return scale
    max_left = max(cell["foot_x"] - cell["bbox"][0] for cell in cells)
    max_right = max(cell["bbox"][2] - cell["foot_x"] for cell in cells)
    max_top = max(cell["bbox"][3] - cell["bbox"][1] for cell in cells)
    return min(capacities[0] / max_left, capacities[1] / max_right, capacities[2] / max_top)

def build_frame(cell: dict, scale: float, frame_size: tuple[int, int], padding: int):
    """按统一缩放裁切主体，把源脚锚点整数平移到画布中线与 height-padding。"""
    frame_width, frame_height = frame_size
    left, top, right, bottom = cell["bbox"]
    anchor_x = frame_width // 2
    width = max(1, round((right - left) * scale))
    height = max(1, round((bottom - top) * scale))
    subject = cell["image"].crop(cell["bbox"]).resize(
        (width, height), Image.Resampling.NEAREST)
    source_offset_x = round((cell["foot_x"] - left) * scale)
    x = anchor_x - source_offset_x
    y = frame_height - padding - height
    if x < 0 or y < 0 or x + width > frame_width:
        raise SpritePipelineError(
            f"第 {cell['index']} 格在 padding={padding} 下越界；"
            "请增大 frame-size 或减小 padding")

    canvas = Image.new("RGBA", frame_size, (0, 0, 0, 0))
    canvas.alpha_composite(subject, (x, y))
    return (canvas, {"width": width, "height": height}, {"x": x, "y": y},
            {"x": x + source_offset_x, "y": y + height})

def save_contact_sheet(images: list[Image.Image], durations: list[int], columns: int,
                       rows: int, frame_size: tuple[int, int], path: Path, light: bool):
    """输出浅色或深色棋盘对照图，只供审查透明边缘和帧位置。"""
    frame_width, frame_height = frame_size
    width = CONTACT_MARGIN * 2 + columns * frame_width + (columns - 1) * CONTACT_GAP
    height = (CONTACT_MARGIN * 2 + rows * (frame_height + LABEL_HEIGHT)
              + (rows - 1) * CONTACT_GAP)
    colors = ((232, 232, 232, 255), (255, 255, 255, 255)) if light else ((30, 30, 30, 255), (46, 46, 46, 255))
    ink = (60, 60, 60, 255) if light else (225, 225, 225, 255)

    board = Image.new("RGBA", (width, height))
    draw = ImageDraw.Draw(board)
    for y in range(0, height, CHECKER_TILE):
        for x in range(0, width, CHECKER_TILE):
            draw.rectangle((x, y, x + CHECKER_TILE - 1, y + CHECKER_TILE - 1),
                           fill=colors[(x // CHECKER_TILE + y // CHECKER_TILE) % 2])
    for index, image in enumerate(images):
        x = CONTACT_MARGIN + (index % columns) * (frame_width + CONTACT_GAP)
        y = CONTACT_MARGIN + (index // columns) * (frame_height + LABEL_HEIGHT + CONTACT_GAP) + LABEL_HEIGHT
        draw.text((x, y - LABEL_HEIGHT + 3), f"{index:02d}  {durations[index]} ms", fill=ink)
        draw.rectangle((x - 1, y - 1, x + frame_width, y + frame_height), outline=ink)
        board.alpha_composite(image, (x, y))
    board.convert("RGB").save(path)

def process_sprite_sheet(source: Path, output: Path, columns: int, rows: int,
                         frame_size: tuple[int, int], alpha_threshold: int = 16,
                         padding: int = DEFAULT_PADDING, neutral_height: int | None = None,
                         durations_ms: list[int] | None = None, loop: bool = True,
                         regions_json: Path | None = None) -> dict:
    source, output = Path(source), Path(output)
    frame_width, frame_height = frame_size
    total = columns * rows
    if min(columns, rows, frame_width, frame_height) <= 0:
        raise SpritePipelineError("columns、rows 和 frame-size 必须是正整数")
    if not 0 <= alpha_threshold <= 255:
        raise SpritePipelineError("alpha-threshold 必须在 0～255 之间")
    if padding < 0:
        raise SpritePipelineError("padding 必须是非负整数")
    if neutral_height is not None and (not isinstance(neutral_height, int) or neutral_height <= 0):
        raise SpritePipelineError("neutral-height 必须是正整数")

    durations = list(DEFAULT_DURATIONS_MS if durations_ms is None else durations_ms)
    if len(durations) != total:
        raise SpritePipelineError(
            f"帧时长数量 {len(durations)} 与帧数 {total} 不一致；请用 --durations-ms 指定")
    if any(not isinstance(duration, int) or duration <= 0 for duration in durations):
        raise SpritePipelineError("帧时长必须是正整数毫秒")

    sheet, digest = load_source(source)
    sheet_width, sheet_height = sheet.size
    regions_config = None
    explicit_anchor = None
    if regions_json is not None:
        regions_config = load_regions_config(regions_json, columns, rows)
        expected_digest = regions_config["content"].get("sourceSha256")
        if expected_digest is not None and expected_digest != digest:
            raise SpritePipelineError(
                "源图 SHA-256 与 regions 配置的 sourceSha256 不一致")
        cells = analyze_regions(sheet, regions_config, alpha_threshold)
        scale, explicit_anchor = explicit_layout(
            cells, frame_size, padding, neutral_height)
        cell_size = None
    else:
        if sheet_width % columns or sheet_height % rows:
            raise SpritePipelineError(
                f"源图尺寸 {sheet_width}x{sheet_height} 不能被 {columns}x{rows} 网格整除")
        cell_size = (sheet_width // columns, sheet_height // rows)
        cells = analyze_cells(sheet, columns, rows, cell_size, alpha_threshold)
        scale = common_scale(cells, frame_size, padding, neutral_height)

    digits = max(2, len(str(total - 1)))
    records, images = [], []
    for cell in cells:
        if regions_config is None:
            image, scaled_size, paste, output_anchor = build_frame(
                cell, scale, frame_size, padding)
            bbox = cell["bbox"]
            records.append({
                "index": cell["index"], "row": cell["row"], "column": cell["column"],
                "file": f"frame-{cell['index']:0{digits}d}.png",
                "duration_ms": durations[cell["index"]],
                "source_bbox": {"x": bbox[0], "y": bbox[1],
                                "width": bbox[2] - bbox[0], "height": bbox[3] - bbox[1]},
                "source_foot_anchor": {"x": cell["foot_x"], "y": bbox[3]},
                "output_foot_anchor": output_anchor,
                "scaled_size": scaled_size, "paste": paste,
            })
        else:
            image, scaled_size, paste, output_anchor = build_explicit_frame(
                cell, scale, frame_size, padding, explicit_anchor)
            bbox, region = cell["bbox"], cell["region"]
            records.append({
                "index": cell["index"], "row": cell["row"], "column": cell["column"],
                "file": f"frame-{cell['index']:0{digits}d}.png",
                "duration_ms": durations[cell["index"]],
                "source_region": {
                    "x": region["x"], "y": region["y"],
                    "width": region["width"], "height": region["height"],
                },
                "source_bbox": {
                    "x": region["x"] + bbox[0], "y": region["y"] + bbox[1],
                    "width": bbox[2] - bbox[0], "height": bbox[3] - bbox[1],
                },
                "source_anchor": {
                    "x": region["x"] + cell["anchor"]["x"],
                    "y": region["y"] + cell["anchor"]["y"],
                },
                "output_ground_anchor": output_anchor,
                "scaled_size": scaled_size, "paste": paste,
            })
        images.append(image)

    output_names = {"atlas.png", "manifest.json", "contact-sheet-light.png",
                    "contact-sheet-dark.png", *(record["file"] for record in records)}
    if source.parent.resolve() == output.resolve() and source.name in output_names:
        raise SpritePipelineError("输出会覆盖源文件；请更换输出目录或源文件名")

    if regions_config is None:
        spec = {
            "columns": columns, "rows": rows,
            "cell_size": {"width": cell_size[0], "height": cell_size[1]},
            "frame_size": {"width": frame_width, "height": frame_height},
            "alpha_threshold": alpha_threshold, "scale": round(scale, 6),
            "neutral_height": neutral_height,
            "resample": "nearest", "alignment": "foot-bottom-center",
            "padding": padding, "foot_band_ratio": FOOT_BAND_RATIO,
            "anchor_mode": "standing-foot-band",
            "anchor_note": "站立素材底部12%区域alpha范围的中点；尾巴低垂、趴卧或道具低于脚不适用",
        }
    else:
        spec = {
            "columns": columns, "rows": rows,
            "frame_size": {"width": frame_width, "height": frame_height},
            "alpha_threshold": alpha_threshold, "scale": round(scale, 6),
            "neutral_height": neutral_height,
            "resample": "nearest", "alignment": "explicit-region-anchor",
            "padding": padding, "anchor_mode": "explicit-region-anchor",
            "anchor_note": "按配置的每帧源区域与区域内anchor统一缩放；输出地面锚固定，anchor以下像素保留",
            "output_ground_anchor": explicit_anchor,
            "regions_config": {
                "path": regions_config["path"],
                "sha256": regions_config["sha256"],
                "content": regions_config["content"],
            },
        }
    manifest = {
        "tool": "sprite-pipeline",
        "source": {"path": str(source), "sha256": digest,
                   "size": {"width": sheet_width, "height": sheet_height}},
        "spec": spec,
        "loop": loop,
        "frame_durations_ms": durations,
        "atlas": {"file": "atlas.png", "columns": columns, "rows": rows,
                  "frame_size": {"width": frame_width, "height": frame_height}},
        "contact_sheets": {"light": "contact-sheet-light.png",
                           "dark": "contact-sheet-dark.png"},
        "frames": records,
    }

    output.mkdir(parents=True, exist_ok=True)
    for record, image in zip(records, images):
        image.save(output / record["file"])
    atlas = Image.new("RGBA", (frame_width * columns, frame_height * rows), (0, 0, 0, 0))
    for index, image in enumerate(images):
        atlas.alpha_composite(image, ((index % columns) * frame_width, (index // columns) * frame_height))
    atlas.save(output / "atlas.png")
    for light, name in ((True, "contact-sheet-light.png"),
                        (False, "contact-sheet-dark.png")):
        save_contact_sheet(images, durations, columns, rows, frame_size, output / name, light)
    (output / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="固定网格 spritesheet 切帧、统一缩放与脚底中点对齐")
    parser.add_argument(
        "--source", required=True, type=Path, help="源 spritesheet PNG（需含透明通道）")
    parser.add_argument("--columns", required=True, type=positive_int, help="网格列数")
    parser.add_argument("--rows", required=True, type=positive_int, help="网格行数")
    parser.add_argument("--output", required=True, type=Path, help="输出目录")
    parser.add_argument("--frame-size", required=True, type=parse_frame_size,
                        help="单帧画布 WIDTHxHEIGHT，例如 256x256")
    parser.add_argument("--alpha-threshold", type=int, default=16, help="alpha 阈值，默认 16")
    parser.add_argument("--padding", type=non_negative_int, default=DEFAULT_PADDING,
                        help="画布安全边距，默认 8 像素")
    parser.add_argument("--neutral-height", type=positive_int, default=None,
                        help="按第0帧主体高度指定目标像素，全套共用同一 scale；越界报错")
    parser.add_argument("--regions-json", type=Path, default=None,
                        help="可选显式区域 JSON；数量须等于 columns×rows，保持默认网格不变")
    parser.add_argument("--durations-ms", type=parse_durations_ms, default=None,
                        help="逗号分隔的每帧毫秒；默认值为 8 帧呼吸试样时序")
    parser.add_argument("--no-loop", action="store_true", help="在 manifest 中标记 loop=false")
    args = parser.parse_args(argv)

    try:
        manifest = process_sprite_sheet(
            args.source, args.output, args.columns, args.rows, args.frame_size,
            alpha_threshold=args.alpha_threshold, padding=args.padding,
            neutral_height=args.neutral_height,
            durations_ms=args.durations_ms, loop=not args.no_loop,
            regions_json=args.regions_json)
    except (OSError, SpritePipelineError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 2

    print(f"已导出 {len(manifest['frames'])} 帧，"
          f"统一缩放 {manifest['spec']['scale']:.6g}，输出目录 {args.output}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
