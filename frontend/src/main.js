import "@fontsource/schibsted-grotesk/400.css";
import "@fontsource/schibsted-grotesk/500.css";
import "@fontsource/schibsted-grotesk/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource-variable/newsreader/opsz-italic.css";
import "./styles.css";

import { api } from "./api.js";
import { Workspace } from "./workspace.js";
import { NoteView } from "./noteView.js";
import { TodoView } from "./todoView.js";
import { ReviewSession } from "./review.js";
import { NotesPanel, SearchPanel, InboxPanel } from "./sidebar.js";
import { HomeView } from "./home.js";
import { bootSequence } from "./boot.js";
import { h, stem, store, debounce, toast } from "./util.js";

const sidebar = document.getElementById("sidebar");
let info = { agent: "none", agent_label: "agent", agent_available: false, todo_file: "todo.md" };
let mode = "notes";
let session = null;

const ws = new Workspace(document.getElementById("workspace"), { onChange: () => { notes.render(); persistTabs(); } });

function openNote(path, opts = {}) {
  if (path === info.todo_file && !opts.asText) return openTodo(opts);
  ws.open({ key: `note:${path}`, kind: "note", title: stem(path), tooltip: path, create: () => new NoteView(path, { open: openNote }) }, opts);
}

function openHome() {
  ws.open({ key: "home", kind: "home", title: "Home",
    create: () => new HomeView({ info, openNote, openTodo, openInbox: () => setMode("inbox"), startReview }) }, { pane: 0 });
}

function openTodo(opts = {}) {
  ws.open({ key: "todo", kind: "todo", title: "To-do",
    create: () => new TodoView(info.todo_file, { openSource: (p) => openNote(p, { asText: true, other: true }) }) }, opts);
}

const activePath = () => ws.activeView()?.path ?? null;
const notes = new NotesPanel({ open: openNote, activePath, openInbox: () => setMode("inbox") });
const search = new SearchPanel({ open: openNote });
let inbox;

async function startReview(id, manual = false) {
  try {
    if (manual) await api.manual(id);
    session?.close();
    session = new ReviewSession(id, {
      ws, openNote, getPaths: () => notes.paths(),
      onExit: () => {
        session = null; setMode("inbox"); inbox.load(); notes.load();
        ws.allTabs().find((t) => t.kind === "home")?.view.reloadInbox();
      },
    });
    await session.load();
    setMode("review");
    session.start();
  } catch (e) { toast(e.message, "error"); }
}

function setMode(next) {
  if (next === "todo") { openTodo(); return; }
  if (next === "home") { openHome(); return; }
  if (next === "inbox" && session) next = "review";
  mode = next;
  const panel = { notes: notes.el, search: search.el, inbox: inbox.el, review: session?.panel }[mode];
  sidebar.replaceChildren(panel || notes.el);
  for (const b of document.querySelectorAll(".rail-btn[data-mode]")) {
    const m = b.dataset.mode;
    b.classList.toggle("is-on", m === mode || (m === "inbox" && mode === "review"));
  }
  if (mode === "search") search.focus();
  if (mode === "inbox") inbox.load();
  store.set("mode", mode === "review" ? "inbox" : mode);
}

function persistTabs() {
  const tabs = ws.allTabs().filter((t) => t.kind === "note" || t.kind === "todo")
    .map((t) => ({ pane: t.pane, kind: t.kind, path: t.view.path }));
  store.set("tabs", tabs);
}

function restoreTabs() {
  for (const t of store.get("tabs", [])) {
    if (t.kind === "todo") openTodo({ pane: t.pane });
    else if (t.path) openNote(t.path, { pane: t.pane });
  }
}

/** The "lamp": the rail's Inbox icon glows while Jarvis works or has proposals waiting. */
function setLamp(items) {
  const busy = items.some((i) => i.status === "running" || i.status === "queued");
  const ready = items.some((i) => i.status === "review");
  const btn = document.querySelector('.rail-btn[data-mode="inbox"]');
  btn.classList.toggle("is-lamp", busy || ready);
  btn.classList.toggle("is-busy", busy);
}

// ---------- live updates from disk (OneDrive sync, AI agents, other editors) ----------

function listen() {
  const reloadTree = debounce(() => notes.load(), 400);
  const reloadInbox = debounce(() => inbox.load(), 400);
  const reloadHome = debounce(() => ws.allTabs().find((t) => t.kind === "home")?.view.reloadInbox(), 400);
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    const evt = JSON.parse(m.data);
    if (evt.path.startsWith(".jarvis/")) { reloadInbox(); reloadHome(); return; }
    ws.notify(evt);
    if (evt.type !== "modified") reloadTree();
    if (evt.path.startsWith("ProcessingBay/")) reloadInbox();
  };
}

// ---------- theme ----------

const themeBtn = document.getElementById("theme-btn");
function setTheme(theme) {
  const dark = theme === "dark";
  if (dark) document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  themeBtn.setAttribute("aria-pressed", String(dark));
  themeBtn.title = `${dark ? "Light" : "Dark"} mode (Ctrl+Shift+L)`;
  themeBtn.setAttribute("aria-label", `${dark ? "Light" : "Dark"} mode`);
  store.set("theme", dark ? "dark" : "light");
}
const toggleTheme = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
setTheme(store.get("theme", "light"));
themeBtn.addEventListener("click", toggleTheme);

// ---------- keyboard ----------

document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || e.defaultPrevented) return; // editors handle their own shortcuts (Ctrl+K = link there)
  if (e.shiftKey && e.key.toLowerCase() === "l") { e.preventDefault(); toggleTheme(); return; }
  if (e.key === "k" || e.key === "p") { e.preventDefault(); setMode("search"); }
  else if (e.key === "1") { e.preventDefault(); setMode("notes"); }
  else if (e.key === "2") { e.preventDefault(); setMode("inbox"); }
  else if (e.key === "3") { e.preventDefault(); setMode("todo"); }
  else if (e.key === "\\") { e.preventDefault(); ws.setSplit(!ws.split); }
});

for (const b of document.querySelectorAll(".rail-btn[data-mode]")) b.addEventListener("click", () => setMode(b.dataset.mode));
document.getElementById("split-btn").addEventListener("click", () => ws.setSplit(!ws.split));

window.addEventListener("beforeunload", () => { for (const t of ws.allTabs()) t.view.destroy?.(); });

// ---------- boot ----------

(async function boot() {
  const seq = bootSequence();
  try {
    info = await api.info();
  } catch {
    seq.line("Core", "offline", "bad");
    await seq.finish();
    sidebar.replaceChildren(h("p", { class: "notice" }, "Jarvis can't reach its local server. Start it with start.bat and reload this page."));
    return;
  }
  seq.line("Core", "online");
  inbox = new InboxPanel({
    info, open: openNote, startReview,
    onCount: (n) => { const b = document.getElementById("inbox-badge"); b.hidden = !n; b.textContent = n; },
    onLoad: (items) => { notes.setStatus(items); setLamp(items); },
  });
  await notes.load();
  const count = notes.items.filter((i) => i.type === "file" && i.ext === ".md" && !i.path.startsWith("Archive/")).length;
  seq.line("Knowledge base", `${count} notes`);
  setMode(store.get("mode", "notes"));
  await inbox.load().catch(() => {});
  const fresh = inbox.items.filter((i) => i.status === "new").length;
  const ready = inbox.items.filter((i) => i.status === "review").length;
  seq.line("Inbox", [fresh && `${fresh} new`, ready && `${ready} to review`].filter(Boolean).join(", ") || "clear");
  if (info.agent !== "none") seq.line(info.agent_label, info.agent_available ? "online" : "not found", info.agent_available ? "ok" : "bad");
  restoreTabs();
  openHome(); // Jarvis always opens on Home
  listen();
  await seq.finish();
})();
