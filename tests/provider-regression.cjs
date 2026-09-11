/* Protocol and usage fixtures for every provider; no external network. */
const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../src/background");
(async () => {
  const storage = {}, calls = [];
  let listener, kind = "openai", failure = "";
  const worker = vm.createContext({
    console, URL, AbortController, setTimeout, clearTimeout,
    chrome: {
      storage: { local: {
        async setAccessLevel() {},
        async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, storage[key]])); },
        async set(values) { Object.assign(storage, values); }
      } },
      runtime: {
        onInstalled: { addListener() {} }, onStartup: { addListener() {} },
        onMessage: { addListener(fn) { listener = fn; } }
      }
    },
    async fetch(url, options) {
      const body = JSON.parse(options.body); calls.push(body);
      if (failure) {
        const problem = failure; failure = "";
        return { ok: false, status: 400, text: async () => problem + " unsupported" };
      }
      let payload, prompt;
      if (kind === "anthropic") {
        assert(url.endsWith("/messages"));
        assert.equal(options.headers["x-api-key"], "fixture-only");
        payload = JSON.parse(body.messages[0].content); prompt = body.system;
      } else if (kind === "gemini") {
        assert(url.endsWith(":generateContent"));
        assert.equal(options.headers["x-goog-api-key"], "fixture-only");
        payload = JSON.parse(body.contents[0].parts[0].text); prompt = body.systemInstruction.parts[0].text;
      } else {
        assert(url.endsWith("/chat/completions"));
        assert.equal(options.headers.Authorization, "Bearer fixture-only");
        payload = JSON.parse(body.messages[1].content); prompt = body.messages[0].content;
      }
      assert(prompt.includes("documentation = 文档"));
      assert(!prompt.includes("UnusedShouldNotSend"), "unrelated glossary terms must not increase each request");
      const content = JSON.stringify({ translations: payload.items.map((item) => ({ id: item.id, text: "文档" })) });
      const response = kind === "anthropic"
        ? { content: [{ type: "text", text: content }], usage: { input_tokens: 11, output_tokens: 3,
          cache_read_input_tokens: 4, cache_creation_input_tokens: 2 } }
        : kind === "gemini" ? { candidates: [{ content: { parts: [{ text: content }] } }],
          usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3, thoughtsTokenCount: 2, cachedContentTokenCount: 4 } }
          : { choices: [{ message: { content } }], usage: { prompt_tokens: 11, completion_tokens: 3,
            prompt_tokens_details: { cached_tokens: 4 } } };
      return { ok: true, json: async () => response };
    }
  });
  worker.importScripts = (...files) => files.forEach((file) => vm.runInContext(fs.readFileSync(path.resolve(root, file), "utf8"), worker));
  vm.runInContext(fs.readFileSync(path.join(root, "service-worker.js"), "utf8"), worker);
  const DT = worker.DeerWebTranslator;
  function configure(provider) {
    kind = provider.kind;
    storage[DT.STORAGE_KEY] = { ...DT.normalizePublicSettings({ provider: provider.id,
      baseUrl: provider.baseUrl || "https://fixture.example.test/v1", glossary: "documentation = 文档\nUnusedShouldNotSend = 不发送" }),
      apiKeys: { [provider.id]: "fixture-only" } };
  }
  const send = (text) => new Promise((resolve) => listener({ type: "DEERWEBTRANSLATOR_TRANSLATE_BATCH",
    runId: "providers", pageUrl: "https://example.test", pageTitle: "Provider fixture",
    items: [{ id: "p1", hash: "fixture", text, context: { tag: "p", region: "main" } }]
  }, { tab: { id: 7 } }, resolve));
  for (const provider of Object.values(DT.PROVIDERS)) {
    configure(provider);
    const result = await send("documentation " + provider.id);
    assert.equal(result.ok, true, provider.id);
    assert.equal(result.translations[0].text, "文档");
    assert.equal(result.usage.requests, 1);
    assert.equal(result.usage.inputTokens, provider.kind === "anthropic" ? 17 : 11);
    assert.equal(result.usage.outputTokens, provider.kind === "gemini" ? 5 : 3);
    assert.equal(result.usage.cacheReadTokens, 4);
    assert(!JSON.stringify(result).includes("fixture-only"), "keys never appear in content responses");
  }
  configure(DT.PROVIDERS.openai);
  failure = "response_format";
  assert.equal((await send("documentation format fallback")).usage.requests, 2);
  assert.equal((await send("documentation remembered format")).usage.requests, 1);
  assert.equal(calls.at(-1).response_format, undefined);
  failure = "temperature";
  assert.equal((await send("documentation temperature fallback")).usage.requests, 2);
  assert.equal((await send("documentation remembered temperature")).usage.requests, 1);
  assert.equal(calls.at(-1).temperature, undefined);
  console.log("PASS: all nine provider presets, native auth/payload/response adapters, actual usage normalization, relevant glossary and remembered finite option fallback");
})().catch((error) => { console.error(error); process.exitCode = 1; });
