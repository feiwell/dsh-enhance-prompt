/**
 * Server-half tests for index.js.
 *
 * A fake cordis context stands in for commands, llm, agentDefaultModel,
 * webServer and effect, so the rewrite pipeline can be exercised without a
 * running harness.
 *
 *   node --test test/server.test.mjs
 */

import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const INDEX_URL = pathToFileURL(path.resolve(import.meta.dirname, "../index.js")).href;

/** A stream that emits the given chunks. */
function streamOf(chunks) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

const textChunks = (text) => [
  { type: "block-end", block: { type: "text", text } },
  { type: "finish", reason: "stop" },
];

function makeCtx({ text = "改写结果", selection = { provider: "p", model: "m" }, efforts } = {}) {
  const registered = {};
  const routes = {};
  const seen = {};
  const ctx = {
    commands: {
      register(def) {
        registered[def.name] = def;
      },
    },
    llm: {
      async resolveModelInfo() {
        return efforts === undefined ? {} : { reasoning: { efforts: efforts.map((id) => ({ id })) } };
      },
      stream(options) {
        seen.stream = options;
        if (typeof text === "function") return text();
        return streamOf(textChunks(text));
      },
    },
    agentDefaultModel: {
      currentSelection() {
        return selection;
      },
    },
    webServer: {
      register(route) {
        routes[route.path] = route;
        return () => {};
      },
    },
    effect(fn) {
      fn();
    },
    seen,
    registered,
    routes,
  };
  return ctx;
}

/** Minimal req/res pair for the route handler. */
function makeReq({ method = "POST", body = "" }) {
  const listeners = {};
  let destroyed = false;
  return {
    method,
    destroyed: () => destroyed,
    on(event, fn) {
      (listeners[event] ??= []).push(fn);
      return this;
    },
    destroy() {
      destroyed = true;
    },
    async start() {
      if (body !== "") {
        // Feed the body in chunks so an oversized request trips the budget
        // mid-stream, the way a real slow client would.
        const buf = Buffer.from(body);
        const step = 16 * 1024;
        for (let at = 0; at < buf.length; at += step) {
          for (const fn of listeners.data ?? []) fn(buf.subarray(at, Math.min(at + step, buf.length)));
        }
      }
      for (const fn of listeners.end ?? []) fn();
    },
  };
}

function makeRes() {
  const res = {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
    },
    end(payload) {
      res.body = payload;
    },
  };
  return res;
}

async function callRoute(ctx, { method = "POST", payload } = {}) {
  const route = ctx.routes["/api/enhance-prompt"];
  assert.ok(route !== undefined, "route was not registered");
  const body = payload === undefined ? "" : typeof payload === "string" ? payload : JSON.stringify(payload);
  const req = makeReq({ method, body });
  const res = makeRes();
  const done = route.handler(req, res);
  await req.start();
  await done;
  return { status: res.status, json: res.body === "" ? null : JSON.parse(res.body), headers: res.headers, req };
}

const mod = await import(INDEX_URL);

test("exports the cordis plugin shape and declared services", () => {
  assert.equal(mod.name, "enhance-prompt");
  assert.deepEqual(mod.inject, ["commands", "llm", "agentDefaultModel", "webServer"]);
  assert.equal(typeof mod.apply, "function");
});

test("registers the /enhance command and exactly one route", () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  assert.deepEqual(Object.keys(ctx.registered), ["enhance"]);
  assert.deepEqual(Object.keys(ctx.routes), ["/api/enhance-prompt"]);
  assert.equal(ctx.routes["/api/enhance-prompt"].kind, "exact");
});

test("the request uses the documented model parameters", async () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  await callRoute(ctx, { payload: { input: "写个登录页", mode: "code" } });
  const stream = ctx.seen.stream;
  assert.equal(stream.temperature, 0.2);
  assert.equal(stream.maxTokens, 800);
  assert.equal(stream.provider, "p");
  assert.equal(stream.model, "m");
  const userText = stream.messages[0].content[0].text;
  assert.ok(userText.includes("写个登录页"), "the draft must reach the prompt");
  assert.ok(userText.includes("TARGET MODE"), "the mode guide must be appended");
});

test("a successful rewrite answers 200 with text and the normalized mode", async () => {
  const ctx = makeCtx({ text: "更清晰的提示词" });
  mod.apply(ctx);
  const { status, json, headers } = await callRoute(ctx, { payload: { input: "帮我写个登录页", mode: "design" } });
  assert.equal(status, 200);
  assert.equal(json.text, "更清晰的提示词");
  assert.equal(json.mode, "design");
  assert.match(headers["content-type"], /application\/json/);
});

test("an unknown mode is answered as work instead of being rejected", async () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const { status, json } = await callRoute(ctx, { payload: { input: "x", mode: "nope" } });
  assert.equal(status, 200);
  assert.equal(json.mode, "work");
});

test("empty input answers 400 with guidance", async () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const { status, json } = await callRoute(ctx, { payload: { input: "   " } });
  assert.equal(status, 400);
  assert.match(json.error, /先输入内容/);
});

test("non-POST methods answer 405", async () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const { status, json } = await callRoute(ctx, { method: "GET" });
  assert.equal(status, 405);
  assert.match(json.error, /POST/);
});

test("malformed JSON answers 400", async () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const { status } = await callRoute(ctx, { payload: "{not json" });
  assert.equal(status, 400);
});

test("an oversized body answers 413, not a generic error", async () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const huge = JSON.stringify({ input: "字".repeat(40000) }); // > 64 KB of UTF-8
  const { status, json } = await callRoute(ctx, { payload: huge });
  assert.equal(status, 413);
  assert.match(json.error, /48 KB/);
});

test("an oversized body keeps the connection open so the 413 can be read", async () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const huge = JSON.stringify({ input: "字".repeat(40000) });
  const { status, req } = await callRoute(ctx, { payload: huge });
  assert.equal(status, 413);
  assert.equal(req.destroyed(), false, "destroying the socket turns the 413 into a transport error");
});

test("a missing default model answers 503", async () => {
  const ctx = makeCtx({ selection: {} });
  mod.apply(ctx);
  const { status, json } = await callRoute(ctx, { payload: { input: "x" } });
  assert.equal(status, 503);
  assert.match(json.error, /默认模型/);
});

test("an empty model answer is reported instead of wiping the draft", async () => {
  const ctx = makeCtx({ text: "   " });
  mod.apply(ctx);
  const { status, json } = await callRoute(ctx, { payload: { input: "x" } });
  assert.equal(status, 502);
  assert.match(json.error, /空结果/);
  assert.match(json.error, /p\/m/, "the failing model must be named for diagnosis");
});

test("a failing stream answers 502 with the reason", async () => {
  const ctx = makeCtx({ text: () => streamOf([{ type: "finish", reason: "error" }]) });
  mod.apply(ctx);
  const { status, json } = await callRoute(ctx, { payload: { input: "x" } });
  assert.equal(status, 502);
  assert.match(json.error, /增强失败/);
});

test("duplicated model output is collapsed to one copy", async () => {
  const single = "请为现有项目新增登录页：邮箱与密码输入框、记住我、提交按钮，并在成功后跳转。";
  const ctx = makeCtx({ text: single + single });
  mod.apply(ctx);
  const { status, json } = await callRoute(ctx, { payload: { input: "登录页" } });
  assert.equal(status, 200);
  assert.equal(json.text, single);
});

test("wrapping quotes are stripped from the result", async () => {
  const ctx = makeCtx({ text: "“请说明这段代码的主流程与边界。”" });
  mod.apply(ctx);
  const { json } = await callRoute(ctx, { payload: { input: "解释这段代码" } });
  assert.equal(json.text, "请说明这段代码的主流程与边界。");
});

test("the cheapest reasoning effort the model offers is used", async () => {
  const ctx = makeCtx({ efforts: ["high", "low", "medium"] });
  mod.apply(ctx);
  await callRoute(ctx, { payload: { input: "x" } });
  assert.equal(ctx.seen.stream.reasoningEffort, "low");
});

test("a model with no reasoning tiers sends no reasoningEffort", async () => {
  const ctx = makeCtx({ efforts: [] });
  mod.apply(ctx);
  await callRoute(ctx, { payload: { input: "x" } });
  assert.equal("reasoningEffort" in ctx.seen.stream, false);
});

test("the /enhance command returns the rewrite as a command result", async () => {
  const ctx = makeCtx({ text: "命令改写结果" });
  mod.apply(ctx);
  const outcome = await ctx.registered.enhance.handler({
    rawInput: "帮我写个登录页",
    signal: new AbortController().signal,
  });
  assert.equal(outcome.kind, "success");
  assert.equal(outcome.text, "命令改写结果");
});

test("the /enhance command honours a --code flag and keeps it out of the prompt", async () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  await ctx.registered.enhance.handler({ rawInput: "--code 写个导出脚本", signal: new AbortController().signal });
  const userText = ctx.seen.stream.messages[0].content[0].text;
  assert.ok(userText.includes("写个导出脚本"));
  assert.ok(!userText.includes("--code"), "the flag must not reach the model");
  assert.match(userText, /代码开发/);
});

test("empty /enhance input returns usage text as an error result", async () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const outcome = await ctx.registered.enhance.handler({ rawInput: "  ", signal: new AbortController().signal });
  assert.equal(outcome.kind, "error");
  assert.match(outcome.text, /用法/);
});

test("an already-aborted command reports cancellation without calling the model", async () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const controller = new AbortController();
  controller.abort();
  const outcome = await ctx.registered.enhance.handler({ rawInput: "x", signal: controller.signal });
  assert.equal(outcome.kind, "error");
  assert.equal(outcome.text, "已取消");
  assert.equal(ctx.seen.stream, undefined, "the model must not be called");
});
