(function (global) {
  "use strict";
  // A small text protocol, not model-generated HTML. Link targets and native
  // nodes stay local; only translatable labels and numbered markers leave.
  const markerPattern = /\[\[DWT_(OPEN|CLOSE|KEEP)_(\d+)\]\]/g;
  const token = (kind, id) => `[[DWT_${kind}_${id}]]`;
  function validate(source, output) {
    const expected = [...source.matchAll(markerPattern)].map((m) => m[0]);
    const received = [...output.matchAll(markerPattern)].map((m) => m[0]);
    if (expected.length !== received.length || new Set(received).size !== received.length
      || expected.some((value) => !received.includes(value))) {
      throw new Error("译文未完整保留链接或行内内容标记。");
    }
    function parents(text) {
      const stack = [];
      const result = new Map();
      for (const match of text.matchAll(markerPattern)) {
        const [, kind, id] = match;
        if (kind === "CLOSE") {
          if (stack.pop() !== id) throw new Error("译文链接标记嵌套无效。");
        } else {
          result.set(match[0], stack.at(-1) || null);
          if (kind === "OPEN") stack.push(id);
        }
      }
      if (stack.length) throw new Error("译文链接标记未闭合。");
      return result;
    }
    const sourceParents = parents(source);
    for (const [key, parent] of parents(output)) {
      if (sourceParents.get(key) !== parent) throw new Error("译文改变了链接的所属关系。");
    }
  }
  function shortLabel(text) {
    return text.length <= 40 && /^[A-Za-z][A-Za-z0-9 +/#&'’_-]*$/.test(text)
      && text.trim().split(/\s+/).length <= 4;
  }
  function labelTranslation(original, translated) {
    // Avoid API｜API（中文） when the terminology policy supplies a gloss.
    const text = translated.trim();
    if (text.startsWith(original)) {
      const gloss = text.slice(original.length).trim().match(/^[（(]([^()（）]+)[）)]$/);
      if (gloss) return gloss[1];
    }
    return text;
  }
  function serializeContent(root) {
    const entries = [];
    const excluded = "script,style,pre,textarea,input,svg,noscript,template,.deeptranslate-translation";
    function walk(node) {
      if (node.nodeType === 3) {
        if (node.data.includes("[[DWT_")) {
          const id = entries.push({ node, keep: true }) - 1;
          return token("KEEP", id);
        }
        return node.data;
      }
      if (node.nodeType !== 1 || node.matches(excluded)) return "";
      if (node !== root && (node.hidden || node.getAttribute("aria-hidden") === "true")) return "";
      if (node !== root) {
        const css = getComputedStyle(node);
        if (css.display === "none" || css.visibility === "hidden") return "";
      }
      const keep = node.matches("code,kbd,samp,[translate=no],.notranslate");
      const inline = node !== root && node.matches("a,strong,b,em,i,u,s,small,sub,sup");
      if (keep) {
        const id = entries.push({ node, keep: true }) - 1;
        return token("KEEP", id);
      }
      if (node.tagName === "BR") return "\n";
      const id = inline ? entries.push({ node, keep: false }) - 1 : -1;
      const text = Array.from(node.childNodes, walk).join("");
      return inline ? token("OPEN", id) + text + token("CLOSE", id) : text;
    }
    const text = global.DeerWebTranslator.normalizeText(walk(root));
    const identity = JSON.stringify([{ node: root, keep: false }, ...entries].map(({ node, keep }) => [
      node.nodeName, keep ? node.textContent : "", node.getAttribute?.("href"),
      node.getAttribute?.("target"), node.getAttribute?.("rel"), node.getAttribute?.("download")
    ]));
    const plainText = global.DeerWebTranslator.normalizeText(text.replace(markerPattern, (_, kind, id) =>
      kind === "KEEP" ? entries[Number(id)].node.textContent : ""));
    return { text, entries, identity, plainText };
  }
  function serialize(root) {
    // Cell-only mode hides the original descendants via inherited visibility.
    // Read the source with our own class temporarily removed, synchronously;
    // page-authored visibility rules still apply. The observer ignores class.
    const hiddenClass = global.DeerWebTranslator.CELL_ORIGINAL_HIDDEN_CLASS;
    const hiddenByUs = root.classList.contains(hiddenClass);
    if (hiddenByUs) root.classList.remove(hiddenClass);
    try { return serializeContent(root); }
    finally { if (hiddenByUs) root.classList.add(hiddenClass); }
  }
  function copyLink(source, target) {
    // DOM-sourced attributes only. The model cannot create a destination.
    for (const name of ["href", "target", "rel", "download", "hreflang", "referrerpolicy", "title"]) {
      if (source.hasAttribute(name)) target.setAttribute(name, source.getAttribute(name));
    }
    // Absolute URL preserves a relative href even when a site's <base> changes.
    if (source.hasAttribute("href")) target.setAttribute("href", source.href);
    target.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey
        || event.shiftKey || event.altKey || !source.isConnected) return;
      event.preventDefault();
      event.stopPropagation();
      // Dispatch through the original node for delegated SPA and per-link
      // listeners; native modified/middle/context-menu clicks use the real href.
      source.click();
    });
  }
  function render(protocol, output) {
    validate(protocol.text, output);
    const fragment = document.createDocumentFragment();
    const stack = [fragment];
    let offset = 0;
    for (const match of output.matchAll(markerPattern)) {
      stack.at(-1).append(document.createTextNode(output.slice(offset, match.index)));
      const [, kind, id] = match;
      if (kind === "CLOSE") {
        stack.pop();
      } else {
        const entry = protocol.entries[Number(id)];
        const node = entry.keep ? entry.node.cloneNode(true) : document.createElement(entry.node.localName);
        if (!entry.keep) {
          if (entry.node.localName === "a") copyLink(entry.node, node);
          const css = getComputedStyle(entry.node);
          for (const property of ["font-size", "font-weight", "font-style", "color", "text-decoration", "font-family"]) {
            node.style.setProperty(property, css.getPropertyValue(property));
          }
        }
        if (node.nodeType === 1) {
          node.removeAttribute("id");
          node.querySelectorAll("[id]").forEach((child) => child.removeAttribute("id"));
        }
        stack.at(-1).append(node);
        if (kind === "OPEN") stack.push(node);
      }
      offset = match.index + match[0].length;
    }
    stack[0].append(document.createTextNode(output.slice(offset)));
    return fragment;
  }
  global.DeerDOMCodec = Object.freeze({ validate, shortLabel, labelTranslation, serialize, render, copyLink });
})(globalThis);
