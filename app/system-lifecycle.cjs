/* 系统暂停原因协调：锁屏与休眠可交错，只有所有原因都解除才恢复业务。 */
const EVENTS = [
  ["suspend", "suspend", "pause"],
  ["lock-screen", "lock", "pause"],
  ["resume", "suspend", "resume"],
  ["unlock-screen", "lock", "resume"],
];

function createSystemLifecycle(powerMonitor, { onPause, onResume }) {
  const reasons = new Set();
  const handlers = [];

  function pause(reason) {
    if (!reason) {
      return;
    }
    const wasPaused = reasons.size > 0;
    reasons.add(reason);
    if (!wasPaused) {
      onPause();
    }
  }

  function resume(reason) {
    if (!reason || !reasons.has(reason)) {
      return;
    }
    reasons.delete(reason);
    if (reasons.size === 0) {
      onResume();
    }
  }

  for (const [eventName, reason, kind] of EVENTS) {
    const handler = () => (kind === "pause" ? pause(reason) : resume(reason));
    powerMonitor.on(eventName, handler);
    handlers.push([eventName, handler]);
  }

  return {
    isPaused: () => reasons.size > 0,
    reasons: () => Array.from(reasons),
    unbind() {
      for (const [eventName, handler] of handlers) {
        powerMonitor.removeListener(eventName, handler);
      }
      handlers.length = 0;
    },
  };
}

module.exports = { createSystemLifecycle };
