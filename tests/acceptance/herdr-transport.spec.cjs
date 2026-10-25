/* S05b-1 正式验收：真实临时 Unix socket fixture + 真实 net/计时。
   覆盖 POL-TRANSPORT-001～003；不连接现有 Herdr、不扫描 HOME、不启动 GUI。
   fixture 只模拟本机 0.9.5 schema 的读请求与订阅事件。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createHerdrTransport } = require("../../app/herdr-transport.cjs");

async function startFixture(t, onRequest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-herdr-transport-"));
  const socketPath = path.join(dir, "herdr.sock");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let newline;
      while ((newline = buffer.indexOf(10)) !== -1) {
        const raw = buffer.subarray(0, newline + 1);
        buffer = buffer.subarray(newline + 1);
        const text = raw.toString("utf8");
        let request;
        try {
          request = JSON.parse(text);
        } catch {
          continue;
        }
        onRequest({ socket, request, raw: text });
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(fs.existsSync(dir), false);
  });
  return { socketPath, sockets };
}

function deferred() {
  let resolve;
  const promise = new Promise((value) => {
    resolve = value;
  });
  return { promise, resolve };
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

const ackLine = (id) => `${JSON.stringify({ id, result: { type: "subscription_started" } })}\n`;
const line = (value) => `${JSON.stringify(value)}\n`;
const statusLine = (paneId, agentStatus) => line({
  event: "pane.agent_status_changed",
  data: { pane_id: paneId, workspace_id: "ws-1", agent_status: agentStatus },
});

/* 003 的本地 fixture 模式：只控制失败注入，不改变传输请求字段。 */
async function failureFixture(t, mode) {
  const received = deferred();
  let socket;
  const fixture = await startFixture(t, (connection) => {
    socket = connection.socket;
    received.resolve(connection.request);
    const request = connection.request;
    if (request.method === "events.subscribe") {
      if (mode === "subscribe" || mode === "subscribe-eof") {
        socket.write(ackLine(request.id));
      }
      if (mode === "subscribe-eof") socket.end();
      if (mode === "invalid-status") {
        socket.write(ackLine(request.id));
        socket.write(line({
          event: "pane.agent_status_changed",
          data: { workspace_id: "ws-1", agent_status: "working" },
        }));
      }
      return;
    }
    if (mode === "eof") socket.end();
    if (mode === "large") socket.write(`${"x".repeat(256)}\n`);
    if (mode === "invalid") socket.write("not-json\n");
  });
  return {
    ...fixture,
    received: received.promise,
    get socket() {
      return socket;
    },
  };
}

test("POL-TRANSPORT-001 临时 Unix socket 分片/多行响应与只读请求格式", async (t) => {
  const seen = [];
  const fixture = await startFixture(t, ({ socket, request, raw }) => {
    seen.push({ request, raw });
    if (request.method === "ping") {
      const payload = Buffer.from(line({
        id: request.id,
        result: { type: "pong", version: "0.9.5-测试", protocol: 22, capabilities: null },
      }));
      const at = payload.indexOf(Buffer.from("测")) + 1;
      socket.write(payload.subarray(0, at));
      setTimeout(() => socket.write(payload.subarray(at)), 5);
    } else if (request.method === "session.snapshot") {
      const wrong = line({
        id: "not-this-request",
        result: { type: "pong", version: "wrong", protocol: 22 },
      });
      const correct = line({
        id: request.id,
        result: {
          type: "session_snapshot",
          snapshot: {
            version: "0.9.5",
            protocol: 22,
            workspaces: [{ name: "测试工作区" }],
            tabs: [],
            panes: [],
            layouts: [],
            agents: [],
          },
        },
      });
      socket.write(Buffer.from(wrong + correct));
    } else if (request.method === "plugin.list") {
      socket.write(line({
        id: request.id,
        error: { code: "plugin_unavailable", message: "fixture 不提供插件" },
      }));
    } else if (request.method === "events.subscribe") {
      socket.write(ackLine(request.id));
    }
  });
  const transport = createHerdrTransport({ socketPath: fixture.socketPath });
  t.after(() => transport.dispose());

  // Given/When：ping 响应跨 UTF-8 字符分片。
  const pong = await transport.request("ping", {});
  assert.deepEqual([pong.type, pong.version, pong.protocol], ["pong", "0.9.5-测试", 22]);

  // When：snapshot 响应一次包含不匹配 id 和正确多行结果。
  const snapshot = await transport.request("session.snapshot", {});
  assert.equal(snapshot.type, "session_snapshot");
  assert.equal(snapshot.snapshot.workspaces[0].name, "测试工作区");

  // When：plugin.list 返回业务错误。
  await assert.rejects(
    transport.request("plugin.list", { plugin_id: null }),
    (error) => {
      assert.equal(error.code, "HERDR_RPC_ERROR");
      assert.equal(error.rpcCode, "plugin_unavailable");
      return true;
    },
  );

  // Expected：request 不接受订阅方法或任意方法，也不打开连接。
  await rejectsWith(transport.request("events.subscribe", {}), "HERDR_METHOD_NOT_ALLOWED");
  await rejectsWith(transport.request("pane.read", {}), "HERDR_METHOD_NOT_ALLOWED");
  // 订阅入口也不接受 pane 内容/输出类事件。
  await rejectsWith(
    transport.subscribe({ subscriptions: [{ type: "pane.output_matched" }] }),
    "HERDR_INVALID_SUBSCRIPTIONS",
  );
  // 状态订阅必须在请求参数中明确 pane_id；事件体缺 pane 是另一项校验。
  await rejectsWith(
    transport.subscribe({ subscriptions: [{ type: "pane.agent_status_changed" }] }),
    "HERDR_INVALID_SUBSCRIPTIONS",
  );
  await rejectsWith(
    transport.subscribe({
      subscriptions: [
        { type: "pane.agent_status_changed", pane_id: "pane-1", agent_status: "busy" },
      ],
    }),
    "HERDR_INVALID_SUBSCRIPTIONS",
  );
  await rejectsWith(
    transport.subscribe({
      subscriptions: [
        { type: "pane.agent_status_changed", pane_id: "pane-1" },
        { type: "pane.agent_status_changed", pane_id: "pane-1" },
      ],
    }),
    "HERDR_INVALID_SUBSCRIPTIONS",
  );

  // When：同一 type 的两个不同 pane 状态订阅（含合法状态过滤与 null 过滤）。
  const handle = await transport.subscribe({
    subscriptions: [
      { type: "pane.agent_status_changed", pane_id: "pane-1", agent_status: "working" },
      { type: "pane.agent_status_changed", pane_id: "pane-2", agent_status: null },
    ],
  });

  // Expected：请求保留 pane_id；handle 元数据/本地 ID 按成员归属。
  assert.equal(handle.subscriptions.length, 2);
  assert.deepEqual(
    handle.subscriptions.map((item) => [item.type, item.paneId, item.agentStatus]),
    [
      ["pane.agent_status_changed", "pane-1", "working"],
      ["pane.agent_status_changed", "pane-2", null],
    ],
  );
  assert.deepEqual(
    handle.subscriptions.map((item) => item.subscriptionId),
    [`${handle.id}-s0`, `${handle.id}-s1`],
  );
  handle.close();

  // Expected：fixture 逐字看到三次只读请求和一次状态订阅，且 JSON 格式精确。
  assert.equal(seen.length, 4);
  assert.match(seen[0].request.id, /^herdr-t\d+-r\d+$/);
  assert.notEqual(seen[0].request.id, seen[1].request.id);
  assert.equal(
    seen[0].raw,
    `${JSON.stringify({ id: seen[0].request.id, method: "ping", params: {} })}\n`,
  );
  assert.deepEqual(seen[0].request.params, {});
  assert.equal(
    seen[1].raw,
    `${JSON.stringify({ id: seen[1].request.id, method: "session.snapshot", params: {} })}\n`,
  );
  assert.deepEqual(seen[1].request.params, {});
  assert.equal(
    seen[2].raw,
    `${JSON.stringify({
      id: seen[2].request.id,
      method: "plugin.list",
      params: { plugin_id: null },
    })}\n`,
  );
  assert.deepEqual(seen[2].request.params, { plugin_id: null });
  assert.equal(seen[3].request.id, handle.id);
  assert.equal(
    seen[3].raw,
    `${JSON.stringify({
      id: seen[3].request.id,
      method: "events.subscribe",
      params: {
        subscriptions: [
          { type: "pane.agent_status_changed", pane_id: "pane-1", agent_status: "working" },
          { type: "pane.agent_status_changed", pane_id: "pane-2", agent_status: null },
        ],
      },
    })}\n`,
  );
});

test("POL-TRANSPORT-002 延迟ack、真实状态/拓扑事件归属与 events_lost 一次性", async (t) => {
  const order = [];
  let subscribeRequest;
  const fixture = await startFixture(t, ({ socket, request, raw }) => {
    if (request.method !== "events.subscribe") return;
    subscribeRequest = { request, raw };
    const status = (paneId, agentStatus) => ({
      event: "pane.agent_status_changed",
      data: { pane_id: paneId, workspace_id: "ws-1", agent_status: agentStatus },
    });
    const pane = {
      pane_id: "pane-2",
      terminal_id: "term-2",
      workspace_id: "ws-1",
      tab_id: "tab-1",
      focused: false,
      agent_status: "idle",
      revision: 1,
    };
    const topology = { event: "pane_created", data: { type: "pane_created", pane } };
    const unknown = { event: "future.thing", data: { note: "raw" } };
    const mismatch = { id: "another-request", result: { type: "pong", version: "x", protocol: 22 } };

    order.push("pre-ack-sent");
    socket.write(Buffer.from(line(mismatch) + line(status("pane-1", "working"))));
    setTimeout(() => {
      order.push("ack-sent");
      socket.write(Buffer.from(
        ackLine(request.id)
        + line(status("pane-2", "blocked"))
        + line(status("pane-1", "done"))
        + line(topology)
        + line(unknown)
        + line({ error: { code: "events_lost", message: "fixture lost" } }),
      ));
      socket.end();
    }, 15);
  });
  const transport = createHerdrTransport({ socketPath: fixture.socketPath });
  t.after(() => transport.dispose());

  const events = [];
  let closeCount = 0;
  let closeError;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const ready = transport.subscribe({
    subscriptions: [
      { type: "pane.agent_status_changed", pane_id: "pane-1" },
      { type: "pane.agent_status_changed", pane_id: "pane-2" },
      { type: "pane.created" },
    ],
    onEvent: (event) => {
      events.push(event);
      order.push("event");
    },
    onClose: (error) => {
      closeCount += 1;
      closeError = error;
      resolveClosed();
    },
  });
  const handle = await ready;
  const [pane1, pane2, topologyId] = handle.subscriptions.map((item) => item.subscriptionId);
  order.push("ready");
  await closed;

  // Expected：ready 只在 ack 之后；pre-ack 事件在 ack 后按序投递。
  assert.deepEqual(order.slice(0, 2), ["pre-ack-sent", "ack-sent"]);
  assert.ok(order.indexOf("ready") > order.indexOf("ack-sent"));
  assert.ok(order.indexOf("event") > order.indexOf("ack-sent"));
  assert.deepEqual(
    handle.subscriptions.map((item) => [item.type, item.paneId]),
    [
      ["pane.agent_status_changed", "pane-1"],
      ["pane.agent_status_changed", "pane-2"],
      ["pane.created", undefined],
    ],
  );

  // Expected：真实无 data.type 状态 payload 按 pane 归属；拓扑保留普通 event 形态。
  assert.deepEqual(
    events.map((event) => [
      event.event,
      event.subscriptionId,
      event.localIndex,
      event.unknown,
    ]),
    [
      ["pane.agent_status_changed", pane1, 1, false],
      ["pane.agent_status_changed", pane2, 1, false],
      ["pane.agent_status_changed", pane1, 2, false],
      ["pane_created", topologyId, 1, false],
      ["future.thing", null, null, true],
    ],
  );
  assert.deepEqual(
    [
      events[0].data.agent_status,
      events[0].data.type,
      events[1].data.agent_status,
      events[2].data.agent_status,
      events[3].data.type,
      events[3].data.pane.pane_id,
      events[4].data.note,
    ],
    ["working", undefined, "blocked", "done", "pane_created", "pane-2", "raw"],
  );
  assert.equal(events.some((event) => event.event === undefined || event.event === "server.stop"), false);

  // Expected：events_lost 只终止一次为明确 gap；随后 EOF 不二次通知。
  assert.equal(closeCount, 1);
  assert.equal(closeError.code, "HERDR_EVENTS_LOST");
  assert.equal(closeError.gap, true);
  assert.equal(closeError.rpcCode, "events_lost");
  handle.close();
  assert.equal(closeCount, 1);

  // Expected：状态订阅参数保留 pane_id，拓扑订阅保持 type-only。
  assert.equal(subscribeRequest.request.method, "events.subscribe");
  assert.equal(
    subscribeRequest.raw,
    `${JSON.stringify({
      id: subscribeRequest.request.id,
      method: "events.subscribe",
      params: {
        subscriptions: [
          { type: "pane.agent_status_changed", pane_id: "pane-1" },
          { type: "pane.agent_status_changed", pane_id: "pane-2" },
          { type: "pane.created" },
        ],
      },
    })}\n`,
  );
});

test("POL-TRANSPORT-003 timeout/abort/dispose、迟到响应、EOF、超限与非法协议", async (t) => {
  // Given/When：请求超时；迟到响应不能改变已确定的失败。
  {
    const fixture = await failureFixture(t, "timeout");
    const transport = createHerdrTransport({ socketPath: fixture.socketPath, requestTimeoutMs: 100 });
    t.after(() => transport.dispose());
    const request = transport.request("ping", {});
    await fixture.received;
    const closed = new Promise((resolve) => fixture.socket.once("close", resolve));
    await rejectsWith(request, "HERDR_TIMEOUT");
    await closed;
    if (!fixture.socket.destroyed) {
      fixture.socket.write(line({ id: "late", result: { type: "pong", version: "x", protocol: 22 } }));
    }
  }

  // Given/When：主动 abort；socket 关闭后不再接收。
  {
    const fixture = await failureFixture(t, "abort");
    const transport = createHerdrTransport({ socketPath: fixture.socketPath, requestTimeoutMs: 200 });
    t.after(() => transport.dispose());
    const controller = new AbortController();
    const request = transport.request("ping", {}, { signal: controller.signal });
    await fixture.received;
    const closed = new Promise((resolve) => fixture.socket.once("close", resolve));
    controller.abort();
    await rejectsWith(request, "HERDR_ABORTED");
    await closed;
    assert.equal(fixture.sockets.size, 0);
  }

  // Given/When：dispose 同时结束在途请求和已就绪订阅；重复 dispose 幂等。
  {
    const requestFixture = await failureFixture(t, "dispose");
    const requestTransport = createHerdrTransport({
      socketPath: requestFixture.socketPath,
      requestTimeoutMs: 200,
    });
    const pending = requestTransport.request("ping", {});
    await requestFixture.received;
    requestTransport.dispose();
    requestTransport.dispose();
    await rejectsWith(pending, "HERDR_DISPOSED");
    await rejectsWith(requestTransport.request("ping", {}), "HERDR_DISPOSED");

    const subFixture = await failureFixture(t, "subscribe");
    const subTransport = createHerdrTransport({ socketPath: subFixture.socketPath });
    let closeCount = 0;
    let closeError;
    await subTransport.subscribe({
      subscriptions: [{ type: "pane.created" }],
      onClose: (error) => {
        closeCount += 1;
        closeError = error;
      },
    });
    subTransport.dispose();
    subTransport.dispose();
    assert.equal(closeCount, 1);
    assert.equal(closeError.code, "HERDR_DISPOSED");
    await rejectsWith(
      subTransport.subscribe({ subscriptions: [{ type: "pane.created" }] }),
      "HERDR_DISPOSED",
    );
  }

  // Given/When：订阅没有 ack；ready 不能提前完成，超时只结束一次。
  {
    const fixture = await failureFixture(t, "timeout");
    const transport = createHerdrTransport({
      socketPath: fixture.socketPath,
      requestTimeoutMs: 60,
    });
    t.after(() => transport.dispose());
    let closeCount = 0;
    let closeError;
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    await assert.rejects(
      transport.subscribe({
        subscriptions: [{ type: "pane.created" }],
        onClose: (error) => {
          closeCount += 1;
          closeError = error;
          resolveClosed();
        },
      }),
      (error) => error.code === "HERDR_TIMEOUT",
    );
    await closed;
    assert.equal(closeCount, 1);
    assert.equal(closeError.code, "HERDR_TIMEOUT");
  }

  // Given/When：显式 close 与 Abort 结束后不再投递迟到事件，onClose 各一次。
  {
    const fixture = await failureFixture(t, "subscribe");
    const transport = createHerdrTransport({ socketPath: fixture.socketPath });
    t.after(() => transport.dispose());
    const events = [];
    let closedCount = 0;
    let abortCount = 0;
    const closes = [];
    const first = await transport.subscribe({
      subscriptions: [{ type: "pane.created" }],
      onEvent: (event) => events.push(event),
      onClose: (error) => {
        closedCount += 1;
        closes.push(error.code);
      },
    });
    first.close();
    first.close();
    const controller = new AbortController();
    const second = await transport.subscribe({
      subscriptions: [{ type: "pane.created" }],
      onEvent: (event) => events.push(event),
      onClose: (error) => {
        abortCount += 1;
        closes.push(error.code);
      },
      signal: controller.signal,
    });
    const secondClosed = new Promise((resolve) => fixture.socket.once("close", resolve));
    controller.abort();
    controller.abort();
    await secondClosed;
    assert.equal(closedCount, 1);
    assert.equal(abortCount, 1);
    assert.deepEqual(closes, ["HERDR_CLOSED", "HERDR_ABORTED"]);
    assert.equal(fixture.sockets.size, 0);
    assert.equal(events.length, 0);
  }


  for (const [mode, code, options] of [
    ["eof", "HERDR_EOF", {}],
    ["large", "HERDR_LINE_TOO_LARGE", { maxLineBytes: 64 }],
    ["invalid", "HERDR_PROTOCOL", {}],
  ]) {
    const fixture = await failureFixture(t, mode);
    const transport = createHerdrTransport({ socketPath: fixture.socketPath, ...options });
    t.after(() => transport.dispose());
    await rejectsWith(transport.request("ping", {}), code);
  }

  // Given/When：订阅 ack 后普通 EOF；只按连接丢失结束，不伪造 server.stop。
  {
    const fixture = await failureFixture(t, "subscribe-eof");
    const transport = createHerdrTransport({ socketPath: fixture.socketPath });
    t.after(() => transport.dispose());
    let closeCount = 0;
    let closeError;
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    await transport.subscribe({
      subscriptions: [{ type: "pane.created" }],
      onClose: (error) => {
        closeCount += 1;
        closeError = error;
        resolveClosed();
      },
    });
    await closed;
    assert.equal(closeCount, 1);
    assert.equal(closeError.code, "HERDR_EOF");
  }

  // Given/When：状态事件缺少 pane_id；异常协议形状终止通道且不投递事件。
  {
    const fixture = await failureFixture(t, "invalid-status");
    const transport = createHerdrTransport({ socketPath: fixture.socketPath });
    t.after(() => transport.dispose());
    const events = [];
    let closeCount = 0;
    let closeError;
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    await transport.subscribe({
      subscriptions: [{ type: "pane.agent_status_changed", pane_id: "pane-1" }],
      onEvent: (event) => events.push(event),
      onClose: (error) => {
        closeCount += 1;
        closeError = error;
        resolveClosed();
      },
    });
    await closed;
    assert.equal(closeCount, 1);
    assert.equal(closeError.code, "HERDR_PROTOCOL");
    assert.equal(events.length, 0);
  }
});

test("POL-TRANSPORT-004 重订阅身份、pre-ack 上限与错ID events_lost", async (t) => {
  // Given/When：两个同时在线的订阅，以及 close 后重订阅同一 pane。
  {
    const sockets = new Map();
    const fixture = await startFixture(t, ({ socket, request }) => {
      if (request.method !== "events.subscribe") return;
      sockets.set(request.id, socket);
      socket.write(ackLine(request.id));
    });
    const transport = createHerdrTransport({ socketPath: fixture.socketPath });
    t.after(() => transport.dispose());
    const events = [];
    const waiters = [];
    const onEvent = (event) => {
      events.push(event);
      waiters.shift()?.(event);
    };
    const nextEvent = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待事件超时")), 100);
      waiters.push((event) => {
        clearTimeout(timer);
        resolve(event);
      });
    });
    let closeCount = 0;
    const onClose = () => {
      closeCount += 1;
    };
    const subscribe = () => transport.subscribe({
      subscriptions: [{ type: "pane.agent_status_changed", pane_id: "pane-1" }],
      onEvent,
      onClose,
    });
    const write = async (handle, agentStatus) => {
      const received = nextEvent();
      sockets.get(handle.id).write(statusLine("pane-1", agentStatus));
      await received;
    };

    const first = await subscribe();
    const second = await subscribe();
    await write(first, "working");
    await write(second, "blocked");
    const firstId = first.subscriptions[0].subscriptionId;
    const secondId = second.subscriptions[0].subscriptionId;

    // Expected：同时订阅的成员身份不同，localIndex 可各自从 1 开始。
    assert.notEqual(first.id, second.id);
    assert.notEqual(firstId, secondId);
    assert.deepEqual(
      events.map((event) => [event.subscriptionId, event.localIndex]),
      [[firstId, 1], [secondId, 1]],
    );

    // When/Expected：close 后重订阅同 pane，组合身份仍必须不同。
    first.close();
    const third = await subscribe();
    await write(third, "done");
    const thirdId = third.subscriptions[0].subscriptionId;
    assert.notEqual(third.id, first.id);
    assert.notEqual(third.id, second.id);
    assert.notEqual(thirdId, firstId);
    assert.notEqual(thirdId, secondId);
    assert.deepEqual([events[2].subscriptionId, events[2].localIndex], [thirdId, 1]);
    assert.equal(new Set([firstId, secondId, thirdId]).size, 3);

    second.close();
    third.close();
    first.close();
    assert.equal(closeCount, 3);
  }

  // Given/When：pre-ack 事件条数超过注入上限。
  {
    const fixture = await startFixture(t, ({ socket, request }) => {
      if (request.method !== "events.subscribe") return;
      socket.write(statusLine("pane-1", "working") + statusLine("pane-1", "blocked"));
    });
    const transport = createHerdrTransport({
      socketPath: fixture.socketPath,
      requestTimeoutMs: 200,
      maxPreAckEvents: 1,
    });
    t.after(() => transport.dispose());
    let events = 0;
    let closeCount = 0;
    let closeError;
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    await assert.rejects(
      transport.subscribe({
        subscriptions: [{ type: "pane.agent_status_changed", pane_id: "pane-1" }],
        onEvent: () => {
          events += 1;
        },
        onClose: (error) => {
          closeCount += 1;
          closeError = error;
          resolveClosed();
        },
      }),
      (error) => error.code === "HERDR_PRE_ACK_LIMIT",
    );
    await closed;
    assert.equal(closeCount, 1);
    assert.equal(closeError.code, "HERDR_PRE_ACK_LIMIT");
    assert.equal(closeError.gap, true);
    assert.equal(events, 0);
  }

  // Given/When：pre-ack 事件字节超过注入上限。
  {
    const fixture = await startFixture(t, ({ socket, request }) => {
      if (request.method !== "events.subscribe") return;
      socket.write(statusLine("pane-1", "working"));
    });
    const transport = createHerdrTransport({
      socketPath: fixture.socketPath,
      requestTimeoutMs: 200,
      maxPreAckBytes: 32,
    });
    t.after(() => transport.dispose());
    let events = 0;
    let closeCount = 0;
    let closeError;
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    await assert.rejects(
      transport.subscribe({
        subscriptions: [{ type: "pane.agent_status_changed", pane_id: "pane-1" }],
        onEvent: () => {
          events += 1;
        },
        onClose: (error) => {
          closeCount += 1;
          closeError = error;
          resolveClosed();
        },
      }),
      (error) => error.code === "HERDR_PRE_ACK_LIMIT",
    );
    await closed;
    assert.equal(closeCount, 1);
    assert.equal(closeError.code, "HERDR_PRE_ACK_LIMIT");
    assert.equal(events, 0);
  }

  // Given/When：不匹配 id 的 events_lost 不能杀死订阅，匹配 id 的才终止。
  {
    const fixture = await startFixture(t, ({ socket, request }) => {
      if (request.method !== "events.subscribe") return;
      socket.write(line({ id: "other-sub", error: { code: "events_lost", message: "wrong" } }));
      socket.write(ackLine(request.id));
      socket.write(statusLine("pane-1", "working"));
      socket.write(line({ id: request.id, error: { code: "events_lost", message: "lost" } }));
      socket.end();
    });
    const transport = createHerdrTransport({ socketPath: fixture.socketPath });
    t.after(() => transport.dispose());
    const events = [];
    let closeCount = 0;
    let closeError;
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    const handle = await transport.subscribe({
      subscriptions: [{ type: "pane.agent_status_changed", pane_id: "pane-1" }],
      onEvent: (event) => events.push(event),
      onClose: (error) => {
        closeCount += 1;
        closeError = error;
        resolveClosed();
      },
    });
    await closed;
    assert.equal(events.length, 1);
    assert.equal(events[0].subscriptionId, handle.subscriptions[0].subscriptionId);
    assert.equal(events[0].localIndex, 1);
    assert.equal(events[0].data.agent_status, "working");
    assert.equal(closeCount, 1);
    assert.equal(closeError.code, "HERDR_EVENTS_LOST");
    assert.equal(closeError.gap, true);
  }
});
