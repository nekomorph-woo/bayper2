// 用 Node 内置 assert 驱动真实 clips.json 与共用 controller，按合同逐条断言。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createController } from "./controller.mjs";

const data = JSON.parse(
  readFileSync(new URL("./assets/processed/clips.json", import.meta.url), "utf8"),
);
const clips = data.clips;
const fresh = () => createController(clips);
const play = (controller, milliseconds) => controller.advance(milliseconds);
const pos = (controller) => {
  const snapshot = controller.snapshot();
  return { clip: snapshot.clip, frame: snapshot.frame,
           playhead: snapshot.playhead, suspended: snapshot.suspended };
};

// 元数据：三 clip 的真实位置、帧数与时长。
assert.equal(data.frame_size, 256);
assert.deepEqual(Object.keys(clips).sort(), ["alert", "idle", "wave"]);
assert.deepEqual([clips.idle.frames.length, clips.wave.frames.length, clips.alert.frames.length],
  [6, 4, 4]);
assert.deepEqual(clips.idle.frames.map((frame) => [frame.x, frame.y, frame.duration]),
  [[0, 0, 150], [256, 0, 150], [512, 0, 150], [0, 256, 150], [256, 256, 150], [512, 256, 150]]);
assert.deepEqual(clips.wave.frames.map((frame) => [frame.x, frame.y, frame.duration]),
  [[0, 0, 600], [256, 0, 600], [512, 0, 600], [768, 0, 600]]);
assert.deepEqual(clips.alert.frames.map((frame) => [frame.x, frame.y, frame.duration]),
  [[0, 256, 200], [256, 256, 250], [512, 256, 250], [768, 256, 200]]);
assert.deepEqual([clips.idle.loop, clips.wave.loop, clips.alert.loop], [true, false, false]);
for (const atlas of new Set(Object.values(clips).map((clip) => clip.atlas))) {
  assert.ok(existsSync(new URL(atlas, import.meta.url)), `图集不存在：${atlas}`);
}
console.log("PASS 元数据：idle6/wave4/alert4，时长与位置来自 clips.json");

// ACT-02：idle 触发 wave 播一次；alert 独立触发并回到 idle 起点。
let controller = fresh();
assert.deepEqual(pos(controller), { clip: "idle", frame: 0, playhead: 0, suspended: null });
controller.trigger("wave", "click");
assert.deepEqual(pos(controller), { clip: "wave", frame: 0, playhead: 0, suspended: null });
play(controller, 600);
assert.equal(controller.snapshot().frame, 1);
play(controller, 600);
assert.equal(controller.snapshot().frame, 2);
play(controller, 1200);
assert.deepEqual(pos(controller), { clip: "idle", frame: 0, playhead: 0, suspended: null });
play(controller, 450);
assert.equal(controller.snapshot().frame, 3);
controller.trigger("alert", "keyboard");
assert.deepEqual(pos(controller), { clip: "alert", frame: 0, playhead: 0, suspended: null });
play(controller, 900);
assert.deepEqual(pos(controller), { clip: "idle", frame: 0, playhead: 0, suspended: null });
controller.trigger("wave", "keyboard");
play(controller, 2400);
assert.equal(controller.snapshot().clip, "idle");
console.log("PASS ACT-02：wave 一次 2400ms，alert 900ms 后回 idle 起点");

// ACT-03：wave 900ms 时被 alert 打断，900ms 后从精确 playhead 恢复，再 1500ms 完成。
controller = fresh();
controller.trigger("wave", "click");
play(controller, 900);
assert.deepEqual(pos(controller), { clip: "wave", frame: 1, playhead: 900, suspended: null });
controller.trigger("alert", "keyboard");
assert.deepEqual(pos(controller), { clip: "alert", frame: 0, playhead: 0,
  suspended: { clip: "wave", playhead: 900 } });
const interrupt = controller.snapshot().events.at(-1);
assert.deepEqual([interrupt.type, interrupt.playhead, interrupt.source],
  ["interrupt", 900, "keyboard"]);

// alert 非均匀帧时长边界：200 / 450 / 700 / 900。
for (const [advance, expected] of [[199, [0, 199]], [1, [1, 200]], [249, [1, 449]],
  [1, [2, 450]], [250, [3, 700]], [199, [3, 899]]]) {
  play(controller, advance);
  const snapshot = controller.snapshot();
  assert.deepEqual([snapshot.frame, snapshot.playhead], expected);
}
play(controller, 1);
assert.deepEqual(pos(controller), { clip: "wave", frame: 1, playhead: 900, suspended: null });
assert.deepEqual(controller.snapshot().events.slice(-2)
  .map((event) => [event.type, event.playhead]), [["complete", 900], ["resume", 900]]);
play(controller, 599);
assert.deepEqual([controller.snapshot().frame, controller.snapshot().playhead], [2, 1499]);
play(controller, 901);
assert.deepEqual(pos(controller), { clip: "idle", frame: 0, playhead: 0, suspended: null });
const events = controller.snapshot().events;
assert.ok(events.some((event) => event.type === "complete" && event.clip === "wave"
  && event.playhead === 2400));
assert.ok(!events.some((event) => event.type === "resume" && event.playhead === 0));
console.log("PASS ACT-03：900ms 中断、900ms 恢复、剩余 1500ms，alert 边界正确");

// ACT-04：alert 中 wave/重复 alert 忽略，不覆盖 saved、不延长 alert；重复 wave 不重启。
controller = fresh();
controller.trigger("wave", "click");
play(controller, 300);
controller.trigger("wave", "click");
assert.deepEqual(pos(controller), { clip: "wave", frame: 0, playhead: 300, suspended: null });
assert.equal(controller.snapshot().events.at(-1).reason, "wave-active");
controller.trigger("alert", "keyboard");
play(controller, 100);
controller.trigger("wave", "click");
controller.trigger("alert", "keyboard");
assert.deepEqual(pos(controller), { clip: "alert", frame: 0, playhead: 100,
  suspended: { clip: "wave", playhead: 300 } });
assert.equal(controller.snapshot().events.at(-1).reason, "alert-active");
assert.equal(controller.snapshot().events.filter((event) => event.type === "ignored").length, 3);
play(controller, 799);
assert.equal(controller.snapshot().playhead, 899);
play(controller, 1);
assert.deepEqual(pos(controller), { clip: "wave", frame: 0, playhead: 300, suspended: null });
play(controller, 2100);
assert.equal(controller.snapshot().clip, "idle");
console.log("PASS ACT-04：低优先级与重复请求被忽略，saved 与 alert 时长不变");

// ACT-06：一次大 dt 处理 alert→wave→idle；reset 清空 suspended。
controller = fresh();
controller.trigger("wave", "click");
play(controller, 1200);
controller.trigger("alert", "keyboard");
play(controller, 5000);
assert.deepEqual(pos(controller), { clip: "idle", frame: 1, playhead: 200, suspended: null });
const crossed = controller.snapshot().events;
assert.ok(crossed.some((event) => event.type === "complete" && event.clip === "alert"
  && event.playhead === 900));
assert.ok(crossed.some((event) => event.type === "resume" && event.playhead === 1200));
assert.ok(crossed.some((event) => event.type === "complete" && event.clip === "wave"
  && event.playhead === 2400));
controller = fresh();
controller.trigger("wave", "click");
play(controller, 5000);
assert.deepEqual(pos(controller), { clip: "idle", frame: 5, playhead: 800, suspended: null });
controller = fresh();
controller.trigger("wave", "click");
play(controller, 900);
controller.trigger("alert", "keyboard");
play(controller, 300);
assert.deepEqual(controller.snapshot().suspended, { clip: "wave", playhead: 900 });
controller.reset();
assert.deepEqual(pos(controller), { clip: "idle", frame: 0, playhead: 0, suspended: null });
assert.equal(controller.snapshot().events.at(-1).type, "reset");
play(controller, 9000);
assert.equal(controller.snapshot().playhead, 0);
controller.trigger("wave", "click");
assert.equal(controller.snapshot().clip, "wave");
console.log("PASS ACT-06：大 dt 跨 alert→wave→idle，reset 清空 suspended 与进度");
console.log("controller.test.mjs：全部断言通过");
