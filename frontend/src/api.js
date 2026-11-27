async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error((data && data.detail) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const q = (o) => new URLSearchParams(o).toString();

/** Streams a chat answer: calls onEvent for each {type: session|tool|text|done|error} event. */
export async function chat(body, onEvent, signal) {
  const res = await fetch("/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try { detail = (await res.json()).detail || detail; } catch { /* no body */ }
    throw new Error(detail);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

export const api = {
  info: () => call("GET", "/api/info"),
  tree: () => call("GET", "/api/tree"),
  read: (path) => call("GET", `/api/file?${q({ path })}`),
  write: (path, content, base_sha, force = false) => call("PUT", "/api/file", { path, content, base_sha, force }),
  create: (path) => call("POST", "/api/file/new", { path }),
  createFolder: (path) => call("POST", "/api/folder/new", { path }),
  backlinks: (path) => call("GET", `/api/backlinks?${q({ path })}`),
  search: (text) => call("GET", `/api/search?${q({ q: text })}`),
  rawUrl: (path) => `/api/raw?${q({ path })}`,

  inbox: () => call("GET", "/api/inbox"),
  processAll: () => call("POST", "/api/inbox/process-all"),
  process: (id) => call("POST", `/api/inbox/${encodeURIComponent(id)}/process`),
  agentStatus: (id) => call("GET", `/api/inbox/${encodeURIComponent(id)}/agent`),
  manual: (id) => call("POST", `/api/review/${encodeURIComponent(id)}/manual`),
  review: (id) => call("GET", `/api/review/${encodeURIComponent(id)}`),
  saveChange: (id, body) => call("PUT", `/api/review/${encodeURIComponent(id)}/change`, body),
  saveTodo: (id, body) => call("PUT", `/api/review/${encodeURIComponent(id)}/todo`, body),
  addReviewFile: (id, path) => call("POST", `/api/review/${encodeURIComponent(id)}/file`, { path }),
  removeReviewFile: (id, path) => call("DELETE", `/api/review/${encodeURIComponent(id)}/file?${q({ path })}`),
  apply: (id, force = false) => call("POST", `/api/review/${encodeURIComponent(id)}/apply`, { force }),
  discard: (id) => call("DELETE", `/api/review/${encodeURIComponent(id)}`),
};
