import { h } from "./util.js";

const NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#/<>";

/** Letters settle one by one out of random glyphs. */
function decode(el, word, ms = 700) {
  const start = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - start) / ms);
    const fixed = Math.floor(t * word.length);
    el.textContent = [...word].map((c, i) => (i < fixed ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join("");
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function reactor() {
  const s = svg("svg", { class: "boot-reactor", viewBox: "-120 -120 240 240", "aria-hidden": "true" });
  s.append(
    svg("circle", { class: "boot-ticks", r: 112 }),
    svg("circle", { class: "boot-arc boot-arc-1", r: 98, pathLength: 360 }),
    svg("circle", { class: "boot-arc boot-arc-2", r: 82, pathLength: 360 }),
    svg("circle", { class: "boot-ring", r: 64, pathLength: 100 }),
    svg("circle", { class: "boot-arc boot-arc-3", r: 48, pathLength: 360 }),
    svg("circle", { class: "boot-core-glow", r: 30 }),
    svg("circle", { class: "boot-core", r: 16 }),
  );
  return s;
}

/**
 * The start-up sequence: a reactor spins up while Jarvis loads and the status lines report
 * what it actually found. Then it waits for you: click anywhere (or press a key), at any point,
 * and the core flares and the screen dissolves into Home.
 * Skipped entirely when the system asks for reduced motion.
 */
export function bootSequence() {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) return { line() {}, finish: async () => {} };

  const word = h("div", { class: "boot-word" }, "JARVIS");
  const log = h("div", { class: "boot-log", "aria-hidden": "true" });
  const hint = h("p", { class: "boot-hint", hidden: true }, "Click anywhere to continue");
  const el = h("div", { class: "boot", role: "status", "aria-label": "Jarvis is starting" },
    h("div", { class: "boot-stage" }, reactor(), word, log), hint);
  document.body.append(el);
  decode(word, "JARVIS", 1200);

  let queue = Promise.resolve();
  let dismissed = false;
  let done = null;
  const gone = new Promise((r) => { done = r; });

  // The exit: the core flares, the rings swell, and the overlay fades into Home.
  const dismiss = (e) => {
    e?.preventDefault?.();
    if (dismissed) return;
    dismissed = true;
    removeEventListener("keydown", dismiss, true);
    el.classList.add("is-ready");
    setTimeout(() => el.classList.add("is-leaving"), 380);
    setTimeout(() => { el.remove(); done(); }, 380 + 520);
  };
  el.addEventListener("pointerdown", dismiss);
  addEventListener("keydown", dismiss, true);

  return {
    /** Adds a status line; lines appear in order, a beat apart. */
    line(label, value, state = "ok") {
      queue = queue.then(async () => {
        if (dismissed) return;
        log.append(h("div", { class: `boot-line is-${state}` },
          h("span", { class: "boot-chev" }, "›"), h("span", { class: "boot-label" }, label), h("span", { class: "boot-fill" }, h("span", { class: "boot-dots" }), h("span", { class: "boot-value" }, value)),
          h("span", { class: "boot-dot" })));
        await new Promise((r) => setTimeout(r, 600));
      });
    },
    /** Shows the prompt once every line is in; resolves when the user has continued and the overlay is gone. */
    async finish() {
      await queue;
      if (!dismissed) hint.hidden = false;
      await gone;
    },
  };
}
