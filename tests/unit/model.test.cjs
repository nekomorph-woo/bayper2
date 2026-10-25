const assert = require("node:assert/strict");
const test = require("node:test");
const {
  validateModelInput,
  parseBaseUrl,
  parseModelName,
  buildEndpoint,
  isOfficialDeepSeekHost,
  timeoutFor,
  buildCheckRequest,
  CHECK_MAX_TOKENS,
  REQUEST_TIMEOUT_MS,
  DEEPSEEK_REQUEST_TIMEOUT_MS,
} = require("../../app/model.cjs");

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test("Base URL 只允许 HTTPS 或本机 loopback HTTP", () => {
  assert.equal(parseBaseUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
  assert.equal(parseBaseUrl("http://127.0.0.1:8080/v1"), "http://127.0.0.1:8080/v1");
  assert.equal(parseBaseUrl("http://localhost:8080"), "http://localhost:8080");
  assert.equal(parseBaseUrl("http://[::1]:8080/v1"), "http://[::1]:8080/v1");

  expectCode(() => parseBaseUrl("http://example.com/v1"), "INSECURE_URL");
  expectCode(() => parseBaseUrl("https://user:pass@example.com/v1"), "INVALID_URL");
  expectCode(() => parseBaseUrl("file:///tmp/model"), "INVALID_URL");
  expectCode(() => parseBaseUrl("https://api.example.com/v1?token=1"), "INVALID_URL");
  expectCode(() => parseBaseUrl(""), "INVALID_URL");
});

test("模型名与 API Key 在发请求前完成校验", () => {
  assert.equal(parseModelName("  model-name  "), "model-name");
  expectCode(() => parseModelName(""), "INVALID_MODEL");
  expectCode(() => parseModelName("bad model"), "INVALID_MODEL");
  expectCode(() => parseModelName("bad\nmodel"), "INVALID_MODEL");
  expectCode(() => parseModelName("x".repeat(121)), "INVALID_MODEL");

  expectCode(
    () => validateModelInput({ baseUrl: "https://api.example.com/v1", modelName: "m", apiKey: "   " }),
    "MISSING_KEY",
  );
  expectCode(
    () =>
      validateModelInput({
        baseUrl: "http://example.com/v1",
        modelName: "m",
        apiKey: "sk-unit",
      }),
    "INSECURE_URL",
  );
});

test("兼容端点由 Base URL 拼接，不修改用户路径", () => {
  assert.equal(
    buildEndpoint("https://api.example.com/v1"),
    "https://api.example.com/v1/chat/completions",
  );
  assert.equal(
    buildEndpoint("http://127.0.0.1:9000/openai/v1"),
    "http://127.0.0.1:9000/openai/v1/chat/completions",
  );
});

test("DeepSeek 官方短检查关闭 thinking，通用服务不带私有字段", () => {
  assert.equal(isOfficialDeepSeekHost("https://api.deepseek.com/v1"), true);
  assert.equal(isOfficialDeepSeekHost("https://api.deepseek.com.cn/v1"), false);
  assert.equal(isOfficialDeepSeekHost("https://api.example.com/v1"), false);

  const generic = buildCheckRequest({
    baseUrl: "https://api.example.com/v1",
    modelName: "generic-model",
  });
  assert.equal("thinking" in generic, false);
  assert.equal(generic.max_tokens, CHECK_MAX_TOKENS);
  assert.equal(generic.messages.length, 1);
  assert.equal(generic.messages[0].role, "user");

  const deepseek = buildCheckRequest({
    baseUrl: "https://api.deepseek.com/v1",
    modelName: "deepseek-flash",
  });
  assert.deepEqual(deepseek.thinking, { type: "disabled" });
  assert.equal(deepseek.max_tokens, CHECK_MAX_TOKENS);

  assert.equal(timeoutFor("https://api.example.com/v1"), REQUEST_TIMEOUT_MS);
  assert.equal(timeoutFor("https://api.deepseek.com/v1"), DEEPSEEK_REQUEST_TIMEOUT_MS);
});
