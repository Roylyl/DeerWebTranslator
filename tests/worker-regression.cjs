const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.resolve(__dirname, "../src/background");
(async () => {
  const storage = {};
  let listener, calls = 0, failure = "markers";
  const sandbox = vm.createContext({
    console, URL, AbortController, setTimeout, clearTimeout,
    chrome: {
      storage: { local: {
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
      assert(request.messages[0].content.includes("DWT_OPEN"));
      assert(request.messages[0].content.includes("final semantic discretion"));
      const payload = JSON.parse(request.messages[1].content.split("\n").at(-1));
      assert.equal(payload.page.title, "Agent test page");
      assert.equal(payload.items[0].context.region, "main");
      const items = payload.items;
      assert(!items[0].text.includes("https://"));
      const translations = items.map((item) => ({
        id: failure === "ids" ? "wrong" : item.id,
        text: failure === "markers" ? "缺失链接标记" : item.text.replace("documentation", "文档")
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
  const invalid = await send({ ...request, items: [{ ...request.items[0], hash: "new-hash" }] });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_RESPONSE");
  assert.equal(calls, 5, "invalid IDs must stop after finite retries");
  console.log("PASS: background prompt, marker validation retry, URL restoration, cache reuse, exact IDs and finite retries");
})().catch((error) => { console.error(error); process.exitCode = 1; });
