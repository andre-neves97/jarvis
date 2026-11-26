import { EditorView, keymap, drawSelection, highlightActiveLine, placeholder as cmPlaceholder } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle, indentUnit } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "650", fontSize: "1.18em" },
  { tag: t.heading2, fontWeight: "650", fontSize: "1.1em" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "650" },
  { tag: t.strong, fontWeight: "650" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--ink-3)" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "var(--ink-3)" },
  { tag: t.monospace, color: "var(--ink-2)" },
  { tag: t.quote, color: "var(--ink-2)" },
]);

export const baseTheme = EditorView.theme({
  "&": { color: "var(--ink)", backgroundColor: "transparent", fontSize: "13.5px" },
  ".cm-content": { fontFamily: "var(--font-mono)", caretColor: "var(--accent)", padding: "10px 0" },
  ".cm-line": { padding: "0 14px" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "var(--select) !important" },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--ink-3)" },
  ".cm-placeholder": { color: "var(--ink-3)" },
});

export function editorExtensions({ onChange, onCursor, keys = [], placeholder, readOnly = false } = {}) {
  return [
    history(),
    drawSelection(),
    highlightActiveLine(),
    indentUnit.of("  "),
    keymap.of([...keys, indentWithTab, ...defaultKeymap, ...historyKeymap]),
    markdown({ base: markdownLanguage }), // GFM: tables, strikethrough, task lists
    syntaxHighlighting(mdHighlight),
    EditorView.lineWrapping,
    baseTheme,
    placeholder ? cmPlaceholder(placeholder) : [],
    readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
    onChange ? EditorView.updateListener.of((u) => { if (u.docChanged) onChange(u.state.doc.toString(), u); }) : [],
    onCursor ? EditorView.updateListener.of((u) => { if (u.docChanged || u.selectionSet || u.focusChanged) onCursor(u.view); }) : [],
  ];
}

export function createEditor(parent, doc, opts = {}) {
  return new EditorView({ parent, state: EditorState.create({ doc, extensions: editorExtensions(opts) }) });
}
