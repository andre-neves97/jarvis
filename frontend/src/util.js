export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const basename = (p) => p.split("/").pop();
export const stem = (p) => basename(p).replace(/\.(md|txt)$/i, "");
export const dirname = (p) => p.split("/").slice(0, -1).join("/");

export function resolveLink(fromPath, href) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return null;
  let target = href.split("#")[0];
  try { target = decodeURIComponent(target); } catch { /* keep raw */ }
  if (!target) return null;
  const parts = [];
  for (const part of `${dirname(fromPath)}/${target}`.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => {
    clearTimeout(t);
    d.pending = true;
    t = setTimeout(() => { d.pending = false; fn(...args); }, ms);
  };
  d.pending = false;
  d.flush = (...args) => { clearTimeout(t); d.pending = false; return fn(...args); };
  d.cancel = () => { clearTimeout(t); d.pending = false; };
  return d;
}

export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`jarvis:${key}`); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`jarvis:${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

export function toast(message, kind = "info", ms = 4500) {
  const host = document.getElementById("toasts");
  const el = h("div", { class: `toast toast-${kind}`, role: kind === "error" ? "alert" : "status" }, message);
  host.append(el);
  setTimeout(() => el.remove(), ms);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function daysFromToday(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(y, m - 1, d) - t) / 86400000);
}
export function friendlyDate(iso) {
  if (!iso) return "";
  const n = daysFromToday(iso);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  const [y, m, d] = iso.split("-").map(Number);
  const sameYear = y === new Date().getFullYear();
  return `${d} ${MONTHS[m - 1]}${sameYear ? "" : " " + y}`;
}

/** "2026-11-17T03_00_00" -> "Mon 17 Nov" */
export function captureTitle(id) {
  const m = id.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return id;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const day = d.toLocaleDateString("en-GB", { weekday: "short" });
  return `${day} ${+m[3]} ${MONTHS[+m[2] - 1]}`;
}

export function confirmDialog({ title, body, confirm = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "dialog" },
      h("h2", {}, title),
      typeof body === "string" ? h("p", {}, body) : body,
      h("div", { class: "dialog-actions" },
        h("button", { class: "btn", value: "cancel", onclick: () => dlg.close("cancel") }, "Cancel"),
        h("button", { class: `btn ${danger ? "btn-danger" : "btn-primary"}`, onclick: () => dlg.close("ok") }, confirm),
      ),
    );
    dlg.addEventListener("close", () => { resolve(dlg.returnValue === "ok"); dlg.remove(); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

/** replaceChildren that skips null/false (native replaceChildren would print "null"). */
export function fill(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c != null && c !== false));
  return el;
}
