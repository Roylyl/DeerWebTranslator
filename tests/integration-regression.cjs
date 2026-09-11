/* Content script + actual service worker wired together. Provider only is mocked. */
const { chromium } = require("playwright");
const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN
    || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined) });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 750 } });
    await page.route("https://example.test/**", (route) => route.fulfill({ body: "" }));
    await page.goto("https://example.test/fixture");
    const storage = {}, calls = [], partials = [];
    let listener, gate = null, release, breakOne = false;
    let revisionRelease, revisionRequests = 0;
    const worker = vm.createContext({
      console, URL, AbortController, clearTimeout,
      setTimeout(fn, ms) { const t = setTimeout(fn, ms); if (ms > 60000) t.unref(); return t; },
      chrome: {
        storage: { local: {
          async setAccessLevel() {},
          async get(keys) { return keys === null ? { ...storage } : Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).map((key) => [key, storage[key]])); },
          async set(values) { Object.assign(storage, values); },
          async remove(keys) { keys.forEach((key) => delete storage[key]); },
          async getBytesInUse() { return 256; }
        } },
        tabs: { async sendMessage(id, message) {
          partials.push(message);
          return page.evaluate((message) => window.fromWorker(message), message);
        } },
        runtime: {
          getURL(p) { return "chrome-extension://fixture/" + p; },
          onInstalled: { addListener() {} }, onStartup: { addListener() {} },
          onMessage: { addListener(fn) { listener = fn; } }
        }
      },
      async fetch(url, options) {
        const request = JSON.parse(options.body);
        const data = JSON.parse(request.messages[1].content);
        calls.push(data.items.map((item) => item.text));
        if (gate && data.items.some((item) => item.text.includes("Slow paragraph"))) await gate;
        let revisionText = "";
        if (data.items.some((item) => item.text.includes("Revision paragraph"))) {
          revisionText = ++revisionRequests === 1 ? "旧的迟到译文" : "新的重译结果";
          if (revisionRequests === 1) await new Promise((resolve) => { revisionRelease = resolve; });
        }
        const translations = data.items.map((item) => ({
          id: item.id, text: breakOne && item.text.includes("Bad")
            ? "缺失标记"
            : item.text.replaceAll("Cached paragraph", "缓存段落").replaceAll("Slow paragraph", "慢段落")
              .replaceAll("Good paragraph", "成功段落").replaceAll("New visible", "新可见区域")
              .replaceAll("Bad", "错误").replaceAll("marker", "标记")
              .replaceAll("Revision paragraph", revisionText)
              .replaceAll("Short", "这是一段绝对不应该撑坏按钮的过长翻译".repeat(4))
        }));
        return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify({ translations }) } }],
          usage: { prompt_tokens: 11, completion_tokens: 3, prompt_cache_hit_tokens: 4 } }; } };
      }
    });
    worker.importScripts = (...files) => files.forEach((file) => vm.runInContext(
      fs.readFileSync(path.resolve(root, "src/background", file), "utf8"), worker));
    vm.runInContext(fs.readFileSync(path.join(root, "src/background/service-worker.js"), "utf8"), worker);
    const DT = worker.DeerWebTranslator;
    storage[DT.STORAGE_KEY] = { ...DT.normalizePublicSettings({ provider: "ollama" }), apiKeys: {} };
    const request = (message, sender = { tab: { id: 7, url: page.url() }, frameId: 0, url: page.url() }) =>
      new Promise((resolve) => listener(message, sender, resolve));
    await page.exposeFunction("backend", (message) => request(message));
    await page.setContent(`<html><head><title>Fixture</title><style>
      #below {margin-top:2200px} .hidden{display:none} button{width:70px;white-space:nowrap}
    </style></head><body><p id="cached">Cached paragraph</p>
      <p id="slow" class="hidden">Slow paragraph</p>
      <button id="short">Short</button>
      <section id="below"><p id="visible">New visible</p></section>
    </body></html>`);
    await page.evaluate(() => {
      const handlers = [];
      window.historyStates = [];
      window.fromWorker = (message) => new Promise((resolve) => handlers.forEach((fn) => fn(message, {}, resolve)));
      window.send = (name, rest = {}) => window.fromWorker({ type: "DEERWEBTRANSLATOR_" + name, ...rest });
      window.chrome = { runtime: {
        id: "fixture-extension",
        onMessage: { addListener(fn) { handlers.push(fn); } },
        sendMessage(message) {
          if (message.type === "DEERWEBTRANSLATOR_PROGRESS") { historyStates.push(message.state); return Promise.resolve({ ok: true }); }
          return window.backend(message);
        }
      }};
    });
    for (const file of ["src/shared/constants.js", "src/shared/dom-codec.js", "src/content/text-index.js", "src/content/content-script.js"]) {
      await page.addScriptTag({ path: path.join(root, file) });
    }
    const start = () => page.evaluate(() => send("START_TRANSLATION", { settings: { provider: "ollama", displayMode: "translation" } }));
    const lastState = () => page.evaluate(async () => (await send("GET_STATE")).state);
    await start();
    await page.waitForFunction(() => document.querySelector("#cached").textContent === "缓存段落");
    await page.waitForFunction(() => historyStates.at(-1)?.status === "completed");
    assert.equal((await lastState()).overflow, 1);
    assert.equal(await page.locator("#short").textContent(), "Short", "overflowing controls retain source");
    assert((await page.locator("#short").getAttribute("title")).includes("过长翻译"));
    assert.equal((await lastState()).usage.inputTokens, 11);

    // Mixed cache/miss: cached text renders while the provider is held open.
    await page.evaluate(() => send("STOP_TRANSLATION"));
    await page.evaluate(() => document.querySelector("#slow").classList.remove("hidden"));
    gate = new Promise((resolve) => { release = resolve; });
    const before = calls.length;
    await start();
    await page.waitForFunction(() => document.querySelector("#cached").textContent === "缓存段落");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert(calls.length > before);
    assert.equal(await page.locator("#slow").textContent(), "Slow paragraph");
    assert(partials.some((message) => message.source === "cache"));
    assert((await lastState()).cached >= 1);

    // A newly visible region gets a free connection without waiting for old work.
    await page.locator("#below").scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector("#visible").textContent === "新可见区域");
    assert.equal(await page.locator("#slow").textContent(), "Slow paragraph");
    const indexedBefore = (await lastState()).diagnostics.visitedTextNodes;
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.locator("#below").scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    assert.equal((await lastState()).diagnostics.visitedTextNodes, indexedBefore, "scrolling must not re-walk text nodes");
    release(); gate = null;
    await page.waitForFunction(() => document.querySelector("#slow").textContent === "慢段落");

    // Bad ID slots only retry the bad item, and do not stop subsequent regions.
    breakOne = true;
    const failureStart = calls.length;
    await page.evaluate(() => {
      scrollTo(0, 0);
      const good = document.createElement("p"); good.id = "good"; good.textContent = "Good paragraph";
      const bad = document.createElement("p"); bad.id = "bad";
      bad.append(document.createTextNode("Bad "), Object.assign(document.createElement("b"), { textContent: "marker" }));
      document.body.prepend(good, bad);
    });
    await page.waitForFunction(() => document.querySelector("#good").textContent === "成功段落");
    await page.waitForFunction(() => historyStates.at(-1)?.status === "partial");
    assert.equal((await lastState()).failed, 1);
    assert.equal(calls.slice(failureStart).flat().filter((text) => text === "Good paragraph").length, 1);
    assert.equal((await lastState()).autoTranslate, true);
    breakOne = false;
    const retryStart = calls.length;
    await page.evaluate(() => send("RETRY_FAILED"));
    await page.waitForFunction(() => document.querySelector("#bad").textContent.includes("错误"));
    assert(!calls.slice(retryStart).flat().some((text) => text.includes("Good paragraph")), "retry never repeats successful paragraphs");
    await page.waitForFunction(() => historyStates.at(-1)?.status === "completed");
    const usage = (await lastState()).usage;
    assert.equal(usage.inputTokens, usage.reportedRequests * 11);
    assert.equal(usage.outputTokens, usage.reportedRequests * 3);
    assert.equal(usage.cacheReadTokens, usage.reportedRequests * 4);

    // Selected retranslation bypasses cache for just that paragraph.
    const selectionStart = calls.length;
    await page.evaluate(() => {
      const selection = getSelection(), range = document.createRange();
      range.selectNodeContents(document.querySelector("#good")); selection.removeAllRanges(); selection.addRange(range);
      return send("TRANSLATE_SELECTION");
    });
    await page.waitForFunction(() => document.querySelector("#good").textContent === "成功段落");
    assert.equal(calls.slice(selectionStart).flat().filter((text) => text.includes("Good paragraph")).length, 1);
    assert.equal(await page.locator("#cached").textContent(), "缓存段落");

    // A forced revision wins against an earlier in-flight paragraph, including cache.
    await page.evaluate(() => {
      document.body.prepend(Object.assign(document.createElement("p"), { id: "revision", textContent: "Revision paragraph" }));
    });
    while (!revisionRelease) await page.waitForTimeout(20);
    await page.evaluate(() => {
      const range = document.createRange(); range.selectNodeContents(document.querySelector("#revision"));
      getSelection().removeAllRanges(); getSelection().addRange(range); return send("TRANSLATE_SELECTION");
    });
    await page.waitForFunction(() => document.querySelector("#revision").textContent === "新的重译结果");
    revisionRelease();
    await page.waitForFunction(() => historyStates.at(-1)?.status === "completed");
    assert.equal(await page.locator("#revision").textContent(), "新的重译结果");
    assert(Object.values(storage).some((value) => value?.text === "新的重译结果"));
    assert(!Object.values(storage).some((value) => value?.text === "旧的迟到译文"), "late response cannot overwrite newer persistent cache");

    // Page code cannot inspect/clear cache or trigger the connection test.
    for (const type of ["CACHE_INFO", "CLEAR_CACHE", "TEST_CONNECTION"]) {
      assert.equal((await request({ type: "DEERWEBTRANSLATOR_" + type })).ok, false);
    }
    storage.deerwebtranslatorSitePreferences = { "https://example.test": { auto: "always", mode: "bilingual" } };
    const policy = await request({ type: "DEERWEBTRANSLATOR_PAGE_POLICY" });
    assert.equal(policy.policy.auto, "always");
    assert.equal(policy.settings.apiKeys, undefined);
    const trusted = { url: "chrome-extension://fixture/src/options/options.html" };
    const connectionBefore = calls.length;
    const connection = await request({ type: "DEERWEBTRANSLATOR_TEST_CONNECTION" }, trusted);
    assert.equal(connection.ok, true);
    assert.equal(connection.usage.requests, 1);
    assert.deepEqual(calls.slice(connectionBefore), [["Hello"]]);
    const localBefore = calls.length;
    const label = { type: "DEERWEBTRANSLATOR_TRANSLATE_BATCH", runId: "local-label", pageUrl: page.url(),
      items: [{ id: "local", hash: "fixture", text: "Settings", context: { tag: "button", region: "ui" } }] };
    assert.equal((await request(label)).localCount, 1);
    assert.equal(calls.length, localBefore, "unambiguous labels avoid API");
    storage[DT.STORAGE_KEY].glossary = "Settings = 首选项\nUnused term = 不应发送";
    assert.equal((await request({ ...label, runId: "glossary-label" })).localCount, 0);
    assert.equal(calls.length, localBefore + 1, "a glossary override bypasses the local dictionary");
    const info = await request({ type: "DEERWEBTRANSLATOR_CACHE_INFO" }, trusted);
    assert(info.entries > 0);
    const clear = await request({ type: "DEERWEBTRANSLATOR_CLEAR_CACHE" }, trusted);
    assert.equal(clear.entries, info.entries);
    assert(storage[DT.STORAGE_KEY]);
    assert(storage.deerwebtranslatorSitePreferences);
    console.log("PASS: cache before API, concurrent new viewport, no scroll re-index, partial/recovery retries, usage aggregation, overflow fallback, selection/stale-cache safety, local labels/glossary and privileged utilities");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
