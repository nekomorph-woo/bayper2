/* 对比页：把两张预览卡按容器的实际宽度等比缩放，
   并在角标里如实写出缩放比例；全尺寸模式才用 1:1 直接渲染。 */

const frames = [...document.querySelectorAll('.frame')];
const grid = document.querySelector('.cmp__grid');
const full = document.querySelector('#full');
const toggle = document.querySelector('[data-toggle-full]');

function fitFrames() {
  frames.forEach((frame) => {
    const scale = frame.clientWidth / 1200;
    frame.style.setProperty('--s', scale.toFixed(4));
    const label = frame.closest('.card').querySelector('.frame__scale b');
    if (label) label.textContent = `${Math.round(scale * 100)}%`;
  });
}

fitFrames();
window.addEventListener('resize', fitFrames);

toggle.addEventListener('click', () => {
  const expand = toggle.getAttribute('aria-pressed') !== 'true';

  toggle.setAttribute('aria-pressed', String(expand));
  toggle.textContent = expand ? '返回对比' : '并排看全尺寸';
  grid.hidden = expand;
  full.hidden = !expand;

  if (expand) {
    // 第一次进入全尺寸才加载这两个 1:1 窗口，避免重复请求。
    full.querySelectorAll('iframe').forEach((iframe) => {
      if (!iframe.getAttribute('src')) iframe.src = iframe.dataset.src;
    });
    window.scrollTo({ top: 0 });
  }
});
