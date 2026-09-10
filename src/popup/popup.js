(function (global) {
  "use strict";
  const DT = global.DeerWebTranslator;
  const $ = (id) => document.getElementById(id);
  const elements = {
    pageLabel: $("page-label"), providerLabel: $("provider-label"),
    statusLabel: $("status-label"), progressLabel: $("progress-label"),
    progressBar: $("progress-bar"), progressTrack: document.querySelector(".progress-track"),
    detailLabel: $("detail-label"), translateButton: $("translate-button"),
    stopButton: $("stop-button"), modeButtons: [...document.querySelectorAll(".mode-button")],
    errorLabel: $("error-label"), keyStatus: $("key-status"), settingsButton: $("settings-button")
  };
  let activeTab = null, configPromise = null, injectionPromise = null;
  let busy = false, interacted = false, pageStateReceived = false, revision = 0;
  let state = { status: "idle", mode: DT.DEFAULT_DISPLAY_MODE, total: 0, completed: 0, cached: 0 };

  function deadline(promise, ms, message) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]).finally(() => clearTimeout(timer));
  }
  const supported = (tab) => Boolean(tab && /^https?:\/\//i.test(tab.url || ""));
  function setError(message = "") {
    elements.errorLabel.textContent = message;
    elements.errorLabel.hidden = !message;
  }
  function renderButtons() {
    const unavailable = activeTab !== null && !supported(activeTab);
    elements.translateButton.disabled = busy || unavailable || state.status === "translating";
    elements.translateButton.textContent = busy ? "处理中…" : "翻译当前页面";
    elements.stopButton.disabled = busy || unavailable || !(state.status === "translating" || state.autoTranslate);
    elements.modeButtons.forEach((button) => { button.disabled = busy; });
  }
  function renderState(next, advanceRevision = true) {
    if (!next) return;
    if (advanceRevision) revision++;
    state = { ...state, ...next };
    const total = Math.max(0, Number(state.total) || 0);
    const done = Math.min(total, Math.max(0, Number(state.completed) || 0));
    const percent = total ? Math.round(done / total * 100) : 0;
    elements.statusLabel.textContent = {
      idle: "未开始", translating: "翻译中", completed: "已完成", stopped: "已停止", error: "翻译失败"
    }[state.status] || "未开始";
    elements.progressLabel.textContent = done + " / " + total;
    elements.progressBar.style.width = percent + "%";
    elements.progressTrack.setAttribute("aria-valuenow", String(percent));
    elements.detailLabel.textContent = state.error
      || (state.cached ? "复用缓存 " + state.cached + " 段。" : "按需翻译当前页面，滚动时自动补译。");
    for (const button of elements.modeButtons) {
      const selected = button.dataset.mode === state.mode;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    renderButtons();
  }
  function renderProvider(config) {
    const label = config.provider.label + " · " + config.settings.model;
    elements.providerLabel.textContent = label;
    elements.providerLabel.title = label;
    elements.keyStatus.textContent = !config.provider.requiresApiKey ? "本地模型 · 无需 API Key"
      : config.ready ? "API Key 已配置" : "请在设置中填写 API Key";
  }
  function loadConfig() {
    if (!configPromise) {
      configPromise = deadline(chrome.storage.local.get(DT.STORAGE_KEY), 2500,
        "读取设置超时，请重新打开弹窗。").then((result) => {
        const saved = result?.[DT.STORAGE_KEY] || {};
        const settings = DT.normalizePublicSettings(saved);
        const provider = DT.getProvider(settings.provider);
        const key = saved.apiKeys?.[settings.provider]
          ?? (settings.provider === "deepseek" ? saved.apiKey : "");
        // Only a boolean readiness flag is retained outside the storage result.
        return { settings, provider, ready: !provider.requiresApiKey || Boolean(String(key || "").trim()) };
      });
      const pending = configPromise;
      pending.catch(() => { if (configPromise === pending) configPromise = null; });
    }
    return configPromise;
  }
  // Both calls start immediately. Neither depends on content-script readiness.
  const tabReady = deadline(chrome.tabs.query({ active: true, currentWindow: true }), 1500,
    "读取当前标签页超时，请重新打开弹窗。").then((tabs) => {
    activeTab = tabs[0] || {};
    elements.pageLabel.textContent = supported(activeTab) ? new URL(activeTab.url).hostname
      : activeTab.id == null ? "没有活动页面" : "此页面不支持翻译";
    renderButtons();
    return activeTab;
  });
  const initialConfig = loadConfig();

  function send(tab, message, ms = 5000) {
    return deadline(chrome.tabs.sendMessage(tab.id, message), ms,
      "页面暂时没有响应，请等待页面加载完成后重试。");
  }
  function missingReceiver(error) {
    return /receiving end does not exist|could not establish connection/i.test(error?.message || "");
  }
  async function inject(tab) {
    if (!injectionPromise) {
      injectionPromise = deadline(Promise.all([
        chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["src/content/content-style.css"] }),
        chrome.scripting.executeScript({ target: { tabId: tab.id },
          files: ["src/shared/constants.js", "src/shared/dom-codec.js", "src/content/content-script.js"] })
      ]), 5000, "页面脚本加载超时，请刷新网页后重试。");
      injectionPromise.finally(() => { injectionPromise = null; }).catch(() => {});
    }
    await injectionPromise;
  }
  async function command(message) {
    const tab = await tabReady;
    if (!supported(tab)) throw new Error("当前页面不允许翻译，请打开普通网页。");
    try {
      return await send(tab, message);
    } catch (error) {
      // Only a confirmed absent receiver permits injection and one retry.
      // A timeout may mean the command already ran, so never resend it blindly.
      if (!missingReceiver(error)) throw error;
      await inject(tab);
      return send(tab, message);
    }
  }
  function accept(response) {
    if (!response?.ok) throw new Error(response?.error?.message || "页面操作失败。");
    pageStateReceived = true;
    renderState(response.state);
  }
  async function action(operation) {
    if (busy) return;
    busy = true; interacted = true; revision++;
    setError(); renderButtons();
    try { await operation(); }
    catch (error) { setError(error.message || "操作失败，请重试。"); }
    finally { busy = false; renderButtons(); }
  }
  elements.translateButton.addEventListener("click", () => action(async () => {
    const config = await loadConfig();
    renderProvider(config);
    if (!config.ready) throw new Error("请先在设置中填写 " + config.provider.label + " API Key。");
    accept(await command({ type: "DEERWEBTRANSLATOR_START_TRANSLATION",
      settings: { ...config.settings, displayMode: DT.DEFAULT_DISPLAY_MODE } }));
  }));
  elements.stopButton.addEventListener("click", () => action(async () => {
    accept(await command({ type: "DEERWEBTRANSLATOR_STOP_TRANSLATION" }));
  }));
  elements.settingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());

  async function saveMode(mode) {
    // Read at write time to preserve keys/settings changed in another extension page.
    const result = await deadline(chrome.storage.local.get(DT.STORAGE_KEY), 2500, "读取设置超时。");
    const saved = result?.[DT.STORAGE_KEY] || {};
    await deadline(chrome.storage.local.set({ [DT.STORAGE_KEY]: { ...saved, displayMode: mode } }),
      2500, "保存显示模式超时。");
    configPromise = null;
  }
  for (const button of elements.modeButtons) button.addEventListener("click", () => action(async () => {
    const mode = button.dataset.mode;
    const tab = await tabReady;
    // Update the live page before waiting for a storage write.
    if (supported(tab)) accept(await command({ type: "DEERWEBTRANSLATOR_SET_DISPLAY_MODE", mode }));
    else renderState({ mode });
    await saveMode(mode);
  }));
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== "DEERWEBTRANSLATOR_PROGRESS" || !activeTab
      || sender.tab?.id !== activeTab.id) return;
    pageStateReceived = true;
    renderState(message.state);
    setError(message.state?.status === "error" ? message.state.error : "");
  });
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes[DT.STORAGE_KEY]) return;
    configPromise = null;
    loadConfig().then(renderProvider).catch(() => {});
  });
  initialConfig.then((config) => {
    if (configPromise !== initialConfig) return;
    renderProvider(config);
    if (!pageStateReceived && !interacted) renderState({ mode: config.settings.displayMode }, false);
  }).catch((error) => {
    elements.providerLabel.textContent = "暂时无法读取配置";
    elements.keyStatus.textContent = "可打开设置检查";
    if (!interacted) setError(error.message);
  });
  tabReady.then(async (tab) => {
    if (!supported(tab) || interacted) return;
    const probeRevision = revision;
    try {
      // Opening the popup never injects scripts. A busy page cannot hold the UI.
      const result = await send(tab, { type: "DEERWEBTRANSLATOR_GET_STATE" }, 650);
      if (interacted || revision !== probeRevision || !result?.ok) return;
      pageStateReceived = true;
      renderState(result.state);
      setError(result.state?.error || "");
    } catch {
      // A missing script is normal on pre-install tabs; install on user action.
    }
  }).catch((error) => { if (!interacted) setError(error.message); });
})(globalThis);
