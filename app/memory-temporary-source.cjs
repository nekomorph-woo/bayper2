/* S03m 2c-1 临时理解来源标识：只解析/构建无正文来源字符串。
   临时理解共用随机身份 T，来源中只嵌入锚条目与 chat 消息标识；这里不访问
   数据库，也不判断事实是否同一。S03p 起，时间约束临时理解可追加第五段
   “今日授权”回答消息；旧四段来源保持原样。 */
const DIRECT_SOURCE =
  /^chat-current:([^:\s]+):(\d+):(chat:[^:\s]+)(?::(chat:[^:\s]+))?$/u;
/* copy 与 edit 共用同一段无正文锚信息；edit 只额外表示正文经过面板编辑，
   不声称与消息片段逐字一致。 */
const COPY_LIKE_SOURCE =
  /^(chat-current-copy|temporary-edit):([^:\s]+):(\d+):([^:\s]+):(\d+):([^:\s]+):(\d+):(chat:[^:\s]+)(?::(chat:[^:\s]+))?$/u;

function parseTemporarySource(sourceId) {
  if (typeof sourceId !== "string") {
    return null;
  }
  const direct = DIRECT_SOURCE.exec(sourceId);
  if (direct) {
    return {
      kind: "direct",
      originLongEntryId: direct[1],
      originLongVersion: null,
      originCurrentEntryId: null,
      originCurrentVersion: null,
      holderLongEntryId: null,
      holderLongVersion: 0,
      messageSourceId: direct[3],
      timeSourceId: direct[4] ?? null,
    };
  }
  const copy = COPY_LIKE_SOURCE.exec(sourceId);
  if (!copy) {
    return null;
  }
  const holderLong = copy[6] === "-" ? null : copy[6];
  return {
    kind: copy[1] === "temporary-edit" ? "edit" : "copy",
    originLongEntryId: copy[2],
    originLongVersion: Number(copy[3]),
    originCurrentEntryId: copy[4],
    originCurrentVersion: Number(copy[5]),
    holderLongEntryId: holderLong,
    holderLongVersion: holderLong ? Number(copy[7]) : 0,
    messageSourceId: copy[8],
    timeSourceId: copy[9] ?? null,
  };
}

function isTemporarySource(sourceId) {
  return parseTemporarySource(sourceId) !== null;
}

function directTemporarySource({
  originLongEntryId, createdAt, messageSourceId, timeSourceId = null,
}) {
  return `chat-current:${originLongEntryId}:${createdAt}:${messageSourceId}` +
    `${timeSourceId ? `:${timeSourceId}` : ""}`;
}

function copiedTemporarySource({
  originLongEntryId,
  originLongVersion,
  originCurrentEntryId,
  originCurrentVersion,
  holderLongEntryId,
  holderLongVersion,
  messageSourceId,
  timeSourceId = null,
}) {
  return temporaryCopySource("chat-current-copy", {
    originLongEntryId,
    originLongVersion,
    originCurrentEntryId,
    originCurrentVersion,
    holderLongEntryId,
    holderLongVersion,
    messageSourceId,
    timeSourceId,
  });
}

function editedTemporarySource(options) {
  return temporaryCopySource("temporary-edit", options);
}

function temporaryCopySource(prefix, {
  originLongEntryId,
  originLongVersion,
  originCurrentEntryId,
  originCurrentVersion,
  holderLongEntryId,
  holderLongVersion,
  messageSourceId,
  timeSourceId = null,
}) {
  const holder = holderLongEntryId ?? "-";
  return `${prefix}:${originLongEntryId}:${originLongVersion}:` +
    `${originCurrentEntryId}:${originCurrentVersion}:${holder}:` +
    `${holderLongEntryId ? holderLongVersion : 0}:${messageSourceId}` +
    `${timeSourceId ? `:${timeSourceId}` : ""}`;
}

function temporaryFactKey(longFactKey, longEntryId) {
  return `${longFactKey}.current.${longEntryId}`;
}

module.exports = {
  parseTemporarySource,
  isTemporarySource,
  directTemporarySource,
  copiedTemporarySource,
  editedTemporarySource,
  temporaryFactKey,
};
