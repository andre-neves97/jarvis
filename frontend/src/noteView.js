import MarkdownIt from "markdown-it";
import { api } from "./api.js";
import { createEditor } from "./editor.js";
import { FormatToolbar, formatKeys } from "./format.js";
import { h, stem, dirname, resolveLink, debounce, toast } from "./util.js";

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

// GitHub-style task list checkboxes, rendered read-only (clicks handled by the view).
md.core.ruler.after("inline", "tasks", (state) => {
  for (const tok of state.tokens) {
    if (tok.type !== "inline" || !tok.children?.length) continue;
    const first = tok.children[0];
    const m = first.type === "text" && first.content.match(/^\[([ xX])\]\s/);
    if (m) {
      first.content = first.content.slice(m[0].length);
      const box = new state.Token("html_inline", "", 0);
      box.content = `<input type="checkbox" class="task-box" ${m[1] !== " " ? "checked" : ""} tabindex="-1"> `;
      tok.children.unshift(box);
    }
  }
});

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

/** Split markdown source into top-level blocks with exact source line ranges. */
export function splitBlocks(source) {
  const blocks = [];
  let body = source, offset = 0;
  const fm = source.match(FRONTMATTER);
  if (fm) {
    const lines = fm[0].replace(/\n$/, "").split("\n").length;
    blocks.push({ start: 0, end: lines, kind: "frontmatter", raw: fm[1] });
    body = source.slice(fm[0].length);
    offset = lines;
  }
  const env = {};
  const tokens = md.parse(body, env);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.level !== 0 || !tok.map) continue;
    let j = i;
    if (tok.nesting === 1) {
      let depth = 0;
      for (j = i; j < tokens.length; j++) {
        depth += tokens[j].nesting;
        if (depth === 0) break;
      }
    }
    blocks.push({
      start: tok.map[0] + offset, end: tok.map[1] + offset, kind: tok.type,
      html: md.renderer.render(tokens.slice(i, j + 1), md.options, env),
    });
    i = j;
  }
  return blocks;
}

function renderFrontmatter(raw) {
  const rows = raw.split("\n").map((l) => l.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean);
  return h("dl", { class: "frontmatter" }, rows.flatMap(([, k, v]) => [h("dt", {}, k.replace(/_/g, " ")), h("dd", {}, v)]));
}

/**
 * A note shown as formatted text. Clicking a block swaps in an editor holding exactly
 * that block's source lines, so saving never reformats the rest of the file.
 */
export class NoteView {
  constructor(path, { open, readOnly = false } = {}) {
    this.path = path;
    this.openLink = open;
    this.readOnly = readOnly;
    this.source = "";
    this.sha = null;
    this.mode = "read";
    this.editing = null; // { index, view }
    this.highlights = [];
    this.saveSoon = debounce(() => this.save(), 600);

    this.banner = h("div", { class: "banner", hidden: true });
    this.doc = h("article", { class: "note-doc", onclick: (e) => this._onDocClick(e) });
    this.links = h("footer", { class: "backlinks" });
    this.modeBtn = h("button", { class: "btn btn-quiet", onclick: () => this.setMode(this.mode === "read" ? "source" : "read") }, "Edit source");
    // Word-style formatting bar; with nothing open for editing, using it starts a new paragraph.
    this.toolbar = readOnly ? null : new FormatToolbar({
      getView: (start) => {
        const v = this.sourceView || this.editing?.view;
        if (v || !start || this.mode !== "read") return v || null;
        this._edit(this.blocks.length);
        return this.editing?.view || null;
      },
    });
    const crumbs = dirname(path).split("/").filter(Boolean).filter((c, i, a) => !(i === a.length - 1 && c === stem(path)));
    this.el = h("div", { class: "view note-view" },
      h("div", { class: "view-bar" },
        h("div", { class: "crumbs" }, ...crumbs.map((c) => h("span", { class: "crumb" }, c)), h("span", { class: "crumb crumb-file" }, stem(path))),
        this.readOnly ? h("span", { class: "pill" }, "Read only") : this.modeBtn,
      ),
      this.toolbar?.el,
      this.banner,
      h("div", { class: "note-scroll" }, this.doc, this.links),
    );
    this.load();
  }

  get title() { return stem(this.path); }
  get dirty() { return !!this.editing || this.saveSoon.pending; }

  async load() {
    try {
      const f = await api.read(this.path);
      this.source = f.content;
      this.sha = f.sha;
      this.render();
      this.loadBacklinks();
    } catch (e) {
      this.doc.replaceChildren(h("p", { class: "muted" }, `This note could not be opened: ${e.message}`));
    }
  }

  async loadBacklinks() {
    try {
      const links = await api.backlinks(this.path);
      this.links.replaceChildren(...(links.length ? [
        h("h3", {}, `Linked from ${links.length} ${links.length === 1 ? "note" : "notes"}`),
        h("ul", {}, links.map((l) => h("li", {}, h("a", { href: "#", "data-path": l.path, onclick: (e) => { e.preventDefault(); this.openLink(l.path, { other: e.ctrlKey || e.metaKey }); } }, stem(l.path))))),
      ] : []));
    } catch { /* non-essential */ }
  }

  setMode(mode) {
    this._commitEditing();
    this.mode = mode;
    this.modeBtn.textContent = mode === "read" ? "Edit source" : "Done";
    this.render();
  }

  render() {
    this.editing?.view.destroy();
    this.editing = null;
    if (this.mode === "source") {
      const host = h("div", { class: "source-editor" });
      this.doc.replaceChildren(host);
      this.sourceView = createEditor(host, this.source, {
        onChange: (text) => { this.source = text; this.saveSoon(); },
        onCursor: (v) => this.toolbar?.update(v),
        keys: [{ key: "Mod-s", run: () => { this.saveSoon.flush(); return true; } }, ...formatKeys],
      });
      this.sourceView.focus();
      this.toolbar?.update(this.sourceView);
      return;
    }
    this.sourceView?.destroy();
    this.sourceView = null;
    this.toolbar?.update(null);
    this.blocks = splitBlocks(this.source);
    const els = this.blocks.map((b, i) => {
      const el = b.kind === "frontmatter"
        ? h("div", { class: "block block-frontmatter", "data-i": i }, renderFrontmatter(b.raw))
        : h("div", { class: `block block-${b.kind}`, "data-i": i, html: b.html });
      for (const img of el.querySelectorAll("img")) {
        const target = resolveLink(this.path, img.getAttribute("src") || "");
        if (target) img.src = api.rawUrl(target);
      }
      return el;
    });
    const tail = this.readOnly ? [] : [h("div", { class: "block-add", "data-add": "1", tabindex: "0", role: "button" },
      this.blocks.length ? "Click to add a paragraph" : "This note is empty. Click to start writing.")];
    this.doc.replaceChildren(...els, ...tail);
    this._applyHighlights();
  }

  _onDocClick(e) {
    const a = e.target.closest("a[href]");
    if (a && !a.dataset.path) {
      e.preventDefault();
      const href = a.getAttribute("href");
      const target = resolveLink(this.path, href);
      if (target) this.openLink(target, { other: e.ctrlKey || e.metaKey || e.shiftKey });
      else if (!href.startsWith("#")) window.open(href, "_blank", "noopener");
      return;
    }
    if (this.readOnly || this.mode !== "read") return;
    if (e.target.matches("input.task-box")) {
      e.preventDefault();
      this._toggleTask(e.target);
      return;
    }
    if (e.target.closest(".cm-editor")) return;
    if (window.getSelection()?.toString()) return; // user is selecting text to copy
    if (e.target.closest("[data-add]")) return this._edit(this.blocks.length);
    const block = e.target.closest(".block");
    if (block) this._edit(+block.dataset.i);
  }

  _toggleTask(box) {
    const blockEl = box.closest(".block");
    const b = this.blocks[+blockEl.dataset.i];
    const boxes = [...blockEl.querySelectorAll("input.task-box")];
    let n = boxes.indexOf(box);
    const lines = this.source.split("\n");
    for (let li = b.start; li < b.end; li++) {
      if (/^\s*[-*+] \[[ xX]\]/.test(lines[li]) && n-- === 0) {
        lines[li] = lines[li].replace(/\[([ xX])\]/, (_, c) => (c === " " ? "[x]" : "[ ]"));
        break;
      }
    }
    this.source = lines.join("\n");
    this.render();
    this.saveSoon.flush();
  }

  /** Open block `index` for editing (index === blocks.length appends a new block). */
  _edit(index, cursorAtEnd = false) {
    this._commitEditing();
    const lines = this.source.split("\n");
    const isNew = index >= this.blocks.length;
    const b = isNew ? null : this.blocks[index];
    const text = isNew ? "" : lines.slice(b.start, b.end).join("\n");
    const el = isNew ? this.doc.querySelector("[data-add]") : this.doc.querySelector(`.block[data-i="${index}"]`);
    if (!el) return;
    const host = h("div", { class: "block block-editing" });
    el.replaceWith(host);
    const move = (dir) => (view) => {
      const sel = view.state.selection.main;
      const line = view.state.doc.lineAt(sel.head);
      const atEdge = dir < 0 ? line.number === 1 : line.number === view.state.doc.lines;
      if (!atEdge || !sel.empty) return false;
      const next = index + dir;
      if (next < 0 || next > this.blocks.length - (this.readOnly ? 1 : 0)) return false;
      this._commitEditing();
      this._edit(Math.min(next, this.blocks.length), dir < 0);
      return true;
    };
    const view = createEditor(host, text, {
      placeholder: "Start writing, or use the toolbar above to format. Esc to finish.",
      onCursor: (v) => { if (this.editing?.view === v) this.toolbar?.update(v); },
      keys: [
        ...formatKeys,
        { key: "Escape", run: () => { this._commitEditing(); return true; } },
        { key: "Mod-Enter", run: () => { this._commitEditing(); return true; } },
        { key: "Mod-s", run: () => { this._commitEditing(); return true; } },
        { key: "ArrowUp", run: move(-1) },
        { key: "ArrowDown", run: move(1) },
      ],
    });
    view.contentDOM.addEventListener("blur", () => setTimeout(() => {
      if (this.editing?.view === view && !host.contains(document.activeElement)) this._commitEditing();
    }, 120));
    this.editing = { index, isNew, view, original: text };
    view.focus();
    const pos = cursorAtEnd ? view.state.doc.length : 0;
    view.dispatch({ selection: { anchor: pos } });
    host.scrollIntoView({ block: "nearest" });
  }

  _commitEditing() {
    if (!this.editing) return;
    const { index, isNew, view, original } = this.editing;
    const text = view.state.doc.toString();
    this.editing = null;
    view.destroy();
    if (text !== original) {
      const lines = this.source.split("\n");
      if (isNew) {
        if (text.trim()) {
          while (lines.length && lines[lines.length - 1] === "") lines.pop();
          this.source = [...lines, ...(lines.length ? [""] : []), ...text.split("\n"), ""].join("\n");
        }
      } else {
        const b = this.blocks[index];
        lines.splice(b.start, b.end - b.start, ...(text === "" ? [] : text.split("\n")));
        this.source = lines.join("\n");
      }
      this.saveSoon.flush();
    }
    this.render();
  }

  async save(force = false) {
    if (this.readOnly) return;
    try {
      const r = await api.write(this.path, this.source, this.sha, force);
      this.sha = r.sha;
      this.banner.hidden = true;
    } catch (e) {
      if (e.status === 409 && e.data?.current) return this._conflict(e.data.current);
      toast(`Not saved: ${e.message}`, "error");
    }
  }

  _conflict(current) {
    this.banner.hidden = false;
    this.banner.replaceChildren(
      h("span", {}, "This note was changed outside Jarvis (OneDrive, an AI agent or another editor) while you were editing."),
      h("button", { class: "btn", onclick: () => { this.source = current.content; this.sha = current.sha; this.banner.hidden = true; this.render(); } }, "Use their version"),
      h("button", { class: "btn btn-primary", onclick: () => this.save(true) }, "Keep mine"),
    );
  }

  onShow() { this.sourceView?.requestMeasure(); }

  async onFileEvent(evt) {
    if (evt.path !== this.path || this.dirty) return;
    try {
      const f = await api.read(this.path);
      if (f.sha !== this.sha) { this.source = f.content; this.sha = f.sha; this.render(); }
    } catch {
      if (evt.type === "deleted") this.doc.replaceChildren(h("p", { class: "muted" }, "This note was moved or deleted."));
    }
  }

  /** Mark blocks whose text contains any of the given quotes (used by review). */
  highlight(quotes) {
    this.highlights = (quotes || []).filter(Boolean);
    this._applyHighlights(true);
  }

  _applyHighlights(scroll = false) {
    const norm = (s) => s.toLowerCase().replace(/[*_`>#]/g, "").replace(/\s+/g, " ").trim();
    const wanted = this.highlights.map(norm).filter((q) => q.length > 3);
    const matches = (el) => {
      const text = norm(el.textContent);
      return wanted.some((q) => text.includes(q) || (q.length > 60 && text.includes(q.slice(0, 60))));
    };
    let first = null;
    for (const el of this.doc.querySelectorAll(".is-source")) el.classList.remove("is-source");
    for (const el of this.doc.querySelectorAll(".block")) {
      if (!matches(el)) continue;
      // In lists and tables, mark only the items that hold the quote, not the whole block.
      const parts = [...el.querySelectorAll("li, tr")].filter((x) => !x.querySelector("li") && matches(x));
      const targets = parts.length ? parts : [el];
      for (const t of targets) t.classList.add("is-source");
      first ||= targets[0];
    }
    if (scroll && first) first.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  destroy() {
    if (this.editing) this._commitEditing();
    if (this.saveSoon.pending) this.saveSoon.flush();
    this.sourceView?.destroy();
    this.toolbar?.destroy();
  }
}
