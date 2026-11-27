import { h, store } from "./util.js";

/**
 * Two panes, each with its own tabs. A tab wraps a "view": any object with
 *   el, title, dirty?, onShow?(), onFileEvent?(evt), destroy?(), confirmClose?()
 * Views stay alive while their tab is open, so editor state survives tab switches.
 */
export class Workspace {
  constructor(root, { onChange } = {}) {
    this.root = root;
    this.onChange = onChange || (() => {});
    this.split = store.get("split", false);
    this.activePane = 0;
    this.panes = [0, 1].map((i) => this._makePane(i));
    this._render();
  }

  _makePane(index) {
    const tabsEl = h("div", { class: "tabs", role: "tablist" });
    const bodyEl = h("div", { class: "pane-body" });
    const moveBtn = h("button", {
      class: "icon-btn", title: "Move tab to the other side", "aria-label": "Move tab to the other side",
      onclick: () => this.moveActive(index),
      html: '<svg viewBox="0 0 24 24"><path d="M7 8h12m0 0-3-3m3 3-3 3M17 16H5m0 0 3-3m-3 3 3 3"/></svg>',
    });
    const el = h("section", { class: "pane", "data-pane": index, onmousedown: () => this.focusPane(index) },
      h("header", { class: "pane-head" }, tabsEl, moveBtn),
      bodyEl,
    );
    return { index, el, tabsEl, bodyEl, tabs: [], active: null };
  }

  _render() {
    this.root.replaceChildren(this.panes[0].el, ...(this.split ? [this.panes[1].el] : []));
    this.root.classList.toggle("is-split", this.split);
    document.getElementById("split-btn")?.classList.toggle("is-on", this.split);
    for (const p of this.panes) this._renderPane(p);
  }

  _renderPane(p) {
    p.el.classList.toggle("is-active", p.index === this.activePane && this.split);
    p.tabsEl.replaceChildren(...p.tabs.map((t) => {
      const title = t.view.title || t.title;
      return h("div", {
        class: `tab ${t.key === p.active ? "is-active" : ""} ${t.view.dirty ? "is-dirty" : ""} tab-${t.kind || "note"}`,
        role: "tab", "aria-selected": String(t.key === p.active), title: t.tooltip || title, tabindex: "0",
        onclick: () => this.activate(p.index, t.key),
        onkeydown: (e) => { if (e.key === "Enter") this.activate(p.index, t.key); },
        onauxclick: (e) => { if (e.button === 1) this.close(p.index, t.key); },
      },
        h("span", { class: "tab-title" }, title),
        h("button", {
          class: "tab-close", "aria-label": `Close ${title}`,
          onclick: (e) => { e.stopPropagation(); this.close(p.index, t.key); },
        }, "×"),
      );
    }));
    for (const t of p.tabs) t.view.el.hidden = t.key !== p.active;
    if (!p.tabs.length) {
      if (!p.empty) {
        p.empty = h("div", { class: "pane-empty" },
          h("p", {}, p.index === 0 ? "Open a note from the sidebar." : "This side is free."),
          h("p", { class: "muted" }, "Ctrl+click a note to open it on the other side."));
      }
      p.bodyEl.replaceChildren(p.empty);
    } else if (p.empty && p.empty.isConnected) {
      p.empty.remove();
    }
  }

  refreshTabs() { for (const p of this.panes) this._renderPane(p); }

  focusPane(index) {
    if (this.activePane === index) return;
    this.activePane = index;
    this.refreshTabs();
    this.onChange();
  }

  setSplit(on) {
    this.split = on;
    store.set("split", on);
    if (!on) {
      // fold the right pane's tabs into the left one
      for (const t of [...this.panes[1].tabs]) this._transfer(1, 0, t.key);
      this.activePane = 0;
    }
    this._render();
    this.onChange();
  }

  /** Split with one side emptied (tabs moved or closed): fold back into one view, keeping the tab you were on. */
  _unsplitIfOneSided() {
    if (!this.split || (this.panes[0].tabs.length && this.panes[1].tabs.length)) return false;
    const [left, right] = this.panes;
    const keep = right.tabs.length ? right.active : left.active;
    this.split = false;
    store.set("split", false);
    for (const t of [...right.tabs]) this._transfer(1, 0, t.key);
    left.active = keep ?? left.active;
    this.activePane = 0;
    this._render();
    left.tabs.find((t) => t.key === left.active)?.view.onShow?.();
    this.onChange();
    return true;
  }

  /** spec: { key, title, kind, create: () => view }  opts: { pane, other } */
  open(spec, opts = {}) {
    let pane = opts.pane ?? (opts.other ? 1 - this.activePane : this.activePane);
    if (pane === 1 && !this.split) this.setSplit(true);
    const p = this.panes[pane];
    let tab = p.tabs.find((t) => t.key === spec.key);
    if (!tab) {
      tab = { ...spec, view: spec.create() };
      p.tabs.push(tab);
      p.bodyEl.append(tab.view.el);
    }
    this.activePane = pane;
    this.activate(pane, tab.key);
    return tab.view;
  }

  activate(pane, key) {
    const p = this.panes[pane];
    p.active = key;
    this.activePane = pane;
    this._renderPane(p);
    this.refreshTabs();
    const tab = p.tabs.find((t) => t.key === key);
    tab?.view.onShow?.();
    this.onChange();
  }

  async close(pane, key) {
    const p = this.panes[pane];
    const i = p.tabs.findIndex((t) => t.key === key);
    if (i < 0) return;
    const tab = p.tabs[i];
    if (tab.view.confirmClose && !(await tab.view.confirmClose())) return;
    tab.view.destroy?.();
    tab.view.el.remove();
    p.tabs.splice(i, 1);
    if (p.active === key) p.active = p.tabs[Math.min(i, p.tabs.length - 1)]?.key ?? null;
    if (this._unsplitIfOneSided()) return;
    this._renderPane(p);
    if (p.active) this.activate(pane, p.active);
    this.onChange();
  }

  closeWhere(pred) {
    for (const p of this.panes) for (const t of [...p.tabs]) if (pred(t)) {
      t.view.destroy?.(); t.view.el.remove();
      p.tabs = p.tabs.filter((x) => x !== t);
      if (p.active === t.key) p.active = p.tabs[0]?.key ?? null;
    }
    if (this._unsplitIfOneSided()) return;
    this.refreshTabs();
    for (const p of this.panes) if (p.active) p.tabs.find((t) => t.key === p.active)?.view.onShow?.();
    this.onChange();
  }

  _transfer(from, to, key) {
    const src = this.panes[from], dst = this.panes[to];
    const i = src.tabs.findIndex((t) => t.key === key);
    if (i < 0) return;
    const [tab] = src.tabs.splice(i, 1);
    if (src.active === key) src.active = src.tabs[Math.min(i, src.tabs.length - 1)]?.key ?? null;
    const dupe = dst.tabs.find((t) => t.key === key);
    if (dupe) { tab.view.destroy?.(); tab.view.el.remove(); }
    else { dst.tabs.push(tab); dst.bodyEl.append(tab.view.el); }
    dst.active = key;
  }

  moveActive(from) {
    const key = this.panes[from].active;
    if (!key) return;
    if (!this.split) { this.setSplit(true); }
    this._transfer(from, 1 - from, key);
    this.activePane = 1 - from;
    if (this._unsplitIfOneSided()) return;
    this.refreshTabs();
    this.panes[1 - from].tabs.find((t) => t.key === key)?.view.onShow?.();
    this.onChange();
  }

  activeView(pane = this.activePane) {
    const p = this.panes[pane];
    return p.tabs.find((t) => t.key === p.active)?.view || null;
  }

  allTabs() { return this.panes.flatMap((p) => p.tabs.map((t) => ({ ...t, pane: p.index }))); }

  notify(evt) {
    for (const t of this.allTabs()) t.view.onFileEvent?.(evt);
    this.refreshTabs();
  }
}
