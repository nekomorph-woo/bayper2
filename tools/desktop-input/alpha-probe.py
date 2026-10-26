#!/usr/bin/env python3
"""S07c 命中点探针：从实际导出 PNG 读取 alpha，按生产同样的 display 映射
给出可点击身体点、稳定透明点和换帧/换角色切换点。只做验收取点，不参与运行时。"""
import json
import math
import sys

try:
    from PIL import Image, ImageChops, ImageFilter
except ImportError:
    print(json.dumps({"ok": False, "error": "需要 Pillow（PIL）"}, ensure_ascii=False))
    sys.exit(2)


def load_alphas(paths):
    return [Image.open(path).convert("RGBA").getchannel("A") for path in paths]


def mask_for(alpha, kind, threshold):
    if kind == "body":
        return alpha.point(lambda value: 255 if value >= threshold else 0)
    return alpha.point(lambda value: 255 if value < threshold else 0)


def eroded(mask, margin):
    return mask.filter(ImageFilter.MinFilter(2 * margin + 1)) if margin > 0 else mask


def combine(masks):
    result = masks[0]
    for mask in masks[1:]:
        result = ImageChops.multiply(result, mask)
    return result


def stable_mask(paths, kind, threshold, margin):
    return combine([eroded(mask_for(image, kind, threshold), margin) for image in load_alphas(paths)])


def image_point(display, x, y):
    scale = float(display["scale"])
    return (
        math.floor((x + float(display["offsetX"])) / scale),
        math.floor((y + float(display["offsetY"])) / scale),
    )


def alpha_at(alpha_images, x, y):
    if x < 0 or y < 0:
        return None
    size = alpha_images[0].size
    if x >= size[0] or y >= size[1]:
        return None
    return [image.getpixel((x, y)) for image in alpha_images]


def mask_at(mask, x, y):
    if x < 0 or y < 0 or x >= mask.size[0] or y >= mask.size[1]:
        return False
    return mask.getpixel((x, y)) > 0


def centroid(alpha_image, threshold):
    total = 0
    sum_x = 0
    sum_y = 0
    width, height = alpha_image.size
    for y in range(height):
        for x in range(width):
            if alpha_image.getpixel((x, y)) >= threshold:
                total += 1
                sum_x += x
                sum_y += y
    if total == 0:
        return (width / 2, height / 2)
    return (sum_x / total, sum_y / total)


def local_points(window, margin=2):
    width = int(window["width"])
    height = int(window["height"])
    for y in range(margin, max(margin + 1, height - margin + 1)):
        for x in range(margin, max(margin + 1, width - margin + 1)):
            yield x, y


def candidate_points(window, from_mask, to_mask, display_from, display_to, margin):
    points = []
    for x, y in local_points(window, margin):
        from_x, from_y = image_point(display_from, x, y)
        to_x, to_y = image_point(display_to, x, y)
        if mask_at(from_mask, from_x, from_y) and mask_at(to_mask, to_x, to_y):
            points.append((x, y))
    return points


def nearest(points, center):
    return min(points, key=lambda point: (point[0] - center[0]) ** 2 + (point[1] - center[1]) ** 2)


def farthest(points, center):
    return max(points, key=lambda point: (point[0] - center[0]) ** 2 + (point[1] - center[1]) ** 2)


def stable_job(job, threshold):
    frames = job["frames"]
    display = job["display"]
    window = job["window"]
    alpha_images = load_alphas(frames)
    center_image = centroid(alpha_images[0], threshold)
    center_local = (
        center_image[0] * float(display["scale"]) - float(display["offsetX"]),
        center_image[1] * float(display["scale"]) - float(display["offsetY"]),
    )
    for margin in (2, 1, 0):
        body_mask = stable_mask(frames, "body", threshold, margin)
        trans_mask = stable_mask(frames, "trans", threshold, margin)
        body = []
        transparent = []
        for x, y in local_points(window, 2):
            image_x, image_y = image_point(display, x, y)
            if mask_at(body_mask, image_x, image_y):
                body.append((x, y))
            if mask_at(trans_mask, image_x, image_y):
                transparent.append((x, y))
        if body and transparent:
            body_point = nearest(body, center_local)
            trans_point = farthest(transparent, center_local)
            body_alpha = alpha_at(alpha_images, *image_point(display, *body_point))
            trans_alpha = alpha_at(alpha_images, *image_point(display, *trans_point))
            return {
                "margin": margin,
                "body": {"x": body_point[0], "y": body_point[1], "alphas": body_alpha},
                "transparent": {
                    "x": trans_point[0],
                    "y": trans_point[1],
                    "alphas": trans_alpha,
                },
            }
    return {"error": "没有同时满足身体与透明的稳定点"}


def toggle_job(job, threshold):
    frames = job["frames"]
    display = job["display"]
    window = job["window"]
    source = int(job["from"])
    target = int(job["to"])
    alpha_images = load_alphas(frames)
    center = (int(window["width"]) / 2, int(window["height"]) / 2)
    for margin in (2, 1, 0):
        from_mask = eroded(mask_for(alpha_images[source], "body", threshold), margin)
        to_mask = eroded(mask_for(alpha_images[target], "trans", threshold), margin)
        points = candidate_points(window, from_mask, to_mask, display, display, 2)
        if points:
            point = nearest(points, center)
            image_pixel = image_point(display, *point)
            values = alpha_at(alpha_images, *image_pixel)
            if not values:
                continue
            return {
                "margin": margin,
                "x": point[0],
                "y": point[1],
                "from": source,
                "to": target,
                "fromAlpha": values[source],
                "toAlpha": values[target],
                "candidates": len(points),
            }
    return {"error": f"帧 {source}->{target} 没有可切换命中点"}


def switch_job(job, threshold):
    window = job["window"]
    from_display = job["fromDisplay"]
    to_display = job["toDisplay"]
    from_images = load_alphas(job["fromFrames"])
    to_images = load_alphas(job["toFrames"])
    from_center = (int(window["width"]) / 2, int(window["height"]) / 2)
    to_center = from_center
    for margin in (2, 1, 0):
        from_body = stable_mask(job["fromFrames"], "body", threshold, margin)
        from_trans = stable_mask(job["fromFrames"], "trans", threshold, margin)
        to_body = stable_mask(job["toFrames"], "body", threshold, margin)
        to_trans = stable_mask(job["toFrames"], "trans", threshold, margin)
        trans_to_body = candidate_points(
            window, from_trans, to_body, from_display, to_display, 2
        )
        body_to_trans = candidate_points(
            window, from_body, to_trans, from_display, to_display, 2
        )
        if trans_to_body and body_to_trans:
            first = nearest(trans_to_body, to_center)
            second = nearest(body_to_trans, from_center)
            first_from = alpha_at(from_images, *image_point(from_display, *first))
            first_to = alpha_at(to_images, *image_point(to_display, *first))
            second_from = alpha_at(from_images, *image_point(from_display, *second))
            second_to = alpha_at(to_images, *image_point(to_display, *second))
            if not (first_from and first_to and second_from and second_to):
                continue
            return {
                "margin": margin,
                "transToBody": {
                    "x": first[0],
                    "y": first[1],
                    "fromAlphas": first_from,
                    "toAlphas": first_to,
                },
                "bodyToTrans": {
                    "x": second[0],
                    "y": second[1],
                    "fromAlphas": second_from,
                    "toAlphas": second_to,
                },
            }
    return {"error": "没有可用的换角色命中切换点"}


def main():
    request = json.load(sys.stdin)
    threshold = int(request.get("threshold", 16))
    results = {}
    for job in request.get("jobs", []):
        kind = job.get("kind")
        if kind == "stable":
            results[job["id"]] = stable_job(job, threshold)
        elif kind == "toggle":
            results[job["id"]] = toggle_job(job, threshold)
        elif kind == "switch":
            results[job["id"]] = switch_job(job, threshold)
        else:
            results[job["id"]] = {"error": f"未知任务类型 {kind}"}
    print(json.dumps({"ok": True, "threshold": threshold, "results": results}, ensure_ascii=False))


if __name__ == "__main__":
    main()
