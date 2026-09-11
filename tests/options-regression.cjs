const { chromium } = require("playwright");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN
    || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined) });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("https://options.test/**", (route) => {
      const file = path.join(root, new URL(route.request().url()).pathname);
      return route.fulfill({ body: fs.readFileSync(file), contentType: {
        ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".png": "image/png"
      }[path.extname(file)] });
    });
    await page.addInitScript(() => {
      window.calls = [];
      window.saved = { provider: "deepseek", model: "fixture-model", baseUrl: "https://gateway.example.test/v1",
        displayMode: "bilingual", apiKeys: { deepseek: "fixture-deepseek-only", gemini: "fixture-gemini-only" } };
      window.chrome = {
        storage: { local: {
          get: async () => ({ deerwebtranslatorSettings: window.saved }),
          set: async (value) => { window.saved = value.deerwebtranslatorSettings; }
        } },
        permissions: { request: async (value) => { calls.push(value); return true; } },
        runtime: { sendMessage: async (message) => {
          calls.push(message);
          if (message.type.endsWith("TEST_CONNECTION")) return new Promise((resolve) => { window.finishTest = resolve; });
          if (message.type.endsWith("CLEAR_CACHE")) { window.cacheCleared = true; return { ok: true, entries: 4 }; }
          return { ok: true, entries: window.cacheCleared ? 0 : 4, bytes: window.cacheCleared ? 0 : 1024 };
        } }
      };
    });
    await page.goto("https://options.test/src/options/options.html");
    await page.waitForFunction(() => document.querySelector("#api-key").value === "fixture-deepseek-only");
    await page.locator("#api-key").fill("fixture-deepseek-edited");
    await page.locator("#toggle-key").click();
    await page.locator("#provider").selectOption("gemini");
    assert.equal(await page.locator("#api-key").inputValue(), "fixture-gemini-only");
    assert.equal(await page.locator("#api-key").getAttribute("type"), "password");
    assert.equal(await page.locator("#base-url").inputValue(), "https://generativelanguage.googleapis.com/v1beta",
      "switching provider must not carry a previous proxy endpoint/key into the next provider");
    await page.locator("#provider").selectOption("deepseek");
    assert.equal(await page.locator("#api-key").inputValue(), "fixture-deepseek-edited");
    assert.equal(await page.locator("#base-url").inputValue(), "https://gateway.example.test/v1");
    assert.equal(await page.locator("#custom-model").inputValue(), "fixture-model");
    await page.locator('button[type="submit"]').click();
    await page.waitForFunction(() => saved.apiKeys.deepseek === "fixture-deepseek-edited");
    assert.equal(await page.evaluate(() => saved.apiKeys.gemini), "fixture-gemini-only");
    assert.equal(await page.evaluate(() => saved.displayMode), "bilingual");
    assert.equal(await page.evaluate(() => calls.some((item) => item.origins?.[0] === "https://gateway.example.test/*")), true);
    await page.locator("#base-url").fill("https://api.deepseek.com/?key=fixture-only");
    await page.locator('button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("#save-status").textContent.includes("查询参数"));
    assert.equal(await page.evaluate(() => saved.baseUrl), "https://gateway.example.test/v1", "invalid built-in URL is not saved either");

    await page.locator("#test-button").click();
    assert.equal(await page.locator("#test-button").isDisabled(), true);
    assert.equal(await page.evaluate(() => Object.keys(calls.find((item) => item.type?.endsWith("TEST_CONNECTION"))).join(",")), "type",
      "connection test uses saved config in worker, no page text or key in message");
    await page.evaluate(() => finishTest({ ok: false, error: { message: "模拟：Key 无效" } }));
    await page.waitForFunction(() => document.querySelector("#save-status").textContent.includes("Key 无效"));
    assert.equal(await page.locator("#test-button").isEnabled(), true);
    await page.locator("#test-button").click();
    await page.evaluate(() => finishTest({ ok: true }));
    await page.waitForFunction(() => document.querySelector("#save-status").textContent.includes("连接正常"));
    await page.locator("#clear-cache-button").click();
    await page.waitForFunction(() => document.querySelector("#cache-info").textContent.startsWith("0 条缓存"));
    assert.equal(await page.evaluate(() => saved.apiKeys.deepseek), "fixture-deepseek-edited");
    await page.locator("#api-key").fill("fixture-retained-on-reset");
    await page.locator("#reset-button").click();
    assert.equal(await page.locator("#api-key").inputValue(), "fixture-retained-on-reset");
    await page.setViewportSize({ width: 360, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "narrow settings view has no horizontal overflow");
    assert.deepEqual(errors, []);
    console.log("PASS: provider key/endpoint isolation, model drafts, save/reset preservation, minimal explicit connection test, error recovery, cache clear UI and narrow layout");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
