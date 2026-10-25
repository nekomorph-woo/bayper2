const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createSystemLifecycle } = require("../../app/system-lifecycle.cjs");

test("POL-DESKTOP-006 锁屏与休眠交错保持真实暂停状态，全部解除后才恢复", () => {
  const powerMonitor = new EventEmitter();
  let pauses = 0;
  let resumes = 0;
  const lifecycle = createSystemLifecycle(powerMonitor, {
    onPause: () => {
      pauses += 1;
    },
    onResume: () => {
      resumes += 1;
    },
  });

  powerMonitor.emit("lock-screen");
  powerMonitor.emit("suspend");
  assert.equal(lifecycle.isPaused(), true);
  assert.deepEqual(lifecycle.reasons().sort(), ["lock", "suspend"]);
  powerMonitor.emit("resume");
  assert.equal(lifecycle.isPaused(), true, "屏幕仍锁定时不得提前恢复");
  assert.deepEqual(lifecycle.reasons(), ["lock"]);
  powerMonitor.emit("unlock-screen");
  assert.equal(lifecycle.isPaused(), false);
  assert.equal(pauses, 1);
  assert.equal(resumes, 1);

  powerMonitor.emit("suspend");
  powerMonitor.emit("lock-screen");
  powerMonitor.emit("unlock-screen");
  assert.equal(lifecycle.isPaused(), true, "休眠未结束不得恢复");
  powerMonitor.emit("resume");
  assert.equal(lifecycle.isPaused(), false);
  assert.equal(pauses, 2);
  assert.equal(resumes, 2);

  powerMonitor.emit("lock-screen");
  powerMonitor.emit("lock-screen");
  assert.deepEqual(lifecycle.reasons(), ["lock"]);
  powerMonitor.emit("unlock-screen");
  powerMonitor.emit("unlock-screen");
  assert.equal(pauses, 3);
  assert.equal(resumes, 3);

  lifecycle.unbind();
  powerMonitor.emit("suspend");
  powerMonitor.emit("resume");
  assert.equal(lifecycle.isPaused(), false);
  assert.equal(pauses, 3);
  assert.equal(resumes, 3);
});
