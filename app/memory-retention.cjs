/* S03q 普通细节上下文的年龄淡化。只服务 buildContext 的 details 排序：
   不参与管理检索、纠正/删除候选，也不读写数据库或刷新 updatedAt。
   借鉴 LangChain time_weighted_retriever 将时间与相关性分开计算的思路，
   不引入其依赖或向量库；重要性与事实有效性仍由本项目约束判断。 */
const DETAIL_CONTEXT_CONFIG = Object.freeze({
  decay: true,
  maxEntries: 3,
  // 正式检索先取有界候选池；混合类别在 20 条处会饿死 details，故名额另留。
  candidatePool: 50,
  candidateLimit: 20,
  halfLifeDays: 30,
  floor: 0.1,
  importantThreshold: 80,
});

function detailRetention(entry, nowMs, config = DETAIL_CONTEXT_CONFIG) {
  if (entry.importance >= config.importantThreshold) {
    return 1;
  }
  // 时钟回拨时 ageDays 归零，保留率不会超过 1。
  const ageDays = Math.max(0, nowMs - entry.updatedAt) / 86_400_000;
  return Math.max(config.floor, 2 ** (-ageDays / config.halfLifeDays));
}

/* candidate 下标是过滤出 detail 后的正式检索相对顺序（0 起），不是混合类别
   候选池的全量下标；只乘年龄保留率，不按年龄重排来源。
   分数降序取最多 maxEntries 条，同分保持原检索顺序。 */
function rankDetailCandidates(candidates, {
  nowMs,
  decay = DETAIL_CONTEXT_CONFIG.decay,
  config = DETAIL_CONTEXT_CONFIG,
} = {}) {
  return candidates
    .slice(0, config.candidateLimit)
    .map((entry, rank) => ({
      entry,
      rank,
      score: (1 / (rank + 1)) * (decay ? detailRetention(entry, nowMs, config) : 1),
    }))
    .sort((left, right) => right.score - left.score || left.rank - right.rank)
    .slice(0, config.maxEntries)
    .map((row) => row.entry);
}

module.exports = { DETAIL_CONTEXT_CONFIG, detailRetention, rankDetailCandidates };
