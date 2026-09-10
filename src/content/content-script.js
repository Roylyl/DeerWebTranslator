(function (global) {
  "use strict";
  if (global.__DEERWEBTRANSLATOR_CONTENT_SCRIPT_LOADED__) return;
  global.__DEERWEBTRANSLATOR_CONTENT_SCRIPT_LOADED__ = true;
  const DT = global.DeerWebTranslator;
  const codec = global.DeerDOMCodec;
  const excluded = DT.EXCLUDED_SELECTOR + ",kbd,samp,select,option,math,[contenteditable]:not([contenteditable=false])";
  const blocks = "p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,figcaption,button,summary,label,a";
  const records = new Set();
  const byText = new WeakMap();
  let run = null, timer = null, counter = 0, scanning = false, pendingScan = false;
  let pageUrl = location.href;
  let settings = DT.normalizePublicSettings({});
  const state = { status: "idle", mode: DT.DEFAULT_DISPLAY_MODE, total: 0, completed: 0,
    cached: 0, error: "", autoTranslate: false, runId: "", pageUrl, updatedAt: Date.now() };
  const snapshot = () => ({ ...state, pageUrl: location.href });
  const current = (task) => run === task && !task.cancelled;
  function publish() {
    state.updatedAt = Date.now();
    chrome.runtime.sendMessage({ type: "DEERWEBTRANSLATOR_PROGRESS", state: snapshot() }).catch(() => {});
  }
  function visible(element) {
    if (!element?.isConnected || element.closest(excluded) || !element.getClientRects().length) return false;
    for (let node = element; node; node = node.parentElement) {
      const css = getComputedStyle(node);
      if (css.display === "none" || /hidden|collapse/.test(css.visibility)
        || css.contentVisibility === "hidden" || css.opacity === "0") return false;
    }
    return true;
  }
  function nearby(element) {
    const rect = element.getBoundingClientRect();
    return rect.bottom >= -250 && rect.top <= innerHeight + 500
      && rect.right >= 0 && rect.left <= innerWidth;
  }
  function eligible(text) {
    const value = text.trim();
    if (!/\p{L}/u.test(value) || value.includes("[[DWT_")) return false;
    // Only unambiguous non-prose patterns are filtered locally.
    if (/^(?:(?:https?|ftp):\/\/|www\.)\S+$/i.test(value)
      || /^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(value)
      || /^(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|ai|cn)(?:\/\S*)?$/i.test(value)
      || /^(?:[./~]|[A-Z]:\\)\S+$/.test(value)
      || /^[0-9a-f]{7,40}$/i.test(value)
      || /^v?\d+(?:\.\d+)+(?:[-+][\w.-]+)?$/.test(value)) return false;
    if (/Chinese|中文|^zh\b/i.test(settings.targetLanguage)
      && /\p{Script=Han}/u.test(value) && !/\p{Script=Latin}|\p{Script=Cyrillic}/u.test(value)) return false;
    return true;
  }
  function owner(element) {
    const closest = element.closest(blocks);
    // Keep UI controls as units; collect inline links with their prose paragraph.
    if (closest?.matches("a") && closest.closest("p,h1,h2,h3,h4,h5,h6,blockquote")) {
      return closest.closest("p,h1,h2,h3,h4,h5,h6,blockquote");
    }
    if (closest) return closest;
    let node = element;
    while (node.parentElement && node !== document.body
      && getComputedStyle(node).display === "inline") node = node.parentElement;
    return node;
  }
  function contextFor(element) {
    const region = element.closest("main,article,nav,header,footer,aside");
    const ui = Boolean(element.closest("button,summary,label,nav,header,footer,[role=menu],[role=tablist]"));
    return { tag: element.localName, region: ui ? "ui" : region?.localName || "body",
      isLink: element.matches("a"), linkKind: "" };
  }
  function removeExtra(record) {
    record.extra?.remove();
    record.extra = null;
  }
  function intact(record) {
    return record.slots.every((slot) => slot.node.isConnected && slot.node.data === slot.written
      && slot.node.parentElement === slot.parent && owner(slot.parent) === record.element);
  }
  function restore(record) {
    removeExtra(record);
    for (const slot of record.slots) {
      // Never overwrite a newer site update.
      if (slot.node.data === slot.written) slot.node.data = slot.original;
      if (byText.get(slot.node) === record) byText.delete(slot.node);
    }
    records.delete(record);
  }
  function render(record) {
    if (!record.output || !intact(record)) return;
    removeExtra(record);
    const original = state.mode === "original";
    const bilingual = state.mode === "bilingual";
    const prose = bilingual && !record.short && record.context.region !== "ui"
      && record.element.matches("p,h1,h2,h3,h4,h5,h6,blockquote,figcaption");
    record.slots.forEach((slot, index) => {
      const translated = record.output[index];
      const trimmed = slot.original.trim();
      let value = original || prose ? slot.original : translated;
      if (bilingual && !prose && trimmed !== translated.trim()) {
        value = trimmed + "｜" + codec.labelTranslation(trimmed, translated);
      }
      // Text.data keeps the actual element, attributes, event listeners,
      // pseudo-elements and CSS selectors in place. Never assign innerHTML or
      // element.textContent. Whitespace around inline nodes is retained.
      if (!original && !prose) {
        value = (slot.original.match(/^\s*/)?.[0] || "") + value.trim()
          + (slot.original.match(/\s*$/)?.[0] || "");
      }
      slot.written = value;
      if (slot.node.data !== value) slot.node.data = value;
    });
    if (prose && record.output.some((value, index) => value.trim() !== record.slots[index].original.trim())) {
      const extra = document.createElement("div");
      extra.className = DT.TRANSLATION_CLASS;
      extra.lang = /Chinese|中文|^zh\b/i.test(settings.targetLanguage) ? "zh" : "";
      const output = new Map(record.slots.map((slot, index) => [slot.node, record.output[index]]));
      function copy(node) {
        if (node.nodeType === 3) return document.createTextNode(output.get(node) ?? node.data);
        if (node.nodeType !== 1 || node.matches("script,style,svg,input,textarea,button")
          || !visible(node)) return document.createTextNode("");
        const tag = /^(A|STRONG|B|EM|I|CODE|KBD|SAMP|BR|SUB|SUP)$/.test(node.tagName) ? node.localName : "span";
        const clone = document.createElement(tag);
        if (tag === "a") codec.copyLink(node, clone);
        for (const child of node.childNodes) clone.append(copy(child));
        return clone;
      }
      for (const child of record.element.childNodes) extra.append(copy(child));
      record.element.after(extra);
      record.extra = extra;
    }
  }
  function sourceFor(slots) {
    if (slots.length === 1) return slots[0].original.trim();
    return slots.map((slot, index) => "[[DWT_OPEN_" + index + "]]"
      + slot.original.trim() + "[[DWT_CLOSE_" + index + "]]").join("");
  }
  function decode(record, text) {
    codec.validate(record.text, text);
    if (record.slots.length === 1) return [text];
    const matches = [...text.matchAll(/\[\[DWT_OPEN_(\d+)\]\]([\s\S]*?)\[\[DWT_CLOSE_\1\]\]/g)];
    if (matches.length !== record.slots.length
      || text.replace(/\[\[DWT_OPEN_(\d+)\]\][\s\S]*?\[\[DWT_CLOSE_\1\]\]/g, "").trim()) {
      throw new Error("译文文字槽位无效，已保留原文。");
    }
    const output = [];
    matches.forEach((match, index) => {
      if (Number(match[1]) !== index || !match[2].trim()) throw new Error("译文改变了文字顺序。");
      output[index] = match[2];
    });
    return output;
  }
  async function collect(task) {
    for (const record of records) if (!intact(record)) restore(record);
    const groups = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (byText.has(node) || !eligible(node.data)) continue;
      const parent = node.parentElement;
      if (!nearby(parent) || !visible(parent)) continue;
      const element = owner(parent);
      if (!groups.has(element)) groups.set(element, []);
      groups.get(element).push({ node, parent, original: node.data, written: node.data });
    }
    const added = [];
    for (const [element, slots] of groups) {
      // A very large individual Text node is split only in the wire request,
      // never into DOM elements.
      const record = { element, slots, text: sourceFor(slots), context: contextFor(element),
        id: String(++counter), short: codec.shortLabel(slots.map((s) => s.original).join("")) };
      record.hash = await DT.sha256Hex(record.text + JSON.stringify(record.context));
      if (!current(task)) return [];
      slots.forEach((slot) => byText.set(slot.node, record));
      records.add(record);
      added.push(record);
    }
    return added.sort((a, b) => Math.abs(a.element.getBoundingClientRect().top)
      - Math.abs(b.element.getBoundingClientRect().top));
  }
  function wireItems(record) {
    if (record.text.length <= 3000) return [{ id: record.id, text: record.text, hash: record.hash, context: record.context }];
    // Partition long text at sentence/space boundaries, keeping exact source
    // separators locally. Each slot is translated in order and reassembled.
    record.parts = [];
    record.slots.forEach((slot, slotIndex) => {
      let remaining = slot.original;
      while (remaining.length) {
        let end = Math.min(1800, remaining.length);
        if (end < remaining.length) {
          const prefix = remaining.slice(0, end);
          const boundary = Math.max(prefix.lastIndexOf(". "), prefix.lastIndexOf("\n"), prefix.lastIndexOf(" "));
          if (boundary > 900) end = boundary + 1;
          if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
        }
        const text = remaining.slice(0, end);
        remaining = remaining.slice(end);
        record.parts.push({ id: record.id + "." + record.parts.length, text,
          hash: record.hash + "." + record.parts.length, context: record.context, slotIndex });
      }
    });
    return record.parts;
  }
  async function scan() {
    if (!run || !state.autoTranslate || state.mode === "original") return;
    if (scanning) { pendingScan = true; return; }
    scanning = true;
    const task = run;
    try {
      const added = await collect(task);
      if (!current(task)) return;
      state.total += added.length;
      const queue = added.flatMap(wireItems);
      const results = new Map();
      // Coalesce repeated labels/paragraphs before batching. IDs remain local.
      const unique = new Map();
      queue.forEach((item) => {
        const key = JSON.stringify([item.text, item.context]);
        if (!unique.has(key)) unique.set(key, []);
        unique.get(key).push(item);
      });
      const batches = [];
      let batch = [], size = 0;
      for (const group of unique.values()) {
        const item = group[0];
        const limit = batches.length ? DT.MAX_BATCH_CHARS : 2200;
        if (batch.length && (size + item.text.length > limit || batch.length >= DT.MAX_BATCH_ITEMS)) {
          batches.push(batch); batch = []; size = 0;
        }
        batch.push(group); size += item.text.length;
      }
      if (batch.length) batches.push(batch);
      if (batches.length) { state.status = "translating"; publish(); }
      let next = 0;
      const workers = async () => {
        while (current(task) && state.mode !== "original" && next < batches.length) {
          const groups = batches[next++];
          const response = await chrome.runtime.sendMessage({
            type: "DEERWEBTRANSLATOR_TRANSLATE_BATCH", runId: task.id, pageUrl,
            pageTitle: document.title, items: groups.map((group) => group[0])
          });
          if (!current(task)) return;
          if (!response?.ok) throw new Error(response?.error?.message || "翻译请求失败。");
          const expected = new Set(groups.map((group) => group[0].id));
          if (!Array.isArray(response.translations) || response.translations.length !== groups.length
            || new Set(response.translations.map((item) => item.id)).size !== expected.size
            || response.translations.some((item) => !expected.has(item.id) || typeof item.text !== "string")) {
            throw new Error("翻译结果 ID 与原文不匹配。");
          }
          response.translations.forEach((translation) => {
            const group = groups.find((value) => value[0].id === translation.id);
            group.forEach((item) => results.set(item.id, translation.text));
          });
          state.cached += response.cachedCount || 0;
          for (const record of added) {
            if (record.output || !intact(record)) continue;
            if (record.parts) {
              if (!record.parts.every((part) => results.has(part.id))) continue;
              record.output = record.slots.map(() => "");
              for (const part of record.parts) {
                const output = results.get(part.id);
                codec.validate(part.text, output);
                record.output[part.slotIndex] += (part.text.match(/^\s*/)?.[0] || "")
                  + output.trim() + (part.text.match(/\s*$/)?.[0] || "");
              }
            } else {
              if (!results.has(record.id)) continue;
              record.output = decode(record, results.get(record.id));
            }
            render(record);
            state.completed++;
          }
          publish();
        }
      };
      await Promise.all(Array.from({ length: Math.min(DT.MAX_CONCURRENT_BATCHES, batches.length) }, workers));
      if (current(task)) { state.status = "completed"; publish(); }
    } catch (error) {
      if (current(task)) {
        state.status = "error"; state.error = error.message; state.autoTranslate = false;
        cancel(); publish();
      }
    } finally {
      // Unsent/failed records must be eligible for an explicit retry.
      for (const record of records) if (!record.output) {
        restore(record);
        state.total = Math.max(state.completed, state.total - 1);
      }
      if (run === task) publish();
      scanning = false;
      if (pendingScan) { pendingScan = false; schedule(); }
    }
  }
  function schedule() {
    if (!state.autoTranslate) return;
    clearTimeout(timer);
    timer = setTimeout(() => scan().catch(() => {}), 180);
  }
  function cancel() {
    if (run) {
      run.cancelled = true;
      chrome.runtime.sendMessage({ type: "DEERWEBTRANSLATOR_CANCEL_TRANSLATION", runId: run.id }).catch(() => {});
    }
  }
  function start(input) {
    cancel();
    for (const record of records) restore(record);
    settings = DT.normalizePublicSettings(input);
    pageUrl = location.href;
    run = { id: "run-" + Date.now() + "-" + Math.random().toString(36).slice(2), cancelled: false };
    Object.assign(state, { status: "translating", mode: settings.displayMode, total: 0,
      completed: 0, cached: 0, error: "", autoTranslate: true, runId: run.id, pageUrl });
    publish();
    scan().catch(() => {});
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    switch (message?.type) {
      case "DEERWEBTRANSLATOR_GET_STATE": break;
      case "DEERWEBTRANSLATOR_START_TRANSLATION": start(message.settings || settings); break;
      case "DEERWEBTRANSLATOR_STOP_TRANSLATION":
        cancel(); state.autoTranslate = false; state.status = "stopped"; publish(); break;
      case "DEERWEBTRANSLATOR_SET_DISPLAY_MODE":
        if (Object.values(DT.DISPLAY_MODES).includes(message.mode)) {
          state.mode = message.mode;
          for (const record of records) render(record);
          publish(); schedule();
        }
        break;
      default: return false;
    }
    respond({ ok: true, state: snapshot() });
    return false;
  });
  const observer = new MutationObserver((changes) => {
    const meaningful = changes.some((change) => {
      if (change.target.parentElement?.closest("." + DT.TRANSLATION_CLASS)) return false;
      if (change.type === "characterData") {
        const record = byText.get(change.target);
        return !record || !intact(record);
      }
      if (change.type === "childList") {
        return [...change.addedNodes, ...change.removedNodes].some((node) =>
          node.nodeType !== 1 || !node.classList.contains(DT.TRANSLATION_CLASS));
      }
      return true;
    });
    if (meaningful) schedule();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ["hidden", "aria-hidden", "class", "style", "open"] });
  document.addEventListener("scroll", schedule, { passive: true, capture: true });
  global.addEventListener("resize", schedule, { passive: true });
  setInterval(() => {
    if (pageUrl === location.href) return;
    const auto = state.autoTranslate;
    cancel();
    for (const record of records) restore(record);
    pageUrl = location.href;
    state.pageUrl = pageUrl;
    if (auto) start({ ...settings, displayMode: state.mode });
  }, 500);
})(globalThis);
