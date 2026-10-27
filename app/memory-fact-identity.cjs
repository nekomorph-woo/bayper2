/* S03l 事实身份的纯计算部分：不接触数据库，也不保存正文或模型解释。
   factKey 只是模型给出的主题定位提示，不能跨角色当作同一事实。这里定义的
   严格指纹只服务别名与控制覆盖：正文相同不能证明主体相同，事实身份由各来源
   独立建立，只有明确派生或经核验的 associateFacts 才建立关联。
   正文只做 trim/NFC，不去否定、不替换词、不删标点；experience/detail
   即使同文也不会自动合并（“我们一起”可能是不同的共同经历）。 */
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

/* 可登记为别名的正文指纹：只覆盖用户明确说出的 identity/preference，用于
   删除/禁分享控制覆盖。它不含主体或语境，不能证明两条事实是同一身份，
   新来源与缺身份迁移都不再据此复用或归组。 */
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
