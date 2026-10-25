/** 审查播放器的显示缩放：默认 1 保持源尺寸，只改变 CSS 显示大小，不重采样。 */
const MIN_SCALE = 0.1;
const MAX_SCALE = 4;

function parseDisplayScale(value) {
  if (value === undefined || value === null) return 1;
  const scale = Number(value);
  if (!Number.isFinite(scale) || scale < MIN_SCALE || scale > MAX_SCALE) {
    throw new Error(`--display-scale 必须为 ${MIN_SCALE} 到 ${MAX_SCALE} 之间的有限数，收到 ${JSON.stringify(value)}`);
  }
  return scale;
}

function displaySize(frameSize, scale) {
  return { width: frameSize.width * scale, height: frameSize.height * scale };
}

module.exports = { MIN_SCALE, MAX_SCALE, parseDisplayScale, displaySize };
