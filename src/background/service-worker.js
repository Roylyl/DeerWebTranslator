importScripts("../shared/constants.js");
importScripts("../shared/dom-codec.js");
importScripts("translation-policy.js");

(function initializeDeerWebTranslatorServiceWorker(global) {
  "use strict";

  const DT = global.DeerWebTranslator;
  const activeRequests = new Map();
  const cancelledRuns = new Map();
  const inFlight = new Map();
  const providerPools = new Map();
  const capabilities = new Map();
  const cacheVersions = new Map();
  // Keys are only available to extension pages and the service worker.
  const storageReady = chrome.storage.local.setAccessLevel
    ? chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    : Promise.resolve();

  class DeerWebTranslatorError extends Error {
    constructor(code, message, retryable = false) {
      super(message);
      this.name = "DeerWebTranslatorError";
      this.code = code;
      this.retryable = retryable;
    }
  }

  function rememberCancellation(runId) {
    if (!runId) {
      return;
    }
    cancelledRuns.set(runId, Date.now());
    setTimeout(() => cancelledRuns.delete(runId), 10 * 60 * 1000);
  }

  function isCancelled(runId) {
    return Boolean(runId && cancelledRuns.has(runId));
  }

  function delay(milliseconds, runId) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (isCancelled(runId)) {
          reject(new DeerWebTranslatorError("CANCELLED", "翻译已停止。"));
          return;
        }
        resolve();
      }, Math.max(0, milliseconds));
    });
  }

  function registerRequest(runId, controller) {
    if (!activeRequests.has(runId)) {
      activeRequests.set(runId, new Set());
    }
    activeRequests.get(runId).add(controller);
  }

  function unregisterRequest(runId, controller) {
    const requests = activeRequests.get(runId);
    if (!requests) {
      return;
    }
    requests.delete(controller);
    if (requests.size === 0) {
      activeRequests.delete(runId);
    }
  }

  function cancelRun(runId) {
    if (!runId || typeof runId !== "string") {
      return;
    }
    rememberCancellation(runId);
    const requests = activeRequests.get(runId);
    if (requests) {
      for (const controller of requests) {
        controller.abort();
      }
    }
  }

  async function getStoredConfig() {
    await storageReady;
    const result = await chrome.storage.local.get(DT.STORAGE_KEY);
    const saved = result && result[DT.STORAGE_KEY] && typeof result[DT.STORAGE_KEY] === "object"
      ? result[DT.STORAGE_KEY]
      : {};
    const settings = DT.normalizePublicSettings(saved);
    const apiKeys = saved.apiKeys && typeof saved.apiKeys === "object" ? saved.apiKeys : {};
    // Migrate the original one-provider prototype without exposing the value
    // outside the service worker.
    const legacyKey = typeof saved.apiKey === "string" ? saved.apiKey.trim() : "";
    const apiKey = typeof apiKeys[settings.provider] === "string"
      ? apiKeys[settings.provider].trim()
      : settings.provider === "deepseek" ? legacyKey : "";
    return { settings, apiKey };
  }

  function validateBatchMessage(message) {
    if (!message || typeof message !== "object") {
      throw new DeerWebTranslatorError("INVALID_REQUEST", "翻译请求格式无效。" );
    }
    if (!Array.isArray(message.items) || message.items.length === 0 || message.items.length > DT.MAX_BATCH_ITEMS) {
      throw new DeerWebTranslatorError("INVALID_REQUEST", "翻译批次为空或超过单批数量限制。" );
    }
    if (typeof message.runId !== "string" || message.runId.length < 1 || message.runId.length > 128) {
      throw new DeerWebTranslatorError("INVALID_REQUEST", "翻译任务 ID 无效。" );
    }
    if (typeof message.pageUrl !== "string" || message.pageUrl.length > 8192) {
      throw new DeerWebTranslatorError("INVALID_REQUEST", "页面 URL 无效。" );
    }

    const ids = new Set();
    let totalCharacters = 0;
    const items = message.items.map((item) => {
      if (!item || typeof item !== "object") {
        throw new DeerWebTranslatorError("INVALID_REQUEST", "翻译项目格式无效。" );
      }
      const id = typeof item.id === "string" ? item.id : "";
      const text = typeof item.text === "string" ? item.text : "";
      const hash = typeof item.hash === "string" ? item.hash : "";
      if (!id || id.length > 256 || ids.has(id)) {
        throw new DeerWebTranslatorError("INVALID_REQUEST", "翻译项目 ID 必须唯一。" );
      }
      if (!text || text.length > 50000 || !hash || hash.length > 256) {
        throw new DeerWebTranslatorError("INVALID_REQUEST", "翻译项目文本或哈希无效。" );
      }
      ids.add(id);
      totalCharacters += text.length;
      const context = item.context && typeof item.context === "object" ? {
        tag: String(item.context.tag || "").slice(0, 24),
        region: String(item.context.region || "").slice(0, 32),
        isLink: Boolean(item.context.isLink),
        linkKind: String(item.context.linkKind || "").slice(0, 24),
        heading: String(item.context.heading || "").slice(0, 96)
      } : {};
      return { id, text, hash, context, force: item.force === true };
    });

    if (totalCharacters > DT.MAX_BATCH_INPUT_CHARS) {
      throw new DeerWebTranslatorError("BATCH_TOO_LARGE", "翻译批次过大，请稍后重试。" );
    }

    return {
      runId: message.runId,
      pageUrl: message.pageUrl,
      items
    };
  }

  function normalizeBaseUrl(settings) {
    const provider = DT.getProvider(settings.provider);
    const value = String(settings.baseUrl || provider.baseUrl || "").trim().replace(/\/+$/, "");
    if (!value) {
      throw new DeerWebTranslatorError("ENDPOINT_MISSING", "请先在设置中填写 API Base URL。" );
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch (error) {
      throw new DeerWebTranslatorError("ENDPOINT_INVALID", "API Base URL 不是有效的 URL。" );
    }
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new DeerWebTranslatorError("ENDPOINT_INVALID", "API Base URL 只支持 http/https，不能包含用户名、密码、查询参数或片段。" );
    }
    return value;
  }

  function appendPath(baseUrl, path) {
    const normalized = baseUrl.replace(/\/+$/, "");
    return normalized.endsWith(path) ? normalized : `${normalized}${path}`;
  }

  function createTranslationSystemPrompt(settings, correction) {
    const domainGuidance = DT.DOMAIN_PRESETS[settings.domain] || DT.DOMAIN_PRESETS.General;
    const glossary = settings.glossary
      ? `\nCustom terminology glossary (follow it when applicable):\n${settings.glossary}`
      : "";
    const retryCorrection = correction
      ? `\nPrevious response validation failed. Correct the format before answering: ${correction}`
      : "";

    return [
      settings.systemPrompt === DT.DEFAULT_SYSTEM_PROMPT ? "" : settings.systemPrompt,
      `Target language: ${settings.targetLanguage}.`,
      `Technical domain: ${settings.domain}. ${domainGuidance}`,
      global.DeerTranslationPolicy.prompt,
      glossary,
      retryCorrection
    ].filter(Boolean).join("\n");
  }

  function createUserMessage(items, pageContext) {
    return [
      JSON.stringify({
        page: pageContext,
        items: items.map((item) => ({ id: item.id, text: item.text,
          context: { tag: item.context?.tag, region: item.context?.region, heading: item.context?.heading || undefined } }))
      })
    ].join("\n");
  }

  function buildProviderRequest(settings, apiKey, items, pageContext, useJsonMode, useTemperature, correction) {
    const provider = DT.getProvider(settings.provider);
    const baseUrl = normalizeBaseUrl(settings);
    const systemPrompt = createTranslationSystemPrompt({ ...settings, glossary: relevantGlossary(items, settings.glossary) }, correction);
    const userMessage = createUserMessage(items, pageContext);

    if (provider.kind === "anthropic") {
      return {
        url: appendPath(baseUrl, "/messages"),
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: {
          model: settings.model,
          max_tokens: 8192,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }]
        },
        supportsJsonMode: false,
        supportsTemperature: false
      };
    }

    if (provider.kind === "gemini") {
      const modelPath = encodeURIComponent(settings.model);
      return {
        url: `${appendPath(baseUrl, "")}/models/${modelPath}:generateContent`,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userMessage }] }],
          generationConfig: {
            ...(useTemperature ? { temperature: 0.1 } : {}),
            ...(useJsonMode ? { responseMimeType: "application/json" } : {})
          }
        },
        supportsJsonMode: true,
        supportsTemperature: true
      };
    }

    const headers = { "Content-Type": "application/json" };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const body = {
      model: settings.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      stream: false,
      ...(settings.provider === "deepseek" && /^deepseek-v4-/.test(settings.model)
        ? { thinking: { type: "disabled" } } : {}),
      ...(useTemperature ? { temperature: 0.1 } : {}),
      ...(useJsonMode ? { response_format: { type: "json_object" } } : {})
    };
    return {
      url: appendPath(baseUrl, "/chat/completions"),
      headers,
      body,
      supportsJsonMode: true,
      supportsTemperature: true
    };
  }

  function extractProviderContent(provider, apiResponse) {
    if (provider.kind === "anthropic") {
      const content = apiResponse && apiResponse.content;
      if (Array.isArray(content)) {
        return content.map((part) => part && typeof part.text === "string" ? part.text : "").join("");
      }
    } else if (provider.kind === "gemini") {
      const parts = apiResponse && apiResponse.candidates && apiResponse.candidates[0]
        && apiResponse.candidates[0].content && apiResponse.candidates[0].content.parts;
      if (Array.isArray(parts)) {
        return parts.map((part) => part && typeof part.text === "string" ? part.text : "").join("");
      }
    } else {
      const content = apiResponse && apiResponse.choices && apiResponse.choices[0]
        && apiResponse.choices[0].message && apiResponse.choices[0].message.content;
      if (typeof content === "string") {
        return content;
      }
      if (Array.isArray(content)) {
        return content.map((part) => part && typeof part.text === "string" ? part.text : "").join("");
      }
    }
    throw new DeerWebTranslatorError("INVALID_RESPONSE", "模型返回中缺少文本内容。", true);
  }

  function parseStrictJson(content) {
    let candidate = String(content || "").trim();
    const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) {
      candidate = fenced[1].trim();
    }
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
      throw new DeerWebTranslatorError("INVALID_RESPONSE", "模型未返回严格 JSON。", true);
    }
    try {
      return JSON.parse(candidate);
    } catch (error) {
      throw new DeerWebTranslatorError("INVALID_RESPONSE", "模型返回的 JSON 无法解析。", true);
    }
  }

  function validateTranslations(result, items) {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new DeerWebTranslatorError("INVALID_RESPONSE", "模型返回格式不是 JSON 对象。", true);
    }
    const resultKeys = Object.keys(result);
    if (resultKeys.length !== 1 || resultKeys[0] !== "translations" || !Array.isArray(result.translations)) {
      throw new DeerWebTranslatorError("INVALID_RESPONSE", "模型返回缺少严格的 translations 数组。", true);
    }
    if (result.translations.length !== items.length) {
      throw new DeerWebTranslatorError("INVALID_RESPONSE", "模型返回的翻译数量与输入不一致。", true);
    }

    const expectedIds = new Set(items.map((item) => item.id));
    const seenIds = new Set();
    const byId = new Map();
    for (const translation of result.translations) {
      if (!translation || typeof translation !== "object" || Array.isArray(translation)) {
        throw new DeerWebTranslatorError("INVALID_RESPONSE", "翻译项目不是对象。", true);
      }
      const keys = Object.keys(translation);
      if (keys.length !== 2 || !keys.includes("id") || !keys.includes("text")) {
        throw new DeerWebTranslatorError("INVALID_RESPONSE", "翻译项目字段不符合严格格式。", true);
      }
      if (typeof translation.id !== "string" || !expectedIds.has(translation.id) || seenIds.has(translation.id)) {
        throw new DeerWebTranslatorError("INVALID_RESPONSE", "模型返回了未知或重复的翻译 ID。", true);
      }
      if (typeof translation.text !== "string" || !translation.text.trim()) {
        throw new DeerWebTranslatorError("INVALID_RESPONSE", "模型返回了空翻译文本。", true);
      }
      try {
        const source = items.find((item) => item.id === translation.id).text;
        global.DeerDOMCodec.validate(source, translation.text);
        const pattern = /\[\[DWT_(?:OPEN|CLOSE|KEEP)_\d+\]\]/g;
        if (JSON.stringify(source.match(pattern)) !== JSON.stringify(translation.text.match(pattern))) {
          throw new Error("译文改变了文字槽位顺序。");
        }
        const slots = /\[\[DWT_OPEN_(\d+)\]\]([^]*?)\[\[DWT_CLOSE_\1\]\]/g;
        // New page requests consist entirely of flat slots. Reject dropped
        // words outside those slots here, while provider retries are possible.
        if (source.startsWith("[[DWT_OPEN_") && source.replace(slots, "").trim() === "") {
          if (translation.text.replace(slots, "").trim()
            || [...translation.text.matchAll(slots)].some((match) => !match[2].trim())) {
            throw new Error("译文含槽位外文字或空槽位。");
          }
        }
        if (translation.text.length > Math.max(2000, source.length * 6)) {
          throw new Error("译文长度异常。");
        }
        const urls = source.match(/__DWT_URL_[A-Z_]*\d+__/g) || [];
        if (urls.some((token) => translation.text.split(token).length !== 2)) {
          throw new Error("译文未完整保留网址占位符。");
        }
      } catch (error) {
        throw new DeerWebTranslatorError("INVALID_RESPONSE", error.message, true);
      }
      seenIds.add(translation.id);
      byId.set(translation.id, translation.text);
    }
    if (seenIds.size !== expectedIds.size) {
      throw new DeerWebTranslatorError("INVALID_RESPONSE", "模型未返回所有输入 ID。", true);
    }
    return items.map((item) => ({ id: item.id, text: byId.get(item.id) }));
  }

  function isFormatOptionError(status, responseText) {
    if (status !== 400) {
      return false;
    }
    return /response[_ ]format|json_object|json mode|structured output.*unsupported|unsupported.*response[_ ]format/i.test(
      String(responseText || "")
    );
  }

  function isTemperatureOptionError(status, responseText) {
    if (status !== 400) {
      return false;
    }
    return /temperature.*(unsupported|not supported|invalid)|unsupported.*temperature/i.test(String(responseText || ""));
  }

  function shouldRetryStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  function getRetryDelay(response, attempt) {
    const header = response?.headers?.get("Retry-After");
    const retryAfter = header == null ? NaN : Number(header);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) {
      return Math.min(retryAfter * 1000, 20000);
    }
    return Math.min(1000 * (2 ** Math.max(0, attempt - 1)), 12000);
  }

  function errorForHttpStatus(status, providerLabel) {
    if (status === 401 || status === 403) {
      return new DeerWebTranslatorError("API_KEY_INVALID", `${providerLabel} API Key 无效或没有权限。` );
    }
    if (status === 429) {
      return new DeerWebTranslatorError("RATE_LIMITED", `${providerLabel} 请求过于频繁，已达到速率限制。`, true);
    }
    if (status >= 500) {
      return new DeerWebTranslatorError("UPSTREAM_ERROR", `${providerLabel} 服务暂时不可用，请稍后重试。`, true);
    }
    if (status === 408) {
      return new DeerWebTranslatorError("TIMEOUT", `${providerLabel} 请求超时，请稍后重试。`, true);
    }
    if (status === 400) {
      return new DeerWebTranslatorError("BAD_REQUEST", `${providerLabel} 拒绝了请求，请检查模型、Endpoint 或提示词。` );
    }
    return new DeerWebTranslatorError("API_ERROR", `${providerLabel} API 请求失败（HTTP ${status}）。`, false);
  }


  function relevantGlossary(items, glossary) {
    const text = items.map((item) => item.text + " " + (item.context?.heading || "")).join(" ").toLowerCase();
    return String(glossary || "").split("\n").filter((line) => {
      const match = line.match(/^\s*(.+?)\s*(?:=|=>|→)\s*(.+)$/);
      return !match || text.includes(match[1].trim().toLowerCase());
    }).join("\n");
  }
  function newUsage() { return { requests: 0, reportedRequests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }; }
  function countUsage(stats, body, kind) {
    const usage = kind === "gemini" ? body?.usageMetadata : body?.usage;
    if (!usage) return;
    const input = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount;
    const output = usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount;
    if (!Number.isFinite(input) || !Number.isFinite(output)) return;
    stats.reportedRequests++;
    stats.inputTokens += input + (kind === "anthropic"
      ? (Number(usage.cache_read_input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0) : 0);
    stats.outputTokens += output + (kind === "gemini" ? Number(usage.thoughtsTokenCount) || 0 : 0);
    stats.cacheReadTokens += Number(usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens
      ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cachedContentTokenCount) || 0;
  }
  async function acquire(pool, runId) {
    while (pool.active >= pool.limit || Date.now() < pool.until) {
      await delay(Math.min(250, Math.max(25, pool.until - Date.now())), runId);
    }
    if (isCancelled(runId)) throw new DeerWebTranslatorError("CANCELLED", "翻译已停止。");
    pool.active++;
  }
  async function callProvider(items, settings, apiKey, runId, pageContext, usage, onValid = async () => {}, attemptLimit = DT.MAX_API_ATTEMPTS) {
    const provider = DT.getProvider(settings.provider);
    const poolKey = settings.provider + "|" + settings.baseUrl + "|" + settings.model;
    if (!providerPools.has(poolKey)) providerPools.set(poolKey, { active: 0, limit: 3, until: 0, successes: 0 });
    const pool = providerPools.get(poolKey);
    const cap = capabilities.get(poolKey) || {};
    let useJsonMode = provider.kind !== "anthropic" && cap.json !== false;
    let useTemperature = cap.temperature !== false;
    let pending = [...items], attempt = 0, correction = "";
    const accepted = new Map();
    let lastError = new DeerWebTranslatorError("INVALID_RESPONSE", "模型未返回有效译文。", true);
    while (pending.length && attempt < attemptLimit) {
      if (isCancelled(runId)) throw new DeerWebTranslatorError("CANCELLED", "翻译已停止。");
      await acquire(pool, runId);
      attempt++;
      let request, response, responseText = "", apiResponse, timedOut = false;
      const controller = new AbortController();
      registerRequest(runId, controller);
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, DT.API_TIMEOUT_MS);
      try {
        request = buildProviderRequest(settings, apiKey, pending, pageContext, useJsonMode, useTemperature, correction);
        usage.requests++;
        response = await fetch(request.url, { method: "POST", headers: request.headers,
          body: JSON.stringify(request.body), signal: controller.signal });
        if (response.ok) {
          apiResponse = await response.json();
          countUsage(usage, apiResponse, provider.kind);
        } else responseText = await response.text();
      } catch (error) {
        lastError = error instanceof DeerWebTranslatorError ? error : new DeerWebTranslatorError(
          timedOut ? "TIMEOUT" : error instanceof SyntaxError ? "INVALID_RESPONSE" : "NETWORK_ERROR",
          timedOut ? "模型响应超时，可重试未完成部分。" : "模型连接或响应异常，可重试未完成部分。", true);
        response = null;
      } finally {
        clearTimeout(timeout); unregisterRequest(runId, controller); pool.active--;
      }
      if (isCancelled(runId)) throw new DeerWebTranslatorError("CANCELLED", "翻译已停止。");
      if (!response) {
        if (!lastError.retryable) break;
        if (attempt < attemptLimit) await delay(500 * attempt, runId);
        continue;
      }
      if (!response.ok) {
        if (request.supportsJsonMode && useJsonMode && isFormatOptionError(response.status, responseText)) {
          useJsonMode = false; cap.json = false; capabilities.set(poolKey, cap); attempt--; continue;
        }
        if (request.supportsTemperature && useTemperature && isTemperatureOptionError(response.status, responseText)) {
          useTemperature = false; cap.temperature = false; capabilities.set(poolKey, cap); attempt--; continue;
        }
        lastError = errorForHttpStatus(response.status, provider.label);
        if (response.status === 429) {
          pool.limit = Math.max(1, pool.limit - 1); pool.successes = 0;
          pool.until = Math.max(pool.until, Date.now() + getRetryDelay(response, attempt));
        }
        if (!shouldRetryStatus(response.status)) break;
        if (attempt < attemptLimit) await delay(getRetryDelay(response, attempt), runId);
        continue;
      }
      try {
        const result = parseStrictJson(extractProviderContent(provider, apiResponse));
        if (!result || Object.keys(result).length !== 1 || !Array.isArray(result.translations)) {
          throw new DeerWebTranslatorError("INVALID_RESPONSE", "模型 JSON 结构无效。", true);
        }
        const expected = new Set(pending.map((item) => item.id)), seen = new Set(), valid = [];
        if (result.translations.some((item) => {
          if (!expected.has(item?.id) || seen.has(item.id)) return true;
          seen.add(item.id); return false;
        })) throw new DeerWebTranslatorError("INVALID_RESPONSE", "模型返回未知或重复 ID。", true);
        for (const item of pending) {
          const translation = result.translations.find((value) => value.id === item.id);
          if (!translation) continue;
          try { valid.push(...validateTranslations({ translations: [translation] }, [item])); }
          catch (error) { lastError = error; }
        }
        // Successfully validated paragraphs are saved/displayed once and
        // excluded from all subsequent format retries.
        await onValid(valid);
        valid.forEach((item) => accepted.set(item.id, item));
        pending = pending.filter((item) => !accepted.has(item.id));
        if (++pool.successes >= 8) { pool.limit = Math.min(3, pool.limit + 1); pool.successes = 0; }
      } catch (error) {
        lastError = error instanceof DeerWebTranslatorError ? error
          : new DeerWebTranslatorError("INVALID_RESPONSE", "模型返回无法处理。", true);
      }
      if (pending.length && attempt < attemptLimit) {
        correction = "Retry only these IDs. Preserve every marker and return strict JSON with id and text.";
        await delay(250 * attempt, runId);
      }
    }
    return { translations: items.filter((item) => accepted.has(item.id)).map((item) => accepted.get(item.id)),
      failed: pending.map((item) => ({ id: item.id, error: lastError })) };
  }

  function cacheKeyFor(item, pageUrl, settings) {
    return DT.makeCacheKey(
      pageUrl,
      item.hash,
      settings.targetLanguage,
      settings.model,
      settings.provider,
      settings.baseUrl
    );
  }

  async function readCache(items, pageUrl, settings) {
    const keys = items.map((item) => cacheKeyFor(item, pageUrl, settings));
    const stored = await chrome.storage.local.get(keys);
    const cached = [];
    const missing = [];
    items.forEach((item, index) => {
      const entry = stored[keys[index]];
      if (!item.force && entry && typeof entry === "object"
        && entry.originalHash === item.hash
        && entry.provider === settings.provider
        && entry.model === settings.model
        && typeof entry.text === "string"
        && entry.text.trim()) {
        cached.push({ id: item.id, text: entry.text });
      } else {
        missing.push(item);
      }
    });
    return { cached, missing };
  }

  async function writeCache(items, translations, pageUrl, settings) {
    const values = {};
    const translationById = new Map(translations.map((translation) => [translation.id, translation.text]));
    items.forEach((item) => {
      const translatedText = translationById.get(item.id);
      if (typeof translatedText !== "string" || !translatedText.trim()) {
        return;
      }
      values[cacheKeyFor(item, pageUrl, settings)] = {
        text: translatedText,
        originalHash: item.hash,
        targetLanguage: settings.targetLanguage,
        model: settings.model,
        provider: settings.provider,
        createdAt: Date.now()
      };
    });
    if (Object.keys(values).length === 0) {
      return;
    }
    try {
      await chrome.storage.local.set(values);
    } catch (error) {
      // A cache write failure must not discard a successful translation.
      console.warn("DeerWebTranslator cache write failed", error && error.message ? error.message : error);
    }
  }


  function localLabel(item, settings) {
    if (item.force || item.context?.region !== "ui" || settings.systemPrompt !== DT.DEFAULT_SYSTEM_PROMPT
      || relevantGlossary([item], settings.glossary).trim() || !/Simplified|简体/i.test(settings.targetLanguage)) return null;
    const labels = { Settings: "设置", Search: "搜索", Cancel: "取消", Save: "保存",
      Close: "关闭", Next: "下一步", Previous: "上一步", Documentation: "文档",
      Terms: "条款", Privacy: "隐私" };
    return Object.hasOwn(labels, item.text.trim()) ? labels[item.text.trim()] : null;
  }
  function notifyPartial(request, sender, translations, source) {
    if (!request.batchId || !translations.length || !chrome.tabs?.sendMessage || isCancelled(request.runId)) return;
    void chrome.tabs.sendMessage(sender.tab.id, { type: "DEERWEBTRANSLATOR_PARTIAL",
      runId: request.runId, batchId: request.batchId, translations, source },
      { frameId: sender.frameId || 0 }).catch(() => {});
  }
  async function translateBatch(message, sender) {
    if (!sender?.tab || typeof sender.tab.id !== "number") {
      throw new DeerWebTranslatorError("INVALID_SENDER", "翻译请求必须来自网页内容脚本。");
    }
    const request = validateBatchMessage(message);
    request.batchId = typeof message.batchId === "string" ? message.batchId.slice(0, 160) : "";
    if (isCancelled(request.runId)) throw new DeerWebTranslatorError("CANCELLED", "翻译已停止。");
    const usage = newUsage();
    try {
      const { settings, apiKey } = await getStoredConfig();
      const provider = DT.getProvider(settings.provider);
      const pageContext = { title: String(message.pageTitle || "").slice(0, 160) };
      try { pageContext.site = new URL(request.pageUrl).hostname; } catch {}
      await Promise.all(request.items.map(async (item) => {
        item.hash = await DT.sha256Hex(JSON.stringify([item.text, item.context, pageContext,
          settings.domain, settings.systemPrompt, relevantGlossary([item], settings.glossary)]));
      }));
      const cache = await readCache(request.items, request.pageUrl, settings);
      // Notify before any network wait, key error or in-flight joining.
      notifyPartial(request, sender, cache.cached, "cache");
      const local = [], missing = [];
      for (const item of cache.missing) {
        const text = localLabel(item, settings);
        if (text !== null) local.push({ id: item.id, text });
        else missing.push(item);
      }
      notifyPartial(request, sender, local, "local");
      if (local.length) await writeCache(cache.missing.filter((item) => local.some((t) => t.id === item.id)),
        local, request.pageUrl, settings);
      if (missing.length && provider.requiresApiKey && !apiKey) {
        throw new DeerWebTranslatorError("API_KEY_MISSING", "请先在设置中填写 " + provider.label + " API Key。");
      }
      const owned = [], waiting = [];
      for (const item of missing) {
        const cacheKey = cacheKeyFor(item, request.pageUrl, settings);
        const key = sender.tab.id + "|" + request.runId + "|" + cacheKey + "|" + item.force;
        let job = inFlight.get(key);
        if (!job) {
          let resolve, reject;
          const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
          const cacheState = cacheVersions.get(cacheKey) || { version: 0, pending: 0 };
          cacheState.version++; cacheState.pending++; cacheVersions.set(cacheKey, cacheState);
          job = { promise, resolve, reject, item, key, done: false, cacheKey, cacheState, version: cacheState.version };
          inFlight.set(key, job); owned.push(job);
        }
        waiting.push(job.promise.then((text) => ({ id: item.id, text })));
      }
      const allResults = Promise.allSettled(waiting);
      if (owned.length) {
        try {
          const originals = owned.map((job) => job.item);
          const wire = originals.map((item, i) => ({ ...item, id: String(i) }));
          const protectedBatch = global.DeerTranslationPolicy.protect(wire);
          const outcome = await callProvider(protectedBatch.items, settings, apiKey, request.runId, pageContext, usage,
            async (valid) => {
              if (isCancelled(request.runId)) throw new DeerWebTranslatorError("CANCELLED", "翻译已停止。");
              if (!valid.length) return;
              const restored = global.DeerTranslationPolicy.restore(valid, protectedBatch.maps);
              const fresh = restored.map((item) => ({ id: originals[Number(item.id)].id, text: item.text }));
              notifyPartial(request, sender, fresh, "model");
              // A late pre-retranslation request must not overwrite the newer
              // forced result in persistent cache, even across tabs.
              const cacheable = owned.filter((job) => job.version === job.cacheState.version
                && fresh.some((item) => item.id === job.item.id)).map((job) => job.item);
              await writeCache(cacheable, fresh, request.pageUrl, settings);
              for (const item of restored) {
                const job = owned[Number(item.id)]; job.done = true; job.resolve(item.text);
              }
            });
          outcome.failed.forEach(({ id, error }) => owned[Number(id)].reject(error));
        } catch (error) {
          owned.filter((job) => !job.done).forEach((job) => job.reject(error));
        } finally { owned.forEach((job) => {
          inFlight.delete(job.key);
          if (--job.cacheState.pending === 0) cacheVersions.delete(job.cacheKey);
        }); }
      }
      const results = await allResults;
      const fresh = results.filter((item) => item.status === "fulfilled").map((item) => item.value);
      const translationsById = new Map([...cache.cached, ...local, ...fresh].map((t) => [t.id, t]));
      const failed = results.flatMap((result, i) => result.status === "rejected"
        ? [{ id: missing[i].id, error: serializeError(result.reason) }] : []);
      if (!translationsById.size && failed.length) {
        const error = results.find((r) => r.status === "rejected").reason;
        throw error;
      }
      return { translations: request.items.filter((i) => translationsById.has(i.id)).map((i) => translationsById.get(i.id)),
        failed, cachedCount: cache.cached.length, localCount: local.length, requestedCount: request.items.length, usage };
    } catch (error) { error.usage = usage; throw error; }
  }

  function serializeError(error) {
    const known = error instanceof DeerWebTranslatorError;
    return {
      code: known ? error.code : "UNKNOWN_ERROR",
      message: known ? error.message : "翻译服务发生未知错误，请稍后重试。"
    };
  }

  async function initializeSettings() {
    const result = await chrome.storage.local.get(DT.STORAGE_KEY);
    if (!result || !result[DT.STORAGE_KEY]) {
      await chrome.storage.local.set({
        [DT.STORAGE_KEY]: {
          ...DT.normalizePublicSettings({}),
          apiKeys: {}
        }
      });
    }
  }

  const SITE_KEY = "deerwebtranslatorSitePreferences";
  async function pagePolicy(url) {
    const { settings } = await getStoredConfig();
    const stored = await chrome.storage.local.get(SITE_KEY);
    let policy = {};
    try { policy = stored[SITE_KEY]?.[new URL(url).origin] || {}; } catch {}
    return { settings, policy: { auto: ["always", "never"].includes(policy.auto) ? policy.auto : "manual",
      mode: Object.values(DT.DISPLAY_MODES).includes(policy.mode) ? policy.mode : settings.displayMode } };
  }
  function trustedPage(sender) {
    return Boolean(sender.url && chrome.runtime.getURL
      && sender.url.startsWith(chrome.runtime.getURL("")));
  }
  async function cacheInfo(clear) {
    await storageReady;
    const data = await chrome.storage.local.get(null);
    const keys = Object.keys(data).filter((key) => key.startsWith("deerwebtranslator.cache."));
    const bytes = chrome.storage.local.getBytesInUse ? await chrome.storage.local.getBytesInUse(keys) : null;
    if (clear && keys.length) await chrome.storage.local.remove(keys);
    return { entries: keys.length, bytes };
  }
  async function testConnection() {
    const { settings, apiKey } = await getStoredConfig();
    const provider = DT.getProvider(settings.provider);
    if (provider.requiresApiKey && !apiKey) throw new DeerWebTranslatorError("API_KEY_MISSING", "请先保存 API Key。");
    const usage = newUsage();
    const result = await callProvider([{ id: "0", text: "Hello", context: { tag: "p", region: "main" } }],
      { ...settings, systemPrompt: DT.DEFAULT_SYSTEM_PROMPT, glossary: "" }, apiKey,
      "test-" + Date.now(), { title: "Connection test" }, usage, async () => {}, 1);
    if (result.failed.length) throw result.failed[0].error;
    return { usage };
  }
  async function runCommand(type, tab) {
    if (!tab?.id || !/^https?:/.test(tab.url || "")) return;
    const { settings } = await pagePolicy(tab.url);
    const message = { type, settings };
    try { await chrome.tabs.sendMessage(tab.id, message); }
    catch (error) {
      if (!/receiving end does not exist|could not establish connection/i.test(error.message)) return;
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["src/content/content-style.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id },
        files: ["src/shared/constants.js", "src/shared/dom-codec.js", "src/content/text-index.js", "src/content/content-script.js"] });
      await chrome.tabs.sendMessage(tab.id, message);
    }
  }
  function installMenu() {
    if (!chrome.contextMenus) return;
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: "deer-selection", title: "翻译／重译选中段落", contexts: ["selection"],
        documentUrlPatterns: ["http://*/*", "https://*/*"] });
    });
  }
  chrome.commands?.onCommand.addListener((name) => {
    if (name === "toggle-translation") chrome.tabs.query({ active: true, currentWindow: true })
      .then((tabs) => runCommand("DEERWEBTRANSLATOR_TOGGLE_TRANSLATION", tabs[0])).catch(() => {});
  });
  chrome.contextMenus?.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "deer-selection") runCommand("DEERWEBTRANSLATOR_TRANSLATE_SELECTION", tab).catch(() => {});
  });

  chrome.runtime.onInstalled.addListener(() => {
    installMenu();
    initializeSettings().catch((error) => console.warn("DeerWebTranslator settings initialization failed", error));
  });

  chrome.runtime.onStartup.addListener(() => {
    initializeSettings().catch((error) => console.warn("DeerWebTranslator settings initialization failed", error));
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") {
      return false;
    }
    if (message.type === "DEERWEBTRANSLATOR_PAGE_POLICY" && sender.tab) {
      pagePolicy(sender.url || sender.tab.url || message.pageUrl)
        .then((value) => sendResponse({ ok: true, ...value }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (["DEERWEBTRANSLATOR_CACHE_INFO", "DEERWEBTRANSLATOR_CLEAR_CACHE", "DEERWEBTRANSLATOR_TEST_CONNECTION"].includes(message.type)) {
      if (!trustedPage(sender)) { sendResponse({ ok: false, error: { message: "此操作只允许在扩展设置页执行。" } }); return false; }
      const operation = message.type === "DEERWEBTRANSLATOR_TEST_CONNECTION" ? testConnection()
        : cacheInfo(message.type === "DEERWEBTRANSLATOR_CLEAR_CACHE");
      operation.then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
      return true;
    }

    if (message.type === "DEERWEBTRANSLATOR_CANCEL_TRANSLATION") {
      cancelRun(message.runId);
      sendResponse({ ok: true });
      return false;
    }

    if (message.type !== "DEERWEBTRANSLATOR_TRANSLATE_BATCH") {
      return false;
    }

    translateBatch(message, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: serializeError(error), usage: error.usage || newUsage() }));
    return true;
  });
})(globalThis);
