/* Local Chrome fixtures with mocked translation. Never reads real credentials. */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const executablePath = process.env.CHROME_BIN || (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.route("https://example.test/**", (route) => route.fulfill({ body: "" }));
    await page.goto("https://example.test/repo");
    await page.setContent(`<html><head><title>Repository guide</title><style>
      body {font:16px sans-serif;margin:20px} nav{display:grid;grid-template-columns:140px 140px;gap:10px}
      button,a{font:inherit} nav>a,button{box-sizing:border-box;width:140px;height:38px}
      nav>a:last-child{border:3px solid red} button::before{content:"★"}
      #sentence{width:620px} #footer{margin-top:2400px} #hidden{display:none}
      #plain{font-size:24px} #tiny{font-size:11px}
    </style></head><body>
      <nav><button id="action"><svg width="12" height="12"></svg><span>Settings</span></button>
      <a id="link" href="/docs">Documentation</a></nav>
      <h2 id="plain">Installation</h2><p id="tiny">Installation</p>
      <p id="duplicate">Installation</p>
      <p id="sentence">Please read the <a id="inline" href="/guide"><strong>documentation</strong></a> before continuing.</p>
      <p id="term">API</p><p id="code">Install with <code>npm install deer</code> today.</p>
      <p id="keep">DeerWebTranslator</p><p id="chinese">这是中文。</p><p id="url">https://example.test/private?token=example</p>
      <p id="hidden">Private hidden text</p><p translate="no">Never translate</p>
      <div contenteditable="plaintext-only">Editable private text</div><input value="secret">
      <table><tr><th id="cell">Installation</th><td><a id="cell-link" href="/table">Documentation</a></td></tr></table>
      <footer id="footer"><a id="terms" href="/terms">Terms</a></footer>
    </body></html>`);
    await page.evaluate(() => {
      window.sent = []; window.progress = []; window.clicks = [];
      window.originalButton = document.querySelector("#action");
      window.originalText = document.querySelector("#action span").firstChild;
      window.originalLink = document.querySelector("#inline");
      document.querySelector("#action").addEventListener("click", (e) => window.clicks.push(e.isTrusted));
      document.querySelector("#inline").addEventListener("click", (e) => { e.preventDefault(); window.clicks.push(e.isTrusted); });
      const handlers = [];
      window.send = (type, rest = {}) => new Promise((resolve) =>
        handlers.forEach((fn) => fn({ type: "DEERWEBTRANSLATOR_" + type, ...rest }, {}, resolve)));
      const dict = [["Installation", "安装"], ["Settings", "设置"], ["Documentation", "文档"],
        ["documentation", "文档"], ["Please read the", "请阅读"], ["before continuing.", "然后继续。"],
        ["Install with", "安装方式"], ["today.", "现在。"], ["Terms", "条款"], ["Updated text", "已更新文字"]];
      window.chrome = { runtime: {
        id: "fixture-extension",
        onMessage: { addListener(fn) { handlers.push(fn); } },
        async sendMessage(message) {
          if (message.type === "DEERWEBTRANSLATOR_PROGRESS") window.progress.push(message.state);
          if (message.type !== "DEERWEBTRANSLATOR_TRANSLATE_BATCH") return { ok: true };
          window.sent.push(message);
          await new Promise((r) => setTimeout(r, window.mockDelay || 20));
          return { ok: true, cachedCount: 0, translations: message.items.map((item) => ({
            id: item.id, text: dict.reduce((text, [from, to]) => text.replaceAll(from, to), item.text)
          })) };
        }
      }};
    });
    const dimensions = () => page.locator("nav").evaluate((nav) => ({
      children: nav.childElementCount,
      nav: [nav.offsetWidth, nav.offsetHeight],
      button: [nav.firstElementChild.offsetWidth, nav.firstElementChild.offsetHeight],
      border: getComputedStyle(nav.lastElementChild).borderTopWidth,
      icon: nav.querySelectorAll("svg").length,
      font: getComputedStyle(document.querySelector("#plain")).fontSize
    }));
    const before = await dimensions();
    await page.addStyleTag({ path: path.join(root, "src/content/content-style.css") });
    for (const file of ["src/shared/constants.js", "src/shared/dom-codec.js", "src/content/text-index.js", "src/content/content-script.js"]) {
      await page.addScriptTag({ path: path.join(root, file) });
    }
    await page.evaluate(() => window.send("START_TRANSLATION", { settings: { displayMode: "translation" } }));
    await page.waitForFunction(() => window.progress.at(-1)?.status === "completed");
    assert.equal(await page.locator("#action span").innerText(), "设置");
    assert.equal(await page.locator("#link").innerText(), "文档");
    assert.equal(await page.locator("#plain").innerText(), "安装");
    assert.equal(await page.locator("#cell").innerText(), "安装");
    assert.equal(await page.locator("#code code").innerText(), "npm install deer");
    assert.equal(await page.locator("#inline strong").innerText(), "文档");
    assert.deepEqual(await dimensions(), before, "real controls, grid geometry, pseudo-elements and font stay intact");
    assert.equal(await page.locator(".deeptranslate-translation").count(), 0, "replacement adds no DOM elements");
    assert.equal(await page.evaluate(() => window.originalButton === document.querySelector("#action")
      && window.originalText === document.querySelector("#action span").firstChild
      && window.originalLink === document.querySelector("#inline")), true);
    await page.locator("#action").click();
    await page.locator("#inline").click();
    assert.deepEqual(await page.evaluate(() => window.clicks), [true, true], "original trusted clicks must survive");
    const sent = await page.evaluate(() => window.sent.flatMap((batch) => batch.items));
    assert(!sent.some((item) => /Private|Never translate|Editable|npm install|https:\/\/|这是中文|Terms/.test(item.text)));
    assert.equal(sent.filter((item) => item.text === "Installation" && item.context.tag === "p").length, 1);
    // Same context can be coalesced; differently styled paragraphs remain valid.
    assert.equal(await page.locator("#terms").innerText(), "Terms");
    const count = await page.evaluate(() => window.sent.length);
    for (const mode of ["original", "bilingual", "translation", "original", "translation"]) {
      await page.evaluate((mode) => window.send("SET_DISPLAY_MODE", { mode }), mode);
      assert.equal(await page.locator("#action span").innerText(),
        mode === "original" ? "Settings" : mode === "bilingual" ? "Settings｜设置" : "设置");
      assert.equal(await page.locator("#plain").innerText(),
        mode === "original" ? "Installation" : mode === "bilingual" ? "Installation｜安装" : "安装");
      assert.equal(await page.locator("#inline").getAttribute("href"), "/guide");
      if (mode === "bilingual") {
        assert.equal(await page.locator("#sentence + .deeptranslate-translation a").innerText(), "文档");
      }
    }
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => window.sent.length), count, "mode changes must cost zero API requests");
    await page.evaluate(() => document.querySelector("#inline").href = "/new-guide");
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.sent.length), count, "href changes do not require retranslating labels");
    await page.evaluate(() => document.querySelector("#tiny").firstChild.data = "Updated text");
    await page.waitForFunction(() => document.querySelector("#tiny").textContent === "已更新文字");
    await page.evaluate(() => window.send("SET_DISPLAY_MODE", { mode: "original" }));
    assert.equal(await page.locator("#tiny").innerText(), "Updated text", "restore latest site-authored source");
    await page.evaluate(() => window.send("SET_DISPLAY_MODE", { mode: "translation" }));
    await page.locator("#footer").scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector("#terms").textContent === "条款");
    // Cancel an in-flight response: it must not replace the newly written source.
    await page.evaluate(() => {
      window.mockDelay = 500;
      document.querySelector("#terms").firstChild.data = "Updated text";
    });
    const prior = await page.evaluate(() => window.sent.length);
    await page.waitForFunction((prior) => window.sent.length > prior, prior);
    await page.evaluate(() => window.send("STOP_TRANSLATION"));
    await page.waitForTimeout(650);
    assert.equal(await page.locator("#terms").innerText(), "Updated text");
    // Long individual Text nodes used to exceed the batch hard limit.
    await page.evaluate(() => {
      window.mockDelay = 0;
      const p = document.createElement("p");
      p.id = "huge";
      p.append(document.createTextNode("Read documentation. ".repeat(1000)));
      document.body.prepend(p);
      window.longOriginal = p.firstChild.data;
      window.longNode = p.firstChild;
      window.longStart = window.sent.length;
      scrollTo(0, 0);
      return window.send("START_TRANSLATION", { settings: { displayMode: "translation" } });
    });
    await page.waitForFunction(() => document.querySelector("#huge").textContent.includes("文档"));
    assert.equal(await page.locator("#huge").textContent(),
      (await page.evaluate(() => window.longOriginal)).replaceAll("documentation", "文档"),
      "long-text boundaries preserve original separators");
    assert.equal(await page.evaluate(() => document.querySelector("#huge").firstChild === window.longNode), true);
    assert.equal(await page.evaluate(() => window.sent.slice(window.longStart)
      .every((batch) => batch.items.reduce((sum, item) => sum + item.text.length, 0) <= 14000)), true);
    await page.evaluate(() => window.send("SET_DISPLAY_MODE", { mode: "original" }));
    assert.equal(await page.locator("#huge").textContent(), await page.evaluate(() => window.longOriginal));
    await page.evaluate(() => {
      document.querySelector("#huge").remove();
      history.pushState({}, "", "/new-repository");
      const p = document.createElement("p");
      p.id = "spa";
      p.append(document.createTextNode("Updated text"));
      document.body.prepend(p);
      return window.send("SET_DISPLAY_MODE", { mode: "translation" });
    });
    await page.waitForFunction(() => document.querySelector("#spa").textContent === "已更新文字"
      && window.progress.at(-1)?.pageUrl.endsWith("/new-repository"));
    await page.evaluate(() => window.send("SET_DISPLAY_MODE", { mode: "original" }));
    assert.equal(await page.locator("#spa").textContent(), "Updated text");
    await page.evaluate(() => {
      const section = document.createElement("section"); section.id = "chapter";
      const heading = document.createElement("h2");
      heading.append(Object.assign(document.createElement("strong"), { textContent: "Installation" }));
      section.append(heading); document.body.prepend(section);
      return send("SET_DISPLAY_MODE", { mode: "translation" });
    });
    await page.waitForFunction(() => document.querySelector("#chapter strong").textContent === "安装");
    await page.evaluate(() => document.querySelector("#chapter").append(Object.assign(document.createElement("p"), { id: "append", textContent: "Updated text" })));
    await page.waitForFunction(() => document.querySelector("#append").textContent === "已更新文字");
    assert.equal(await page.evaluate(() => sent.flatMap((batch) => batch.items).find((item) => item.text === "Updated text" && item.context.heading)?.context.heading), "Installation",
      "nested heading context uses original source, not an earlier translation");
    await page.evaluate(() => document.querySelector("#append").append(Object.assign(document.createElement("em"), { textContent: " Installation" })));
    await page.waitForFunction(() => document.querySelector("#append").textContent.includes("安装"));
    await page.evaluate(() => send("SET_DISPLAY_MODE", { mode: "original" }));
    assert.equal(await page.locator("#append").textContent(), "Updated text Installation");
    await page.evaluate(() => send("SET_DISPLAY_MODE", { mode: "translation" }));
    await page.evaluate(() => document.querySelector("#append").setAttribute("contenteditable", "true"));
    await page.waitForFunction(() => document.querySelector("#append").textContent === "Updated text Installation");

    // Starting from a selection must not expand to the entire page on mutation.
    await page.evaluate(() => {
      const range = document.createRange(); range.selectNodeContents(document.querySelector("#spa"));
      getSelection().removeAllRanges(); getSelection().addRange(range);
      return send("STOP_TRANSLATION").then(() => send("TRANSLATE_SELECTION"));
    });
    await page.waitForFunction(() => document.querySelector("#spa").textContent === "已更新文字");
    const scoped = await page.evaluate(() => sent.length);
    await page.evaluate(() => document.body.prepend(Object.assign(document.createElement("p"), { id: "outside", textContent: "Installation" })));
    await page.waitForTimeout(200);
    assert.equal(await page.locator("#outside").textContent(), "Installation");
    assert.equal(await page.evaluate(() => sent.length), scoped);
    console.log("PASS: original nodes/clicks/UI, modes, filters, viewport/dedup, dynamic text/inline appends, original heading context, editable protection, cancellation, long text, SPA and scoped selection");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
