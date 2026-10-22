/**
 * Live end-to-end check: a real model call through the plugin's own route
 * handler, asserting the behaviour the README promises rather than just that
 * the route answers.
 *
 *   DEEPSEEK_API_KEY=... node scripts/live-check.cjs
 *
 * The model transport here is a plain chat-completions stream adapted to the
 * chunk shape index.js reads, so the plugin code under test is unmodified.
 */
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const INDEX = pathToFileURL(path.resolve(__dirname, "../index.js")).href;
const API_KEY = process.env.DEEPSEEK_API_KEY;
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";

if (!API_KEY) {
  console.error("DEEPSEEK_API_KEY is required (the live check calls a real model)");
  process.exit(2);
}

/** Chat-completions stream translated into the chunk shape the plugin reads. */
async function* openaiStream({ system, messages, temperature, maxTokens, signal }) {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        ...messages.map((m) => ({ role: m.role, content: m.content.map((p) => p.text).join("") })),
      ],
    }),
    signal,
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const piece = JSON.parse(data).choices?.[0]?.delta?.content;
        if (typeof piece === "string") text += piece;
      } catch {
        /* keep-alive or partial frame */
      }
    }
  }
  yield { type: "block-end", block: { type: "text", text } };
  yield { type: "finish", reason: "stop" };
}

function makeCtx() {
  const routes = {};
  const ctx = {
    commands: { register() {} },
    llm: {
      async resolveModelInfo() {
        return { reasoning: { efforts: [] } };
      },
      stream: openaiStream,
    },
    agentDefaultModel: { currentSelection: () => ({ provider: "deepseek", model: MODEL }) },
    webServer: {
      register(route) {
        routes[route.path] = route;
        return () => {};
      },
    },
    effect(fn) {
      fn();
    },
  };
  return { ctx, routes };
}

function makeReq(body) {
  const listeners = {};
  return {
    method: "POST",
    on(event, fn) {
      (listeners[event] ??= []).push(fn);
      return this;
    },
    destroy() {},
    start() {
      for (const fn of listeners.data ?? []) fn(Buffer.from(body));
      for (const fn of listeners.end ?? []) fn();
    },
  };
}

function makeRes() {
  const res = {
    status: null,
    body: "",
    writeHead(status) {
      res.status = status;
    },
    end(payload) {
      res.body = payload;
    },
  };
  return res;
}

async function call(route, payload) {
  const res = makeRes();
  const req = makeReq(JSON.stringify(payload));
  const done = route.handler(req, res);
  req.start();
  await done;
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
}

let failures = 0;
async function step(name, fn) {
  try {
    console.log(`PASS ${name}${(await fn()) ?? ""}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${error.message}`);
  }
}

const cjkCount = (text) => (text.match(/[\u4e00-\u9fff]/g) ?? []).length;

(async () => {
  const mod = await import(INDEX);
  const { ctx, routes } = makeCtx();
  mod.apply(ctx);
  const route = routes["/api/enhance-prompt"];

  await step("code mode adds implementation constraints", async () => {
    const { status, json } = await call(route, { input: "帮我写个登录页", mode: "code" });
    if (status !== 200) throw new Error(`status ${status}: ${json?.error}`);
    if (json.mode !== "code") throw new Error(`mode came back as ${json.mode}`);
    if (json.text.length < 20) throw new Error(`too short: ${json.text}`);
    if (!/邮箱|密码|email|password|校验|validation/i.test(json.text)) {
      throw new Error(`no added constraint detail: ${json.text.slice(0, 160)}`);
    }
    return ` — ${json.text.length} chars`;
  });

  await step("Chinese input yields Chinese output", async () => {
    const { json } = await call(route, { input: "写个周报", mode: "work" });
    if (cjkCount(json.text) < 10) throw new Error(`expected Chinese: ${json.text.slice(0, 120)}`);
    return ` — ${cjkCount(json.text)} CJK chars`;
  });

  await step("English input yields English output", async () => {
    const { json } = await call(route, { input: "write a login page", mode: "code" });
    if (cjkCount(json.text) > 5) throw new Error(`expected English: ${json.text.slice(0, 120)}`);
    return "";
  });

  await step("a question is rewritten, not answered", async () => {
    const { json } = await call(route, { input: "什么是闭包", mode: "work" });
    if (/闭包是|闭包指|A closure is/i.test(json.text)) {
      throw new Error(`answered instead of rewriting: ${json.text.slice(0, 160)}`);
    }
    if (json.text.length > 800) throw new Error(`longer than a draft: ${json.text.length}`);
    return "";
  });

  await step("result is not quoted or duplicated", async () => {
    const { json } = await call(route, { input: "做一张活动海报", mode: "design" });
    if (/^["'“”]/.test(json.text) || /["'“”]$/.test(json.text)) throw new Error("still wrapped in quotes");
    const compact = json.text.replace(/\s+/g, "");
    const half = Math.floor(compact.length / 2);
    if (compact.length > 40 && compact.slice(0, half) === compact.slice(half, half * 2)) {
      throw new Error("duplicated paragraph survived");
    }
    return "";
  });

  console.log(failures === 0 ? "\nALL PASS (live model)" : `\n${failures} FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
