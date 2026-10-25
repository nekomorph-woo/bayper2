#!/usr/bin/env node
/** 构造检查 --display-scale 的解析、边界与尺寸换算，不启动 GUI。 */
const assert = require('node:assert/strict');
const { MIN_SCALE, MAX_SCALE, parseDisplayScale, displaySize } =
  require('./display-scale.cjs');

assert.equal(parseDisplayScale(undefined), 1);
assert.equal(parseDisplayScale(null), 1);
assert.equal(parseDisplayScale('1'), 1);
assert.equal(parseDisplayScale('0.5'), 0.5);
assert.equal(parseDisplayScale(String(MAX_SCALE)), MAX_SCALE);
for (const bad of ['0', '-1', '', 'abc', 'NaN', 'Infinity',
  String(MIN_SCALE / 2), String(MAX_SCALE + 1)]) {
  assert.throws(() => parseDisplayScale(bad), /--display-scale/, `应拒绝 ${bad}`);
}
assert.deepEqual(displaySize({ width: 256, height: 384 }, 1),
  { width: 256, height: 384 });
assert.deepEqual(displaySize({ width: 256, height: 384 }, 0.5),
  { width: 128, height: 192 });
console.log('display-scale: OK');
