/* S07c 透明命中纯坐标/阈值测试：实际窗口路由由 s07c 验收用例单独覆盖。 */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  ALPHA_HIT_THRESHOLD,
  alphaFromBitmap,
  readAlpha,
  imagePoint,
  isBodyHit,
  createAlphaCache,
} = require("../../app/desktop/hit-test.cjs");

function bitmap(width, height, alphas) {
  const buffer = Buffer.alloc(width * height * 4);
  alphas.forEach((alpha, index) => {
    buffer[index * 4 + 3] = alpha;
  });
  return buffer;
}

function frame(width, height, alphas) {
  return alphaFromBitmap({ width, height, bitmap: bitmap(width, height, alphas) });
}

test("POL-HIT-002 alpha 取自 BGRA 第 4 字节，阈值 16 为身体", () => {
  const decoded = frame(2, 2, [0, 15, 16, 255]);
  assert.ok(decoded);
  assert.equal(decoded.alpha[0], 0);
  assert.equal(decoded.alpha[1], ALPHA_HIT_THRESHOLD - 1);
  assert.equal(decoded.alpha[2], ALPHA_HIT_THRESHOLD);
  assert.equal(decoded.alpha[3], 255);
  // 位图长度与声明尺寸不一致时不能把错位内存当作 alpha。
  assert.equal(alphaFromBitmap({ width: 2, height: 2, bitmap: Buffer.alloc(3) }), null);
  const fakeImage = {
    getSize: () => ({ width: 2, height: 2 }),
    toBitmap: () => bitmap(2, 2, [0, 15, 16, 255]),
  };
  assert.deepEqual([...readAlpha(fakeImage).alpha], [0, 15, 16, 255]);
});

test("POL-HIT-002 窗口逻辑点按 display 缩放/裁剪映射到图像坐标", () => {
  const display = { scale: 0.4, offsetX: 20, offsetY: 8 };
  // local(0,0) -> image(50,20)；像素中心 local(0.2,0.2) 仍映射到同一格。
  assert.deepEqual(imagePoint(display, 0, 0), { x: 50, y: 20 });
  assert.deepEqual(imagePoint(display, 0.2, 0.2), { x: 50, y: 20 });
  assert.deepEqual(imagePoint(display, 40, 40), { x: 150, y: 120 });
  // 负局部坐标（指针在窗口外）和无效 display 不得误命中。
  assert.deepEqual(imagePoint(display, -100, -100), { x: -200, y: -230 });
  assert.equal(imagePoint({ scale: 0 }, 0, 0), null);
  assert.equal(imagePoint({ scale: 0.4, offsetX: 0, offsetY: 0 }, NaN, 0), null);
});

test("POL-HIT-002 透明、越界与阈值以下像素均不进身体命中", () => {
  const body = frame(2, 2, [255, 0, 16, 15]);
  const display = { scale: 1, offsetX: 0, offsetY: 0 };
  assert.equal(isBodyHit(body, display, 0, 0), true);
  assert.equal(isBodyHit(body, display, 1, 0), false);
  assert.equal(isBodyHit(body, display, 0, 1), true);
  assert.equal(isBodyHit(body, display, 1, 1), false);
  assert.equal(isBodyHit(body, display, -1, 0), false);
  assert.equal(isBodyHit(body, display, 2, 0), false);
  assert.equal(isBodyHit(null, display, 0, 0), false);
});

test("POL-HIT-002 只缓存当前帧，重复 mousemove 不重复解码", () => {
  const decoded = [];
  const cache = createAlphaCache((key) => {
    decoded.push(key);
    return { key };
  });
  cache.select("frame-a");
  cache.select("frame-a");
  cache.select("frame-a");
  assert.deepEqual(decoded, ["frame-a"]);
  assert.deepEqual(cache.get(), { key: "frame-a" });
  cache.select("frame-b");
  assert.deepEqual(decoded, ["frame-a", "frame-b"]);
  cache.clear();
  assert.equal(cache.get(), null);
  cache.select("frame-b");
  assert.deepEqual(decoded, ["frame-a", "frame-b", "frame-b"]);
});
