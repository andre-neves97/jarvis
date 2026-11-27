import { api } from "./api.js";
import { h, fill, stem, basename, dirname, store, debounce, captureTitle, toast } from "./util.js";

// ---------- Notes tree ----------

export class NotesPanel {
  constructor({ open, activePath }) {
    this.open = open;
    this.activePath = activePath;
    this.items = [];
    this.expanded = new Set(store.get("expanded", null) ?? []);
    this.firstRun = store.get("expanded", null) == null;
    this.treeEl = h("div", { class: "tree", role: "tree" });
    this.newForm = null;
    this.targetDir = null; // folder new notes/folders go into: the last folder you clicked
    this.el = h("div", { class: "notes-panel" },
      h("div", { class: "side-head" },
        h("h2", { class: "side-title" }, "Notes"),
        h("div", { class: "side-actions" },
          h("button", { class: "icon-btn", title: "New note", "aria-label": "New note", onclick: () => this.showNewForm("note"),
            html: '<svg viewBox="0 0 24 24"><path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z"/><path d="M13.5 3.5v5h5M12 11.5v6M9 14.5h6"/></svg>' }),
          h("button", { class: "icon-btn", title: "New folder", "aria-label": "New folder", onclick: () => this.showNewForm("folder"),
            html: '<svg viewBox="0 0 24 24"><path d="M3.5 6A1.5 1.5 0 0 1 5 4.5h4.5l2 2H19A1.5 1.5 0 0 1 20.5 8v10a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z"/><path d="M12 10.5v6M9 13.5h6"/></svg>' }),
        ),
      ),
      h("div", { class: "side-scroll" }, this.treeEl),
    );
  }

  async load() {
    this.items = await api.tree();
    if (this.firstRun) {
      for (const i of this.items) if (i.type === "dir" && !i.path.includes("/") && i.path !== "Archive") this.expanded.add(i.path);
      this.firstRun = false;
      this.saveExpanded();
    }
    this.render();
  }

  paths() { return this.items.filter((i) => i.type === "file" && /\.(md|txt)$/i.test(i.path)).map((i) => i.path); }
  saveExpanded() { store.set("expanded", [...this.expanded]); }

  render() {
    const children = new Map();
    for (const item of this.items) {
      const parent = dirname(item.path);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(item);
    }
    const active = this.activePath();
    const build = (parent, depth) => (children.get(parent) || [])
      .sort((a, b) => (a.type === b.type ? 0 : a.type === "dir" ? -1 : 1))
      .map((item) => {
        if (item.type === "dir") {
          const isOpen = this.expanded.has(item.path);
          // A folder holding one same-named note (Projects/ECHO/ECHO.md) acts as that note.
          const kids = children.get(item.path) || [];
          const self = kids.length === 1 && kids[0].type === "file" && stem(kids[0].path) === basename(item.path) ? kids[0] : null;
          if (self) return this.fileRow(self, depth, active, basename(item.path));
          return h("div", { class: "tree-group" },
            h("button", {
              class: `tree-row tree-dir ${isOpen ? "is-open" : ""}`, style: `--depth:${depth}`, role: "treeitem", "aria-expanded": String(isOpen),
              onclick: () => {
                isOpen ? this.expanded.delete(item.path) : this.expanded.add(item.path);
                this.targetDir = item.path;
                this.saveExpanded(); this.render();
              },
            }, h("span", { class: "chev", "aria-hidden": "true" }), h("span", { class: "tree-icon", "aria-hidden": "true" }), basename(item.path), h("span", { class: "tree-count" }, countFiles(item.path))),
            isOpen ? h("div", { role: "group", class: "tree-children", style: `--depth:${depth}` }, kids.length ? build(item.path, depth + 1)
              : h("p", { class: "tree-empty", style: `--depth:${depth + 1}` }, "Empty folder")) : null);
        }
        return this.fileRow(item, depth, active);
      });
    const countFiles = (dir) => this.items.filter((i) => i.type === "file" && i.path.startsWith(dir + "/")).length || "";
    this.treeEl.replaceChildren(...(this.newForm ? [this.newForm] : []), ...build("", 0));
  }

  fileRow(item, depth, active, label) {
    const isText = /\.(md|txt)$/i.test(item.path);
    return h("button", {
      class: `tree-row tree-file ${item.path === active ? "is-active" : ""} ${isText ? "" : "is-binary"}`, style: `--depth:${depth}`,
      role: "treeitem", title: isText ? `${item.path}\nCtrl+click opens on the other side` : `${item.path} (Jarvis only opens notes)`,
      onclick: (e) => { this.targetDir = dirname(item.path); if (isText) this.open(item.path, { other: e.ctrlKey || e.metaKey }); },
      onauxclick: (e) => { if (e.button === 1 && isText) this.open(item.path, { other: true }); },
    }, h("span", { class: "tree-icon", "aria-hidden": "true" }), h("span", { class: "tree-label" }, label || (isText ? stem(item.path) : basename(item.path))));
  }

  /** Inline form for a new note ("note") or folder ("folder"), prefilled with the target folder. */
  showNewForm(kind = "note") {
    const active = this.activePath();
    const folder = this.targetDir ?? (active ? dirname(active) : "");
    const isFolder = kind === "folder";
    const input = h("input", { class: "input", value: folder ? `${folder}/` : "", "aria-label": isFolder ? "New folder path" : "New note path",
      placeholder: isFolder ? "Folder/New folder" : "Folder/Note name", spellcheck: "false" });
    const error = h("p", { class: "form-error", role: "alert", hidden: true });
    const cancel = () => { this.newForm = null; this.render(); };
    this.newForm = h("form", { class: "new-note", onsubmit: async (e) => {
      e.preventDefault();
      const path = input.value.trim().replaceAll("\\", "/").replace(/\/+$/, "");
      if (!path || path === folder) { error.hidden = false; error.textContent = `Type a name for the ${kind}.`; input.focus(); return; }
      try {
        if (isFolder) {
          const r = await api.createFolder(path);
          this.newForm = null;
          // Show the new folder: expand it and its parents, and make it the target for the next note.
          const parts = r.path.split("/");
          for (let i = 1; i <= parts.length; i++) this.expanded.add(parts.slice(0, i).join("/"));
          this.saveExpanded();
          this.targetDir = r.path;
          await this.load();
          toast(`Folder “${basename(r.path)}” created. New notes will go in it.`, "success");
        } else {
          const r = await api.create(path);
          this.newForm = null;
          const dir = dirname(r.path);
          if (dir) { const parts = dir.split("/"); for (let i = 1; i <= parts.length; i++) this.expanded.add(parts.slice(0, i).join("/")); this.saveExpanded(); }
          await this.load();
          this.open(r.path);
        }
      } catch (err) { error.hidden = false; error.textContent = err.message; input.focus(); }
    } },
      h("label", { class: "muted" }, isFolder ? "New folder" : "New note, created from Template.md"),
      input,
      error,
      h("div", { class: "row-actions" },
        h("button", { class: "btn btn-quiet", type: "button", onclick: cancel }, "Cancel"),
        h("button", { class: "btn btn-primary", type: "submit" }, isFolder ? "Create folder" : "Create note")),
    );
    input.addEventListener("keydown", (e) => { if (e.key === "Escape") cancel(); });
    input.addEventListener("input", () => { error.hidden = true; });
    this.render();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

// ---------- Search ----------

export class SearchPanel {
  constructor({ open }) {
    this.open = open;
    this.input = h("input", { class: "input search-input", type: "search", placeholder: "Search all notes", "aria-label": "Search all notes" });
    this.results = h("div", { class: "search-results" });
    this.el = h("div", { class: "search-panel" },
      h("div", { class: "side-head" }, h("h2", { class: "side-title" }, "Search")),
      h("div", { class: "side-pad" }, this.input),
      h("div", { class: "side-scroll" }, this.results),
    );
    const run = debounce(() => this.run(), 160);
    this.input.addEventListener("input", run);
    this.input.addEventListener("keydown", (e) => { if (e.key === "Enter") run.flush(); });
  }

  focus() { this.input.focus(); this.input.select(); }

  async run() {
    const q = this.input.value.trim();
    if (!q) return this.results.replaceChildren();
    const res = await api.search(q);
    if (!res.length) return this.results.replaceChildren(h("p", { class: "muted empty-hint" }, `No notes mention “${q}”.`));
    const mark = (text) => {
      const i = text.toLowerCase().indexOf(q.toLowerCase());
      return i < 0 ? [text] : [text.slice(0, i), h("mark", {}, text.slice(i, i + q.length)), text.slice(i + q.length)];
    };
    this.results.replaceChildren(...res.map((r) => h("button", {
      class: "search-hit", onclick: (e) => this.open(r.path, { other: e.ctrlKey || e.metaKey }),
    },
      h("span", { class: "hit-name" }, ...mark(stem(r.path))),
      h("span", { class: "hit-dir" }, dirname(r.path) || "Knowledge base"),
      ...r.snippets.map((s) => h("span", { class: "hit-line" }, ...mark(s.text))))));
  }
}

// ---------- Inbox ----------

/** The inbox, used both in the sidebar and (compact) on the Home page. */
export class InboxPanel {
  constructor({ info, open, startReview, onCount, onLoad, compact = false }) {
    this.info = info;
    this.open = open;
    this.startReview = startReview;
    this.onCount = onCount || (() => {});
    this.onLoad = onLoad || (() => {});
    this.compact = compact;
    this.items = [];
    this.logs = new Map();
    this.expandedLog = null;
    this.bar = h("div", { class: "inbox-bar" });
    this.list = h("div", { class: "inbox-list" });
    this.el = compact
      ? h("div", { class: "inbox-panel is-compact" }, this.bar, this.list)
      : h("div", { class: "inbox-panel" },
        h("div", { class: "side-head" }, h("h2", { class: "side-title" }, "Inbox")),
        h("div", { class: "side-scroll" }, this.bar, this.list));
  }

  async load() {
    this.items = await api.inbox();
    this.onCount(this.items.length);
    this.onLoad(this.items);
    this.render();
    const busy = this.items.filter((i) => i.status === "running" || i.status === "queued");
    const justFinished = [...(this.wasBusy || [])].filter((id) => !busy.some((i) => i.id === id));
    this.wasBusy = new Set(busy.map((i) => i.id));
    clearTimeout(this.poll);
    if (justFinished.length) {
      await Promise.all(justFinished.map(async (id) => this.logs.set(id, await api.agentStatus(id))));
      this.render();
    }
    if (busy.length) {
      const active = busy.filter((i) => i.status === "running");
      await Promise.all(active.map(async (i) => this.logs.set(i.id, await api.agentStatus(i.id))));
      this.render();
      this.poll = setTimeout(() => this.load(), 2000);
    }
  }

  async process(item) {
    try {
      await api.process(item.id);
      await this.load();
    } catch (e) { toast(e.message, "error"); }
  }

  async processAll() {
    try {
      const r = await api.processAll();
      toast(r.queued === 1 ? "Processing 1 capture." : `Processing ${r.queued} captures, oldest first.`);
      await this.load();
    } catch (e) { toast(e.message, "error"); }
  }

  renderBar() {
    const { agent_label: agent, agent_available: ok } = this.info;
    const count = (s) => this.items.filter((i) => i.status === s).length;
    const fresh = count("new"), busy = count("running") + count("queued"), ready = count("review");
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const lines = [];
    if (busy) lines.push(h("p", { class: "inbox-summary is-busy" }, h("span", { class: "status-dot" }),
      `${agent} is working through ${plural(busy, "capture", "captures")}. Proposals appear here when ready.`));
    if (ready) lines.push(h("p", { class: "inbox-summary is-ready" }, h("span", { class: "status-dot" }),
      `${plural(ready, "proposal is", "proposals are")} ready for your review.`));
    if (fresh) {
      lines.push(h("div", { class: "inbox-process" },
        h("p", { class: "inbox-summary" }, h("span", { class: "status-dot" }), `${plural(fresh, "capture hasn't", "captures haven't")} been processed.`),
        ok ? h("button", { class: "btn btn-primary btn-big", onclick: () => this.processAll() },
          fresh === 1 ? `Process with ${agent}` : `Process all ${fresh} with ${agent}`) : null));
    }
    if (!ok && this.info.agent !== "none" && this.items.length) {
      lines.push(h("p", { class: "notice" },
        `${agent} wasn't found on this machine, so captures can only be reviewed manually. To use an agent, install it or change "agent" in jarvis.config.json.`));
    }
    fill(this.bar, ...lines);
  }

  render() {
    this.renderBar();
    const { agent_label: agent, agent_available: ok } = this.info;
    if (!this.items.length) {
      return fill(this.list, h("div", { class: "empty-state" },
        h("p", {}, "The inbox is empty."),
        h("p", { class: "muted" }, "New daily captures appear here when they sync into ProcessingBay.")));
    }
    fill(this.list, ...this.items.map((item) => {
      const st = this.logs.get(item.id);
      const statusText = {
        new: "Not processed", queued: "Waiting its turn", running: `${agent} is working on it`, review: "Proposal ready",
      }[item.status];
      const actions = item.status === "review"
        ? [h("button", { class: "btn btn-primary", onclick: () => this.startReview(item.id) }, "Open review")]
        : item.status !== "new" ? []
          : [
            ok ? h("button", { class: "btn", onclick: () => this.process(item) }, "Process this one") : null,
            h("button", { class: `btn ${ok ? "btn-quiet" : "btn-primary"}`, onclick: () => this.startReview(item.id, true) }, "Review manually"),
          ];
      const failed = st?.status === "failed" && item.status === "new";
      return h("article", { class: `inbox-item status-${item.status}` },
        h("button", { class: "inbox-title", onclick: (e) => this.open(item.path, { other: e.ctrlKey || e.metaKey }), title: "Read the capture" },
          captureTitle(item.id), h("span", { class: "inbox-file" }, basename(item.path))),
        h("p", { class: "inbox-status" }, h("span", { class: "status-dot" }), statusText),
        failed ? h("p", { class: "warning" }, st.error) : null,
        h("div", { class: "row-actions" }, ...actions,
          st?.log ? h("button", { class: "btn btn-quiet", onclick: () => { this.expandedLog = this.expandedLog === item.id ? null : item.id; this.render(); } },
            this.expandedLog === item.id ? "Hide log" : "Show log") : null),
        this.expandedLog === item.id && st?.log ? h("pre", { class: "agent-log" }, st.log.slice(-4000)) : null,
      );
    }));
  }
}
