(function initializeDeerWebTranslatorPopup(global) {
  "use strict";

  const DT = global.DeerWebTranslator;
  const elements = {
    pageLabel: document.getElementById("page-label"),
    providerLabel: document.getElementById("provider-label"),
    statusLabel: document.getElementById("status-label"),
    progressLabel: document.getElementById("progress-label"),
    progressBar: document.getElementById("progress-bar"),
    progressTrack: document.querySelector(".progress-track"),
    detailLabel: document.getElementById("detail-label"),
    translateButton: document.getElementById("translate-button"),
    stopButton: document.getElementById("stop-button"),
    modeButtons: Array.from(document.querySelectorAll(".mode-button")),
    errorLabel: document.getElementById("error-label"),
    keyStatus: document.getElementById("key-status"),
    settingsButton: document.getElementById("settings-button")
  };

  let activeTab = null;
  let currentProvider = DT.getProvider("deepseek");
  let currentState = {
    status: "idle",
    mode: DT.DEFAULT_DISPLAY_MODE,
    total: 0,
    completed: 0,
    cached: 0,
    error: ""
  };

  function setError(message) {
    elements.errorLabel.textContent = message || "";
    elements.errorLabel.hidden = !message;
  }

  function isSupportedPage(tab) {
    return Boolean(tab && typeof tab.url === "string" && /^https?:\/\//i.test(tab.url));
  }

  function getProviderKey(saved, providerId) {
    const apiKeys = saved && saved.apiKeys && typeof saved.apiKeys === "object" ? saved.apiKeys : {};
    if (typeof apiKeys[providerId] === "string") {
      return apiKeys[providerId].trim();
    }
    return providerId === "deepseek" && typeof saved.apiKey === "string" ? saved.apiKey.trim() : "";
  }

  async function loadStoredConfig() {
    const result = await chrome.storage.local.get(DT.STORAGE_KEY);
    const saved = result && result[DT.STORAGE_KEY] && typeof result[DT.STORAGE_KEY] === "object"
      ? result[DT.STORAGE_KEY]
      : {};
    const settings = DT.normalizePublicSettings(saved);
    const provider = DT.getProvider(settings.provider);
    const apiKey = getProviderKey(saved, settings.provider);
    return {
      saved,
      settings,
      provider,
      apiKey,
      ready: !provider.requiresApiKey || Boolean(apiKey)
    };
  }

  async function sendToTab(message) {
    if (!activeTab || typeof activeTab.id !== "number") {
      throw new Error("找不到当前页面。");
    }
    return chrome.tabs.sendMessage(activeTab.id, message);
  }

  async function ensureContentScript() {
    if (!activeTab || typeof activeTab.id !== "number") {
      throw new Error("找不到当前页面。");
    }
    if (!isSupportedPage(activeTab)) {
      throw new Error("Chrome 内部页面或当前页面不允许扩展访问。");
    }

    try {
      const existing = await sendToTab({ type: "DEERWEBTRANSLATOR_GET_STATE" });
      if (existing && existing.ok) {
        return existing;
      }
    } catch (error) {
      // A tab that was already open before the extension loaded may not yet
      // have the declared content script. Use activeTab for a fallback inject.
    }

    try {
      await chrome.scripting.insertCSS({
        target: { tabId: activeTab.id },
        files: ["src/content/content-style.css"]
      });
    } catch (error) {
      // Duplicate CSS insertion is harmless; executeScript below is the
      // readiness check and will surface restricted-page errors.
    }
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ["src/shared/constants.js", "src/shared/dom-codec.js", "src/content/content-script.js"]
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const injected = await sendToTab({ type: "DEERWEBTRANSLATOR_GET_STATE" });
    if (!injected || !injected.ok) {
      throw new Error("无法连接当前页面的内容脚本。");
    }
    return injected;
  }

  function stateLabel(status) {
    return {
      idle: "未开始",
      translating: "翻译中",
      completed: "已完成",
      stopped: "已停止",
      error: "翻译失败"
    }[status] || "未开始";
  }

  function renderState(nextState) {
    if (!nextState || typeof nextState !== "object") {
      return;
    }
    currentState = { ...currentState, ...nextState };
    const total = Math.max(0, Number(currentState.total) || 0);
    const completed = Math.min(total, Math.max(0, Number(currentState.completed) || 0));
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
    elements.statusLabel.textContent = stateLabel(currentState.status);
    elements.progressLabel.textContent = `${completed} / ${total}`;
    elements.progressBar.style.width = `${percentage}%`;
    elements.progressTrack.setAttribute("aria-valuenow", String(percentage));
    elements.detailLabel.textContent = currentState.error
      || (currentState.cached > 0 ? `已完成，命中缓存 ${currentState.cached} 段。` : "翻译当前页面的可读正文。");
    elements.modeButtons.forEach((button) => {
      const active = button.dataset.mode === currentState.mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    const translating = currentState.status === "translating";
    elements.translateButton.disabled = translating;
    elements.stopButton.disabled = !translating;
  }

  function renderProvider(config) {
    currentProvider = config.provider;
    elements.providerLabel.textContent = `${config.provider.label} · ${config.settings.model}`;
    elements.keyStatus.textContent = config.provider.requiresApiKey
      ? (config.ready ? "当前 API Key 已配置" : "当前供应商尚未配置 API Key")
      : "本地模型 · 无需 API Key";
  }

  async function refreshPageState() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0] || null;
    if (!activeTab) {
      elements.pageLabel.textContent = "没有活动页面";
      elements.translateButton.disabled = true;
      elements.stopButton.disabled = true;
      return;
    }
    try {
      const parsedUrl = new URL(activeTab.url || "");
      elements.pageLabel.textContent = parsedUrl.hostname || "当前页面";
    } catch (error) {
      elements.pageLabel.textContent = "当前页面";
    }
    const config = await loadStoredConfig();
    renderProvider(config);
    renderState({ mode: config.settings.displayMode });
    if (!isSupportedPage(activeTab)) {
      setError("当前页面是 Chrome 内部页面，无法注入翻译脚本。");
      elements.translateButton.disabled = true;
      elements.stopButton.disabled = true;
      return;
    }
    try {
      const response = await ensureContentScript();
      renderState(response.state);
      setError(response.state && response.state.error ? response.state.error : "");
    } catch (error) {
      setError(error && error.message ? error.message : "无法连接当前页面。");
    }
  }

  async function translateCurrentPage() {
    setError("");
    const config = await loadStoredConfig();
    renderProvider(config);
    if (!config.ready) {
      setError(`请先在“设置”中填写 ${config.provider.label} API Key。`);
      return;
    }
    try {
      await ensureContentScript();
      // Starting a page translation always follows the native-translation
      // flow: return Chinese into the page's visual position and hide the
      // source text. The mode switch remains available after that for users
      // who want bilingual comparison or the original page back.
      const replacementSettings = {
        ...config.settings,
        displayMode: DT.DEFAULT_DISPLAY_MODE
      };
      const response = await sendToTab({
        type: "DEERWEBTRANSLATOR_START_TRANSLATION",
        // This object is intentionally non-secret. Provider keys remain in
        // extension storage and are read only by the service worker.
        settings: replacementSettings
      });
      if (!response || !response.ok) {
        throw new Error(response && response.error ? response.error.message : "无法启动翻译。");
      }
      renderState(response.state);
    } catch (error) {
      setError(error && error.message ? error.message : "无法启动翻译。");
    }
  }

  async function stopCurrentPage() {
    setError("");
    try {
      const response = await sendToTab({ type: "DEERWEBTRANSLATOR_STOP_TRANSLATION" });
      if (response && response.state) {
        renderState(response.state);
      }
    } catch (error) {
      setError("无法停止当前页面的翻译。");
    }
  }

  async function changeMode(mode) {
    setError("");
    try {
      const result = await chrome.storage.local.get(DT.STORAGE_KEY);
      const saved = result && result[DT.STORAGE_KEY] && typeof result[DT.STORAGE_KEY] === "object"
        ? result[DT.STORAGE_KEY]
        : {};
      await chrome.storage.local.set({
        [DT.STORAGE_KEY]: {
          ...saved,
          ...DT.normalizePublicSettings({ ...saved, displayMode: mode }),
          apiKeys: saved.apiKeys && typeof saved.apiKeys === "object" ? saved.apiKeys : {}
        }
      });
      if (activeTab && isSupportedPage(activeTab)) {
        const response = await ensureContentScript();
        const modeResponse = await sendToTab({ type: "DEERWEBTRANSLATOR_SET_DISPLAY_MODE", mode });
        renderState((modeResponse && modeResponse.state) || response.state);
      } else {
        renderState({ mode });
      }
    } catch (error) {
      setError(error && error.message ? error.message : "显示模式切换失败。");
    }
  }

  elements.translateButton.addEventListener("click", () => {
    translateCurrentPage().catch((error) => setError(error && error.message ? error.message : "无法启动翻译。"));
  });
  elements.stopButton.addEventListener("click", () => {
    stopCurrentPage().catch(() => setError("无法停止当前页面的翻译。"));
  });
  elements.settingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
  elements.modeButtons.forEach((button) => {
    button.addEventListener("click", () => changeMode(button.dataset.mode));
  });

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message || message.type !== "DEERWEBTRANSLATOR_PROGRESS" || !activeTab || !sender.tab) {
      return;
    }
    if (sender.tab.id === activeTab.id) {
      renderState(message.state);
      setError(message.state && message.state.status === "error" ? message.state.error : "");
    }
  });

  refreshPageState().catch((error) => {
    setError(error && error.message ? error.message : "初始化失败。");
  });
})(globalThis);
