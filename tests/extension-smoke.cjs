/* Load the unpacked MV3 extension in a disposable Chromium profile.
 * A loopback fixture server replaces the model API; no real credentials.
 * Requires Playwright's full Chromium (npx playwright install chromium).
 */
const { chromium } = require("playwright");
const http = require("node:http"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
(async () => {
  const requests = [], errors = [];
  const fixtureHtml = '<!doctype html><html lang="en"><title>Fixture</title><body><p id="hello">Hello</p>'
    + '<nav><a href="#docs" id="docs">Read documentation</a></nav></body></html>';
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
    if (req.method === "OPTIONS") { res.end(); return; }
    if (req.url === "/v1/chat/completions") {
      let body = ""; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body), payload = JSON.parse(request.messages[1].content);
      requests.push(payload.items.map((item) => item.text));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: payload.items.map((item) => ({
        id: item.id, text: item.text.replaceAll("Hello", "你好").replaceAll("Read documentation", "阅读文档")
      })) }) } }], usage: { prompt_tokens: 8, completion_tokens: 2 } }));
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(fixtureHtml);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let context;
  try {
    context = await chromium.launchPersistentContext("", { channel: "chromium", headless: true,
      executablePath: process.env.EXTENSION_CHROME_BIN,
      args: ["--disable-extensions-except=" + root, "--load-extension=" + root] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
    const extensionId = new URL(worker.url()).host;
    const origin = "http://127.0.0.1:" + server.address().port;
    const extensionUrl = "chrome-extension://" + extensionId;
    // This existing manifest-permitted origin is intercepted locally. It
    // grants the test probe scripting access without broadening permissions.
    const fixtureUrl = "https://api.deepseek.com/deer-extension-fixture";
    await context.route("https://api.deepseek.com/**", (route) => route.fulfill({ contentType: "text/html", body: fixtureHtml }));
    const options = await context.newPage();
    options.on("pageerror", (error) => errors.push(error.message));
    await options.goto(extensionUrl + "/src/options/options.html");
    await options.locator("#provider").selectOption("ollama");
    await options.locator("#base-url").fill(origin + "/v1");
    // Configure only this disposable profile. No user Chrome data is opened.
    await worker.evaluate(async (baseUrl) => chrome.storage.local.set({ deerwebtranslatorSettings: {
      ...DeerWebTranslator.normalizePublicSettings({ provider: "ollama", baseUrl }), apiKeys: { ollama: "fixture-only" }
    }}), origin + "/v1");
    await options.reload();
    await options.locator("#test-button").click();
    await options.waitForFunction(() => document.querySelector("#save-status").textContent.includes("连接正常"));
    assert.equal(requests.length, 1, "explicit connection test reaches only fixture endpoint");

    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(fixtureUrl);
    await page.bringToFront();
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
    await page.evaluate(() => {
      window.originalLink = document.querySelector("#docs"); window.realClicks = 0;
      originalLink.addEventListener("click", (event) => { event.preventDefault(); if (event.isTrusted) realClicks++; });
    });
    await worker.evaluate(async (tabId) => {
      const stored = await chrome.storage.local.get("deerwebtranslatorSettings");
      return chrome.tabs.sendMessage(tabId, { type: "DEERWEBTRANSLATOR_START_TRANSLATION",
        settings: DeerWebTranslator.normalizePublicSettings(stored.deerwebtranslatorSettings) });
    }, tabId);
    await page.waitForFunction(() => document.querySelector("#hello").textContent === "你好");
    await page.locator("#docs").click();
    assert.equal(await page.evaluate(() => originalLink === document.querySelector("#docs") && realClicks === 1), true);
    assert.equal(await page.evaluate(() => typeof window.DeerWebTranslator), "undefined", "content globals are isolated from the page");
    const tabCommand = (type, extra = {}) => worker.evaluate(async ({ tabId, type, extra }) => {
      return chrome.tabs.sendMessage(tabId, { type: "DEERWEBTRANSLATOR_" + type, ...extra });
    }, { tabId, type, extra });
    await tabCommand("SET_DISPLAY_MODE", { mode: "original" });
    assert.equal(await page.locator("#hello").textContent(), "Hello");
    await tabCommand("SET_DISPLAY_MODE", { mode: "translation" });
    assert.equal(await page.locator("#hello").textContent(), "你好");

    // An injected isolated-world probe must be denied storage access.
    const protectedStorage = await worker.evaluate(async (tabId) => {
      const result = await chrome.scripting.executeScript({ target: { tabId }, func: async () => {
        try { await chrome.storage.local.get("deerwebtranslatorSettings"); return false; }
        catch { return true; }
      } });
      return result[0].result;
    }, tabId);
    assert.equal(protectedStorage, true, "TRUSTED_CONTEXTS blocks content-script storage reads");

    await worker.evaluate(async (origin) => chrome.storage.local.set({ deerwebtranslatorSitePreferences: {
      [origin]: { auto: "always", mode: "translation" }
    } }), new URL(fixtureUrl).origin);
    const beforeReload = requests.length;
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#hello").textContent === "你好");
    assert.equal(requests.length, beforeReload, "explicit always-translate policy reuses persistent cache on reload");
    await options.locator("#clear-cache-button").click();
    await options.waitForFunction(() => document.querySelector("#cache-info").textContent.startsWith("0 条缓存"));
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get("deerwebtranslatorSettings")).deerwebtranslatorSettings.apiKeys.ollama), "fixture-only");
    // Keep this translated page open while reloading only the extension.
    // A service-worker restart alone is not an invalidated content context.
    await page.bringToFront();
    await worker.evaluate(async () => chrome.storage.local.set({ deerwebtranslatorSitePreferences: {} }));
    await page.evaluate(() => { window.linkBeforeExtensionReload = document.querySelector("#docs"); });
    await worker.evaluate(() => chrome.runtime.reload()).catch((error) => {
      if (!/closed|destroyed/i.test(error.message)) throw error;
    });
    await page.evaluate(() => {
      document.querySelector("#hello").firstChild.data = "New site text";
      document.body.append(Object.assign(document.createElement("p"), { textContent: "Fresh content after extension reload" }));
      document.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(1100);
    assert.deepEqual(errors, [], "extension reload must not produce uncaught invalid-context errors");
    assert.equal(await page.locator("#hello").textContent(), "New site text", "cleanup never overwrites site-authored updates");
    assert.equal(await page.locator("#docs").textContent(), "Read documentation", "orphaned translations restore before a fresh injection");
    assert.equal(await page.evaluate(() => window.linkBeforeExtensionReload === document.querySelector("#docs")), true);
    // Fresh/duplicate injection is covered in context-lifecycle-regression.
    // Command-line-loaded test builds may disable the extension on self-reload;
    // this check deliberately focuses on the still-open page's old context.
    assert.deepEqual(errors, []);
    console.log("PASS: actual MV3/CSP/messages/storage, translations/cache/utilities, live extension reload without page refresh and orphan cleanup");
  } finally {
    if (context) await context.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
