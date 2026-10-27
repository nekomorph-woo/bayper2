/* S03l 事实身份的纯计算部分：不接触数据库，也不保存正文或模型解释。
   factKey 只是模型给出的主题定位提示，不能跨角色当作同一事实。这里只定义
   无需模型即可确认的极窄同一性：用户明确说出的 identity/preference，其余
   条件（正文、类别、可信性质、来源种类、有效期限）全部严格相同。
   正文只做 trim/NFC，不去否定、不替换词、不删标点；experience/detail
   即使同文也不自动合并（“我们一起”可能是不同的共同经历）。 */
const crypto = require("node:crypto");

const REUSABLE_KINDS = new Set(["identity", "preference"]);

function factKeyHash(factKey) {
  return crypto.createHash("sha256").update(factKey, "utf8").digest("hex");
}

/* 正文比较只做 trim/NFC：不忽略否定、不替换词、不删标点。 */
function normalizeFactBody(body) {
  return typeof body === "string" ? body.normalize("NFC").trim() : "";
}

/* 严格正文指纹：kind/trust/sourceKind/有效期限与 NFC+trim 正文全部相同。
   删除控制用它判断“同一角色是否又学回了已删除的原文”，不用于跨角色身份
   合并；experience/detail 也可以使用。 */
function strictFactFingerprint({ kind, trust, sourceKind, expiresAt, body }) {
  const source = sourceKind ?? "user";
  const normalizedBody = normalizeFactBody(body);
  if (normalizedBody === "") {
    return null;
  }
  const payload = JSON.stringify([
    kind,
    trust,
    source,
    expiresAt ?? null,
    normalizedBody,
  ]);
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

/* 可复用身份的指纹只覆盖用户明确说出的 identity/preference；
   其余事实没有可安全跨角色复用的身份证据。 */
function identityFingerprint({ kind, trust, sourceKind, expiresAt, body }) {
  const source = sourceKind ?? "user";
  if (!REUSABLE_KINDS.has(kind) || trust !== "stated" || source !== "user") {
    return null;
  }
  return strictFactFingerprint({ kind, trust, sourceKind: source, expiresAt, body });
}

module.exports = {
  factKeyHash,
  identityFingerprint,
  normalizeFactBody,
  strictFactFingerprint,
};
