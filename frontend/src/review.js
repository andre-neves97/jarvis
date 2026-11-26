import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { unifiedMergeView, MergeView, getChunks, goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
import { api } from "./api.js";
import { editorExtensions } from "./editor.js";
import { NoteView } from "./noteView.js";
import { h, fill, stem, dirname, debounce, toast, captureTitle, confirmDialog, store } from "./util.js";

const STATUS_LABEL = { pending: "Needs a decision", accepted: "Accepted", rejected: "Rejected" };

export class ReviewSession {
  constructor(id, { ws, openNote, getPaths, onExit }) {
    this.id = id;
    this.ws = ws;
    this.openNote = openNote;
    this.getPaths = getPaths;
    this.onExit = onExit;
    this.data = null;
    this.panel = h("div", { class: "review-panel" });
    this.savers = new Map();
  }

  async load() {
    this.data = await api.review(this.id);
    this.renderPanel();
    return this;
  }

  change(path) { return this.data?.changes.find((c) => c.path === path); }

  start() {
    if (!this.ws.split) this.ws.setSplit(true);
    if (this.data.capture) {
      this.captureView = this.ws.open({
        key: `capture:${this.data.capture}`, kind: "capture", title: `Capture ${captureTitle(this.id)}`,
        create: () => new NoteView(this.data.capture, { open: this.openNote, readOnly: true }),
      }, { pane: 0 });
    }
    const first = this.data.changes.find((c) => c.status === "pending") || this.data.changes[0];
    if (first) this.openChange(first.path);
  }

  openChange(path) {
    this.ws.open({
      key: `change:${this.id}:${path}`, kind: "change", title: stem(path), tooltip: `${path} (review)`,
      create: () => new ChangeView(this, path),
    }, { pane: 1 });
    this.activePath = path;
    this.renderPanel();
  }

  showSources(path) {
    this.activePath = path;
    this.captureView?.highlight(this.change(path)?.sources || []);
    this.renderPanel();
  }

  saveWorking(path, text) {
    const c = this.change(path);
    const wasEdited = c?.edited;
    if (c) { c.working = text; c.edited = text !== c.proposed; }
    if (!this.savers.has(path)) {
      this.savers.set(path, debounce((t) => api.saveChange(this.id, { path, working: t })
        .catch((e) => toast(`Your edit to ${stem(path)} was not saved: ${e.message}`, "error")), 500));
    }
    this.savers.get(path)(text);
    if (c && wasEdited !== c.edited) this.renderPanel();
  }

  async flush() {
    for (const s of this.savers.values()) if (s.pending) await s.flush();
  }

  async setStatus(path, status) {
    const c = this.change(path);
    if (!c) return;
    c.status = c.status === status ? "pending" : status;
    await api.saveChange(this.id, { path, status: c.status });
    this.renderPanel();
    for (const t of this.ws.allTabs()) if (t.kind === "change") t.view.refreshHeader?.();
    if (c.status !== "pending") {
      const next = this.data.changes.find((x) => x.status === "pending");
      if (next) this.openChange(next.path);
    }
  }

  async addFile(path) {
    try {
      this.data = await api.addReviewFile(this.id, path);
      const added = this.data.changes.find((c) => c.path === path || c.path === `${path}.md`);
      this.renderPanel();
      if (added) this.openChange(added.path);
    } catch (e) { toast(e.message, "error"); }
  }

  async removeFile(path) {
    this.data = await api.removeReviewFile(this.id, path);
    this.ws.closeWhere((t) => t.key === `change:${this.id}:${path}`);
    this.renderPanel();
  }

  async saveTodo(t, fields) {
    Object.assign(t, fields);
    await api.saveTodo(this.id, { index: t.index, ...fields }).catch((e) => toast(e.message, "error"));
    this.renderPanel();
  }

  close() {
    this.ws.closeWhere((t) => t.key.startsWith(`change:${this.id}:`) || (this.data?.capture && t.key === `capture:${this.data.capture}`));
    this.onExit();
  }

  async apply(force = false) {
    await this.flush();
    const d = this.data;
    const acc = d.changes.filter((c) => c.status === "accepted");
    const rej = d.changes.filter((c) => c.status === "rejected");
    const todos = d.todos.filter((t) => t.include && t.text.trim());
    if (!force) {
      const body = h("div", {},
        h("ul", { class: "dialog-list" },
          h("li", {}, `${acc.length} ${acc.length === 1 ? "note" : "notes"} saved${acc.some((c) => c.edited) ? ", including your edits" : ""}`),
          rej.length ? h("li", {}, `${rej.length} rejected and left as they are`) : null,
          todos.length ? h("li", {}, `${todos.length} ${todos.length === 1 ? "to-do" : "to-dos"} added to your list`) : null,
        ),
        h("p", { class: "muted" }, "Jarvis backs up the knowledge base first, then writes the change log and moves the capture to Archive."),
      );
      if (!(await confirmDialog({ title: "Apply this review?", body, confirm: "Apply review" }))) return;
    }
    try {
      const r = await api.apply(this.id, force);
      toast(`Review applied. Backup saved to ${r.backup}.`, "success", 7000);
      this.close();
    } catch (e) {
      if (e.status === 409 && e.data?.stale) {
        const ok = await confirmDialog({
          title: "Some notes changed since the proposal",
          body: h("div", {}, h("p", {}, "These notes were edited after the agent made its proposal. Applying replaces those newer edits with the reviewed version:"),
            h("ul", { class: "dialog-list" }, e.data.stale.map((p) => h("li", {}, p)))),
          confirm: "Apply anyway", danger: true,
        });
        if (ok) return this.apply(true);
      } else toast(e.message, "error");
    }
  }

  async discard() {
    const ok = await confirmDialog({
      title: "Discard this review?",
      body: "The proposal and your edits to it are deleted. Your notes and the capture stay as they are, and you can process the capture again later.",
      confirm: "Discard review", danger: true,
    });
    if (!ok) return;
    await api.discard(this.id);
    toast("Review discarded.");
    this.close();
  }

  renderPanel() {
    const d = this.data;
    if (!d) return;
    const decided = d.changes.filter((c) => c.status !== "pending").length;
    const accepted = d.changes.filter((c) => c.status === "accepted").length;
    const pending = d.changes.length - decided;

    const fileRows = d.changes.map((c) => h("li", {
      class: `change-row status-${c.status} ${this.activePath === c.path ? "is-current" : ""}`,
    },
      h("button", { class: "change-open", onclick: () => this.openChange(c.path), title: c.summary || c.path },
        h("span", { class: "status-dot", "aria-label": STATUS_LABEL[c.status] }),
        h("span", { class: "change-name" },
          h("span", { class: "change-file" }, stem(c.path), c.edited ? h("span", { class: "edited-mark", title: "You edited this proposal" }, " edited") : null),
          h("span", { class: "change-dir" }, dirname(c.path) || "Knowledge base")),
        h("span", { class: `action-tag action-${c.action}` }, c.action === "create" ? "New" : "Update"),
      ),
    ));

    const addInput = h("input", { class: "input", list: `paths-${this.id}`, placeholder: "Note path, e.g. People/Jane Doe", "aria-label": "Note to add to this review" });
    const addForm = h("form", { class: "add-file", hidden: true, onsubmit: (e) => { e.preventDefault(); if (addInput.value.trim()) this.addFile(addInput.value.trim()); } },
      addInput,
      h("datalist", { id: `paths-${this.id}` }, this.getPaths().map((p) => h("option", { value: p }))),
      h("button", { class: "btn", type: "submit" }, "Add"),
    );

    const todoRows = d.todos.map((t) => h("li", { class: `todo-proposal ${t.include ? "" : "is-off"}` },
      h("input", { type: "checkbox", checked: t.include, "aria-label": "Add this to-do", onchange: (e) => this.saveTodo(t, { include: e.target.checked }) }),
      h("div", { class: "todo-proposal-fields" },
        h("input", { class: "input input-plain", value: t.text, "aria-label": "To-do text", onchange: (e) => this.saveTodo(t, { text: e.target.value }) }),
        h("input", { class: "input input-date", type: "date", value: t.due || "", "aria-label": "Due date", onchange: (e) => this.saveTodo(t, { due: e.target.value || null }) }),
      ),
    ));

    fill(this.panel, 
      h("div", { class: "side-head" },
        h("button", { class: "btn btn-quiet back-btn", onclick: () => this.close() }, "‹ Inbox"),
      ),
      h("div", { class: "side-scroll" },
        h("h2", { class: "review-title" }, `Review of ${captureTitle(this.id)}`),
        h("p", { class: "review-by muted" }, d.agent === "manual" ? "Manual review" : `Proposed by ${d.agent || "the agent"}`),
        d.summary ? h("p", { class: "review-summary" }, d.summary) : null,
        ...d.warnings.map((w) => h("p", { class: "warning" }, w)),
        h("div", { class: "section-head" },
          h("h3", {}, "Notes"),
          h("span", { class: "muted" }, d.changes.length ? `${decided} of ${d.changes.length} decided` : "")),
        d.changes.length ? h("ul", { class: "change-list" }, fileRows)
          : h("p", { class: "muted empty-hint" }, "No notes in this review yet. Add the notes you want to update; the capture stays open on the left."),
        h("button", { class: "btn btn-quiet add-toggle", onclick: (e) => { addForm.hidden = !addForm.hidden; e.target.hidden = true; addInput.focus(); } }, "+ Add a note"),
        addForm,
        d.todos.length ? h("div", { class: "section-head" }, h("h3", {}, "To-dos"), h("span", { class: "muted" }, "Ticked ones go to your list")) : null,
        d.todos.length ? h("ul", { class: "todo-proposals" }, todoRows) : null,
        d.skipped.length ? h("details", { class: "skipped" },
          h("summary", {}, `Not stored (${d.skipped.length})`),
          h("ul", {}, d.skipped.map((s) => h("li", {}, typeof s === "string" ? s : h("span", {}, h("strong", {}, s.what), s.why ? ` ${s.why}` : ""))))) : null,
      ),
      h("div", { class: "side-foot" },
        h("button", { class: "btn btn-quiet", onclick: () => this.discard() }, "Discard"),
        h("button", {
          class: "btn btn-primary", disabled: pending > 0 || (!d.changes.length && !d.todos.some((t) => t.include)),
          title: pending ? `${pending} ${pending === 1 ? "note needs" : "notes need"} a decision first` : "",
          onclick: () => this.apply(),
        }, pending ? `${pending} left to decide` : `Apply ${accepted} ${accepted === 1 ? "note" : "notes"}`),
      ),
    );
  }
}

/** One proposed note: the agent's version, editable in place, diffed against the current note. */
class ChangeView {
  constructor(session, path) {
    this.session = session;
    this.path = path;
    this.layout = store.get("diffLayout", "inline");
    this.head = h("div", { class: "change-head" });
    this.toolbar = h("div", { class: "change-toolbar" });
    this.host = h("div", { class: "merge-host" });
    this.el = h("div", { class: "view change-view" }, this.head, this.toolbar, this.host);
    this.refreshHeader();
    this.build();
  }

  get c() { return this.session.change(this.path); }
  get title() { return stem(this.path); }
  get dirty() { return false; }

  refreshHeader() {
    const c = this.c;
    if (!c) return;
    this.el.dataset.status = c.status;
    fill(this.head, 
      h("div", { class: "change-head-top" },
        h("div", { class: "crumbs" }, ...dirname(c.path).split("/").filter(Boolean).filter((x, i, a) => !(i === a.length - 1 && x === stem(c.path))).map((x) => h("span", { class: "crumb" }, x)), h("span", { class: "crumb crumb-file" }, stem(c.path))),
        h("span", { class: `action-tag action-${c.action}` }, c.action === "create" ? "New note" : "Update"),
        h("span", { class: `status-pill status-${c.status}` }, STATUS_LABEL[c.status]),
      ),
      c.summary ? h("p", { class: "change-summary" }, c.summary) : null,
      c.sources?.length ? h("div", { class: "sources" },
        h("span", { class: "muted" }, "From the capture:"),
        ...c.sources.map((s) => h("button", { class: "source-quote", title: "Show in the capture", onclick: () => this.session.captureView?.highlight([s]) }, `“${s}”`))) : null,
      c.stale ? h("p", { class: "warning" }, "This note changed after the proposal was made. The diff below compares against the current note.") : null,
    );
    this.renderToolbar();
  }

  renderToolbar() {
    const c = this.c;
    if (!c) return;
    const count = this.chunkCount();
    const seg = (value, label) => h("button", {
      class: `seg ${this.layout === value ? "is-on" : ""}`, "aria-pressed": String(this.layout === value),
      onclick: () => { if (this.layout !== value) { this.layout = value; store.set("diffLayout", value); this.build(); this.renderToolbar(); } },
    }, label);
    fill(this.toolbar, 
      h("div", { class: "segmented", role: "group", "aria-label": "Diff layout" }, seg("inline", "Inline"), seg("split", "Side by side")),
      h("div", { class: "chunk-nav" },
        h("button", { class: "icon-btn", title: "Previous change (Alt+↑)", "aria-label": "Previous change", onclick: () => this.jump(-1), html: '<svg viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg>' }),
        h("span", { class: "chunk-count" }, count === 0 ? "No differences" : `${count} ${count === 1 ? "change" : "changes"}`),
        h("button", { class: "icon-btn", title: "Next change (Alt+↓)", "aria-label": "Next change", onclick: () => this.jump(1), html: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>' }),
      ),
      h("div", { class: "toolbar-spacer" }),
      c.edited ? h("button", { class: "btn btn-quiet", onclick: () => this.resetEdits(), title: "Go back to the agent's proposal" }, "Undo my edits") : null,
      c.origin === "user" ? h("button", { class: "btn btn-quiet", onclick: () => this.session.removeFile(c.path) }, "Remove from review") : null,
      h("button", { class: `btn btn-reject ${c.status === "rejected" ? "is-on" : ""}`, onclick: () => this.session.setStatus(c.path, "rejected") }, c.status === "rejected" ? "Rejected" : "Reject"),
      h("button", { class: `btn btn-accept ${c.status === "accepted" ? "is-on" : ""}`, onclick: () => this.session.setStatus(c.path, "accepted") }, c.status === "accepted" ? "Accepted" : "Accept"),
    );
  }

  extensions() {
    return editorExtensions({
      onChange: (text) => { this.session.saveWorking(this.path, text); },
      keys: [
        { key: "Alt-ArrowDown", run: goToNextChunk },
        { key: "Alt-ArrowUp", run: goToPreviousChunk },
      ],
    });
  }

  build() {
    const c = this.c;
    this.view?.destroy();
    this.mv?.destroy();
    this.view = this.mv = null;
    this.host.replaceChildren();
    const collapse = { margin: 3, minSize: 8 };
    const counter = EditorView.updateListener.of(() => this._countSoon());
    if (this.layout === "split") {
      this.mv = new MergeView({
        parent: this.host,
        a: { doc: c.original, extensions: [editorExtensions({ readOnly: true })] },
        b: { doc: c.working, extensions: [this.extensions(), counter] },
        revertControls: "a-to-b",
        highlightChanges: true,
        gutter: true,
        collapseUnchanged: collapse,
      });
      this.mv.dom.classList.add("merge-split");
      this.host.prepend(h("div", { class: "split-labels" },
        h("span", {}, c.action === "create" ? "Nothing yet (new note)" : "Current note"),
        h("span", {}, "Proposed (edit here)")));
    } else {
      this.view = new EditorView({
        parent: this.host,
        state: EditorState.create({
          doc: c.working,
          extensions: [
            this.extensions(), counter,
            unifiedMergeView({ original: c.original, mergeControls: true, highlightChanges: true, gutter: true, syntaxHighlightDeletions: true, collapseUnchanged: collapse }),
          ],
        }),
      });
    }
  }

  editor() { return this.view || this.mv?.b; }

  chunkCount() {
    if (this.mv) return this.mv.chunks.length;
    if (this.view) return getChunks(this.view.state)?.chunks.length ?? 0;
    return 0;
  }

  _countSoon() {
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => {
      const el = this.toolbar.querySelector(".chunk-count");
      const n = this.chunkCount();
      if (el) el.textContent = n === 0 ? "No differences" : `${n} ${n === 1 ? "change" : "changes"}`;
      const undo = this.c?.edited;
      if (!!this.toolbar.querySelector('[title="Go back to the agent\'s proposal"]') !== !!undo) this.renderToolbar();
    });
  }

  jump(dir) {
    const ed = this.editor();
    if (!ed) return;
    (dir > 0 ? goToNextChunk : goToPreviousChunk)(ed);
    ed.focus();
  }

  async resetEdits() {
    const c = this.c;
    if (!(await confirmDialog({ title: "Undo your edits?", body: `${stem(c.path)} goes back to the agent's proposal.`, confirm: "Undo my edits" }))) return;
    this.session.saveWorking(c.path, c.proposed);
    this.build();
    this.renderToolbar();
  }

  onShow() {
    this.session.showSources(this.path);
    this.editor()?.requestMeasure();
  }

  destroy() {
    this.view?.destroy();
    this.mv?.destroy();
  }
}
