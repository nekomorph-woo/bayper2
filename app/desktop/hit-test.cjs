/* 透明像素命中：用当前显示帧的实际 alpha 判断指针是否落在角色身体上。
   窗口逻辑点按现有 display 计划映射回源图像素；只保留当前一帧 alpha，
   不截屏、不按每次 mousemove 解码。 */
const ALPHA_HIT_THRESHOLD = 16;

function alphaFromBitmap({ width, height, bitmap }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return null;
  }
  if (!bitmap || bitmap.length !== width * height * 4) {
    return null;
  }
  const alpha = new Uint8Array(width * height);
  for (let index = 0; index < alpha.length; index += 1) {
    alpha[index] = bitmap[index * 4 + 3];
  }
  return { width, height, alpha };
}

// Electron nativeImage 的 BGRA 位图：alpha 固定在第 4 字节。
function readAlpha(image) {
  if (!image || typeof image.getSize !== "function" || typeof image.toBitmap !== "function") {
    return null;
  }
  const size = image.getSize();
  return alphaFromBitmap({ width: size?.width, height: size?.height, bitmap: image.toBitmap() });
}

function imagePoint(display, x, y) {
  const scale = Number(display?.scale);
  const offsetX = Number(display?.offsetX);
  const offsetY = Number(display?.offsetY);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.floor((x + offsetX) / scale),
    y: Math.floor((y + offsetY) / scale),
  };
}

function isBodyHit(frame, display, x, y) {
  if (!frame) return false;
  const point = imagePoint(display, x, y);
  if (!point || point.x < 0 || point.y < 0) return false;
  if (point.x >= frame.width || point.y >= frame.height) return false;
  return frame.alpha[point.y * frame.width + point.x] >= ALPHA_HIT_THRESHOLD;
}

/* 当前帧缓存：同一帧的重复 mousemove 不重复解码，换帧或换角色时替换。 */
function createAlphaCache(decode) {
  let key = "";
  let value = null;
  return {
    select(nextKey) {
      if (nextKey === key) return;
      key = nextKey;
      value = nextKey ? decode(nextKey) : null;
    },
    get() {
      return value;
    },
    clear() {
      key = "";
      value = null;
    },
  };
}

module.exports = {
  ALPHA_HIT_THRESHOLD,
  alphaFromBitmap,
  readAlpha,
  imagePoint,
  isBodyHit,
  createAlphaCache,
};
