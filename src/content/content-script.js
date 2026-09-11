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
  let run = null, timer = null, counter = 0, index = null, progressTimer = null;
  let observer = null, navigationTimer = null, disposed = false;
  let pageUrl = location.href;
  let settings = DT.normalizePublicSettings({});
  const state = { status: "idle", mode: DT.DEFAULT_DISPLAY_MODE, total: 0, completed: 0,
    cached: 0, local: 0, failed: 0, overflow: 0, usage: {}, error: "", autoTranslate: false, runId: "", pageUrl, updatedAt: Date.now() };
  const snapshot = () => ({ ...state, pageUrl: location.href, diagnostics: index ? { ...index.metrics } : {} });
  const current = (task) => !disposed && run === task && !task.cancelled;
  function hasRuntime() {
    try { return Boolean(global.chrome?.runtime?.id && typeof global.chrome.runtime.sendMessage === "function"); }
    catch { return false; }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    state.autoTranslate = false; state.status = "stopped";
    state.error = "扩展连接已失效，请刷新网页后重试。";
    if (run) run.cancelled = true;
    clearTimeout(timer); clearTimeout(progressTimer); clearInterval(navigationTimer);
    timer = progressTimer = navigationTimer = null;
    observer?.disconnect(); index?.close();
    document.removeEventListener("scroll", schedule, true);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    global.removeEventListener("resize", schedule);
    // Removing a Chrome listener may itself throw once the context is gone.
    try { global.chrome?.runtime?.onMessage?.removeListener(onMessage); } catch {}
    // Drop only our own text/extra elements. Preserve newer site-authored text
    // so a fresh injection cannot mistake an orphaned translation for source.
    for (const record of [...records]) restore(record);
    run?.jobs.clear(); run?.batches.clear();
    run = null; index = null;
    global.__DEERWEBTRANSLATOR_CONTENT_SCRIPT_LOADED__ = false;
  }
  function ensureContext() {
    if (disposed) return false;
    if (hasRuntime()) return true;
    dispose(); return false;
  }
  async function sendToBackground(message) {
    if (!ensureContext()) throw new Error("Extension context invalidated.");
    try {
      // An async boundary catches BOTH a synchronous API throw and a rejected
      // Promise. sendMessage(...).catch(...) alone cannot catch the former.
      const response = await chrome.runtime.sendMessage(message);
      if (!ensureContext()) throw new Error("Extension context invalidated.");
      return response;
    } catch (error) {
      if (!hasRuntime() || /extension context invalidated/i.test(error?.message || String(error))) dispose();
      throw error;
    }
  }
  function publish() {
    if (disposed || progressTimer) return;
    progressTimer = setTimeout(() => {
      progressTimer = null;
      if (!ensureContext()) return;
      if (run && !run.cancelled) {
        const all = [...run.records];
        state.total = all.length;
        state.completed = all.filter((r) => r.output).length;
        state.failed = all.filter((r) => r.failed && !r.output).length;
        state.overflow = all.filter((r) => r.overflow).length;
        const working = run.active > 0 || [...run.jobs.values()].some((j) => j.status === "queued" && live(j));
        state.status = state.mode === "original" || document.hidden ? "paused"
          : working ? "translating" : state.failed ? "partial" : "completed";
        const reason = all.find((r) => r.failed && !r.output && r.error)?.error;
        state.error = state.failed ? (reason ? reason + " " : "") + "有 " + state.failed + " 段未完成，可重试失败部分。" : "";
      }
      state.updatedAt = Date.now();
      void sendToBackground({ type: "DEERWEBTRANSLATOR_PROGRESS", state: snapshot() }).catch(() => {});
    }, 40);
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
      && !/^(ja|ko)\b/i.test(document.documentElement.lang)
      && /\p{Script=Han}/u.test(value)
      && !/\p{Script=Latin}|\p{Script=Cyrillic}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(value)) return false;
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
      && !node.matches("div,section,article,main,nav,header,footer,aside")) node = node.parentElement;
    return node;
  }
  function contextFor(element) {
    const region = element.closest("main,article,nav,header,footer,aside");
    const ui = Boolean(element.closest("button,summary,label,nav,header,footer,[role=menu],[role=tablist]"));
    const heading = element.closest("section,article")?.querySelector("h1,h2,h3");
    let headingText = "";
    if (heading && visible(heading)) {
      const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
      let node;
      while (headingText.length < 96 && (node = walker.nextNode())) {
        if (!visible(node.parentElement)) continue;
        headingText += byText.get(node)?.slots.find((slot) => slot.node === node)?.original || node.data;
      }
    }
    return { tag: element.localName, region: ui ? "ui" : region?.localName || "body",
      heading: headingText.trim().slice(0, 96), isLink: element.matches("a"), linkKind: "" };
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
    if (record.tooltip && record.element.getAttribute("title") === record.tooltip) record.element.removeAttribute("title");
    for (const slot of record.slots) {
      // Never overwrite a newer site update.
      if (slot.node.data === slot.written) slot.node.data = slot.original;
      if (byText.get(slot.node) === record) byText.delete(slot.node);
    }
    records.delete(record);
    run?.records.delete(record);
  }
  function render(record) {
    if (!record.output || !intact(record)) return;
    removeExtra(record);
    if (record.tooltip && record.element.getAttribute("title") === record.tooltip) record.element.removeAttribute("title");
    record.tooltip = null; record.overflow = false;
    const control = record.context.region === "ui" && record.element.matches("button,a,summary,[role=button]");
    const beforeOverflow = control && record.element.scrollWidth > record.element.clientWidth + 2;
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
    if (control && !original && !beforeOverflow && record.element.clientWidth > 0
      && record.element.scrollWidth > record.element.clientWidth + 2) {
      for (const slot of record.slots) { slot.written = slot.original; slot.node.data = slot.original; }
      record.overflow = true;
      if (!record.element.hasAttribute("title")) {
        record.tooltip = record.output.join(" ").slice(0, 500);
        record.element.setAttribute("title", record.tooltip);
      }
    }
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

  function live(job) {
    return job.aliases.some(({ record, generation }) => generation === record.generation && records.has(record) && run?.records.has(record)
      && !record.output && intact(record));
  }
  function enqueue(record, force = false) {
    record.failed = false; record.error = "";
    record.generation = (record.generation || 0) + 1;
    record.results = new Map();
    record.work = wireItems(record);
    for (const item of record.work) {
      const key = JSON.stringify([item.text, item.context, force ? record.id + ":" + Date.now() : false]);
      let job = run.jobs.get(key);
      if (!job || job.status === "failed") {
        job = { key, item: { ...item, force }, aliases: [], status: "queued" };
        run.jobs.set(key, job);
      }
      job.aliases.push({ record, id: item.id, generation: record.generation });
      if (job.status === "done") deliver(job, job.output);
    }
  }
  function deliver(job, text) {
    job.output = text; job.status = "done";
    for (const { record, id, generation } of job.aliases) {
      if (generation !== record.generation || !records.has(record) || !run.records.has(record) || record.output || !intact(record)) continue;
      record.results.set(id, text);
      if (!record.work.every((part) => record.results.has(part.id))) continue;
      try {
        if (record.parts) {
          const output = record.slots.map(() => "");
          for (const part of record.parts) {
            const value = record.results.get(part.id);
            codec.validate(part.text, value);
            output[part.slotIndex] += (part.text.match(/^\s*/)?.[0] || "") + value.trim()
              + (part.text.match(/\s*$/)?.[0] || "");
          }
          record.output = output;
        } else record.output = decode(record, record.results.get(record.id));
        record.failed = false; render(record);
      } catch {
        record.failed = true; record.output = null; job.status = "failed";
        record.error = "译文未通过文字槽位校验，已保留原文。";
      }
    }
  }
  function acceptBatch(task, batch, translations, source) {
    if (!current(task) || !Array.isArray(translations)) return;
    const seen = new Set();
    for (const item of translations) {
      const job = batch.jobs.find((j) => j.item.id === item?.id);
      if (!job || seen.has(item.id) || typeof item.text !== "string") continue;
      seen.add(item.id);
      if (job.status === "done") continue;
      if (source === "cache") state.cached += job.aliases.length;
      if (source === "local") state.local += job.aliases.length;
      deliver(job, item.text);
    }
    publish();
  }
  function addUsage(batch, usage) {
    if (!usage || batch.usageAdded) return;
    batch.usageAdded = true;
    for (const key of ["requests", "reportedRequests", "inputTokens", "outputTokens", "cacheReadTokens"]) {
      state.usage[key] = (state.usage[key] || 0) + (Number(usage[key]) || 0);
    }
  }
  async function sendBatch(task, jobs) {
    const batch = { id: task.id + ":" + (++task.batchId), jobs };
    task.batches.set(batch.id, batch);
    task.active++;
    jobs.forEach((job) => { job.status = "running"; });
    publish();
    try {
      const response = await sendToBackground({
        type: "DEERWEBTRANSLATOR_TRANSLATE_BATCH", runId: task.id, batchId: batch.id,
        pageUrl, pageTitle: document.title, items: jobs.map((job) => job.item)
      });
      if (!current(task)) return;
      addUsage(batch, response?.usage);
      acceptBatch(task, batch, response?.translations, "");
      // Old and new workers are both accepted; only unresolved items fail.
      for (const job of jobs) if (job.status !== "done") {
        job.status = "failed";
        const error = response?.failed?.find((item) => item.id === job.item.id)?.error || response?.error;
        for (const { record, generation } of job.aliases) if (!record.output && generation === record.generation) {
          record.failed = true; record.error = error?.message || "模型未返回有效译文。";
        }
      }
    } catch {
      if (current(task)) for (const job of jobs) if (job.status !== "done") {
        job.status = "failed";
        for (const { record, generation } of job.aliases) if (!record.output && generation === record.generation) {
          record.failed = true; record.error = "后台连接中断，请重新加载扩展后重试。";
        }
      }
    } finally {
      task.active--; task.batches.delete(batch.id);
      if (current(task)) { publish(); schedule(); }
    }
  }
  function dispatch(task) {
    if (!current(task) || document.hidden || state.mode === "original") return;
    while (task.active < DT.MAX_CONCURRENT_BATCHES) {
      const queued = [...task.jobs.values()].filter((job) => job.status === "queued" && live(job));
      const priority = (job) => Math.min(...job.aliases.filter(({ record }) => record.element.isConnected)
        .map(({ record }) => {
          const rect = record.element.getBoundingClientRect();
          return rect.bottom >= 0 && rect.top <= innerHeight ? Math.max(0, rect.top) : 100000 + Math.abs(rect.top);
        }));
      queued.sort((a, b) => priority(a) - priority(b));
      if (!queued.length) break;
      // Reserve one slot for newly visible content rather than fill every
      // connection with prefetch work.
      if (task.active >= DT.MAX_CONCURRENT_BATCHES - 1 && priority(queued[0]) >= 100000) break;
      const jobs = []; let size = 0;
      const limit = task.batchId ? DT.MAX_BATCH_CHARS : 2200;
      for (const job of queued) {
        if (jobs.length && (size + job.item.text.length > limit || jobs.length >= DT.MAX_BATCH_ITEMS)) break;
        jobs.push(job); size += job.item.text.length;
      }
      void sendBatch(task, jobs);
    }
  }
  function collect() {
    if (!ensureContext() || !run || !current(run) || !index || document.hidden || state.mode === "original") return;
    const task = run;
    const started = performance.now();
    for (const [element, nodes] of index.candidates()) {
      if (!nearby(element) || !visible(element)) continue;
      let fresh = [...nodes].filter((node) => !byText.has(node) && eligible(node.data) && visible(node.parentElement));
      if (!fresh.length) continue;
      // Appending an inline node changes the paragraph's sentence context.
      // Rebuild just this group from source, never translate a mixture of old
      // translated text and a newly inserted fragment.
      const previous = new Set([...nodes].map((node) => byText.get(node)).filter(Boolean));
      if (previous.size) {
        previous.forEach(restore);
        fresh = [...nodes].filter((node) => eligible(node.data) && visible(node.parentElement));
      }
      const slots = fresh
        .sort((a,b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
        .map((node) => ({ node, parent: node.parentElement, original: node.data, written: node.data }));
      if (!slots.length) continue;
      const record = { element, slots, text: sourceFor(slots), context: contextFor(element), id: String(++counter),
        short: codec.shortLabel(slots.map((slot) => slot.original).join("")) };
      record.hash = record.id; // The worker hashes actual text and relevant policy.
      records.add(record); task.records.add(record);
      slots.forEach((slot) => byText.set(slot.node, record));
      enqueue(record);
      if (performance.now() - started >= 6) { schedule(); break; }
    }
    dispatch(task); publish();
  }
  function schedule() {
    if (disposed || !state.autoTranslate || timer) return;
    timer = setTimeout(() => { timer = null; collect(); }, 20);
  }
  function queueIndex(root) {
    if (!run?.roots) { index?.queue(root); return; }
    const element = root?.nodeType === 3 ? root.parentElement : root;
    if (!element) return;
    for (const scope of run.roots) {
      if (scope.contains(element)) index?.queue(root);
      else if (element.contains(scope)) index?.queue(scope);
    }
  }
  function cancel() {
    if (!disposed && run) {
      run.cancelled = true;
      void sendToBackground({ type: "DEERWEBTRANSLATOR_CANCEL_TRANSLATION", runId: run.id }).catch(() => {});
    }
  }
  function start(input, roots) {
    if (!ensureContext()) return;
    const normalized = DT.normalizePublicSettings(input);
    if (!roots && run && current(run) && state.status === "translating"
      && JSON.stringify(normalized) === JSON.stringify(settings)) return;
    cancel();
    if (disposed) return;
    index?.close();
    for (const record of records) restore(record);
    settings = normalized; pageUrl = location.href;
    run = { id: "run-" + Date.now() + "-" + Math.random().toString(36).slice(2), cancelled: false,
      records: new Set(), jobs: new Map(), batches: new Map(), active: 0, batchId: 0, roots: roots || null };
    Object.assign(state, { status: "translating", mode: settings.displayMode, total: 0,
      completed: 0, cached: 0, local: 0, failed: 0, overflow: 0, usage: {},
      error: "", autoTranslate: true, runId: run.id, pageUrl });
    index = new global.DeerTextIndex({ owner, excluded, ready: schedule });
    for (const root of roots || [document.body]) index.queue(root);
    publish(); schedule();
  }
  function retryFailed() {
    if (!run || !current(run)) return;
    for (const record of [...run.records]) {
      if (!intact(record)) { restore(record); continue; }
      if (!record.failed || record.output) continue;
      // Keep successful work items; only reset failed jobs.
      record.failed = false; record.error = "";
      for (const job of run.jobs.values()) {
        if (job.status === "failed" && job.aliases.some((entry) => entry.record === record)) job.status = "queued";
      }
    }
    publish(); schedule();
  }
  function selectedParagraphs() {
    const selection = getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const root = range.commonAncestorContainer, roots = new Set();
    if (root.nodeType === 3) roots.add(owner(root.parentElement));
    else {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) if (range.intersectsNode(node) && node.data.trim()) roots.add(owner(node.parentElement));
    }
    if (!run || !current(run)) {
      if (roots.size) start({ ...settings, displayMode: settings.displayMode === "original" ? "translation" : settings.displayMode }, [...roots]);
      return;
    }
    const selected = [...run.records].filter((record) => record.slots.some((slot) => {
      try { return range.intersectsNode(slot.node); } catch { return false; }
    }));
    if (state.mode === "original") { state.mode = "translation"; for (const record of records) render(record); }
    for (const record of selected) {
      if (!intact(record)) { restore(record); continue; }
      // Reuse source slots and the current page. Force only selected paragraphs.
      removeExtra(record);
      for (const slot of record.slots) if (slot.node.data === slot.written) { slot.node.data = slot.original; slot.written = slot.original; }
      record.output = null; record.failed = false;
      enqueue(record, true);
    }
    // A selection can target new text before the mutation/index pass sees it.
    for (const scope of roots) {
      if (run.roots && !run.roots.some((existing) => existing.contains(scope))) run.roots.push(scope);
      index.queue(scope);
    }
    publish(); schedule();
  }
  function onMessage(message, sender, respond) {
    if (!ensureContext()) {
      respond({ ok: false, error: { code: "CONTEXT_INVALIDATED", message: state.error } }); return false;
    }
    switch (message?.type) {
      case "DEERWEBTRANSLATOR_GET_STATE": break;
      case "DEERWEBTRANSLATOR_PARTIAL": {
        const batch = run?.batches.get(message.batchId);
        if (run?.id === message.runId && batch) acceptBatch(run, batch, message.translations, message.source);
        respond({ ok: true }); return false;
      }
      case "DEERWEBTRANSLATOR_START_TRANSLATION": start(message.settings || settings); break;
      case "DEERWEBTRANSLATOR_RETRY_FAILED": retryFailed(); break;
      case "DEERWEBTRANSLATOR_TRANSLATE_SELECTION":
        if (!run || !current(run)) settings = DT.normalizePublicSettings(message.settings || settings);
        selectedParagraphs(); break;
      case "DEERWEBTRANSLATOR_TOGGLE_TRANSLATION":
        if (!run || !current(run)) start({ ...(message.settings || settings), displayMode: "translation" });
        else { state.mode = state.mode === "original" ? "translation" : "original"; for (const r of records) render(r); publish(); schedule(); }
        break;
      case "DEERWEBTRANSLATOR_STOP_TRANSLATION":
        cancel(); state.autoTranslate = false; state.status = "stopped"; publish(); break;
      case "DEERWEBTRANSLATOR_SET_DISPLAY_MODE":
        if (Object.values(DT.DISPLAY_MODES).includes(message.mode)) {
          state.mode = message.mode;
          for (const record of records) if (intact(record)) render(record);
          publish(); schedule();
        }
        break;
      default: return false;
    }
    respond(disposed ? { ok: false, error: { code: "CONTEXT_INVALIDATED", message: state.error } }
      : { ok: true, state: snapshot() }); return false;
  }
  if (!ensureContext()) return;
  try { chrome.runtime.onMessage.addListener(onMessage); }
  catch (error) {
    if (!hasRuntime() || /extension context invalidated/i.test(error?.message || String(error))) { dispose(); return; }
    throw error;
  }
  observer = new MutationObserver((changes) => {
    if (disposed || !index || !state.autoTranslate) return;
    let removed = false;
    for (const change of changes) {
      const target = change.target.nodeType === 3 ? change.target.parentElement : change.target;
      if (target?.closest("." + DT.TRANSLATION_CLASS)) continue;
      if (change.type === "characterData") {
        const record = byText.get(change.target);
        if (record && intact(record)) continue;
        if (record) restore(record);
        queueIndex(target);
      } else if (change.type === "childList") {
        for (const node of change.removedNodes) {
          if (node.nodeType === 1 && node.classList.contains(DT.TRANSLATION_CLASS)) continue;
          removed = true;
        }
        for (const node of change.addedNodes) queueIndex(node);
      } else {
        if (target?.closest(excluded)) {
          for (const record of [...records]) if (record.slots.some((slot) => target.contains(slot.node))) restore(record);
        }
        // CSS visibility changes require only this subtree to be re-indexed.
        queueIndex(target);
      }
    }
    if (removed) {
      for (const record of [...records]) if (!intact(record)) restore(record);
      index.prune();
    }
    schedule();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ["hidden", "aria-hidden", "class", "style", "open", "translate", "contenteditable"] });
  document.addEventListener("scroll", schedule, { passive: true, capture: true });
  function onVisibilityChange() { publish(); schedule(); }
  document.addEventListener("visibilitychange", onVisibilityChange);
  global.addEventListener("resize", schedule, { passive: true });
  navigationTimer = setInterval(() => {
    // Reuse the existing SPA poll; no new IPC or keep-alive traffic. This also
    // retires idle scripts when an extension reload invalidates runtime.id.
    if (!ensureContext()) return;
    if (pageUrl === location.href) return;
    const auto = state.autoTranslate && !run?.roots;
    cancel();
    if (disposed) return;
    index?.close();
    for (const record of records) restore(record);
    pageUrl = location.href; state.pageUrl = pageUrl;
    if (auto) start({ ...settings, displayMode: state.mode });
    else { state.autoTranslate = false; state.status = "idle"; publish(); }
  }, 500);
  // Only public settings and an explicit site preference cross this boundary.
  void sendToBackground({ type: "DEERWEBTRANSLATOR_PAGE_POLICY", pageUrl }).then((response) => {
    if (!disposed && !run && response?.ok && response.policy?.auto === "always") {
      start({ ...response.settings, displayMode: response.policy.mode || response.settings.displayMode });
    }
  }).catch(() => {});
})(globalThis);
