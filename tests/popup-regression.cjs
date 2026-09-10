/* Real popup HTML in Chrome, with controlled local extension API mocks. */
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const executablePath = process.env.CHROME_BIN || (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const failures = [];
  async function open(options = {}) {
    const page = await browser.newPage({ viewport: { width: 360, height: 640 } });
    page.on("pageerror", (error) => failures.push(error.message));
    await page.route("https://popup.test/**", (route) => {
      const file = path.join(root, new URL(route.request().url()).pathname);
      const ext = path.extname(file);
      return route.fulfill({ body: fs.readFileSync(file), contentType:
        ({ ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".png": "image/png" })[ext] });
    });
    await page.addInitScript((options) => {
      const calls = window.calls = [];
      const handlers = [];
      window.config = { provider: "ollama", model: "local-model", displayMode: "bilingual",
        apiKeys: { other: "fixture-only" }, glossary: "Preserve glossary" };
      window.hasReceiver = options.receiver !== false;
      window.pageState = { status: "idle", mode: "translation", total: 0, completed: 0, autoTranslate: false };
      window.chrome = {
        tabs: {
          query() {
            calls.push("tabs");
            return options.delayTabs ? new Promise((resolve) => { window.resolveTabs = resolve; })
              : Promise.resolve([{ id: 7, url: options.url || "https://example.test/repo" }]);
          },
          sendMessage(id, message) {
            calls.push(message.type);
            if (message.type === "DEERWEBTRANSLATOR_GET_STATE" && options.pendingProbe) {
              return new Promise((resolve) => { window.resolveProbe = resolve; });
            }
            if (!window.hasReceiver) return Promise.reject(new Error("Could not establish connection. Receiving end does not exist."));
            if (message.type === "DEERWEBTRANSLATOR_START_TRANSLATION") {
              window.lastStart = message;
              window.pageState = { ...window.pageState, status: "completed", mode: "translation", total: 4, completed: 4, autoTranslate: true };
            }
            if (message.type === "DEERWEBTRANSLATOR_STOP_TRANSLATION") {
              window.pageState = { ...window.pageState, status: "stopped", autoTranslate: false };
            }
            if (message.type === "DEERWEBTRANSLATOR_SET_DISPLAY_MODE") window.pageState.mode = message.mode;
            return Promise.resolve({ ok: true, state: { ...window.pageState } });
          }
        },
        storage: { local: {
          get() {
            calls.push("storage");
            return options.delayConfig ? new Promise((resolve) => { window.resolveConfig = resolve; })
              : Promise.resolve({ deerwebtranslatorSettings: window.config });
          },
          set(value) { calls.push("save"); window.config = value.deerwebtranslatorSettings; return Promise.resolve(); }
        }, onChanged: { addListener() {} } },
        scripting: {
          insertCSS() { calls.push("css"); return Promise.resolve(); },
          executeScript() { calls.push("inject"); window.hasReceiver = true; return Promise.resolve(); }
        },
        runtime: {
          openOptionsPage() { calls.push("settings"); return Promise.resolve(); },
          onMessage: { addListener(fn) { handlers.push(fn); } }
        }
      };
      window.progress = (state) => handlers.forEach((fn) => fn({
        type: "DEERWEBTRANSLATOR_PROGRESS", state
      }, { tab: { id: 7 } }));
    }, options);
    await page.goto("https://popup.test/src/popup/popup.html", { waitUntil: "load" });
    return page;
  }
  try {
    // A slow tab query cannot delay storage or disable opening settings.
    let page = await open({ delayTabs: true, delayConfig: true });
    assert.deepEqual(await page.evaluate(() => calls.slice(0, 2)), ["tabs", "storage"]);
    assert(await page.locator("h1").isVisible());
    const initialWidth = await page.locator("body").evaluate((body) => body.getBoundingClientRect().width);
    await page.locator("#settings-button").click();
    assert((await page.evaluate(() => calls)).includes("settings"));
    await page.locator("#translate-button").click();
    assert.equal(await page.locator("#translate-button").isDisabled(), true, "early click has immediate feedback");
    await page.evaluate(() => {
      resolveTabs([{ id: 7, url: "https://example.test/repo" }]);
      config.model = "a-very-long-custom-model-name-that-must-not-resize-the-popup";
      resolveConfig({ deerwebtranslatorSettings: config });
    });
    await page.waitForFunction(() => window.lastStart);
    assert.equal(await page.evaluate(() => calls.filter((c) => c === "storage").length), 1, "startup and early click share config read");
    assert.equal(await page.locator("body").evaluate((body) => body.getBoundingClientRect().width), initialWidth);
    assert.equal(await page.evaluate(() => JSON.stringify(lastStart).includes("fixture-only")), false);
    await page.close();

    // No receiver: merely opening the popup must not inject CSS/scripts.
    page = await open({ receiver: false });
    await page.waitForFunction(() => calls.includes("DEERWEBTRANSLATOR_GET_STATE"));
    assert.equal(await page.evaluate(() => calls.includes("inject") || calls.includes("css")), false);
    await page.locator("#translate-button").click();
    await page.waitForFunction(() => window.lastStart);
    assert.equal(await page.evaluate(() => calls.filter((c) => c === "inject").length), 1);
    assert.equal(await page.evaluate(() => calls.filter((c) => c === "DEERWEBTRANSLATOR_GET_STATE").length), 1,
      "actions do not add a second status handshake");
    assert.equal(await page.locator("#stop-button").isEnabled(), true, "can stop viewport monitoring after a batch completes");
    await page.locator("#stop-button").click();
    await page.waitForFunction(() => pageState.status === "stopped");
    await page.locator('[data-mode="original"]').click();
    await page.waitForFunction(() => config.displayMode === "original");
    assert.equal(await page.evaluate(() => config.apiKeys.other), "fixture-only");
    assert.equal(await page.evaluate(() => config.glossary), "Preserve glossary");
    assert.equal(await page.evaluate(() => calls.indexOf("DEERWEBTRANSLATOR_SET_DISPLAY_MODE") < calls.indexOf("save")), true);
    await page.close();

    // A late passive status response must not overwrite a newer command result.
    page = await open({ pendingProbe: true });
    await page.waitForFunction(() => typeof resolveProbe === "function");
    await page.locator("#translate-button").click();
    await page.waitForFunction(() => window.lastStart);
    await page.evaluate(() => resolveProbe({ ok: true, state: { status: "idle", mode: "original", total: 0 } }));
    await page.waitForTimeout(50);
    assert.equal(await page.locator("#status-label").textContent(), "已完成");
    assert.equal(await page.locator('[data-mode="translation"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.evaluate(() => calls.includes("inject")), false);
    await page.close();

    // Config resolving during a probe must not invalidate the authoritative page state.
    page = await open({ pendingProbe: true, delayConfig: true });
    await page.waitForFunction(() => typeof resolveProbe === "function");
    await page.evaluate(() => resolveConfig({ deerwebtranslatorSettings: config }));
    await page.waitForFunction(() => document.querySelector("#provider-label").textContent.includes("local-model"));
    await page.evaluate(() => resolveProbe({ ok: true, state: { status: "translating", mode: "original", total: 20, completed: 3 } }));
    await page.waitForFunction(() => document.querySelector("#status-label").textContent === "翻译中");
    assert.equal(await page.locator('[data-mode="original"]').getAttribute("aria-pressed"), "true");
    await page.close();

    page = await open({ pendingProbe: true });
    await page.waitForTimeout(750);
    assert.equal(await page.evaluate(() => calls.includes("inject")), false, "probe timeout must never cause injection");
    assert.equal(await page.locator("#error-label").isVisible(), false);
    assert.equal(await page.locator("#translate-button").isEnabled(), true);
    await page.close();

    page = await open({ url: "chrome://extensions" });
    assert.equal(await page.locator("#translate-button").isDisabled(), true);
    assert.equal(await page.evaluate(() => calls.some((c) => c.includes("DEERWEBTRANSLATOR"))), false);
    await page.close();
    assert.deepEqual(failures, []);
    console.log("PASS: parallel initialization, interactive pending state, fixed width, no startup injection, one-read early action, lazy injection, stale-probe guard, authoritative progress, mode persistence and restricted pages");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
