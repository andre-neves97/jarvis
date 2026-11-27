import MarkdownIt from "markdown-it";
import { api, chat } from "./api.js";
import { parseTodos } from "./todoView.js";
import { h, fill, stem, daysFromToday, resolveLink } from "./util.js";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

function greeting() {
  const hr = new Date().getHours();
  return hr < 5 ? "Good evening." : hr < 12 ? "Good morning." : hr < 18 ? "Good afternoon." : "Good evening.";
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The living background: blurred light drifting on out-of-step loops, and a faint ring cluster turning. */
function aurora() {
  const rings = h("span", {
    class: "aurora-rings",
    html: `<svg viewBox="-200 -200 400 400">
      <circle class="ar ar-ticks" r="190"/>
      <circle class="ar ar-1" r="168" pathLength="360"/>
      <circle class="ar ar-2" r="140" pathLength="360"/>
      <circle class="ar ar-3" r="104"/>
      <circle class="ar ar-4" r="76" pathLength="360"/>
    </svg>`,
  });
  return h("div", { class: "home-aurora", "aria-hidden": "true" },
    h("span", { class: "blob blob-1" }), h("span", { class: "blob blob-2" }),
    h("span", { class: "blob blob-3" }), h("span", { class: "blob blob-4" }),
    rings);
}

/** Home: a greeting, one sentence on what needs you, and a chat bar to ask about your notes. */
export class HomeView {
  constructor({ info, openNote, openTodo, openInbox, startReview }) {
    Object.assign(this, { info, openNote, openTodo, openInbox, startReview });
    this.tasks = undefined; // undefined: loading, null: no to-do file
    this.items = null;
    this.messages = []; // {role, text, tools, sources, error}
    this.session = null;
    this.abort = null;

    this.summary = h("p", { class: "home-summary", "aria-live": "polite" }, " ");
    this.thread = h("div", { class: "chat-thread", "aria-live": "polite" });
    this.input = h("textarea", {
      class: "chat-input", rows: 1, "aria-label": "Ask Jarvis",
      placeholder: info.chat_available ? "Ask Jarvis about your notes, people, projects or to-dos" : "Chat needs Claude Code on this machine",
      disabled: !info.chat_available,
      onkeydown: (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.send(); }
        if (e.key === "Escape" && this.abort) { e.preventDefault(); this.stop(); }
      },
      oninput: () => this.autosize(),
    });
    this.sendBtn = h("button", { class: "chat-send", type: "submit", "aria-label": "Send", disabled: !info.chat_available },
      h("span", { html: '<svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg>' }));
    this.newBtn = h("button", { class: "btn btn-quiet chat-new", type: "button", onclick: () => this.reset(), hidden: true }, "New chat");
    const form = h("form", { class: "chat-bar", onsubmit: (e) => { e.preventDefault(); this.abort ? this.stop() : this.send(); } },
      h("span", { class: "chat-core", "aria-hidden": "true" }), this.input, this.sendBtn);

    const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
    this.el = h("div", { class: "view home-view" },
      h("div", { class: "home-desk" },
        aurora(),
        h("div", { class: "home-scroll" },
          h("div", { class: "home-column" },
            h("header", { class: "home-hero" },
              h("p", { class: "home-date" }, today),
              h("h1", {}, greeting()),
              this.summary),
            this.thread)),
        h("div", { class: "home-dock" }, h("div", { class: "home-column" }, form, this.newBtn))),
    );
    this.scroller = this.el.querySelector(".home-scroll");
    this.loadTodo();
    this.reloadInbox();
    setTimeout(() => this.input.focus(), 0);
  }

  get title() { return "Home"; }
  get dirty() { return false; }
  get path() { return null; }

  // ---------- the one-sentence summary ----------

  async loadTodo() {
    try {
      this.tasks = parseTodos((await api.read(this.info.todo_file)).content).tasks;
    } catch (e) {
      this.tasks = e.status === 404 ? null : this.tasks ?? null;
    }
    this.renderSummary();
  }

  async reloadInbox() {
    clearTimeout(this.poll);
    try { this.items = await api.inbox(); } catch { return; }
    this.renderSummary();
    if (this.items.some((i) => i.status === "running" || i.status === "queued")) this.poll = setTimeout(() => this.reloadInbox(), 3000);
  }

  renderSummary() {
    if (this.tasks === undefined || !this.items) return;
    const link = (text, onclick) => h("button", { class: "summary-link", onclick }, text);
    const parts = [];

    const open = (this.tasks || []).filter((t) => !t.checked);
    if (open.length) {
      const overdue = open.filter((t) => t.due && daysFromToday(t.due) < 0).length;
      const today = open.filter((t) => t.due && daysFromToday(t.due) === 0).length;
      const note = overdue ? `${overdue} overdue` : today ? `${today} due today` : null;
      parts.push([link(plural(open.length, "item", "items"), () => this.openTodo()), " on your to-do",
        note ? h("span", { class: overdue ? "summary-hot" : null }, ` (${note})`) : null]);
    }
    const count = (s) => this.items.filter((i) => i.status === s);
    const ready = count("review");
    if (ready.length) parts.push([link(plural(ready.length, "proposal", "proposals"), () => this.startReview(ready[0].id)), " to review"]);
    const fresh = count("new").length;
    if (fresh) parts.push([link(plural(fresh, "capture", "captures"), () => this.openInbox()), " to process"]);
    const busy = count("running").length + count("queued").length;
    if (busy) parts.push([`${plural(busy, "capture", "captures")} being processed`]);

    if (!parts.length) return fill(this.summary, "Nothing to report.");
    const out = [];
    parts.forEach((p, i) => {
      if (i) out.push(i === parts.length - 1 ? " and " : ", ");
      out.push(...p);
    });
    const first = out[0];
    if (typeof first === "string") out[0] = first[0].toUpperCase() + first.slice(1);
    fill(this.summary, ...out, ".");
  }

  onFileEvent(evt) {
    if (evt.path === this.info.todo_file) this.loadTodo();
    if (evt.path.startsWith("ProcessingBay/")) this.reloadInbox();
  }

  // ---------- chat ----------

  autosize() {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, 160)}px`;
  }

  async send() {
    const text = this.input.value.trim();
    if (!text || this.abort) return;
    const history = this.messages.filter((m) => !m.error).map(({ role, text: t }) => ({ role, text: t }));
    this.messages.push({ role: "user", text });
    const answer = { role: "jarvis", text: "", tools: [], sources: [], working: true };
    this.messages.push(answer);
    this.input.value = "";
    this.autosize();
    this.setBusy(true);
    this.renderThread(true);

    this.abort = new AbortController();
    let frame = 0;
    const redraw = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; this.renderThread(); }); };
    try {
      await chat({ message: text, session: this.session, history }, (e) => {
        if (e.type === "session") this.session = e.id;
        else if (e.type === "text") answer.text += e.text;
        else if (e.type === "tool") {
          answer.tools.push(e.label);
          if (e.path && !answer.sources.includes(e.path)) answer.sources.push(e.path);
        } else if (e.type === "error") answer.error = e.message;
        redraw();
      }, this.abort.signal);
    } catch (e) {
      if (e.name !== "AbortError") answer.error = e.message;
    }
    answer.working = false;
    if (!answer.text && !answer.error) answer.error = this.abort.signal.aborted ? "Stopped." : "No answer came back.";
    this.abort = null;
    this.setBusy(false);
    this.renderThread();
    this.input.focus();
  }

  stop() { this.abort?.abort(); }

  reset() {
    this.stop();
    this.messages = [];
    this.session = null;
    this.renderThread();
    this.input.focus();
  }

  setBusy(busy) {
    this.el.classList.toggle("is-thinking", busy);
    this.sendBtn.setAttribute("aria-label", busy ? "Stop" : "Send");
    this.sendBtn.firstChild.innerHTML = busy
      ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg>';
  }

  renderThread(force = false) {
    const chatting = this.messages.length > 0;
    this.el.classList.toggle("has-chat", chatting);
    this.newBtn.hidden = !chatting;
    const stick = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 80;
    fill(this.thread, ...this.messages.map((m) => (m.role === "user" ? h("div", { class: "msg msg-user" }, m.text) : this.renderAnswer(m))));
    if (stick || force) this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  renderAnswer(m) {
    const body = h("div", { class: "msg-body", html: md.render(m.text) });
    for (const a of body.querySelectorAll("a[href]")) {
      const target = resolveLink("", a.getAttribute("href"));
      if (target) {
        a.classList.add("note-link");
        a.addEventListener("click", (e) => { e.preventDefault(); this.openNote(target, { other: e.ctrlKey || e.metaKey }); });
      } else {
        a.target = "_blank";
        a.rel = "noopener";
      }
    }
    const status = m.working
      ? h("div", { class: "msg-status" }, h("span", { class: "msg-pulse" }), m.tools.at(-1) || "Thinking")
      : null;
    const sources = !m.working && m.sources.length
      ? h("div", { class: "msg-sources" }, h("span", { class: "msg-sources-label" }, "Read"),
        ...m.sources.map((p) => h("button", { class: "source-chip", title: p, onclick: (e) => this.openNote(p, { other: e.ctrlKey || e.metaKey }) }, stem(p))))
      : null;
    return h("div", { class: `msg msg-jarvis${m.working ? " is-working" : ""}` },
      m.text ? body : null, status,
      m.error ? h("p", { class: "msg-error" }, m.error) : null,
      sources);
  }

  destroy() { clearTimeout(this.poll); this.stop(); }
}
