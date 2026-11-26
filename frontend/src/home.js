import { TodoView } from "./todoView.js";
import { InboxPanel } from "./sidebar.js";
import { h, fill, daysFromToday } from "./util.js";

function greeting() {
  const hr = new Date().getHours();
  return hr < 5 ? "Good evening." : hr < 12 ? "Good morning." : hr < 18 ? "Good afternoon." : "Good evening.";
}

/** The page Jarvis opens on: what's due soon, and the inbox with one button to process it. */
export class HomeView {
  constructor({ info, openNote, openTodo, startReview }) {
    this.tasks = null;
    this.items = null;
    this.summary = h("p", { class: "home-summary" });
    this.todo = new TodoView(info.todo_file, {
      focus: true,
      openFull: () => openTodo(),
      openSource: (p) => openNote(p, { asText: true }),
      onTasks: (tasks) => { this.tasks = tasks; this.renderSummary(); },
    });
    this.inbox = new InboxPanel({
      info, open: openNote, startReview, compact: true,
      onLoad: (items) => { this.items = items; this.renderSummary(); },
    });
    this.startReview = startReview;
    this.actions = h("div", { class: "home-actions" });
    this.openTodo = openTodo;
    const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
    this.el = h("div", { class: "view home-view" },
      h("div", { class: "home-scroll" },
        h("header", { class: "home-desk" },
          h("div", { class: "home-desk-inner" },
            h("p", { class: "home-date" }, today),
            h("h1", {}, greeting()),
            this.summary,
            this.actions)),
        h("div", { class: "home-page" }, h("div", { class: "home-grid" },
          h("section", { class: "home-card home-focus", "aria-labelledby": "home-focus-h" },
            h("div", { class: "home-card-head" },
              h("h2", { id: "home-focus-h" }, "Focus"),
              h("button", { class: "btn btn-quiet", onclick: () => openTodo() }, "Full list")),
            this.todo.el),
          h("section", { class: "home-card home-inbox", "aria-labelledby": "home-inbox-h" },
            h("div", { class: "home-card-head" }, h("h2", { id: "home-inbox-h" }, "Inbox")),
            this.inbox.el),
        )),
      ),
    );
    this.inbox.load();
  }

  get title() { return "Home"; }
  get dirty() { return false; }
  get path() { return null; }

  renderSummary() {
    if (!this.tasks || !this.items) return;
    const open = this.tasks.filter((t) => !t.checked);
    const overdue = open.filter((t) => t.due && daysFromToday(t.due) < 0).length;
    const today = open.filter((t) => t.due && daysFromToday(t.due) === 0).length;
    const week = open.filter((t) => t.due && daysFromToday(t.due) > 0 && daysFromToday(t.due) <= 7).length;
    const fresh = this.items.filter((i) => i.status === "new").length;
    const ready = this.items.filter((i) => i.status === "review").length;
    const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;

    const parts = [];
    if (overdue) parts.push(n(overdue, "task is overdue", "tasks are overdue"));
    if (today) parts.push(n(today, "task is due today", "tasks are due today"));
    if (week) parts.push(`${n(week, "task is", "tasks are")} due this week`);
    if (ready) parts.push(n(ready, "review is waiting for you", "reviews are waiting for you"));
    if (fresh) parts.push(n(fresh, "capture needs processing", "captures need processing"));
    const busy = this.items.filter((i) => i.status === "running" || i.status === "queued").length;
    if (busy) parts.push(`${n(busy, "capture is", "captures are")} being processed`);
    const join = (a) => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);
    this.summary.textContent = parts.length ? `${join(parts).replace(/^./, (c) => c.toUpperCase())}.` : "Nothing urgent. Your inbox is clear and nothing is due this week.";
    this.summary.classList.toggle("is-urgent", overdue > 0);

    // The one thing Jarvis wants from you, as a button on the desk.
    const waiting = this.items.filter((i) => i.status === "review");
    fill(this.actions,
      waiting.length ? h("button", { class: "btn btn-lamp", onclick: () => this.startReview(waiting[0].id) },
        waiting.length === 1 ? "Review the proposal" : `Review ${waiting.length} proposals`) : null,
      h("button", { class: `btn ${waiting.length ? "btn-desk" : "btn-lamp"}`, onclick: () => this.openTodo() }, "Open to-do"));
  }

  onFileEvent(evt) {
    this.todo.onFileEvent(evt);
    if (evt.path.startsWith("ProcessingBay/")) this.inbox.load();
  }

  reloadInbox() { this.inbox.load(); }
  destroy() { clearTimeout(this.inbox.poll); }
}
