/* 手动切换/休息前的自然节点等待：超时不能当作已经收束。
   等待时长由当前已导出动画的 manifest 时长推导，而不是固定等一小段。 */
const { AppError } = require("./errors.cjs");

const NODE_TIMEOUT_MARGIN_MS = 1200;
const MIN_NODE_TIMEOUT_MS = 2500;

function animationDuration(animation) {
  if (!animation || !Array.isArray(animation.durations)) {
    return 0;
  }
  return animation.durations.reduce((total, value) => total + Number(value || 0), 0);
}

function boundaryTimeoutFor(presentation) {
  const animations = presentation?.animations;
  const longest = Math.max(
    animationDuration(animations?.idle),
    animationDuration(animations?.wave),
    animationDuration(animations?.sit),
    // 困倦/睡眠阶段用同一个有限上限等待 sleep 循环末，不永久等下一次自然节点。
    animationDuration(animations?.drowsy),
    animationDuration(animations?.sleep),
  );
  return Math.max(MIN_NODE_TIMEOUT_MS, longest + NODE_TIMEOUT_MARGIN_MS);
}

function assertBoundaryCompleted(result) {
  if (!result || result.ok) {
    return;
  }
  if (result.reason === "timeout") {
    throw new AppError(
      "NODE_TIMEOUT",
      "当前动作还没有自然收束，请稍后再试；若持续无法完成，可从托盘重启角色画布。",
    );
  }
  // asset-error/child-exit/no-canvas 等表示播放器不可用；允许用户主动换人恢复。
}

module.exports = {
  boundaryTimeoutFor,
  assertBoundaryCompleted,
  NODE_TIMEOUT_MARGIN_MS,
  MIN_NODE_TIMEOUT_MS,
};
