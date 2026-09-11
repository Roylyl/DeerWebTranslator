(function initializeDeerWebTranslatorOptions(global) {
  "use strict";

  const DT = global.DeerWebTranslator;
  const fields = {
    provider: document.getElementById("provider"),
    providerKindBadge: document.getElementById("provider-kind-badge"),
    providerHelp: document.getElementById("provider-help"),
    modelPreset: document.getElementById("model-preset"),
    customModel: document.getElementById("custom-model"),
    baseUrl: document.getElementById("base-url"),
    endpointHelp: document.getElementById("endpoint-help"),
    apiKey: document.getElementById("api-key"),
    apiKeyOptional: document.getElementById("api-key-optional"),
    keyHelp: document.getElementById("key-help"),
    targetLanguage: document.getElementById("target-language"),
    domain: document.getElementById("domain"),
    systemPrompt: document.getElementById("system-prompt"),
    glossary: document.getElementById("glossary")
  };
  const form = document.getElementById("settings-form");
  const toggleKeyButton = document.getElementById("toggle-key");
  const resetButton = document.getElementById("reset-button");
  const saveStatus = document.getElementById("save-status");
  const testButton = document.getElementById("test-button");
  const clearCacheButton = document.getElementById("clear-cache-button");
  const cacheInfo = document.getElementById("cache-info");

  let savedSettings = {};
  let keyDrafts = {};
  let providerDrafts = {};
  let previousProviderId = "deepseek";

  function showStatus(message, isError = false) {
    saveStatus.textContent = message;
    saveStatus.classList.toggle("error", isError);
  }

  function readKeyMap(settings) {
    const keyMap = settings && settings.apiKeys && typeof settings.apiKeys === "object"
      ? { ...settings.apiKeys }
      : {};
    // Keep users of the original one-provider build signed in after upgrade.
    if (!keyMap.deepseek && typeof settings.apiKey === "string") {
      keyMap.deepseek = settings.apiKey;
    }
    return keyMap;
  }

  function populateProviderSelect() {
    fields.provider.replaceChildren();
    Object.values(DT.PROVIDERS).forEach((provider) => {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = provider.label;
      fields.provider.appendChild(option);
    });
  }

  function populateModelSelect(provider, model) {
    fields.modelPreset.replaceChildren();
    provider.models.forEach((modelName) => {
      const option = document.createElement("option");
      option.value = modelName;
      option.textContent = modelName;
      fields.modelPreset.appendChild(option);
    });
    const customOption = document.createElement("option");
    customOption.value = "__custom__";
    customOption.textContent = "自定义模型…";
    fields.modelPreset.appendChild(customOption);

    if (provider.models.includes(model)) {
      fields.modelPreset.value = model;
      fields.customModel.hidden = true;
      fields.customModel.value = "";
    } else {
      fields.modelPreset.value = "__custom__";
      fields.customModel.hidden = false;
      fields.customModel.value = model || provider.defaultModel;
    }
  }

  function updateProviderFields(providerId, selectedModel, preserveEndpoint = false) {
    const provider = DT.getProvider(providerId);
    fields.providerKindBadge.textContent = provider.kind === "openai" ? "OpenAI-compatible" : provider.kind;
    fields.providerHelp.textContent = provider.id === "ollama"
      ? "请求发往本机 Ollama；请确认 Ollama 已启动并启用了 OpenAI-compatible 接口。"
      : provider.id === "custom"
        ? "可接入任意兼容 /chat/completions 的服务；首次保存自定义域名时会请求 Chrome 网站访问权限。"
        : `${provider.label} 使用后台适配器，翻译请求不会经过网页脚本。`;
    fields.apiKey.placeholder = provider.apiKeyPlaceholder;
    fields.apiKeyOptional.textContent = provider.requiresApiKey ? "" : "（可选，本地模型通常不需要）";
    fields.keyHelp.textContent = provider.requiresApiKey
      ? "Key 按供应商分别保存在扩展的 chrome.storage.local 中，不会发送给网页内容脚本。"
      : "Ollama 默认在本机运行，无需云端 API Key；如果你的本地网关要求鉴权，可以填写。";
    fields.endpointHelp.textContent = provider.id === "custom"
      ? "填写服务的 API Base URL，例如 https://api.example.com/v1；后台会追加 /chat/completions。"
      : "可以保留默认地址，也可以改成兼容代理地址；非内置域名首次保存时会请求 Chrome 网站访问权限。";
    if (!preserveEndpoint || !fields.baseUrl.value.trim()) {
      fields.baseUrl.value = provider.baseUrl;
    }
    populateModelSelect(provider, selectedModel || provider.defaultModel);
    fields.apiKey.value = typeof keyDrafts[provider.id] === "string" ? keyDrafts[provider.id] : "";
  }

  function fillForm(settings) {
    const publicSettings = DT.normalizePublicSettings(settings);
    keyDrafts = readKeyMap(settings);
    providerDrafts = {};
    fields.provider.value = publicSettings.provider;
    fields.baseUrl.value = publicSettings.baseUrl;
    fields.targetLanguage.value = publicSettings.targetLanguage;
    fields.domain.value = publicSettings.domain;
    fields.systemPrompt.value = publicSettings.systemPrompt;
    fields.glossary.value = publicSettings.glossary;
    previousProviderId = publicSettings.provider;
    updateProviderFields(publicSettings.provider, publicSettings.model, true);
  }

  async function loadSettings() {
    const result = await chrome.storage.local.get(DT.STORAGE_KEY);
    savedSettings = result && result[DT.STORAGE_KEY] && typeof result[DT.STORAGE_KEY] === "object"
      ? result[DT.STORAGE_KEY]
      : {};
    fillForm(savedSettings);
  }

  function syncCurrentKeyDraft(providerId = fields.provider.value) {
    keyDrafts[providerId] = fields.apiKey.value.trim();
  }

  function readFormSettings() {
    syncCurrentKeyDraft();
    const provider = DT.getProvider(fields.provider.value);
    const model = fields.modelPreset.value === "__custom__"
      ? fields.customModel.value.trim()
      : fields.modelPreset.value;
    return DT.normalizePublicSettings({
      provider: provider.id,
      baseUrl: fields.baseUrl.value,
      model: model || provider.defaultModel,
      targetLanguage: fields.targetLanguage.value,
      domain: fields.domain.value,
      systemPrompt: fields.systemPrompt.value,
      glossary: fields.glossary.value,
      displayMode: savedSettings.displayMode
    });
  }

  function createOriginPattern(baseUrl) {
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch (error) {
      throw new Error("API Base URL 不是有效的 URL。");
    }
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("API Base URL 只支持 http/https，不能包含用户名、密码、查询参数或片段。");
    }
    return `${parsed.protocol}//${parsed.host}/*`;
  }

  function isBuiltInOrigin(provider, baseUrl) {
    if (!provider.baseUrl) {
      return false;
    }
    try {
      return new URL(provider.baseUrl).origin === new URL(baseUrl).origin;
    } catch (error) {
      return false;
    }
  }

  async function requestEndpointPermission(provider, baseUrl) {
    const origin = createOriginPattern(baseUrl);
    if (isBuiltInOrigin(provider, baseUrl)) {
      return true;
    }
    if (!chrome.permissions || typeof chrome.permissions.request !== "function") {
      return true;
    }
    return chrome.permissions.request({ origins: [origin] });
  }

  async function saveSettings(event) {
    event.preventDefault();
    const publicSettings = readFormSettings();
    const provider = DT.getProvider(publicSettings.provider);
    if (!publicSettings.baseUrl && provider.id === "custom") {
      showStatus("自定义供应商必须填写 API Base URL。", true);
      return;
    }
    try {
      const permissionGranted = await requestEndpointPermission(provider, publicSettings.baseUrl);
      const nextSettings = {
        ...publicSettings,
        apiKeys: { ...keyDrafts }
      };
      await chrome.storage.local.set({ [DT.STORAGE_KEY]: nextSettings });
      savedSettings = nextSettings;
      fields.apiKey.value = keyDrafts[publicSettings.provider] || "";
      showStatus(permissionGranted
        ? "设置已保存。"
        : "设置已保存，但未授予该 Endpoint 的网站访问权限。", !permissionGranted);
    } catch (error) {
      showStatus(error && error.message ? `保存失败：${error.message}` : "保存失败。", true);
    }
  }

  function resetNonSecretSettings() {
    syncCurrentKeyDraft();
    const defaults = DT.normalizePublicSettings({ displayMode: savedSettings.displayMode });
    fillForm({ ...defaults, apiKeys: keyDrafts });
    showStatus("已恢复默认翻译设置；所有供应商 API Key 尚未改变。");
  }

  fields.provider.addEventListener("change", () => {
    // A change event already exposes the NEW select value. The visible key
    // and endpoint still belong to the previous provider until this handler.
    syncCurrentKeyDraft(previousProviderId);
    providerDrafts[previousProviderId] = {
      baseUrl: fields.baseUrl.value,
      model: fields.modelPreset.value === "__custom__" ? fields.customModel.value : fields.modelPreset.value
    };
    const newProviderId = fields.provider.value;
    const selectedProvider = DT.getProvider(newProviderId);
    const draft = providerDrafts[newProviderId];
    fields.baseUrl.value = draft?.baseUrl ?? selectedProvider.baseUrl;
    updateProviderFields(newProviderId, draft?.model || selectedProvider.defaultModel, true);
    fields.apiKey.type = "password";
    toggleKeyButton.textContent = "显示";
    toggleKeyButton.setAttribute("aria-label", "显示 API Key");
    previousProviderId = newProviderId;
  });
  fields.modelPreset.addEventListener("change", () => {
    const custom = fields.modelPreset.value === "__custom__";
    fields.customModel.hidden = !custom;
    if (custom && !fields.customModel.value) {
      fields.customModel.value = DT.getProvider(fields.provider.value).defaultModel;
    }
  });
  toggleKeyButton.addEventListener("click", () => {
    const showing = fields.apiKey.type === "text";
    fields.apiKey.type = showing ? "password" : "text";
    toggleKeyButton.textContent = showing ? "显示" : "隐藏";
    toggleKeyButton.setAttribute("aria-label", showing ? "显示 API Key" : "隐藏 API Key");
  });
  form.addEventListener("submit", saveSettings);
  resetButton.addEventListener("click", resetNonSecretSettings);
  testButton.addEventListener("click", async () => {
    testButton.disabled = true;
    showStatus("正在测试已保存的供应商和模型…");
    try {
      const response = await chrome.runtime.sendMessage({ type: "DEERWEBTRANSLATOR_TEST_CONNECTION" });
      showStatus(response?.ok ? "连接正常，模型已返回有效翻译。"
        : response?.error?.message || "连接测试失败。", !response?.ok);
    } catch { showStatus("无法连接后台，请重新加载扩展。", true); }
    finally { testButton.disabled = false; }
  });
  async function refreshCache() {
    const result = await chrome.runtime.sendMessage({ type: "DEERWEBTRANSLATOR_CACHE_INFO" });
    cacheInfo.textContent = result?.ok ? result.entries + " 条缓存"
      + (result.bytes == null ? "" : "，约 " + (result.bytes / 1024 / 1024).toFixed(2) + " MB") : "暂时无法读取缓存。";
  }
  clearCacheButton.addEventListener("click", async () => {
    clearCacheButton.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: "DEERWEBTRANSLATOR_CLEAR_CACHE" });
      showStatus(result?.ok ? "已清除 " + result.entries + " 条翻译缓存，设置和 Key 已保留。"
        : result?.error?.message || "清除缓存失败。", !result?.ok);
      await refreshCache();
    } catch { showStatus("无法连接后台。", true); }
    finally { clearCacheButton.disabled = false; }
  });

  populateProviderSelect();
  loadSettings().catch((error) => {
    showStatus(error && error.message ? `读取设置失败：${error.message}` : "读取设置失败。", true);
  });
  refreshCache().catch(() => { cacheInfo.textContent = "暂时无法读取缓存。"; });
})(globalThis);
