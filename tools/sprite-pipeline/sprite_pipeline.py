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

def common_scale(cells: list[dict], frame_size: tuple[int, int], padding: int) -> float:
    """统一缩放：容纳各帧相对脚锚点的左右与上方最大扩展，避免尾巴被裁。"""
    anchor_x = frame_size[0] // 2
    max_left = max(cell["foot_x"] - cell["bbox"][0] for cell in cells)
    max_right = max(cell["bbox"][2] - cell["foot_x"] for cell in cells)
    max_top = max(cell["bbox"][3] - cell["bbox"][1] for cell in cells)
    capacities = (anchor_x - padding, frame_size[0] - padding - anchor_x,
                  frame_size[1] - 2 * padding)
    if min(capacities) <= 0:
        raise SpritePipelineError("padding 过大或画布过小，无法保留安全边距")
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
                         padding: int = DEFAULT_PADDING,
                         durations_ms: list[int] | None = None, loop: bool = True) -> dict:
    source, output = Path(source), Path(output)
    frame_width, frame_height = frame_size
    total = columns * rows
    if min(columns, rows, frame_width, frame_height) <= 0:
        raise SpritePipelineError("columns、rows 和 frame-size 必须是正整数")
    if not 0 <= alpha_threshold <= 255:
        raise SpritePipelineError("alpha-threshold 必须在 0～255 之间")
    if padding < 0:
        raise SpritePipelineError("padding 必须是非负整数")

    durations = list(DEFAULT_DURATIONS_MS if durations_ms is None else durations_ms)
    if len(durations) != total:
        raise SpritePipelineError(
            f"帧时长数量 {len(durations)} 与帧数 {total} 不一致；请用 --durations-ms 指定")
    if any(not isinstance(duration, int) or duration <= 0 for duration in durations):
        raise SpritePipelineError("帧时长必须是正整数毫秒")

    sheet, digest = load_source(source)
    sheet_width, sheet_height = sheet.size
    if sheet_width % columns or sheet_height % rows:
        raise SpritePipelineError(
            f"源图尺寸 {sheet_width}x{sheet_height} 不能被 {columns}x{rows} 网格整除")
    cell_size = (sheet_width // columns, sheet_height // rows)
    cells = analyze_cells(sheet, columns, rows, cell_size, alpha_threshold)
    scale = common_scale(cells, frame_size, padding)

    digits = max(2, len(str(total - 1)))
    records, images = [], []
    for cell in cells:
        image, scaled_size, paste, output_anchor = build_frame(
            cell, scale, frame_size, padding)
        images.append(image)
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

    output_names = {"atlas.png", "manifest.json", "contact-sheet-light.png",
                    "contact-sheet-dark.png", *(record["file"] for record in records)}
    if source.parent.resolve() == output.resolve() and source.name in output_names:
        raise SpritePipelineError("输出会覆盖源文件；请更换输出目录或源文件名")

    manifest = {
        "tool": "sprite-pipeline",
        "source": {"path": str(source), "sha256": digest,
                   "size": {"width": sheet_width, "height": sheet_height}},
        "spec": {"columns": columns, "rows": rows,
                 "cell_size": {"width": cell_size[0], "height": cell_size[1]},
                 "frame_size": {"width": frame_width, "height": frame_height},
                 "alpha_threshold": alpha_threshold, "scale": round(scale, 6),
                 "resample": "nearest", "alignment": "foot-bottom-center",
                 "padding": padding, "foot_band_ratio": FOOT_BAND_RATIO,
                 "anchor_mode": "standing-foot-band",
                 "anchor_note": "站立素材底部12%区域alpha范围的中点；尾巴低垂、趴卧或道具低于脚不适用"},
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
    parser.add_argument("--durations-ms", type=parse_durations_ms, default=None,
                        help="逗号分隔的每帧毫秒；默认值为 8 帧呼吸试样时序")
    parser.add_argument("--no-loop", action="store_true", help="在 manifest 中标记 loop=false")
    args = parser.parse_args(argv)

    try:
        manifest = process_sprite_sheet(
            args.source, args.output, args.columns, args.rows, args.frame_size,
            alpha_threshold=args.alpha_threshold, padding=args.padding,
            durations_ms=args.durations_ms, loop=not args.no_loop)
    except (OSError, SpritePipelineError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 2

    print(f"已导出 {len(manifest['frames'])} 帧，"
          f"统一缩放 {manifest['spec']['scale']:.6g}，输出目录 {args.output}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
