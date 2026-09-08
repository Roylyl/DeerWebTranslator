/* Run with Node + Playwright. Uses a local fixture and mock model responses;
   never reads a real API key or sends page text to an external provider. */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const chromePath = process.env.CHROME_BIN || (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  try {
    const context = await browser.newContext();
    await context.route("https://example.test/**", (route) => route.fulfill({ body: "destination" }));
    const page = await context.newPage();
    await page.goto("https://example.test/repo");
    await page.setContent(`<!doctype html><html><head><style>
      body { font: 16px sans-serif; } main { width: 680px; }
      h2 {font-size: 28px;} .label {font-size: 18px;}
      a {color: rgb(20, 80, 180);} .invisible {display:none}
    </style></head><body><main>
      <h2 id="short">Installation</h2>
      <p id="term" class="label">API</p>
      <p id="long">Please read the <a id="docs" href="/docs?q=1#start">documentation</a> and the <a href="/license" target="_blank" rel="noopener">license</a> before installing this software.</p>
      <p id="code">Install the package with <code id="cmd">npm install deer</code> to get started.</p>
      <p id="nested">Read the <a href="/guide"><strong>quick start</strong> guide</a> before continuing with this example.</p>
      <a id="standalone" href="/releases">Releases</a>
      <p id="skip" translate="no">Never translate this content.</p>
      <p id="hidden"><span class="invisible">Hidden secret</span>Visible example text that is long enough to be a sentence.</p>
      <p id="hidden-label"><span class="invisible">Hidden secret</span>Installation</p>
      <p id="agent-keep">DeerWebTranslator</p>
      <table><tr><th id="cell-short">Installation</th><td id="cell-link"><a href="/table-docs">documentation</a></td></tr></table>
    </main><footer role="contentinfo"><a id="footer-terms" href="/terms">Terms</a><a id="footer-privacy" href="/privacy">Privacy</a></footer></body></html>`);
    await page.evaluate(() => {
      window.requestCount = 0;
      window.linkClicks = 0;
      document.getElementById("docs").addEventListener("click", (event) => {
        event.preventDefault();
        window.linkClicks++;
      });
      const handlers = [];
      window.sendExtensionMessage = (message) => new Promise((resolve) => {
        handlers.forEach((handler) => handler(message, {}, resolve));
      });
      window.chrome = { runtime: {
        onMessage: { addListener(handler) { handlers.push(handler); } },
        async sendMessage(message) {
          if (message.type !== "DEERWEBTRANSLATOR_TRANSLATE_BATCH") return { ok: true };
          window.requestCount++;
          window.sentItems = [...(window.sentItems || []), ...message.items];
          const replacements = [
            ["Installation", "安装"], ["API", "API（应用程序编程接口）"],
            ["Terms", "条款"], ["Privacy", "隐私"],
            ["Please read the ", "请阅读"], ["documentation", "文档"],
            [" and the ", "和"], ["license", "许可证"],
            [" before installing this software.", "，然后安装软件。"],
            ["Install the package with ", "使用"], [" to get started.", "安装软件包。"],
            ["Read the ", "阅读"], ["quick start", "快速开始"], [" guide", "指南"],
            [" before continuing with this example.", "，然后继续示例。"],
            ["Releases", "发布版本"],
            ["Visible example text that is long enough to be a sentence.", "足够长的可见示例文本。"]
          ];
          return { ok: true, cachedCount: 0, translations: message.items.map((item) => ({
            id: item.id, text: replacements.reduce((text, [from, to]) => text.replaceAll(from, to), item.text)
          })) };
        }
      }};
    });
    await page.addStyleTag({ path: path.join(root, "src/content/content-style.css") });
    for (const file of ["src/shared/constants.js", "src/shared/dom-codec.js", "src/content/content-script.js"]) {
      await page.addScriptTag({ path: path.join(root, file) });
    }
    const mode = (value) => page.evaluate((mode) => window.sendExtensionMessage({
      type: "DEERWEBTRANSLATOR_SET_DISPLAY_MODE", mode
    }), value);
    await page.evaluate(() => window.sendExtensionMessage({
      type: "DEERWEBTRANSLATOR_START_TRANSLATION", settings: { displayMode: "bilingual" }
    }));
    await page.waitForFunction(async () => (await window.sendExtensionMessage({
      type: "DEERWEBTRANSLATOR_GET_STATE"
    })).state.status === "completed");
    assert.equal(await page.locator("#short + .deeptranslate-translation").innerText(), "Installation｜安装");
    assert.equal(await page.locator("#term + .deeptranslate-translation").innerText(), "API｜应用程序编程接口");
    assert.equal(await page.locator("#hidden-label + .deeptranslate-translation").innerText(), "Installation｜安装");
    assert.equal(await page.locator("#agent-keep + .deeptranslate-translation").count(), 0);
    assert.equal(await page.locator("#agent-keep").isVisible(), true);
    assert.equal(await page.locator("#cell-short > .deeptranslate-translation").innerText(), "Installation｜安装");
    assert.equal(await page.locator("#footer-terms + .deeptranslate-translation").innerText(), "Terms｜条款");
    assert.equal(await page.locator("#footer-privacy + .deeptranslate-translation").innerText(), "Privacy｜隐私");
    assert.equal(await page.locator("#footer-terms + .deeptranslate-translation").getAttribute("href"), "https://example.test/terms");
    assert.equal(await page.locator("#standalone + a").innerText(), "Releases｜发布版本");
    assert.equal(await page.locator("#short + .deeptranslate-translation").evaluate((e) => getComputedStyle(e).fontSize), "28px");
    assert.equal(await page.locator("#short + .deeptranslate-translation").evaluate((e) => getComputedStyle(e).borderLeftWidth), "0px");
    assert.equal(await page.locator("#long").isVisible(), true);
    assert.equal(await page.locator("#long + .deeptranslate-translation").evaluate((e) => getComputedStyle(e).borderLeftWidth), "3px");
    const links = page.locator("#long + .deeptranslate-translation a");
    assert.equal(await links.count(), 2);
    assert.equal(await links.first().innerText(), "文档");
    assert.equal(await links.first().getAttribute("href"), "https://example.test/docs?q=1#start");
    await links.first().click();
    assert.equal(await page.evaluate(() => window.linkClicks), 1);
    const popupPromise = context.waitForEvent("page");
    await links.nth(1).click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(popup.url(), "https://example.test/license");
    await popup.close();
    assert.equal(await page.locator("#nested + .deeptranslate-translation a strong").innerText(), "快速开始");
    assert.equal(await page.locator("#code + .deeptranslate-translation code").innerText(), "npm install deer");
    assert.equal(await page.locator("#cmd").count(), 1);
    assert.equal(await page.evaluate(() => window.sentItems.some((i) => /Hidden secret|Never translate|npm install/.test(i.text))), false);
    const count = await page.evaluate(() => window.requestCount);
    for (const value of ["original", "translation", "bilingual", "original", "translation"]) {
      await mode(value);
      assert.equal(await page.locator("#long").isVisible(), value !== "translation");
      assert.equal(await page.locator("#short").isVisible(), value === "original");
      assert.equal(await page.locator("#short + .deeptranslate-translation").isVisible(), value !== "original");
      assert.equal(await links.first().getAttribute("href"), "https://example.test/docs?q=1#start");
      assert.equal(await page.locator("#cell-link > .deeptranslate-translation a").first().getAttribute("href"), "https://example.test/table-docs");
    }
    await links.first().click();
    assert.equal(await page.evaluate(() => window.linkClicks), 2);
    await page.waitForTimeout(1300);
    assert.equal(await page.evaluate(() => window.requestCount), count, "mode changes must not request translations");
    await page.evaluate(() => document.getElementById("docs").setAttribute("href", "/updated"));
    await page.waitForFunction(() => document.querySelector("#long + .deeptranslate-translation a")?.href === "https://example.test/updated");
    await page.waitForTimeout(1300);
    assert.equal(await page.locator("#cell-link > .deeptranslate-translation a").count(), 1, "table link must survive dynamic scans");
    assert.equal(await page.evaluate(() => {
      const codec = window.DeerDOMCodec;
      try { codec.validate("[[DWT_OPEN_0]]link[[DWT_CLOSE_0]]", "丢失标记"); return false; }
      catch { return true; }
    }), true);
    assert.equal(await page.evaluate(() => {
      const p = window.DeerDOMCodec.serialize(document.createElement("p"));
      const fragment = window.DeerDOMCodec.render(p, '<img src=x onerror="window.injected=true">');
      document.body.append(fragment);
      return !window.injected && !document.querySelector("img");
    }), true);
    console.log("PASS: compact/long bilingual, typography, 5 mode transitions, links and original handlers, new tab, nested formatting, code protection, hidden text, no duplicate calls, dynamic href and safe rendering");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
