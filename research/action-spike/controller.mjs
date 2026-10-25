// 浏览器与 Node 共用的实际动作控制器：只服务 idle / wave / alert 三个固定 clip。
// 播放进度由调用方推进，不使用动作结束回调，避免旧计时器抢回状态。

const CLIP_NAMES = ["idle", "wave", "alert"];
const EVENT_LIMIT = 50;

export function createController(clips) {
  const durations = {};
  const totals = {};
  for (const name of CLIP_NAMES) {
    if (!Array.isArray(clips[name]?.frames) || clips[name].frames.length === 0) {
      throw new Error(`clips.json 缺少 ${name} 帧`);
    }
    durations[name] = clips[name].frames.map((frame) => frame.duration);
    totals[name] = durations[name].reduce((sum, value) => sum + value, 0);
  }

  let clip = "idle";
  let playhead = 0;
  // alert 打断 wave 时保存精确 playhead；只保存 wave 一处，不排队。
  let suspended = null;
  const events = [];

  function log(type, details) {
    events.push({ type, ...details });
    if (events.length > EVENT_LIMIT) events.shift();
  }

  function frameAt(name, time) {
    let boundary = 0;
    for (let index = 0; index < durations[name].length; index += 1) {
      boundary += durations[name][index];
      if (time < boundary) return index;
    }
    return durations[name].length - 1;
  }

  function trigger(name, source = "manual") {
    if (name === "wave") {
      if (clip === "idle") {
        clip = "wave";
        playhead = 0;
        return;
      }
      log("ignored", { request: "wave", source, clip, playhead,
                       reason: clip === "alert" ? "alert-active" : "wave-active" });
      return;
    }
    if (name === "alert") {
      if (clip === "wave") {
        suspended = { clip: "wave", playhead };
        log("interrupt", { clip: "wave", playhead, by: "alert", source });
        clip = "alert";
        playhead = 0;
        return;
      }
      if (clip === "idle") {
        // idle 被 alert 打断不保留 idle 进度；alert 完成回到 idle 起点。
        suspended = null;
        clip = "alert";
        playhead = 0;
        return;
      }
      log("ignored", { request: "alert", source, clip, playhead, reason: "alert-active" });
      return;
    }
    log("ignored", { request: name, source, clip, playhead, reason: "unknown-clip" });
  }

  function advance(dt) {
    if (!(dt > 0)) return;
    let remaining = dt;
    while (remaining > 0) {
      if (clip === "idle") {
        // idle 循环没有结束回调，直接取模，剩余 dt 不会残留。
        playhead = (playhead + remaining) % totals.idle;
        return;
      }
      const room = totals[clip] - playhead;
      if (remaining < room) {
        playhead += remaining;
        return;
      }
      // 恰好或越过动作结尾：完成当前动作，再用剩余 dt 推进下一个动作。
      remaining -= room;
      const finished = clip;
      playhead = totals[finished];
      log("complete", { clip: finished, playhead, duration: totals[finished] });
      if (finished === "alert" && suspended) {
        clip = suspended.clip;
        playhead = suspended.playhead;
        suspended = null;
        log("resume", { clip, playhead });
      } else {
        clip = "idle";
        playhead = 0;
      }
    }
  }

  function reset() {
    log("reset", { clip, playhead, suspended: suspended ? { ...suspended } : null });
    clip = "idle";
    playhead = 0;
    suspended = null;
  }

  function snapshot() {
    return {
      clip, playhead, frame: frameAt(clip, playhead),
      suspended: suspended ? { ...suspended } : null,
      events: events.map((event) => ({ ...event })),
    };
  }

  return { trigger, advance, reset, snapshot };
}
