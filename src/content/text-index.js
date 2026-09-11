(function(global) {
  "use strict";
  // Index text once, then revisit only changed subtrees. Geometry is observed
  // by the browser, not recomputed for every text on every scroll event.
  class TextIndex {
    constructor({ owner, excluded, ready }) {
      this.owner = owner; this.excluded = excluded; this.ready = ready;
      this.groups = new Map(); this.owners = new WeakMap(); this.near = new Set();
      this.roots = new Set(); this.running = false; this.closed = false;
      this.metrics = { visitedTextNodes: 0, slices: 0, indexedRoots: 0 };
      this.observer = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) this.near.add(entry.target);
          else this.near.delete(entry.target);
        }
        this.ready();
      }, { rootMargin: "250px 0px 500px 0px" }) : null;
    }
    queue(root) {
      if (!root || this.closed) return;
      root = root.nodeType === 3 ? root.parentElement : root;
      if (!root || root.nodeType !== 1 || root.closest(this.excluded)) return;
      for (const queued of this.roots) if (queued.contains(root)) return;
      for (const queued of this.roots) if (root.contains(queued)) this.roots.delete(queued);
      this.roots.add(root);
      void this.drain();
    }
    add(node) {
      this.metrics.visitedTextNodes++;
      const parent = node.parentElement;
      const old = this.owners.get(node);
      if (!parent || !node.data.trim() || parent.closest(this.excluded)) {
        if (old) this.groups.get(old)?.delete(node);
        return;
      }
      const element = this.owner(parent);
      if (old && old !== element) this.groups.get(old)?.delete(node);
      if (!this.groups.has(element)) {
        this.groups.set(element, new Set());
        this.observer?.observe(element);
        // New visible groups can be dispatched before the first IO callback.
        const r = element.getBoundingClientRect();
        if (r.bottom >= -250 && r.top <= innerHeight + 500) this.near.add(element);
      }
      this.groups.get(element).add(node);
      this.owners.set(node, element);
    }
    async drain() {
      if (this.running || this.closed) return;
      this.running = true;
      try {
        while (this.roots.size && !this.closed) {
          const root = this.roots.values().next().value;
          this.roots.delete(root);
          if (!root.isConnected) continue;
          this.metrics.indexedRoots++;
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => node.nodeType === 1
              ? node.matches(this.excluded) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP
              : NodeFilter.FILTER_ACCEPT
          });
          let node, start = performance.now(), visited = 0;
          while (!this.closed && (node = walker.nextNode())) {
            this.add(node);
            if (++visited >= 300 || performance.now() - start >= 5) {
              this.metrics.slices++; this.ready();
              await new Promise((resolve) => setTimeout(resolve, 0));
              visited = 0; start = performance.now();
            }
          }
        }
      } finally {
        this.running = false;
        if (!this.closed) this.ready();
      }
    }
    candidates() {
      const elements = this.observer ? [...this.near] : [...this.groups.keys()];
      const groups = [];
      for (const element of elements) {
        if (!element.isConnected) {
          this.observer?.unobserve(element); this.near.delete(element); this.groups.delete(element);
          continue;
        }
        const nodes = this.groups.get(element);
        if (!nodes) continue;
        for (const node of nodes) if (!node.isConnected || this.owner(node.parentElement) !== element) nodes.delete(node);
        if (nodes.size) groups.push([element, nodes]);
      }
      return groups;
    }
    prune() {
      for (const element of this.groups.keys()) {
        if (!element.isConnected) {
          this.observer?.unobserve(element); this.near.delete(element); this.groups.delete(element);
        }
      }
    }
    close() { this.closed = true; this.observer?.disconnect(); this.roots.clear(); this.groups.clear(); this.near.clear(); }
  }
  global.DeerTextIndex = TextIndex;
})(globalThis);
