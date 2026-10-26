/* 首遇角色的唯一初始数值来源。store 与 discovery-outcomes 都从这里读取，
   避免 discovery-outcomes 反向导入 store 形成循环依赖，也避免复制数值。 */
const INITIAL_STATS = Object.freeze({ intimacy: 10, energy: 100, mood: 0 });

module.exports = { INITIAL_STATS };
