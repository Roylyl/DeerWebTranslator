(function initializeDeerWebTranslatorContentScript(global) {
  "use strict";

  if (global.__DEERWEBTRANSLATOR_CONTENT_SCRIPT_LOADED__) {
    return;
  }
  global.__DEERWEBTRANSLATOR_CONTENT_SCRIPT_LOADED__ = true;

  const DT = global.DeerWebTranslator;
  const codec = global.DeerDOMCodec;
  const state = {
    status: "idle",
    mode: DT.DEFAULT_DISPLAY_MODE,
    total: 0,
    completed: 0,
    cached: 0,
    error: "",
    runId: "",
    pageUrl: location.href,
    autoTranslate: false,
    updatedAt: Date.now()
  };

  let activeRun = null;
  let idCounter = 0;
  let pageToken = Math.random().toString(36).slice(2, 10);
  let mutationObserver = null;
  let observedBody = null;
  let mutationTimer = null;
  let locationTimer = null;

  const replacementStyleProperties = [
    "display",
    "box-sizing",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "font-variant",
    "font-stretch",
    "line-height",
    "letter-spacing",
    "text-align",
    "text-transform",
    "text-indent",
    "text-decoration-line",
    "text-decoration-style",
    "text-decoration-color",
    "text-shadow",
    "color",
    "direction",
    "writing-mode",
    "text-orientation",
    "white-space",
    "word-break",
    "overflow-wrap",
    "hyphens",
    "vertical-align",
    "list-style-type",
    "list-style-position",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
    "border-top-style",
    "border-right-style",
    "border-bottom-style",
    "border-left-style",
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
    "border-top-left-radius",
    "border-top-right-radius",
    "border-bottom-right-radius",
    "border-bottom-left-radius",
    "background-color",
    "background-image",
    "background-position",
    "background-size",
    "background-repeat",
    "box-shadow",
    "opacity",
    "visibility",
    "position",
    "top",
    "right",
    "bottom",
    "left",
    "inset-inline-start",
    "inset-inline-end",
    "z-index",
    "transform",
    "transform-origin",
    "overflow-x",
    "overflow-y",
    "float",
    "clear",
    "flex-grow",
    "flex-shrink",
    "flex-basis",
    "order",
    "align-self",
    "justify-self",
    "grid-column-start",
    "grid-column-end",
    "grid-row-start",
    "grid-row-end"
  ];

  function snapshot() {
    return {
      status: state.status,
      mode: state.mode,
      total: state.total,
      completed: state.completed,
      cached: state.cached,
      error: state.error,
      runId: state.runId,
      pageUrl: location.href,
      autoTranslate: state.autoTranslate,
      updatedAt: state.updatedAt
    };
  }

  function updateState(values) {
    Object.assign(state, values, { updatedAt: Date.now(), pageUrl: location.href });
  }

  function sendProgress() {
    const message = {
      type: "DEERWEBTRANSLATOR_PROGRESS",
      state: snapshot()
    };
    chrome.runtime.sendMessage(message).catch(() => {
      // The popup is often closed while a translation continues.
    });
  }

  function isCurrentRun(run) {
    return Boolean(run && activeRun === run && !run.cancelled);
  }

  function isVisible(element) {
    if (!element || !element.isConnected) {
      return false;
    }
    const hiddenOnlyByTranslator = element.classList.contains(DT.ORIGINAL_HIDDEN_CLASS);
    if (!hiddenOnlyByTranslator && element.getClientRects && element.getClientRects().length === 0) {
      return false;
    }
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      if (current.matches("[hidden], [aria-hidden=\"true\"]")) {
        return false;
      }
      const style = getComputedStyle(current);
      const translatorHidesCurrent = current === element
        && current.classList.contains(DT.ORIGINAL_HIDDEN_CLASS);
      if ((!translatorHidesCurrent && style.display === "none")
        || style.visibility === "hidden"
        || style.visibility === "collapse"
        || style.contentVisibility === "hidden") {
        return false;
      }
      if (style.opacity === "0") {
        return false;
      }
      current = current.parentElement;
    }
    return true;
  }

  function isExcluded(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return true;
    }
    if (element.matches(DT.EXCLUDED_SELECTOR)) {
      return true;
    }
    let current = element.parentElement;
    while (current) {
      if (current.matches(DT.EXCLUDED_SELECTOR)) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  function cloneWithoutExcludedContent(element) {
    const clone = element.cloneNode(true);
    if (clone.matches && clone.matches(DT.EXCLUDED_SELECTOR)) {
      return null;
    }
    clone.querySelectorAll(DT.EXCLUDED_SELECTOR).forEach((excluded) => excluded.remove());
    // Display-mode classes belong to the extension, not the source page.
    // Remove them from the detached clone so innerText continues to represent
    // the original visible content after the live source node is hidden.
    clone.classList.remove(DT.ORIGINAL_HIDDEN_CLASS, DT.CELL_ORIGINAL_HIDDEN_CLASS);
    clone.querySelectorAll(`.${DT.ORIGINAL_HIDDEN_CLASS}, .${DT.CELL_ORIGINAL_HIDDEN_CLASS}`)
      .forEach((hidden) => hidden.classList.remove(DT.ORIGINAL_HIDDEN_CLASS, DT.CELL_ORIGINAL_HIDDEN_CLASS));
    return clone;
  }

  function getReadableText(element) {
    const clone = cloneWithoutExcludedContent(element);
    if (!clone) {
      return "";
    }
    const raw = typeof clone.innerText === "string" ? clone.innerText : clone.textContent;
    return DT.normalizeText(raw);
  }

  function chooseReadableRoot() {
    // Chrome's page translation covers visible interface text outside the
    // article too: navigation, sidebars and footers. Scan the complete body;
    // viewport prioritization still sends what the user is reading first.
    return document.body || null;
  }

  function hasCandidateAncestor(element) {
    let current = element.parentElement;
    while (current) {
      if (current.matches && current.matches(DT.EXTRACTABLE_SELECTOR)) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  function collectCandidateElements(root) {
    if (!root || !root.querySelectorAll) {
      return [];
    }
    const candidates = [];
    if (root.matches && root.matches(DT.EXTRACTABLE_SELECTOR)) {
      candidates.push(root);
    }
    candidates.push(...Array.from(root.querySelectorAll(DT.EXTRACTABLE_SELECTOR)));
    const readableCandidates = [];
    const viewportHeight = global.innerHeight || document.documentElement.clientHeight || 0;
    candidates.forEach((element, domOrder) => {
      if (isExcluded(element) || !isVisible(element) || hasCandidateAncestor(element)) {
        return;
      }
      const text = getReadableText(element);
      if (text.length < 2 || !DT.hasLetters(text)) {
        return;
      }
      const rect = element.getBoundingClientRect();
      const inViewport = rect.bottom >= 0 && rect.top <= viewportHeight;
      const viewportPriority = inViewport
        ? Math.max(0, rect.top)
        : rect.top > viewportHeight
          ? 1000000 + rect.top
          : 2000000 + Math.abs(rect.bottom);
      readableCandidates.push({ element, text, viewportPriority, domOrder });
    });
    return readableCandidates
      .sort((left, right) => left.viewportPriority - right.viewportPriority || left.domOrder - right.domOrder);
  }

  function getUniqueId(element, usedIds) {
    const existing = element.getAttribute(DT.ORIGINAL_ID_ATTRIBUTE);
    if (existing && !usedIds.has(existing)) {
      usedIds.add(existing);
      return existing;
    }

    let generated;
    do {
      idCounter += 1;
      generated = DT.createId(pageToken, idCounter);
    } while (usedIds.has(generated));
    element.setAttribute(DT.ORIGINAL_ID_ATTRIBUTE, generated);
    usedIds.add(generated);
    return generated;
  }

  function describeContext(element) {
    const regionElement = element.closest("main, article, nav, header, footer, aside, [role]");
    let region = "body";
    if (regionElement) {
      region = regionElement.getAttribute("role") || regionElement.tagName.toLowerCase();
    }
    const href = element.matches("a[href]") ? element.getAttribute("href") || "" : "";
    let linkKind = "";
    if (href) {
      linkKind = href.startsWith("#") ? "fragment"
        : href.startsWith("mailto:") ? "email"
          : href.startsWith("javascript:") ? "script"
            : "navigation";
    }
    return {
      tag: element.tagName.toLowerCase(),
      region,
      isLink: Boolean(href),
      linkKind
    };
  }

  async function collectRecords(root, run) {
    const candidates = collectCandidateElements(root);
    const records = [];
    for (const candidate of candidates) {
      const { element, text } = candidate;
      const protocol = codec.serialize(element);

      const previousRecord = run.recordsByNode.get(element);
      if (previousRecord) {
        const translationStillExists = previousRecord.translation && previousRecord.translation.isConnected;
        if (previousRecord.text === text && previousRecord.protocol.text === protocol.text
          && previousRecord.protocol.identity === protocol.identity
          && (translationStillExists || !previousRecord.translation)) {
          continue;
        }
        // A page can edit or remove the translation element independently of
        // the source node. Drop only our own stale record so the new text can
        // be translated again without touching the page's original DOM.
        if (previousRecord.translation && previousRecord.translation.isConnected) {
          previousRecord.translation.remove();
        }
        element.classList.remove(DT.ORIGINAL_HIDDEN_CLASS, DT.CELL_ORIGINAL_HIDDEN_CLASS);
        run.knownNodes.delete(element);
        run.recordsById.delete(previousRecord.id);
        run.recordsByNode.delete(element);
        run.usedIds.delete(previousRecord.id);
      } else if (run.knownNodes.has(element)) {
        // Defensive cleanup for a record that was removed while an earlier
        // request was resolving.
        run.knownNodes.delete(element);
      }

      const id = getUniqueId(element, run.usedIds);
      const context = describeContext(element);
      const hash = await DT.sha256Hex(protocol.text + "\n" + protocol.identity + "\n" + JSON.stringify(context));
      const record = { id, node: element, text, hash, protocol, context, short: codec.shortLabel(protocol.plainText) };
      run.knownNodes.add(element);
      run.recordsById.set(id, record);
      run.recordsByNode.set(element, record);
      records.push(record);
    }
    return records;
  }

  function splitIntoBatches(records) {
    const batches = [];
    let current = [];
    let currentCharacters = 0;

    for (const record of records) {
      const recordCharacters = record.protocol.text.length + record.id.length + 48;
      const wouldExceedCharacters = current.length > 0
        && currentCharacters + recordCharacters > DT.MAX_BATCH_CHARS;
      const wouldExceedItems = current.length >= DT.MAX_BATCH_ITEMS;
      if (wouldExceedCharacters || wouldExceedItems) {
        batches.push(current);
        current = [];
        currentCharacters = 0;
      }
      current.push(record);
      currentCharacters += recordCharacters;
    }
    if (current.length > 0) {
      batches.push(current);
    }
    return batches;
  }

  function removeTranslationElements() {
    document.querySelectorAll(`.${DT.TRANSLATION_CLASS}`).forEach((element) => element.remove());
    document.querySelectorAll(`.${DT.ORIGINAL_HIDDEN_CLASS}`).forEach((element) => {
      element.classList.remove(DT.ORIGINAL_HIDDEN_CLASS);
    });
    document.querySelectorAll(`.${DT.CELL_ORIGINAL_HIDDEN_CLASS}`).forEach((element) => {
      element.classList.remove(DT.CELL_ORIGINAL_HIDDEN_CLASS);
    });
  }

  function createTranslationElement(record) {
    const original = record.node;
    // Reuse the source element type so browser defaults and page tag selectors
    // continue to produce the same visual rhythm. Table cells are the one
    // exception because another td/th cannot legally be nested inside a cell.
    const translationTag = original.matches("td, th")
      ? "div"
      : original.tagName.toLowerCase();
    const translation = document.createElement(translationTag);
    translation.className = DT.TRANSLATION_CLASS;
    translation.setAttribute(DT.TRANSLATION_FOR_ATTRIBUTE, record.id);
    translation.setAttribute("dir", "auto");
    if (original.matches("a[href]")) codec.copyLink(original, translation);

    // A table cell cannot legally contain a sibling div in the table row. Put
    // the independent translation element inside the cell instead; the source
    // text itself is never assigned or rewritten.
    if (original.matches("td, th")) {
      original.appendChild(translation);
    } else if (original.parentNode) {
      original.parentNode.insertBefore(translation, original.nextSibling);
    }
    return translation;
  }

  function findOrCreateTranslation(record) {
    if (!record.node || !record.node.isConnected) {
      return null;
    }
    const existing = Array.from(record.node.children || []).find((child) =>
      child.classList && child.classList.contains(DT.TRANSLATION_CLASS)
    );
    if (existing) {
      existing.setAttribute(DT.TRANSLATION_FOR_ATTRIBUTE, record.id);
      return existing;
    }
    const sibling = record.node.nextElementSibling;
    if (sibling && sibling.classList && sibling.classList.contains(DT.TRANSLATION_CLASS)
      && sibling.getAttribute(DT.TRANSLATION_FOR_ATTRIBUTE) === record.id) {
      return sibling;
    }
    return createTranslationElement(record);
  }

  function captureReplacementStyles(record) {
    if (!record || !record.node || !record.node.isConnected) {
      return;
    }
    const computed = getComputedStyle(record.node);
    const isCell = record.node.matches("td, th");
    const styles = {};
    replacementStyleProperties.forEach((property) => {
      // A nested div must not inherit table-cell display semantics, but it
      // should inherit all typography and visual treatment of the cell.
      if (isCell && property === "display") {
        return;
      }
      const value = computed.getPropertyValue(property);
      if (value) {
        styles[property] = value;
      }
    });
    record.replacementStyles = styles;
  }

  function applyReplacementStyles(record) {
    const styles = record.replacementStyles || {};
    Object.entries(styles).forEach(([property, value]) => {
      record.translation.style.setProperty(property, value, "important");
    });
  }

  function clearReplacementStyles(record) {
    replacementStyleProperties.forEach((property) => {
      record.translation.style.removeProperty(property);
    });
  }

  function applyModeToRecord(record) {
    if (!record || !record.node || !record.translation) {
      return;
    }
    const isCell = record.node.matches("td, th");
    const onlyTranslation = state.mode === DT.DISPLAY_MODES.TRANSLATION;
    const onlyOriginal = state.mode === DT.DISPLAY_MODES.ORIGINAL;
    const compact = state.mode === DT.DISPLAY_MODES.BILINGUAL && record.short;
    const replacement = onlyTranslation || compact;

    if (replacement && !record.replacementStyles) {
      captureReplacementStyles(record);
    }
    if (replacement) {
      applyReplacementStyles(record);
    } else {
      clearReplacementStyles(record);
    }
    record.node.classList.toggle(DT.ORIGINAL_HIDDEN_CLASS, replacement && !isCell);
    record.node.classList.toggle(DT.CELL_ORIGINAL_HIDDEN_CLASS, replacement && isCell);
    record.translation.classList.toggle(DT.TRANSLATION_HIDDEN_CLASS, onlyOriginal);
    record.translation.classList.toggle(DT.TRANSLATION_REPLACEMENT_CLASS, replacement);
    record.translation.classList.toggle("deerwebtranslator-compact", compact);
    if (record.translatedText !== undefined) {
      const translated = codec.render(record.protocol, record.translatedText);
      if (compact) {
        // Glosses such as API（中文） become API｜中文 without repetition.
        const walker = document.createTreeWalker(translated, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          walker.currentNode.data = codec.labelTranslation(record.protocol.plainText, walker.currentNode.data);
        }
        record.translation.replaceChildren(codec.render(record.protocol, record.protocol.text),
          document.createTextNode("｜"), translated);
      } else {
        record.translation.replaceChildren(translated);
      }
    }
    // Inline display also wins over inherited list-item and site rules.
    if (onlyOriginal) {
      record.translation.style.setProperty("display", "none", "important");
    }
  }

  function applyTranslation(record, translatedText) {
    if (!record || !record.node || !record.node.isConnected) {
      return false;
    }
    // If a page script changed the source while the request was in flight,
    // never attach a stale translation to the new text.
    const currentProtocol = codec.serialize(record.node);
    if (getReadableText(record.node) !== record.text || currentProtocol.text !== record.protocol.text
      || currentProtocol.identity !== record.protocol.identity) {
      return false;
    }
    const decisionText = String(translatedText);
    codec.validate(record.protocol.text, decisionText);
    // The agent expresses a KEEP decision by returning the protected source
    // exactly unchanged. Leave the original DOM alone instead of displaying a
    // duplicate source string as a fake translation.
    if (decisionText === record.protocol.text) {
      if (record.translation && record.translation.isConnected) {
        record.translation.remove();
      }
      record.translation = null;
      record.translatedText = decisionText;
      record.agentDecision = "keep";
      return true;
    }
    if (!record.replacementStyles) {
      // Capture before inserting the sibling; adjacent/last-child selectors
      // can otherwise change the source element's computed style.
      captureReplacementStyles(record);
    }
    const translation = findOrCreateTranslation(record);
    if (!translation) {
      return false;
    }
    // Write only to the new translation node; the original node is never
    // assigned a textContent value.
    record.translatedText = decisionText;
    record.agentDecision = "translate";
    record.translation = translation;
    applyModeToRecord(record);
    return true;
  }

  function applyTranslations(run, translations) {
    let applied = 0;
    let skipped = 0;
    for (const translation of translations) {
      const record = run.recordsById.get(translation.id);
      if (record && applyTranslation(record, translation.text)) {
        applied += 1;
      } else if (record) {
        // The node may have been removed or its text may have changed. Do not
        // leave it in knownNodes, otherwise dynamic-page support could never
        // retry the new source text.
        run.knownNodes.delete(record.node);
        run.recordsById.delete(record.id);
        run.recordsByNode.delete(record.node);
        run.usedIds.delete(record.id);
        skipped += 1;
      }
    }
    return { applied, skipped };
  }

  async function translateRecords(run, records) {
    if (!isCurrentRun(run) || records.length === 0) {
      return true;
    }
    if (run.translationInProgress) {
      run.pendingDynamicScan = true;
      return false;
    }
    run.translationInProgress = true;
    try {
      const batches = splitIntoBatches(records);
      let nextBatchIndex = 0;

      async function translateOneBatch(batch) {
        if (!isCurrentRun(run)) {
          return;
        }
        const result = await chrome.runtime.sendMessage({
          type: "DEERWEBTRANSLATOR_TRANSLATE_BATCH",
          runId: run.id,
          pageUrl: location.href,
          pageTitle: document.title,
          items: batch.map((record) => ({
            id: record.id,
            text: record.protocol.text,
            hash: record.hash,
            context: record.context
          }))
        });
        if (!isCurrentRun(run)) {
          return;
        }
        if (!result || !result.ok || !Array.isArray(result.translations)) {
          const error = result && result.error ? result.error : { message: "翻译请求失败。" };
          throw new Error(error.message || "翻译请求失败。");
        }
        const expectedIds = new Set(batch.map((record) => record.id));
        const receivedIds = new Set(result.translations.map((translation) => translation && translation.id));
        if (result.translations.length !== batch.length || receivedIds.size !== expectedIds.size
          || [...expectedIds].some((id) => !receivedIds.has(id))) {
          throw new Error("翻译结果与原文段落无法一一对应。");
        }
        const application = applyTranslations(run, result.translations);
        updateState({
          total: Math.max(state.completed + application.applied, state.total - application.skipped),
          completed: state.completed + application.applied,
          cached: state.cached + Number(result.cachedCount || 0),
          error: ""
        });
        sendProgress();
      }

      async function translationWorker() {
        while (isCurrentRun(run)) {
          const batchIndex = nextBatchIndex;
          nextBatchIndex += 1;
          if (batchIndex >= batches.length) {
            return;
          }
          await translateOneBatch(batches[batchIndex]);
        }
      }

      const workerCount = Math.min(DT.MAX_CONCURRENT_BATCHES, batches.length);
      await Promise.all(Array.from({ length: workerCount }, () => translationWorker()));
      return isCurrentRun(run);
    } finally {
      run.translationInProgress = false;
      if (run.pendingDynamicScan && isCurrentRun(run)) {
        run.pendingDynamicScan = false;
        scheduleDynamicTranslation();
      }
    }
  }

  async function startTranslation(rawSettings) {
    const settings = DT.normalizePublicSettings(rawSettings);
    if (activeRun) {
      activeRun.cancelled = true;
      void chrome.runtime.sendMessage({
        type: "DEERWEBTRANSLATOR_CANCEL_TRANSLATION",
        runId: activeRun.id
      }).catch(() => {});
    }

    removeTranslationElements();
    const run = {
      id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      root: chooseReadableRoot(),
      cancelled: false,
      // A Set is intentional: if the page changes a source node while an API
      // request is in flight, the node must be removable so a later mutation
      // scan can pick up its new text.
      knownNodes: new Set(),
      usedIds: new Set(),
      recordsById: new Map(),
      recordsByNode: new Map(),
      translationInProgress: false,
      pendingDynamicScan: false
    };
    activeRun = run;
    updateState({
      status: "translating",
      mode: settings.displayMode,
      total: 0,
      completed: 0,
      cached: 0,
      error: "",
      runId: run.id,
      autoTranslate: true
    });
    applyModeToAllRecords(run);
    sendProgress();

    try {
      if (!run.root) {
        throw new Error("当前页面没有可读取的正文。");
      }
      const records = await collectRecords(run.root, run);
      if (!isCurrentRun(run)) {
        return;
      }
      updateState({ total: records.length });
      sendProgress();
      if (records.length === 0) {
        updateState({ status: "completed" });
        sendProgress();
        return;
      }
      await translateRecords(run, records);
      if (isCurrentRun(run) && state.status === "translating") {
        updateState({ status: "completed" });
        sendProgress();
      }
    } catch (error) {
      if (!isCurrentRun(run)) {
        return;
      }
      if (error && error.message === "翻译已停止。") {
        updateState({ status: "stopped" });
      } else {
        updateState({ status: "error", error: error && error.message ? error.message : "翻译失败。" });
        run.cancelled = true;
      }
      sendProgress();
    }
  }

  function applyModeToAllRecords(run) {
    if (!run || !run.recordsById) {
      return;
    }
    for (const record of run.recordsById.values()) {
      applyModeToRecord(record);
    }
  }

  function stopTranslation() {
    if (activeRun) {
      activeRun.cancelled = true;
      void chrome.runtime.sendMessage({
        type: "DEERWEBTRANSLATOR_CANCEL_TRANSLATION",
        runId: activeRun.id
      }).catch(() => {});
    }
    updateState({ status: "stopped", autoTranslate: false, error: "" });
    sendProgress();
  }

  function setDisplayMode(mode) {
    if (!Object.values(DT.DISPLAY_MODES).includes(mode)) {
      return;
    }
    state.mode = mode;
    if (activeRun) {
      for (const record of activeRun.recordsById.values()) {
        applyModeToRecord(record);
      }
    }
    updateState({ mode });
    sendProgress();
  }

  async function translateNewContent() {
    if (!activeRun || !state.autoTranslate || (state.status !== "completed" && state.status !== "translating")) {
      return;
    }
    const run = activeRun;
    if (run.translationInProgress) {
      run.pendingDynamicScan = true;
      return;
    }
    const root = chooseReadableRoot();
    if (root && root !== run.root) {
      run.root = root;
    }
    const records = await collectRecords(run.root, run);
    if (!isCurrentRun(run) || records.length === 0) {
      return;
    }
    updateState({ status: "translating", total: state.total + records.length, error: "" });
    sendProgress();
    try {
      const processed = await translateRecords(run, records);
      if (processed && isCurrentRun(run)) {
        updateState({ status: "completed" });
        sendProgress();
      }
    } catch (error) {
      if (isCurrentRun(run)) {
        updateState({ status: "error", error: error && error.message ? error.message : "动态内容翻译失败。" });
        run.cancelled = true;
        sendProgress();
      }
    }
  }

  function scheduleDynamicTranslation() {
    if (!state.autoTranslate || (state.status !== "translating" && state.status !== "completed")) {
      return;
    }
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      mutationTimer = null;
      translateNewContent().catch(() => {});
    }, 900);
  }

  function ensureMutationObserver() {
    if (!document.body || observedBody === document.body) {
      return;
    }
    if (mutationObserver) {
      mutationObserver.disconnect();
    }
    observedBody = document.body;
    mutationObserver = new MutationObserver((mutations) => {
      const onlyOurTranslations = mutations.every((mutation) => {
        const target = mutation.target.nodeType === Node.ELEMENT_NODE
          ? mutation.target : mutation.target.parentElement;
        if (target?.closest(`.${DT.TRANSLATION_CLASS}`)) return true;
        if (mutation.type === "attributes") return false;
        if (mutation.type === "characterData") {
          return false;
        }
        const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
        return nodes.length === 0 || nodes.every((node) =>
          node.nodeType === Node.ELEMENT_NODE && node.classList.contains(DT.TRANSLATION_CLASS)
        );
      });
      if (!onlyOurTranslations) {
        scheduleDynamicTranslation();
      }
    });
    mutationObserver.observe(document.body, {
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["href", "target", "rel", "download"],
      subtree: true
    });
  }

  function checkForSpaNavigation() {
    if (state.pageUrl === location.href) {
      ensureMutationObserver();
      return;
    }
    const shouldAutoTranslate = state.autoTranslate;
    if (activeRun) {
      activeRun.cancelled = true;
      void chrome.runtime.sendMessage({
        type: "DEERWEBTRANSLATOR_CANCEL_TRANSLATION",
        runId: activeRun.id
      }).catch(() => {});
    }
    clearTimeout(mutationTimer);
    removeTranslationElements();
    activeRun = null;
    updateState({
      status: "idle",
      total: 0,
      completed: 0,
      cached: 0,
      error: "",
      runId: "",
      autoTranslate: shouldAutoTranslate
    });
    sendProgress();
    if (shouldAutoTranslate) {
      setTimeout(() => {
        if (state.autoTranslate && state.pageUrl === location.href) {
          startTranslation({ displayMode: state.mode }).catch(() => {});
        }
      }, 700);
    }
  }

  function handleMessage(message, sendResponse) {
    if (!message || typeof message.type !== "string") {
      return false;
    }
    if (message.type === "DEERWEBTRANSLATOR_GET_STATE") {
      sendResponse({ ok: true, state: snapshot() });
      return false;
    }
    if (message.type === "DEERWEBTRANSLATOR_STOP_TRANSLATION") {
      stopTranslation();
      sendResponse({ ok: true, state: snapshot() });
      return false;
    }
    if (message.type === "DEERWEBTRANSLATOR_SET_DISPLAY_MODE") {
      setDisplayMode(message.mode);
      sendResponse({ ok: true, state: snapshot() });
      return false;
    }
    if (message.type === "DEERWEBTRANSLATOR_START_TRANSLATION") {
      startTranslation(message.settings || {})
        .catch((error) => {
          updateState({ status: "error", error: error && error.message ? error.message : "翻译启动失败。" });
          sendProgress();
        });
      sendResponse({ ok: true, state: snapshot() });
      return true;
    }
    return false;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => handleMessage(message, sendResponse));

  ensureMutationObserver();
  locationTimer = setInterval(checkForSpaNavigation, 1000);
  // Keep the interval bounded to the page lifetime without touching site timers.
  if (locationTimer && typeof locationTimer.unref === "function") {
    locationTimer.unref();
  }
})(globalThis);
