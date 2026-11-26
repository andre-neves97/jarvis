/**
 * Word-style formatting for the Markdown editors: commands that edit the Markdown
 * source (so files stay plain .md), plus the toolbar that drives them.
 */
import { EditorSelection } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { undo, redo } from "@codemirror/commands";
import { h } from "./util.js";

// ---------- inline marks (bold, italic, strikethrough, code) ----------

const INLINE = {
  bold: { mark: "**", node: "StrongEmphasis" },
  italic: { mark: "*", node: "Emphasis" },
  strike: { mark: "~~", node: "Strikethrough" },
  code: { mark: "`", node: "InlineCode" },
};

/** The syntax node of `type` enclosing the range, if any. */
function enclosing(state, from, to, type) {
  for (let n = syntaxTree(state).resolveInner(from, 1); n; n = n.parent) {
    if (n.name === type && n.from <= from && n.to >= to) return n;
  }
  if (from !== to) return null;
  for (let n = syntaxTree(state).resolveInner(from, -1); n; n = n.parent) {
    if (n.name === type && n.from <= from && n.to >= to) return n;
  }
  return null;
}

function toggleInline(kind) {
  const { mark, node } = INLINE[kind];
  return (view) => {
    const { state } = view;
    const tr = state.changeByRange((range) => {
      const found = enclosing(state, range.from, range.to, node);
      if (found) {
        // Remove the marks around the existing span; keep the selection on the same text.
        const ml = found.firstChild && found.firstChild.to - found.firstChild.from || mark.length;
        const mr = found.lastChild && found.lastChild.to - found.lastChild.from || mark.length;
        const changes = [{ from: found.from, to: found.from + ml }, { from: found.to - mr, to: found.to }];
        const map = (p) => Math.min(Math.max(p - ml, found.from), found.to - ml - mr);
        return { changes, range: EditorSelection.range(map(range.anchor), map(range.head)) };
      }
      if (range.empty) {
        // Word-like: on an empty selection, format the word under the cursor, or start a new span.
        const word = state.wordAt(range.head);
        if (word) {
          return {
            changes: [{ from: word.from, insert: mark }, { from: word.to, insert: mark }],
            range: EditorSelection.cursor(range.head + mark.length),
          };
        }
        return { changes: { from: range.from, insert: mark + mark }, range: EditorSelection.cursor(range.from + mark.length) };
      }
      // Keep surrounding spaces outside the marks ("**word** " not "**word **").
      const text = state.sliceDoc(range.from, range.to);
      const from = range.from + (text.length - text.trimStart().length);
      const to = range.to - (text.length - text.trimEnd().length);
      if (from >= to) return { range };
      return {
        changes: [{ from, insert: mark }, { from: to, insert: mark }],
        range: EditorSelection.range(from + mark.length, to + mark.length),
      };
    });
    view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.format" }));
    view.focus();
    return true;
  };
}

// ---------- line styles (headings, lists, quote) ----------

const HEADING = /^(#{1,6})\s+/;
const LIST = /^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/;
const QUOTE = /^>\s?/;

function selectedLines(state) {
  const lines = new Map();
  for (const r of state.selection.ranges) {
    // A selection ending at the very start of a line doesn't include that line.
    const end = r.to > r.from && state.doc.lineAt(r.to).from === r.to ? r.to - 1 : r.to;
    const last = state.doc.lineAt(end);
    for (let n = state.doc.lineAt(r.from).number; n <= last.number; n++) lines.set(n, state.doc.line(n));
  }
  return [...lines.values()];
}

/** Rewrite each selected line's prefix via fn(text, index) -> new text. */
function mapLines(view, fn) {
  const { state } = view;
  const lines = selectedLines(state);
  const changes = lines.map((line, i) => {
    const old = line.text, next = fn(old, i, lines);
    if (next === old) return null;
    // Only replace the prefix that changed, so the cursor stays where it was in the text.
    let keep = 0;
    while (keep < old.length && keep < next.length && old[old.length - 1 - keep] === next[next.length - 1 - keep]) keep++;
    return { from: line.from, to: line.to - keep, insert: next.slice(0, next.length - keep) };
  }).filter(Boolean);
  if (changes.length) view.dispatch({ changes, scrollIntoView: true, userEvent: "input.format" });
  view.focus();
  return true;
}

const stripBlock = (t) => t.replace(HEADING, "").replace(QUOTE, "").replace(LIST, "$1");

export function setHeading(level) {
  return (view) => mapLines(view, (t) => {
    const body = t.replace(HEADING, "").replace(LIST, "$1").trimStart();
    return level ? `${"#".repeat(level)} ${body}` : body;
  });
}

const LIST_KINDS = {
  bullet: { test: /^\s*[-*+]\s+(?!\[[ xX]\])/, make: () => "- " },
  number: { test: /^\s*\d+[.)]\s+/, make: (i) => `${i + 1}. ` },
  task: { test: /^\s*[-*+]\s+\[[ xX]\]\s+/, make: () => "- [ ] " },
};

function toggleList(kind) {
  const { test, make } = LIST_KINDS[kind];
  return (view) => {
    const lines = selectedLines(view.state).filter((l) => l.text.trim());
    const all = lines.length && lines.every((l) => test.test(l.text));
    let i = 0;
    return mapLines(view, (t) => {
      if (!t.trim() && lines.length) return t;
      if (all) return t.replace(LIST, "$1");
      const indent = t.match(/^\s*/)[0];
      return indent + make(i++) + stripBlock(t).trimStart();
    });
  };
}

function toggleQuote(view) {
  const lines = selectedLines(view.state);
  const all = lines.every((l) => QUOTE.test(l.text));
  return mapLines(view, (t) => (all ? t.replace(QUOTE, "") : `> ${t}`));
}

// ---------- inserts ----------

/** Put `text` on its own lines at the cursor, with blank lines around so it parses as a block. */
function insertBlock(text, selectFrom = 0, selectLen = 0) {
  return (view) => {
    const { doc } = view.state;
    const line = doc.lineAt(view.state.selection.main.head);
    const prev = line.number > 1 ? doc.line(line.number - 1).text : "";
    const next = line.number < doc.lines ? doc.line(line.number + 1).text : "";
    // On a blank line, replace it; otherwise add the block below the current line.
    const blank = !line.text.trim();
    const from = blank ? line.from : line.to;
    const before = blank ? (prev.trim() ? "\n" : "") : "\n\n";
    const after = next.trim() ? "\n" : "";
    const start = from + before.length + selectFrom;
    view.dispatch({ changes: { from, to: line.to, insert: before + text + after },
      selection: EditorSelection.range(start, start + selectLen), scrollIntoView: true, userEvent: "input.format" });
    view.focus();
    return true;
  };
}

function codeBlock(view) {
  const r = view.state.selection.main;
  if (!r.empty) {
    const lines = selectedLines(view.state);
    const from = lines[0].from, to = lines[lines.length - 1].to;
    const body = view.state.sliceDoc(from, to);
    view.dispatch({ changes: { from, to, insert: "```\n" + body + "\n```" }, selection: EditorSelection.cursor(from + 3), userEvent: "input.format" });
    view.focus();
    return true;
  }
  return insertBlock("```\n\n```", 4, 0)(view);
}

function link(view) {
  const { state } = view;
  const r = state.selection.main;
  const existing = enclosing(state, r.from, r.to, "Link");
  if (existing) { // select the URL so it can be retyped
    const url = existing.getChild("URL");
    if (url) view.dispatch({ selection: EditorSelection.range(url.from, url.to) });
    view.focus();
    return true;
  }
  const text = state.sliceDoc(r.from, r.to);
  const looksUrl = /^(https?:\/\/|www\.)\S+$/.test(text.trim());
  if (looksUrl) {
    view.dispatch({ changes: { from: r.from, to: r.to, insert: `[link](${text.trim()})` }, selection: EditorSelection.range(r.from + 1, r.from + 5), userEvent: "input.format" });
  } else {
    const label = text || "link text";
    const insert = `[${label}](url)`;
    const urlAt = r.from + label.length + 3;
    const sel = text ? EditorSelection.range(urlAt, urlAt + 3) : EditorSelection.range(r.from + 1, r.from + 1 + label.length);
    view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: sel, userEvent: "input.format" });
  }
  view.focus();
  return true;
}

const TABLE = "| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |";

export const commands = {
  bold: toggleInline("bold"),
  italic: toggleInline("italic"),
  strike: toggleInline("strike"),
  code: toggleInline("code"),
  link,
  bullet: toggleList("bullet"),
  number: toggleList("number"),
  task: toggleList("task"),
  quote: toggleQuote,
  codeBlock,
  rule: insertBlock("---\n", 4), // cursor lands on a fresh line below the divider
  table: insertBlock(TABLE, 2, 8),
  undo: (v) => { undo(v); v.focus(); return true; },
  redo: (v) => { redo(v); v.focus(); return true; },
};

/** Keyboard shortcuts, Word-like where Word has one. */
export const formatKeys = [
  { key: "Mod-b", run: commands.bold },
  { key: "Mod-i", run: commands.italic },
  { key: "Mod-k", run: commands.link },
  { key: "Mod-e", run: commands.code },
  { key: "Mod-Shift-x", run: commands.strike },
  { key: "Mod-Shift-8", run: commands.bullet },
  { key: "Mod-Shift-7", run: commands.number },
  { key: "Mod-Shift-9", run: commands.task },
  { key: "Mod-Alt-0", run: setHeading(0) },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ key: `Mod-Alt-${n}`, run: setHeading(n) })),
];

// ---------- active state, for lighting up toolbar buttons ----------

function activeState(view) {
  const { state } = view;
  const r = state.selection.main;
  const line = state.doc.lineAt(r.head).text;
  const heading = line.match(HEADING);
  const inline = {};
  for (const [k, { node }] of Object.entries(INLINE)) inline[k] = !!enclosing(state, r.from, r.to, node);
  return {
    ...inline,
    link: !!enclosing(state, r.from, r.to, "Link"),
    style: heading ? heading[1].length : 0,
    bullet: LIST_KINDS.bullet.test.test(line),
    number: LIST_KINDS.number.test.test(line),
    task: LIST_KINDS.task.test.test(line),
    quote: QUOTE.test(line),
  };
}

// ---------- toolbar ----------

const ICONS = {
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  bullet: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/>',
  number: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 4.5h1.5V9M4 9h3M4 14.5c.3-.6.9-1 1.6-1 .9 0 1.4.6 1.4 1.3 0 1.2-3 2-3 3.7h3"/>',
  task: '<rect x="3.5" y="4.5" width="6" height="6" rx="1"/><path d="m4.8 7.6 1.3 1.3 2.4-2.6"/><rect x="3.5" y="13.5" width="6" height="6" rx="1"/><path d="M13 7.5h7.5M13 16.5h7.5"/>',
  quote: '<path d="M5 18v-5.5C5 9 6.5 7 9.5 6.5M14 18v-5.5C14 9 15.5 7 18.5 6.5"/><path d="M5 13h4v5H5zM14 13h4v5h-4z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  code: '<path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5"/>',
  codeBlock: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="m9.5 10-2 2 2 2M14.5 10l2 2-2 2"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10M14.5 9.5v10"/>',
  rule: '<path d="M3.5 12h17"/><path d="M7 7.5h10M7 16.5h10" opacity=".35"/>',
};

const STYLES = [
  { level: 0, label: "Normal text", hint: "Ctrl+Alt+0" },
  { level: 1, label: "Heading 1", hint: "Ctrl+Alt+1" },
  { level: 2, label: "Heading 2", hint: "Ctrl+Alt+2" },
  { level: 3, label: "Heading 3", hint: "Ctrl+Alt+3" },
  { level: 4, label: "Heading 4", hint: "Ctrl+Alt+4" },
  { level: 5, label: "Heading 5", hint: "Ctrl+Alt+5" },
  { level: 6, label: "Heading 6", hint: "Ctrl+Alt+6" },
];

/**
 * A toolbar bound to whichever editor the note is using. `getView(start)` returns the
 * active EditorView; with start=true it may open one (so the toolbar is never dead).
 */
export class FormatToolbar {
  constructor({ getView }) {
    this.getView = getView;
    this.buttons = {};
    // mousedown preventDefault keeps focus (and the open block) in the editor.
    const keep = (e) => e.preventDefault();
    const run = (cmd) => () => { const v = this.getView(true); if (v) { cmd(v); this.update(v); } };

    const btn = (name, title, content, cmd) => {
      const b = h("button", { class: "fmt-btn", type: "button", title, "aria-label": title.split(" (")[0], "aria-pressed": "false",
        onmousedown: keep, onclick: run(cmd) });
      if (content.startsWith("<")) b.innerHTML = `<svg viewBox="0 0 24 24">${content}</svg>`;
      else b.append(h("span", { class: `fmt-glyph fmt-${name}` }, content));
      this.buttons[name] = b;
      return b;
    };
    const sep = () => h("span", { class: "fmt-sep", "aria-hidden": "true" });

    this.styleLabel = h("span", { class: "fmt-style-label" }, "Normal text");
    this.styleBtn = h("button", { class: "fmt-style", type: "button", title: "Text style", "aria-haspopup": "menu", "aria-expanded": "false",
      onmousedown: keep, onclick: () => this.toggleMenu() }, this.styleLabel, h("span", { class: "fmt-caret", "aria-hidden": "true" }));
    this.menu = h("div", { class: "fmt-menu", role: "menu", hidden: true },
      ...STYLES.map((s) => h("button", { class: `fmt-menu-item fmt-h${s.level}`, type: "button", role: "menuitem", "data-level": s.level,
        onmousedown: keep, onclick: () => { this.closeMenu(); run(setHeading(s.level))(); } },
      h("span", {}, s.label), h("kbd", {}, s.hint))));

    this.el = h("div", { class: "fmt-bar", role: "toolbar", "aria-label": "Formatting" },
      btn("undo", "Undo (Ctrl+Z)", ICONS.undo, commands.undo),
      btn("redo", "Redo (Ctrl+Y)", ICONS.redo, commands.redo),
      sep(),
      h("div", { class: "fmt-style-wrap" }, this.styleBtn, this.menu),
      sep(),
      btn("bold", "Bold (Ctrl+B)", "B", commands.bold),
      btn("italic", "Italic (Ctrl+I)", "I", commands.italic),
      btn("strike", "Strikethrough (Ctrl+Shift+X)", "S", commands.strike),
      btn("code", "Inline code (Ctrl+E)", ICONS.code, commands.code),
      btn("link", "Link (Ctrl+K)", ICONS.link, commands.link),
      sep(),
      btn("bullet", "Bulleted list (Ctrl+Shift+8)", ICONS.bullet, commands.bullet),
      btn("number", "Numbered list (Ctrl+Shift+7)", ICONS.number, commands.number),
      btn("task", "Checklist (Ctrl+Shift+9)", ICONS.task, commands.task),
      btn("quote", "Quote", ICONS.quote, commands.quote),
      sep(),
      btn("codeBlock", "Code block", ICONS.codeBlock, commands.codeBlock),
      btn("table", "Insert table", ICONS.table, commands.table),
      btn("rule", "Divider line", ICONS.rule, commands.rule),
    );
    this._outside = (e) => { if (!this.menu.hidden && !e.target.closest(".fmt-style-wrap")) this.closeMenu(); };
    document.addEventListener("mousedown", this._outside);
    this.update(null);
  }

  toggleMenu() { this.menu.hidden ? this.openMenu() : this.closeMenu(); }
  openMenu() {
    this.menu.hidden = false;
    this.styleBtn.setAttribute("aria-expanded", "true");
  }
  closeMenu() {
    this.menu.hidden = true;
    this.styleBtn.setAttribute("aria-expanded", "false");
  }

  /** Reflect the cursor position: which marks and style apply. */
  update(view) {
    const s = view ? activeState(view) : {};
    this.el.classList.toggle("is-idle", !view);
    for (const [name, b] of Object.entries(this.buttons)) {
      const on = !!s[name];
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    }
    const level = s.style || 0;
    this.styleLabel.textContent = STYLES[level].label;
    for (const item of this.menu.children) item.classList.toggle("is-on", +item.dataset.level === level);
  }

  destroy() { document.removeEventListener("mousedown", this._outside); }
}
