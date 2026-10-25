const { manifest, frameUrls, displaySize } = window.reviewData;
const frame = document.querySelector('#frame');
const status = document.querySelector('#status');
const playButton = document.querySelector('#play');
const speedSelect = document.querySelector('#speed');
const durations = manifest.frames.map((item) => item.duration_ms);
// 只按 scale 设置 CSS 显示尺寸，源帧和 manifest 均不改动。
frame.style.width = `${displaySize.width}px`;
frame.style.height = `${displaySize.height}px`;

let frameIndex = 0;
let elapsed = 0;
let lastTime = null;
let playing = true;
let speed = 1;
let loops = 0;

function show() {
  frame.src = frameUrls[frameIndex];
  status.textContent = `帧 ${frameIndex + 1} / ${durations.length}　循环 ${loops}`;
}

function step(delta) {
  frameIndex = (frameIndex + delta + durations.length) % durations.length;
  elapsed = 0;
  show();
}

function tick(now) {
  if (lastTime === null) lastTime = now;
  const delta = now - lastTime;
  lastTime = now;
  if (playing) {
    elapsed += delta * speed;
    while (elapsed >= durations[frameIndex]) {
      elapsed -= durations[frameIndex];
      if (frameIndex < durations.length - 1) {
        frameIndex += 1;
      } else if (manifest.loop) {
        frameIndex = 0;
        loops += 1;
      } else {
        playing = false;
        playButton.textContent = '播放';
        break;
      }
      show();
    }
  }
  requestAnimationFrame(tick);
}

playButton.addEventListener('click', () => {
  if (!playing && !manifest.loop && frameIndex === durations.length - 1) {
    frameIndex = 0;
    elapsed = 0;
    loops = 0;
    show();
  }
  playing = !playing;
  playButton.textContent = playing ? '暂停' : '播放';
});
speedSelect.addEventListener('change', () => {
  speed = Number(speedSelect.value);
});
document.querySelector('#prev').addEventListener('click', () => step(-1));
document.querySelector('#next').addEventListener('click', () => step(1));
document.querySelector('#background').addEventListener('click', (event) => {
  const dark = document.body.classList.toggle('dark');
  event.currentTarget.textContent = dark ? '背景：深' : '背景：浅';
});

show();
requestAnimationFrame(tick);
