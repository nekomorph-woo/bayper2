/* 验收用本机 OpenAI 兼容服务。只验证协议与确定性失败流程，
   不代表真实模型语义；不记录 API Key 明文。 */
const http = require("node:http");

const VALID_COMPLETION = {
  id: "chatcmpl-fixture",
  object: "chat.completion",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "你好，这是连通检查的测试应答。" },
      finish_reason: "stop",
    },
  ],
};

async function startModelServer() {
  const requests = [];
  const allRequests = [];
  const timers = new Set();

  const server = http.createServer(async (request, response) => {
    allRequests.push({ method: request.method, url: request.url });
    if (request.method !== "POST" || !request.url.endsWith("/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    let body = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      body = null;
    }

    const authorization = request.headers.authorization ?? "";
    const key = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    requests.push({ url: request.url, hasAuthorization: Boolean(key), body });

    if (key === "sk-fixture-timeout") {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!response.writableEnded) {
          sendJson(response, 200, VALID_COMPLETION);
        }
      }, 15000);
      timers.add(timer);
      response.on("close", () => {
        clearTimeout(timer);
        timers.delete(timer);
      });
      return;
    }

    if (key === "sk-fixture-401") {
      sendJson(response, 401, { error: { message: "invalid api key" } });
      return;
    }

    if (key === "sk-fixture-role") {
      sendJson(response, 200, {
        ...VALID_COMPLETION,
        choices: [
          {
            index: 0,
            message: { role: "tool", content: "这不是助手文本。" },
            finish_reason: "stop",
          },
        ],
      });
      return;
    }

    if (key === "sk-fixture-empty") {
      sendJson(response, 200, {
        ...VALID_COMPLETION,
        choices: [{ index: 0, message: { role: "assistant", content: "   " } }],
      });
      return;
    }

    if (key === "sk-fixture-ok") {
      sendJson(response, 200, VALID_COMPLETION);
      return;
    }

    sendJson(response, 401, { error: { message: "invalid api key" } });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    allRequests,
    async close() {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}

async function startRedirectServer(location) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
      // 读取并丢弃请求体，只记录是否带有授权头，不记录值。
    }
    requests.push({
      url: request.url,
      hasAuthorization: Boolean(request.headers.authorization),
    });
    response.writeHead(302, { location, "content-length": "0" });
    response.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    async close() {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}

function sendJson(response, status, payload) {
  if (response.writableEnded) {
    return;
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

module.exports = { startModelServer, startRedirectServer };
