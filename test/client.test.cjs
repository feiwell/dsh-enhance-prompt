/**
 * Headless harness for lib/client.js.
 *
 * The composer half is plain React without JSX, so a small hook shim is enough
 * to mount the component, drive its handlers, and observe the draft it writes
 * back. `fetch` is mocked per case. The plugin file is evaluated from source so
 * a fresh module, fresh icon table, and fresh storage can be installed.
 *
 *   node --test test/client.test.cjs
 */

const path = require("node:path");
const fs = require("node:fs");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const CLIENT_FILE = path.resolve(__dirname, "../lib/client.js");
const SOURCE = fs.readFileSync(CLIENT_FILE, "utf8");

// ---------------------------------------------------------------- react shim
let hookIndex = 0;
let hookState = [];
let pendingEffects = [];

const react = {
  useState(initial) {
    const i = hookIndex++;
    if (!(i in hookState)) hookState[i] = typeof initial === "function" ? initial() : initial;
    const set = (next) => {
      hookState[i] = typeof next === "function" ? next(hookState[i]) : next;
    };
    return [hookState[i], set];
  },
  useRef(initial) {
    const i = hookIndex++;
    if (!(i in hookState)) hookState[i] = { current: initial };
    return hookState[i];
  },
  useEffect(fn) {
    const i = hookIndex++;
    if (!(i in hookState)) {
      hookState[i] = true;
      pendingEffects.push(fn);
    }
  },
  useMemo(fn) {
    return fn();
  },
  useCallback(fn) {
    return fn();
  },
};

const jsxRuntime = {
  jsx: (type, props) => ({ type, props: props ?? {} }),
  jsxs: (type, props) => ({ type, props: props ?? {} }),
};

/** The 0.2.x export names only: the sized 0.1.x names are absent on purpose. */
function makePrimitives(overrides = {}) {
  return {
    Menu: "Menu",
    IconEditOutlineRegular: "IconEditOutlineRegular",
    IconChevronDownOutlineRegular: "IconChevronDownOutlineRegular",
    ...overrides,
  };
}

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    clear: () => map.clear(),
  };
}

// ------------------------------------------------------------- module loader
function loadClient(primitives) {
  let captured = null;
  const storage = makeStorage();
  const sandboxWindow = {
    __ModuleLoader__: { load: (def) => void (captured = def) },
    localStorage: storage,
  };
  const sandboxDocument = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: "" }),
    head: { appendChild() {} },
  };
  const requireStub = (name) => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return jsxRuntime;
    if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
    throw new Error(`unexpected require: ${name}`);
  };
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("window", "document", "require", "module", SOURCE)(sandboxWindow, sandboxDocument, requireStub, module);
  assert.ok(captured !== null, "client did not register with the module loader");

  const loaded = captured.factory(requireStub);
  let Component = null;
  const slots = [];
  loaded.apply({
    slots: {
      inject(name, fn) {
        assert.equal(name, "conversation.input.right");
        fn();
      },
      register(meta, component) {
        slots.push(meta);
        Component = component;
        return () => {};
      },
    },
  });
  return { Component, storage, slots, module: loaded };
}

const main = loadClient(makePrimitives());

// ------------------------------------------------------------------- helpers
function render(client, { draft = "", phase = "plain", writes } = {}) {
  hookIndex = 0;
  const sink = writes ?? [];
  const state = { draft };
  const props = {
    useInput: (select) => select({ draft: state.draft, phase }),
    inputActions: {
      setDraft(next) {
        sink.push(next);
        state.draft = next;
      },
    },
  };
  const tree = client.Component(props);
  const cleanups = [];
  for (const fn of pendingEffects.splice(0)) {
    const cleanup = fn();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  return {
    tree,
    writes: sink,
    cleanups,
    get draft() {
      return state.draft;
    },
  };
}

function mount(client, options) {
  hookState = [];
  hookIndex = 0;
  pendingEffects = [];
  if (options?.storedMode !== undefined) client.storage.setItem("dsh-enhance-prompt:mode", options.storedMode);
  else client.storage.clear();
  return render(client, options);
}

function rerender(client, options) {
  pendingEffects = [];
  return render(client, options);
}

/** Walk the JSX tree, expanding function components so their SVG output shows. */
function findAll(node, predicate, found = []) {
  if (node === null || node === undefined) return found;
  if (typeof node === "string" || typeof node === "number") return found;
  if (typeof node === "function") {
    findAll(node({}), predicate, found);
    return found;
  }
  if (typeof node !== "object") return found;
  if (typeof node.type === "function") {
    if (predicate(node)) found.push(node);
    findAll(node.type(node.props ?? {}), predicate, found);
    return found;
  }
  if (predicate(node)) found.push(node);
  for (const value of Object.values(node.props ?? {})) {
    if (Array.isArray(value)) value.forEach((item) => findAll(item, predicate, found));
    else if (value !== null && typeof value === "object") findAll(value, predicate, found);
  }
  return found;
}

const byClass = (tree, cls) =>
  findAll(tree, (n) => typeof n.props?.className === "string" && n.props.className.split(" ").includes(cls))[0];
const byType = (tree, type) => findAll(tree, (n) => n.type === type)[0];

function mockFetch(impl) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init, calls);
  };
  return calls;
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const realSetTimeout = globalThis.setTimeout;

/**
 * The plugin arms a 30 s abort timer per request. Unref only those long timers
 * so the suite exits as soon as the last assertion finishes; short waits used
 * by the tests keep the event loop alive normally.
 */
globalThis.setTimeout = (fn, ms, ...rest) => {
  const timer = realSetTimeout(fn, ms, ...rest);
  if (ms >= 5_000 && typeof timer?.unref === "function") timer.unref();
  return timer;
};

const tick = () => new Promise((resolve) => realSetTimeout(resolve, 10));

// --------------------------------------------------------------------- tests
test("registers on conversation.input.right with the plugin id", () => {
  assert.equal(main.slots.length, 1);
  assert.equal(main.slots[0].id, "enhance-prompt");
  assert.equal(main.slots[0].name, "conversation.input.right");
});

test("uses the runtime icon names that 0.2.x actually exports", () => {
  const view = mount(main, { draft: "写个登录页" });
  assert.ok(byType(view.tree, "IconEditOutlineRegular") !== undefined, "expected the runtime edit icon");
  assert.ok(byType(view.tree, "IconChevronDownOutlineRegular") !== undefined, "expected the runtime chevron");
});

test("falls back to local SVG when the build exports neither icon name", () => {
  const bare = loadClient(makePrimitives({ IconEditOutlineRegular: undefined, IconChevronDownOutlineRegular: undefined }));
  const view = mount(bare, { draft: "x" });
  const svgs = findAll(view.tree, (n) => n.type === "svg");
  assert.equal(svgs.length, 2, `expected two fallback SVGs, got ${svgs.length}`);
});

test("empty draft disables the button with the guidance label", () => {
  const view = mount(main, { draft: "   " });
  const button = byClass(view.tree, "dshEnhance_button");
  assert.equal(button.props.disabled, true);
  assert.equal(button.props.title, "先输入内容，再增强提示词");
});

test("busy composer state freezes both controls", () => {
  const view = mount(main, { draft: "写个登录页", phase: "submitting" });
  assert.equal(byClass(view.tree, "dshEnhance_button").props.disabled, true);
  assert.equal(byClass(view.tree, "dshEnhance_mode").props.disabled, true);
});

test("successful rewrite posts the draft and replaces it", async () => {
  const calls = mockFetch(() => jsonResponse(200, { text: "更具体的提示词", mode: "work" }));
  const view = mount(main, { draft: "帮我写个登录页" });
  await byClass(view.tree, "dshEnhance_button").props.onClick();
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/enhance-prompt");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { input: "帮我写个登录页", mode: "work" });
  assert.deepEqual(view.writes, ["更具体的提示词"]);
});

test("after a rewrite the button becomes 恢复原文 and reverts on click", async () => {
  mockFetch(() => jsonResponse(200, { text: "改写后", mode: "work" }));
  const writes = [];
  const first = mount(main, { draft: "原文", writes });
  await byClass(first.tree, "dshEnhance_button").props.onClick();
  await tick();
  assert.deepEqual(writes, ["改写后"]);

  const second = rerender(main, { draft: first.draft, writes });
  const revert = byClass(second.tree, "dshEnhance_button");
  assert.ok(revert.props.className.includes("dshEnhance_button_revert"), "expected the revert style");
  assert.equal(revert.props.title, "恢复原文");
  revert.props.onClick();
  assert.deepEqual(writes, ["改写后", "原文"]);
});

test("server error leaves the draft untouched", async () => {
  mockFetch(() => jsonResponse(502, { error: "模型调用失败" }));
  const view = mount(main, { draft: "原文" });
  await byClass(view.tree, "dshEnhance_button").props.onClick();
  await tick();
  assert.deepEqual(view.writes, []);
});

test("oversized drafts are refused before any request", async () => {
  const calls = mockFetch(() => jsonResponse(200, { text: "x", mode: "work" }));
  const view = mount(main, { draft: "字".repeat(20000) }); // 60 KB of UTF-8
  await byClass(view.tree, "dshEnhance_button").props.onClick();
  await tick();
  assert.equal(calls.length, 0, "must not call the API for an oversized draft");
});

test("selected mode persists to localStorage", () => {
  const view = mount(main, { draft: "x" });
  byType(view.tree, "Menu").props.onSelect("design");
  assert.equal(main.storage.getItem("dsh-enhance-prompt:mode"), "design");
});

test("stored mode is restored and sent with the request", async () => {
  const calls = mockFetch(() => jsonResponse(200, { text: "y", mode: "design" }));
  const view = mount(main, { draft: "做个海报", storedMode: "design" });
  assert.equal(byType(view.tree, "Menu").props.selectedId, "design");
  await byClass(view.tree, "dshEnhance_button").props.onClick();
  await tick();
  assert.equal(JSON.parse(calls[0].init.body).mode, "design");
});

test("an unknown stored mode falls back to work", () => {
  const view = mount(main, { draft: "x", storedMode: "not-a-mode" });
  assert.equal(byType(view.tree, "Menu").props.selectedId, "work");
});

test("a missing useInput prop does not break render", () => {
  hookState = [];
  hookIndex = 0;
  pendingEffects = [];
  const tree = main.Component({ inputActions: { setDraft() {} } });
  assert.equal(byClass(tree, "dshEnhance_button").props.disabled, true);
});

test("unmount aborts the in-flight request", async () => {
  let signal = null;
  mockFetch((url, init) => new Promise((resolve, reject) => {
    signal = init.signal;
    init.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
  }));
  const view = mount(main, { draft: "原文" });
  byClass(view.tree, "dshEnhance_button").props.onClick();
  assert.ok(signal !== null, "expected a request with an abort signal");
  assert.equal(signal.aborted, false);
  assert.ok(view.cleanups.length >= 1, "expected at least the unmount effect");
  for (const cleanup of view.cleanups) cleanup();
  assert.equal(signal.aborted, true, "unmount must abort the request");
});

test("after the busy state renders, a second click is blocked", async () => {
  const signals = [];
  mockFetch((url, init) => new Promise(() => void signals.push(init.signal)));
  const view = mount(main, { draft: "原文" });
  await byClass(view.tree, "dshEnhance_button").props.onClick();
  await tick();
  assert.equal(signals.length, 1);
  const busy = rerender(main, { draft: "原文" });
  const button = byClass(busy.tree, "dshEnhance_button");
  assert.equal(button.props.disabled, true, "the button must be disabled while loading");
  assert.equal(button.props.title, "增强中…");
  button.props.onClick();
  await tick();
  assert.equal(signals.length, 1, "a disabled button must not start a second request");
});

test("a click that slips past the busy guard aborts the previous request", async () => {
  const signals = [];
  mockFetch((url, init) => new Promise(() => void signals.push(init.signal)));
  const view = mount(main, { draft: "原文" });
  const button = byClass(view.tree, "dshEnhance_button");
  button.props.onClick();
  await tick();
  button.props.onClick(); // stale closure: the guard cannot see the new phase yet
  await tick();
  assert.equal(signals.length, 2, "expected a second request");
  assert.equal(signals[0].aborted, true, "the superseded request must be aborted");
  assert.equal(signals[1].aborted, false, "the newest request stays alive");
});
