const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.resolve(__dirname, "../src/background");
(async () => {
  const storage = {};
  let listener, calls = 0, failure = "markers", accessLevel, gate, releaseGate;
  const bodies = [], delays = [];
  const sandbox = vm.createContext({
    console, URL, AbortController, clearTimeout,
    setTimeout(fn, ms) {
      delays.push(ms);
      const timer = setTimeout(fn, ms === 30000 ? 80 : Math.min(ms, 10));
      if (ms > 60000) timer.unref();
      return timer;
    },
    chrome: {
      storage: { local: {
        async setAccessLevel(options) { accessLevel = options.accessLevel; },
        async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, storage[key]])); },
        async set(values) { Object.assign(storage, values); }
      } },
      runtime: {
        onInstalled: { addListener() {} }, onStartup: { addListener() {} },
        onMessage: { addListener(fn) { listener = fn; } }
      }
    },
    async fetch(url, options) {
      calls++;
      const request = JSON.parse(options.body);
      bodies.push(request);
      assert(request.messages[0].content.includes("DWT_OPEN"));
      assert(request.messages[0].content.includes("UI labels must be concise"));
      assert(request.messages[0].content.length < 2200, "default prompt overhead must stay compact");
      const payload = JSON.parse(request.messages[1].content.split("\n").at(-1));
      assert.equal(payload.page.title, "Agent test page");
      assert.equal(payload.items[0].context.region, "main");
      const items = payload.items;
      if (gate) await gate;
      if (failure === "timeout") return {
        ok: true, json: () => new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })
      };
      if (failure === "429") {
        failure = "";
        return { ok: false, status: 429, headers: { get: () => null }, async text() { return ""; } };
      }
      assert(!items[0].text.includes("https://"));
      const translations = items.map((item) => ({
        id: failure === "ids" ? "wrong" : item.id,
        text: failure === "markers" ? "缺失链接标记"
          : failure === "urls" ? item.text.replace(/__DWT_URL_0__/, "") : item.text.replace("documentation", "文档")
      }));
      if (failure === "markers") failure = "";
      return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify({ translations }) } }] }; } };
    }
  });
  sandbox.importScripts = (...files) => files.forEach((file) => vm.runInContext(fs.readFileSync(path.resolve(root, file), "utf8"), sandbox));
  vm.runInContext(fs.readFileSync(path.join(root, "service-worker.js"), "utf8"), sandbox);
  const dt = sandbox.DeerWebTranslator;
  storage[dt.STORAGE_KEY] = { ...dt.normalizePublicSettings({ provider: "ollama" }), apiKeys: {} };
  const request = {
    type: "DEERWEBTRANSLATOR_TRANSLATE_BATCH", runId: "test", pageUrl: "https://example.test",
    pageTitle: "Agent test page",
    items: [{
      id: "p1",
      text: "[[DWT_OPEN_0]]documentation[[DWT_CLOSE_0]] https://example.test/docs?q=1",
      hash: "hash1",
      context: { tag: "p", region: "main", isLink: false, linkKind: "" }
    }]
  };
  const send = (message) => new Promise((resolve) => listener(message, { tab: { id: 1 } }, resolve));
  const result = await send(request);
  assert.equal(result.ok, true);
  assert.equal(calls, 2, "missing markers must trigger retry");
  assert.equal(result.translations[0].text, "[[DWT_OPEN_0]]文档[[DWT_CLOSE_0]] https://example.test/docs?q=1");
  const cached = await send(request);
  assert.equal(cached.cachedCount, 1);
  assert.equal(calls, 2, "cache must avoid provider call");
  failure = "ids";
  const invalid = await send({ ...request, items: [{ ...request.items[0], text: request.items[0].text + " changed" }] });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_RESPONSE");
  assert.equal(calls, 5, "invalid IDs must stop after finite retries");
  assert.equal(accessLevel, "TRUSTED_CONTEXTS");
  failure = "";
  const make = (text, id = "p1") => ({ ...request,
    items: [{ ...request.items[0], id, text }] });
  gate = new Promise((resolve) => { releaseGate = resolve; });
  const before = calls;
  const duplicate = make("documentation repeated");
  duplicate.items.push({ ...duplicate.items[0], id: "p2" });
  const first = send(duplicate);
  const second = send(make("documentation repeated", "p3"));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(calls, before + 1, "duplicate items and simultaneous batches share one provider call");
  releaseGate(); gate = null;
  const both = await Promise.all([first, second]);
  assert(both.every((result) => result.ok));
  assert.deepEqual(Array.from(both[0].translations, (item) => item.id), ["p1", "p2"]);
  assert.equal(both[1].translations[0].id, "p3");
  const count = calls;
  await send(make("documentation repeated"));
  assert.equal(calls, count);
  storage[dt.STORAGE_KEY].glossary = "documentation = 文档";
  await send(make("documentation repeated"));
  assert.equal(calls, count + 1, "glossary changes invalidate cached decisions");
  storage[dt.STORAGE_KEY].systemPrompt = "Use concise language.";
  await send(make("documentation repeated"));
  assert.equal(calls, count + 2, "prompt changes invalidate cached decisions");
  storage[dt.STORAGE_KEY] = { ...dt.normalizePublicSettings({ provider: "deepseek" }),
    apiKeys: { deepseek: "test-only-not-a-secret" } };
  assert.equal((await send(make("documentation deepseek"))).ok, true);
  assert.equal(bodies.at(-1).thinking.type, "disabled");
  failure = "429";
  assert.equal((await send(make("documentation rate limit"))).ok, true);
  assert(delays.includes(1000), "missing Retry-After must use exponential backoff, not zero");
  failure = "urls";
  const urlCount = calls;
  const badUrl = await send(make("documentation https://example.test/other"));
  assert.equal(badUrl.ok, false);
  assert.equal(calls, urlCount + 3, "damaged URL markers get bounded retries");
  failure = "timeout";
  const timeout = await send(make("documentation slow response body"));
  assert.equal(timeout.error.code, "TIMEOUT", "deadline must cover the response body, not just headers");
  console.log("PASS: compact prompt, exact IDs/slots/URLs, same-run in-flight dedup, glossary/prompt cache invalidation, thinking disabled, trusted storage, 429 backoff and body timeout");
})().catch((error) => { console.error(error); process.exitCode = 1; });
