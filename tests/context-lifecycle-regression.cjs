/* Simulate runtime invalidation, including synchronous API throws. No real API. */
const { chromium } = require("playwright");
const path = require("node:path"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const contentPath = process.env.CONTENT_SCRIPT_UNDER_TEST || path.join(root, "src/content/content-script.js");
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN
    || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined) });
  async function fixture(failType = "", asynchronous = false) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("https://lifecycle.test/**", (route) => route.fulfill({ body: "" }));
    await page.goto("https://lifecycle.test/fixture");
    await page.setContent('<p id="hello">Hello world</p><p id="edited">Site text</p>'
      + '<p id="long">Read the documentation carefully before continuing.</p><button id="control" style="width:45px;white-space:nowrap">Go</button>');
    await page.evaluate(({ failType, asynchronous }) => {
      const listeners = new Set(), intervals = new Set(), timeouts = new Set(), observers = [], domListeners = [];
      const rawTimeout = setTimeout, rawInterval = setInterval, stopTimeout = clearTimeout, stopInterval = clearInterval;
      window.setTimeout = (fn, ms, ...args) => {
        const id = rawTimeout(() => { timeouts.delete(id); fn(...args); }, ms); timeouts.add(id); return id;
      };
      window.clearTimeout = (id) => { timeouts.delete(id); stopTimeout(id); };
      window.setInterval = (...args) => { const id = rawInterval(...args); intervals.add(id); return id; };
      window.clearInterval = (id) => { intervals.delete(id); stopInterval(id); };
      for (const name of ["MutationObserver", "IntersectionObserver"]) {
        const Native = window[name];
        window[name] = class extends Native {
          constructor(...args) {
            super(...args); this.active = false; this.createdAt = new Error().stack;
            // Playwright installs its own listener-removal observer in this
            // realm. It is test infrastructure, not an extension resource.
            if (!/InjectedScript\./.test(this.createdAt)) observers.push(this);
          }
          observe(...args) { this.active = true; return super.observe(...args); }
          disconnect() { this.active = false; return super.disconnect(); }
        };
      }
      for (const target of [window, document]) {
        const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target);
        target.addEventListener = (type, fn, options) => {
          if (["scroll", "resize", "visibilitychange"].includes(type)) domListeners.push({ target, type, fn });
          return add(type, fn, options);
        };
        target.removeEventListener = (type, fn, options) => {
          const index = domListeners.findIndex((item) => item.target === target && item.type === type && item.fn === fn);
          if (index >= 0) domListeners.splice(index, 1);
          return remove(type, fn, options);
        };
      }
      window.calls = []; window.states = [];
      window.failure = { type: failType, asynchronous, transient: false };
      window.refs = [document.querySelector("#hello").firstChild, document.querySelector("#control")];
      window.chrome = { runtime: {
        id: "fixture-extension",
        onMessage: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } },
        // Deliberately NOT async: reproduce Chrome throwing before .catch exists.
        sendMessage(message) {
          calls.push(message.type);
          if (message.type === failure.type) {
            const error = new Error(failure.transient ? "The message port closed before a response was received." : "Extension context invalidated.");
            if (failure.asynchronous) return Promise.reject(error);
            throw error;
          }
          if (message.type.endsWith("PROGRESS")) states.push(message.state);
          if (message.type.endsWith("TRANSLATE_BATCH")) {
            const result = { ok: true, translations: message.items.map((item) => ({ id: item.id,
              text: item.text.replaceAll("Hello world", "你好世界").replaceAll("Site text", "网站文字")
                .replaceAll("Read the documentation carefully before continuing.", "继续之前，请仔细阅读文档。")
                .replaceAll("Go", "这条译文过长不能撑坏按钮") })) };
            if (window.holdBatch) return new Promise((resolve) => { window.releaseBatch = () => resolve(result); });
            return Promise.resolve(result);
          }
          return Promise.resolve({ ok: true });
        }
      }};
      window.send = (name, extra = {}) => new Promise((resolve) => {
        if (!listeners.size) { resolve({ ok: false }); return; }
        [...listeners].forEach((fn) => fn({ type: "DEERWEBTRANSLATOR_" + name, ...extra }, {}, resolve));
      });
      window.resources = () => ({ intervals: intervals.size, timeouts: timeouts.size,
        observers: observers.filter((item) => item.active).length, domListeners: domListeners.length, listeners: listeners.size });
      window.observerDetails = () => observers.filter((item) => item.active).map((item) => item.createdAt);
    }, { failType, asynchronous });
    for (const file of ["src/shared/constants.js", "src/shared/dom-codec.js", "src/content/text-index.js"]) {
      await page.addScriptTag({ path: path.join(root, file) });
    }
    await page.addScriptTag({ path: contentPath });
    return { page, errors };
  }
  const start = (page, mode = "translation") => page.evaluate((mode) => send("START_TRANSLATION", { settings: { displayMode: mode } }), mode);
  async function translated(page, mode = "translation") {
    const response = await start(page, mode);
    assert.equal(response.ok, true);
    await page.waitForFunction((runId) => states.at(-1)?.runId === runId && states.at(-1)?.status === "completed", response.state.runId);
  }
  async function disposed({ page, errors }) {
    await page.waitForTimeout(700);
    assert.deepEqual(errors, [], "runtime invalidation never escapes as an uncaught exception/rejection");
    assert.equal(await page.evaluate(() => window.__DEERWEBTRANSLATOR_CONTENT_SCRIPT_LOADED__), false);
    assert.deepEqual(await page.evaluate(() => resources()), { intervals: 0, timeouts: 0, observers: 0, domListeners: 0, listeners: 0 },
      JSON.stringify(await page.evaluate(() => observerDetails())));
    const count = await page.evaluate(() => calls.length);
    await page.evaluate(() => {
      document.dispatchEvent(new Event("scroll")); dispatchEvent(new Event("resize"));
      document.dispatchEvent(new Event("visibilitychange")); history.pushState({}, "", "/after-reload");
      document.body.append(Object.assign(document.createElement("p"), { textContent: "Hello world" }));
    });
    await page.waitForTimeout(550);
    assert.equal(await page.evaluate(() => calls.length), count, "retired callbacks never send more IPC");
  }
  try {
    // Screenshot's exact path: progress reporting throws synchronously.
    for (const asynchronous of [false, true]) {
      const item = await fixture(); const { page } = item;
      await translated(page, "bilingual");
      assert(await page.locator(".deeptranslate-translation").count() > 0);
      await page.evaluate((asynchronous) => {
        failure = { type: "DEERWEBTRANSLATOR_PROGRESS", asynchronous };
        document.querySelector("#edited").firstChild.data = "New site-authored text";
        document.dispatchEvent(new Event("visibilitychange"));
      }, asynchronous);
      await disposed(item);
      assert.equal(await page.locator("#hello").textContent(), "Hello world");
      assert.equal(await page.locator("#edited").textContent(), "New site-authored text");
      assert.equal(await page.locator(".deeptranslate-translation").count(), 0);
      assert.equal(await page.locator("#control").getAttribute("title"), null);
      assert.equal(await page.evaluate(() => refs[0] === document.querySelector("#hello").firstChild && refs[1] === document.querySelector("#control")), true);
      {
        await page.evaluate(() => { failure.type = ""; });
        await page.addScriptTag({ path: contentPath });
        await page.addScriptTag({ path: contentPath });
        assert.equal(await page.evaluate(() => resources().listeners), 1, "fresh injection works and duplicate injection stays idempotent");
        await translated(page);
        assert.equal(await page.locator("#hello").textContent(), "你好世界");
      }
      await page.close();
    }
    for (const type of ["PAGE_POLICY", "TRANSLATE_BATCH", "CANCEL_TRANSLATION"]) {
      const item = await fixture(type === "PAGE_POLICY" ? "DEERWEBTRANSLATOR_" + type : "");
      if (type === "CANCEL_TRANSLATION") await translated(item.page);
      if (type !== "PAGE_POLICY") {
        await item.page.evaluate((type) => { failure.type = "DEERWEBTRANSLATOR_" + type; }, type);
        if (type === "CANCEL_TRANSLATION") await item.page.evaluate(() => send("STOP_TRANSLATION"));
        else await start(item.page);
      }
      await disposed(item); await item.page.close();
    }
    const idle = await fixture();
    await idle.page.evaluate(() => { chrome.runtime.id = undefined; });
    await disposed(idle);
    await idle.page.close();
    const pending = await fixture();
    await translated(pending.page);
    await pending.page.evaluate(() => {
      window.holdBatch = true;
      document.body.append(Object.assign(document.createElement("p"), { id: "pending", textContent: "Hello world pending" }));
    });
    await pending.page.waitForFunction(() => typeof releaseBatch === "function");
    await pending.page.evaluate(() => { chrome.runtime.id = undefined; });
    await disposed(pending);
    await pending.page.evaluate(() => releaseBatch());
    await pending.page.waitForTimeout(80);
    assert.equal(await pending.page.locator("#pending").textContent(), "Hello world pending", "late response cannot revive a retired run");
    await pending.page.close();

    const transient = await fixture();
    await translated(transient.page);
    await transient.page.evaluate(() => {
      failure = { type: "DEERWEBTRANSLATOR_PROGRESS", transient: true };
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await transient.page.waitForTimeout(100);
    assert.equal(await transient.page.evaluate(() => resources().listeners), 1, "a transient port failure must not dispose a healthy context");
    assert.equal(await transient.page.locator("#hello").textContent(), "你好世界");
    await transient.page.evaluate(() => {
      failure.type = "";
      document.body.append(Object.assign(document.createElement("p"), { id: "next", textContent: "Hello world next" }));
    });
    await transient.page.waitForFunction(() => document.querySelector("#next").textContent === "你好世界 next");
    assert.deepEqual(transient.errors, []);
    await transient.page.close();
    console.log("PASS: sync/async invalidation on all message paths, full teardown, source/UI preservation, idle invalidation, late response guard, fresh/duplicate injection and transient error recovery");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
