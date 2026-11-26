import { api } from "./api.js";
import { h, toast, isoToday, daysFromToday, friendlyDate, store } from "./util.js";

const TASK = /^(\s*)([-*+]) \[([ xX])\] ?(.*)$/;
const DUE = /\s*@due\((\d{4}-\d{2}-\d{2})\)/;
const DONE = /\s*@done\((\d{4}-\d{2}-\d{2})\)/;
const TAG = /(^|\s)#([\p{L}\p{N}_\/-]+)/gu;

export function parseTodos(source) {
  const lines = source.split("\n");
  const tasks = [];
  let section = "";
  lines.forEach((line, i) => {
    const head = line.match(/^#{2,6}\s+(.*)/);
    if (head) { section = head[1].trim(); return; }
    const m = line.match(TASK);
    if (!m) return;
    const body = m[4];
    const due = body.match(DUE)?.[1] || null;
    const done = body.match(DONE)?.[1] || null;
    const tags = [...body.matchAll(TAG)].map((t) => t[2]);
    const text = body.replace(DUE, "").replace(DONE, "").replace(TAG, "$1").replace(/\s+/g, " ").trim();
    tasks.push({ line: i, indent: m[1], bullet: m[2], checked: m[3] !== " ", body, due, done, tags, text, section });
  });
  return { lines, tasks };
}

function compose(t, { text, due, checked, done }) {
  let body = text.trim();
  const tags = [...body.matchAll(TAG)].map((x) => x[2]);
  for (const tag of t.tags) if (!tags.includes(tag)) body += ` #${tag}`;
  if (due) body += ` @due(${due})`;
  if (checked && done) body += ` @done(${done})`;
  return `${t.indent}${t.bullet} [${checked ? "x" : " "}] ${body}`;
}

export class TodoView {
  /** focus: compact Home version showing only what's due soon, plus quick add. */
  constructor(path, { openSource, focus = false, openFull, onTasks }) {
    this.onTasks = onTasks || (() => {});
    this.path = path;
    this.openSource = openSource;
    this.focus = focus;
    this.openFull = openFull;
    this.source = null;
    this.sha = null;
    this.filter = store.get("todoFilter", null);
    this.showDone = false;
    this.busy = false;

    this.text = h("input", { class: "input todo-add-text", placeholder: "Add a task. Use #tags if you like.", "aria-label": "New task" });
    this.due = h("input", { class: "input input-date", type: "date", "aria-label": "Due date" });
    this.list = h("div", { class: "todo-list" });
    this.filters = h("div", { class: "tag-filters" });
    const form = h("form", { class: "todo-add", onsubmit: (e) => { e.preventDefault(); this.add(); } },
      this.text, this.due, h("button", { class: `btn ${focus ? "" : "btn-primary"}`, type: "submit" }, "Add task"));
    this.el = focus
      ? h("div", { class: "todo-focus" }, form, this.list)
      : h("div", { class: "view todo-view" },
        h("div", { class: "view-bar" },
          h("div", { class: "crumbs" }, h("span", { class: "crumb crumb-file" }, "To-do")),
          h("button", { class: "btn btn-quiet", onclick: () => this.openSource(this.path) }, "Open as text"),
        ),
        h("div", { class: "todo-scroll" }, form, this.filters, this.list),
      );
    this.load();
  }

  get title() { return "To-do"; }
  get dirty() { return this.busy; }

  async load() {
    try {
      const f = await api.read(this.path);
      this.source = f.content;
      this.sha = f.sha;
    } catch (e) {
      if (e.status !== 404) return toast(e.message, "error");
      this.source = null;
    }
    this.render();
  }

  async commit(lines) {
    this.busy = true;
    const next = lines.join("\n");
    try {
      const r = await api.write(this.path, next, this.sha);
      this.source = next;
      this.sha = r.sha;
    } catch (e) {
      if (e.status === 409) { toast("todo.md changed elsewhere. Showing the latest version; please redo that change."); await this.load(); }
      else toast(`Not saved: ${e.message}`, "error");
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async add() {
    let text = this.text.value.trim();
    if (!text) return this.text.focus();
    let due = this.due.value || text.match(DUE)?.[1] || null;
    text = text.replace(DUE, "").trim();
    const line = `- [ ] ${text}${due ? ` @due(${due})` : ""}`;
    const lines = this.source == null ? ["# To-do", ""] : this.source.replace(/\n+$/, "").split("\n");
    lines.push(line, "");
    this.text.value = "";
    this.due.value = "";
    await this.commit(lines);
    this.text.focus();
  }

  update(t, changes) {
    const { lines } = parseTodos(this.source);
    const next = { text: t.text, due: t.due, checked: t.checked, done: t.done, ...changes };
    lines[t.line] = compose(t, next);
    return this.commit(lines);
  }

  toggle(t) {
    return this.update(t, { checked: !t.checked, done: !t.checked ? isoToday() : null });
  }

  remove(t) {
    const { lines } = parseTodos(this.source);
    lines.splice(t.line, 1);
    return this.commit(lines);
  }

  row(t) {
    const days = t.due ? daysFromToday(t.due) : null;
    const textEl = h("span", { class: "todo-text", tabindex: "0", title: "Click to edit" }, t.text,
      ...t.tags.map((tag) => h("span", { class: "tag" }, `#${tag}`)));
    const startEdit = () => {
      const raw = [t.text, ...t.tags.filter((tag) => !t.text.includes(`#${tag}`)).map((x) => `#${x}`)].join(" ");
      const input = h("input", { class: "input input-plain", value: raw, "aria-label": "Edit task" });
      let finished = false;
      const finish = (save) => {
        if (finished) return;
        finished = true;
        if (save && input.value.trim() && input.value.trim() !== raw) this.update({ ...t, tags: [] }, { text: input.value });
        else this.render();
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
      input.addEventListener("blur", () => finish(true));
      textEl.replaceWith(input);
      input.focus();
      input.select();
    };
    textEl.addEventListener("click", startEdit);
    textEl.addEventListener("keydown", (e) => { if (e.key === "Enter") startEdit(); });

    const dateInput = h("input", { class: "input input-date input-date-quiet", type: "date", value: t.due || "", "aria-label": "Due date",
      onchange: (e) => this.update(t, { due: e.target.value || null }) });
    let armed = false;
    const del = h("button", { class: "btn btn-quiet todo-del", onclick: () => {
      if (armed) return this.remove(t);
      armed = true; del.textContent = "Delete?"; del.classList.add("is-armed");
      setTimeout(() => { armed = false; del.textContent = "Delete"; del.classList.remove("is-armed"); }, 2500);
    } }, "Delete");

    return h("li", { class: `todo ${t.checked ? "is-done" : ""} ${days != null && days < 0 && !t.checked ? "is-overdue" : ""}` },
      h("input", { type: "checkbox", class: "todo-check", checked: t.checked, "aria-label": t.checked ? "Mark as not done" : "Mark as done", onchange: () => this.toggle(t) }),
      h("div", { class: "todo-main" }, textEl, t.section ? h("span", { class: "todo-section" }, t.section) : null),
      h("div", { class: "todo-when" },
        t.checked ? h("span", { class: "muted" }, t.done ? `Done ${friendlyDate(t.done)}` : "Done")
          : h("label", { class: "due-label" }, t.due ? h("span", { class: "due" }, friendlyDate(t.due)) : h("span", { class: "muted" }, "No date"), dateInput)),
      del,
    );
  }

  render() {
    if (this.source == null) {
      this.onTasks([]);
      this.filters.replaceChildren();
      this.list.replaceChildren(h("div", { class: "empty-state" },
        h("p", {}, "There's no todo.md in the knowledge base yet."),
        h("p", { class: "muted" }, "Add your first task above and Jarvis creates it at the root of the knowledge base.")));
      return;
    }
    const { tasks } = parseTodos(this.source);
    this.onTasks(tasks);
    if (this.focus) return this.renderFocus(tasks);
    const tags = [...new Set(tasks.flatMap((t) => t.tags))].sort();
    if (this.filter && !tags.includes(this.filter)) this.filter = null;
    this.filters.replaceChildren(...(tags.length ? [
      h("button", { class: `chip ${!this.filter ? "is-on" : ""}`, onclick: () => this.setFilter(null) }, "All"),
      ...tags.map((tag) => h("button", { class: `chip ${this.filter === tag ? "is-on" : ""}`, onclick: () => this.setFilter(tag) }, `#${tag}`)),
    ] : []));

    const shown = tasks.filter((t) => !this.filter || t.tags.includes(this.filter));
    const open = shown.filter((t) => !t.checked);
    const done = shown.filter((t) => t.checked).sort((a, b) => (b.done || "").localeCompare(a.done || ""));
    const groups = [
      ["Overdue", (t) => t.due && daysFromToday(t.due) < 0],
      ["Today", (t) => t.due && daysFromToday(t.due) === 0],
      ["Next 7 days", (t) => t.due && daysFromToday(t.due) > 0 && daysFromToday(t.due) <= 7],
      ["Later", (t) => t.due && daysFromToday(t.due) > 7],
      ["No date", (t) => !t.due],
    ];
    const sections = groups.map(([name, pred]) => {
      const items = open.filter(pred).sort((a, b) => (a.due || "").localeCompare(b.due || ""));
      if (!items.length) return null;
      return h("section", { class: `todo-group group-${name.toLowerCase().replace(/\W+/g, "-")}` },
        h("h3", {}, name, h("span", { class: "count" }, items.length)),
        h("ul", {}, items.map((t) => this.row(t))));
    }).filter(Boolean);

    if (!open.length) sections.unshift(h("div", { class: "empty-state" }, h("p", {}, this.filter ? `Nothing open tagged #${this.filter}.` : "Nothing open. Add a task above.")));
    if (done.length) {
      sections.push(h("section", { class: "todo-group group-done" },
        h("button", { class: "btn btn-quiet done-toggle", "aria-expanded": String(this.showDone), onclick: () => { this.showDone = !this.showDone; this.render(); } },
          `${this.showDone ? "Hide" : "Show"} done (${done.length})`),
        this.showDone ? h("ul", {}, done.slice(0, 50).map((t) => this.row(t))) : null));
    }
    this.list.replaceChildren(...sections);
  }

  renderFocus(tasks) {
    const open = tasks.filter((t) => !t.checked);
    const byDue = (a, b) => (a.due || "").localeCompare(b.due || "");
    const soon = [
      ["Overdue", (t) => t.due && daysFromToday(t.due) < 0],
      ["Today", (t) => t.due && daysFromToday(t.due) === 0],
      ["Next 7 days", (t) => t.due && daysFromToday(t.due) > 0 && daysFromToday(t.due) <= 7],
    ];
    const group = (name, items) => h("section", { class: `todo-group group-${name.toLowerCase().replace(/\W+/g, "-")}` },
      h("h3", {}, name, h("span", { class: "count" }, items.length)),
      h("ul", {}, items.map((t) => this.row(t))));
    let shown = 0;
    const sections = soon.map(([name, pred]) => {
      const items = open.filter(pred).sort(byDue);
      shown += items.length;
      return items.length ? group(name, items) : null;
    }).filter(Boolean);

    // With nothing due this week, the undated tasks are what's left to focus on.
    if (!sections.length) {
      sections.push(h("p", { class: "focus-clear" }, open.length ? "Nothing is due this week." : "Nothing open. Add a task above."));
      const undated = open.filter((t) => !t.due).slice(0, 6);
      shown += undated.length;
      if (undated.length) sections.push(group("No date", undated));
    }
    const hidden = open.length - shown;
    if (open.length) {
      sections.push(h("button", { class: "btn btn-quiet focus-more", onclick: () => this.openFull() },
        hidden ? `${hidden} more ${hidden === 1 ? "task" : "tasks"} in the full list` : "Open the full list"));
    }
    this.list.replaceChildren(...sections);
  }

  setFilter(tag) { this.filter = tag; store.set("todoFilter", tag); this.render(); }

  onFileEvent(evt) {
    if (evt.path === this.path && !this.busy && !this.el.contains(document.activeElement)) this.load();
  }
}
