"use strict";
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = { token: localStorage.getItem("token"), user: null, view: "my", folder: null, items: [], crumbs: [], layout: localStorage.getItem("layout") || "grid", q: "", selected: null };

/* ---------------------------------------------------------------- api */
async function api(path, { method = "GET", body, form } = {}) {
  const headers = {};
  if (state.token) headers.Authorization = "Bearer " + state.token;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : form });
  if (res.status === 401 && state.token) { signOut(); throw new Error("Your session has expired. Sign in again."); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Something went wrong. Try again.");
  return data;
}
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.id); toast.id = setTimeout(() => t.classList.remove("show"), 2800);
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message); } };

/* ---------------------------------------------------------------- helpers */
function fmtSize(n) {
  if (n < 1024) return n + " B";
  const u = ["KB", "MB", "GB"]; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < 2);
  return n.toFixed(n < 10 ? 1 : 0) + " " + u[i];
}
function fmtDate(ts) {
  const d = new Date(ts * 1000), now = new Date();
  return d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}
function kind(it) {
  const m = it.mime || "", ext = (it.name.split(".").pop() || "").toLowerCase();
  if (m.startsWith("image/")) return ["#1f9d73", ext.slice(0, 4) || "img"];
  if (m === "application/pdf") return ["#d6402f", "pdf"];
  if (m.startsWith("video/")) return ["#8a4fd6", ext.slice(0, 4) || "vid"];
  if (m.startsWith("audio/")) return ["#d6812f", ext.slice(0, 4) || "aud"];
  if (/zip|tar|gzip|rar|7z/.test(m)) return ["#6b7387", ext.slice(0, 4) || "zip"];
  if (m.startsWith("text/") || /json|xml|javascript/.test(m)) return ["#2d54e8", ext.slice(0, 4) || "txt"];
  return ["#6b7387", ext.slice(0, 4) || "file"];
}
const folderSvg = (s = 24) => `<svg class="ico" width="${s}" height="${s}" viewBox="0 0 24 24" fill="#e3a72f" aria-hidden="true"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
const fileSvg = (it) => { const [c, e] = kind(it); return `<span class="badge" style="background:${c}">${esc(e)}</span>`; };
const gridSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z"/></svg>`;
const listSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 5h18v3H3zm0 5.5h18v3H3zM3 16h18v3H3z"/></svg>`;

/* ---------------------------------------------------------------- dialogs */
function modal({ title, body, actions = [], wide = false }) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><span>${esc(title)}</span></header><div class="body"></div><footer></footer></div>`;
    const bodyEl = $(".body", back), foot = $("footer", back);
    if (typeof body === "string") bodyEl.innerHTML = body; else bodyEl.append(body);
    const close = (v) => { document.removeEventListener("keydown", onKey); back.remove(); resolve(v); };
    actions.forEach((a) => {
      const b = document.createElement("button");
      b.className = "btn" + (a.primary ? " primary" : ""); b.textContent = a.label;
      b.onclick = () => close(a.value === undefined ? a.label : typeof a.value === "function" ? a.value(back) : a.value);
      foot.append(b);
    });
    const onKey = (e) => { if (e.key === "Escape") close(null); };
    document.addEventListener("keydown", onKey);
    back.addEventListener("mousedown", (e) => { if (e.target === back) close(null); });
    document.body.append(back);
    const first = $("input, .btn.primary", back); first && first.focus();
    if (first && first.select) first.select();
    const inp = $("input", back);
    if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { const p = $(".btn.primary", back); p && p.click(); } });
  });
}
const askText = (title, value = "", cta = "Save") =>
  modal({ title, body: `<input aria-label="${esc(title)}" value="${esc(value)}">`, actions: [{ label: "Cancel", value: null }, { label: cta, primary: true, value: (b) => $("input", b).value.trim() || null }] });
const confirmBox = (title, text, cta) =>
  modal({ title, body: `<p>${esc(text)}</p>`, actions: [{ label: "Cancel", value: false }, { label: cta, primary: true, value: true }] });

/* ---------------------------------------------------------------- auth */
let registering = false;
function showAuth() {
  $("#app").hidden = true; $("#auth").hidden = false;
}
function setMode(reg) {
  registering = reg;
  $("#auth-title").textContent = reg ? "Create your account" : "Sign in";
  $("#auth-submit").textContent = reg ? "Create account" : "Sign in";
  $("#auth-toggle").textContent = reg ? "Have an account? Sign in" : "New here? Create an account";
  $("#name-row").hidden = !reg;
  $("#auth-pass").autocomplete = reg ? "new-password" : "current-password";
  $("#auth-error").textContent = "";
}
$("#auth-toggle").onclick = () => setMode(!registering);
$("#auth-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api(registering ? "/api/auth/register" : "/api/auth/login", { method: "POST", body: { email: $("#auth-email").value, password: $("#auth-pass").value, name: $("#auth-name").value } });
    state.token = r.token; localStorage.setItem("token", r.token);
    $("#auth-pass").value = "";
    await boot();
  } catch (err) { $("#auth-error").textContent = err.message; }
};
function signOut() {
  localStorage.removeItem("token"); state.token = null; state.user = null; showAuth();
}

/* ---------------------------------------------------------------- routing */
function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  if (["recent", "starred", "trash"].includes(h)) return { view: h, folder: null };
  const m = h.match(/^folder\/(\d+)$/);
  return { view: "my", folder: m ? Number(m[1]) : null };
}
window.addEventListener("hashchange", () => state.token && load());
const goFolder = (id) => { location.hash = id ? `#/folder/${id}` : "#/"; };

async function load() {
  const r = parseHash(); state.view = r.view; state.folder = r.folder; state.selected = null;
  const q = state.q.trim();
  const url = "/api/items?" + (q ? "q=" + encodeURIComponent(q) : `view=${state.view}` + (state.folder ? `&parent_id=${state.folder}` : ""));
  try {
    const [list, path] = await Promise.all([api(url), state.view === "my" && state.folder && !q ? api(`/api/items/${state.folder}/path`) : { path: [] }]);
    state.items = list.items; state.crumbs = path.path;
  } catch (e) { toast(e.message); if (state.folder) { goFolder(null); } return; }
  render();
  refreshStorage();
}
async function refreshStorage() {
  try {
    const m = await api("/api/me");
    const pct = Math.min(100, (m.used / m.quota) * 100);
    const f = $("#meter-fill"); f.style.width = pct + "%"; f.classList.toggle("full", pct > 90);
    $("#storage-text").textContent = `${fmtSize(m.used)} of ${fmtSize(m.quota)} used`;
  } catch {}
}

/* ---------------------------------------------------------------- render */
const TITLES = { recent: "Recent", starred: "Starred", trash: "Trash" };
function render() {
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", !state.q && a.dataset.view === state.view));
  $("#layout-btn").innerHTML = state.layout === "grid" ? listSvg : gridSvg;
  $("#empty-trash").hidden = !(state.view === "trash" && state.items.length && !state.q);

  const crumbs = $("#crumbs"); crumbs.innerHTML = "";
  if (state.q.trim()) crumbs.innerHTML = `<span>Results for “${esc(state.q.trim())}”</span>`;
  else if (state.view !== "my") crumbs.innerHTML = `<span>${TITLES[state.view]}</span>`;
  else {
    const parts = [{ id: null, name: "My Drive" }, ...state.crumbs];
    parts.forEach((p, i) => {
      if (i) crumbs.insertAdjacentHTML("beforeend", `<span class="sep">›</span>`);
      const b = document.createElement("button"); b.textContent = p.name; b.dataset.folder = p.id ?? "";
      if (i === parts.length - 1) b.setAttribute("aria-current", "page");
      b.onclick = () => goFolder(p.id);
      crumbs.append(b);
    });
  }

  const c = $("#content");
  if (!state.items.length) { c.innerHTML = emptyState(); return; }
  const folders = state.items.filter((i) => i.is_folder), files = state.items.filter((i) => !i.is_folder);
  if (state.layout === "grid") {
    c.innerHTML = (folders.length ? `<div class="section-label">Folders</div><div class="grid">${folders.map(cardHtml).join("")}</div>` : "") +
      (files.length ? `<div class="section-label">Files</div><div class="grid">${files.map(cardHtml).join("")}</div>` : "");
  } else {
    c.innerHTML = `<div class="list"><div class="row head"><span>Name</span><span class="dim">Modified</span><span class="dim">Size</span><span></span></div>${state.items.map(rowHtml).join("")}</div>`;
  }
  c.querySelectorAll("[data-id]").forEach(wireItem);
}
function emptyState() {
  const m = {
    trash: ["Trash is empty", "Deleted items stay here until you empty the trash."],
    starred: ["No starred items", "Star a file or folder to find it here quickly."],
    recent: ["Nothing here yet", "Files you upload or rename show up here."],
    my: state.q.trim() ? ["No matches", "Try a different name."] : ["This folder is empty", "Drag files here or choose + New to upload."],
  }[state.q.trim() ? "my" : state.view];
  return `<div class="empty"><h2>${m[0]}</h2><p>${m[1]}</p></div>`;
}
const star = (it) => (it.starred ? `<span class="star" title="Starred">★</span>` : "");
const kebab = `<button class="kebab" aria-label="More actions" aria-haspopup="menu">⋮</button>`;
function cardHtml(it) {
  const drag = state.view === "trash" ? "" : 'draggable="true"';
  return it.is_folder
    ? `<div class="card folder" data-id="${it.id}" ${drag}>${folderSvg()}<span class="name" title="${esc(it.name)}">${esc(it.name)}</span>${star(it)}${kebab}</div>`
    : `<div class="card file" data-id="${it.id}" ${drag}><div class="thumb">${fileSvg(it)}</div><div class="meta"><span class="name" title="${esc(it.name)}">${esc(it.name)}</span>${star(it)}${kebab}</div></div>`;
}
function rowHtml(it) {
  const drag = state.view === "trash" ? "" : 'draggable="true"';
  return `<div class="row" data-id="${it.id}" ${drag}><span class="cell-name">${it.is_folder ? folderSvg() : fileSvg(it)}<span class="name">${esc(it.name)}</span>${star(it)}</span><span class="dim">${fmtDate(it.updated_at)}</span><span class="dim">${it.is_folder ? "" : fmtSize(it.size)}</span>${kebab}</div>`;
}
const byId = (id) => state.items.find((i) => i.id === Number(id));

function wireItem(el) {
  const it = byId(el.dataset.id);
  el.onclick = (e) => {
    if (e.target.closest(".kebab")) { openMenu(it, e.target.getBoundingClientRect()); return; }
    select(it.id);
  };
  el.ondblclick = () => openItem(it);
  el.oncontextmenu = (e) => { e.preventDefault(); select(it.id); openMenu(it, { left: e.clientX, bottom: e.clientY }); };
  el.onkeydown = (e) => { if (e.key === "Enter") openItem(it); };
  el.ondragstart = (e) => { e.dataTransfer.setData("text/x-drive-id", String(it.id)); e.dataTransfer.effectAllowed = "move"; };
  if (it.is_folder && state.view !== "trash") dropTarget(el, it.id);
}
function select(id) {
  state.selected = id;
  document.querySelectorAll("#content [data-id]").forEach((e) => e.classList.toggle("selected", Number(e.dataset.id) === id));
}
function dropTarget(el, folderId) {
  el.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/x-drive-id")) { e.preventDefault(); el.classList.add("drop"); } });
  el.addEventListener("dragleave", () => el.classList.remove("drop"));
  el.addEventListener("drop", guard(async (e) => {
    el.classList.remove("drop");
    const id = Number(e.dataTransfer.getData("text/x-drive-id"));
    if (!id || id === folderId) return;
    e.preventDefault(); e.stopPropagation();
    await api(`/api/items/${id}`, { method: "PATCH", body: { parent_id: folderId } });
    toast("Moved"); load();
  }));
}

/* ---------------------------------------------------------------- actions */
function openItem(it) {
  if (state.view === "trash") return toast("Restore this item to open it.");
  if (it.is_folder) { state.q = ""; $("#search").value = ""; goFolder(it.id); } else preview(it);
}
const doRename = guard(async (it) => {
  const name = await askText("Rename", it.name); if (!name || name === it.name) return;
  await api(`/api/items/${it.id}`, { method: "PATCH", body: { name } }); load();
});
const doStar = guard(async (it) => { await api(`/api/items/${it.id}`, { method: "PATCH", body: { starred: !it.starred } }); load(); });
const doTrash = guard(async (it) => { await api(`/api/items/${it.id}/trash`, { method: "POST" }); toast("Moved to trash"); load(); });
const doRestore = guard(async (it) => { await api(`/api/items/${it.id}/restore`, { method: "POST" }); toast("Restored"); load(); });
const doDelete = guard(async (it) => {
  if (!(await confirmBox("Delete forever?", `“${it.name}” will be permanently deleted. This can't be undone.`, "Delete forever"))) return;
  await api(`/api/items/${it.id}`, { method: "DELETE" }); toast("Deleted forever"); load();
});
const doDownload = guard(async (it) => {
  const { url } = await api(`/api/items/${it.id}/link`);
  const a = document.createElement("a"); a.href = url; a.download = it.name; document.body.append(a); a.click(); a.remove();
});
const doNewFolder = guard(async () => {
  const name = await askText("New folder", "Untitled folder", "Create"); if (!name) return;
  await api("/api/folders", { method: "POST", body: { name, parent_id: state.folder } }); load();
});
const doMove = guard(async (it) => {
  const { folders } = await api("/api/folders");
  const skip = new Set([it.id]); // hide the folder itself and everything inside it
  if (it.is_folder) for (let grew = true; grew;) { grew = false; folders.forEach((f) => { if (skip.has(f.parent_id) && !skip.has(f.id)) { skip.add(f.id); grew = true; } }); }
  const kids = (p) => folders.filter((f) => f.parent_id === p && !skip.has(f.id));
  let chosen = null;
  const box = document.createElement("div"); box.className = "picker";
  const draw = (p = null, depth = 0) => kids(p).forEach((f) => { box.insertAdjacentHTML("beforeend", `<button data-id="${f.id}" style="padding-left:${12 + depth * 18}px">${folderSvg(16)} ${esc(f.name)}</button>`); draw(f.id, depth + 1); });
  box.insertAdjacentHTML("beforeend", `<button data-id="" class="on">${folderSvg(16)} My Drive</button>`); draw();
  box.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; chosen = b.dataset.id ? Number(b.dataset.id) : null; box.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); };
  const go = await modal({ title: `Move “${it.name}”`, body: box, actions: [{ label: "Cancel", value: false }, { label: "Move here", primary: true, value: true }] });
  if (!go) return;
  await api(`/api/items/${it.id}`, { method: "PATCH", body: { parent_id: chosen } }); toast("Moved"); load();
});
const doShare = guard(async (it) => {
  let tok = it.share_token;
  if (!tok) tok = (await api(`/api/items/${it.id}/share`, { method: "POST", body: { enabled: true } })).share_token;
  const box = document.createElement("div");
  const link = location.origin + "/s/" + tok;
  box.innerHTML = `<p>Anyone with this link can download the file.</p><div class="sharebox"><input readonly value="${esc(link)}" aria-label="Share link"><button class="btn">Copy</button></div>`;
  $(".btn", box).onclick = async () => { try { await navigator.clipboard.writeText(link); toast("Link copied"); } catch { $("input", box).select(); toast("Press Ctrl+C to copy"); } };
  const stop = await modal({ title: "Share link", body: box, actions: [{ label: "Stop sharing", value: true }, { label: "Done", primary: true, value: false }] });
  if (stop) { await api(`/api/items/${it.id}/share`, { method: "POST", body: { enabled: false } }); toast("Link turned off"); }
  load();
});
async function preview(it) {
  const { url } = await api(`/api/items/${it.id}/link?inline=true`).catch((e) => { toast(e.message); return {}; });
  if (!url) return;
  const m = it.mime || "", wrap = document.createElement("div"); wrap.className = "preview";
  if (/^image\/(png|jpeg|gif|webp)$/.test(m)) wrap.innerHTML = `<img alt="${esc(it.name)}" src="${url}">`;
  else if (m === "application/pdf") wrap.innerHTML = `<iframe title="${esc(it.name)}" src="${url}"></iframe>`;
  else if (m.startsWith("video/")) wrap.innerHTML = `<video controls src="${url}"></video>`;
  else if (m.startsWith("audio/")) wrap.innerHTML = `<audio controls src="${url}"></audio>`;
  else if (m === "text/plain" && it.size < 500_000) { const pre = document.createElement("pre"); wrap.append(pre); fetch(url).then((r) => r.text()).then((t) => (pre.textContent = t)); }
  else wrap.innerHTML = `<div class="empty"><h2>No preview for this file type</h2><p>Download it to open it on your device.</p></div>`;
  const choice = await modal({ title: it.name, body: wrap, wide: true, actions: [{ label: "Download", value: "dl" }, { label: "Close", primary: true, value: null }] });
  if (choice === "dl") doDownload(it);
}

/* menus */
const menu = $("#menu");
function openMenu(it, pos) {
  const trash = state.view === "trash";
  const entries = trash
    ? [["Restore", () => doRestore(it)], ["Delete forever", () => doDelete(it), "danger"]]
    : [[it.is_folder ? "Open" : "Preview", () => openItem(it)], !it.is_folder && ["Download", () => doDownload(it)], !it.is_folder && ["Share link", () => doShare(it)], "-",
       ["Rename", () => doRename(it)], ["Move to…", () => doMove(it)], [it.starred ? "Remove star" : "Add star", () => doStar(it)], "-", ["Move to trash", () => doTrash(it), "danger"]];
  showMenu(entries, pos);
}
function showMenu(entries, pos) {
  menu.innerHTML = "";
  entries.filter(Boolean).forEach((e) => {
    if (e === "-") return menu.append(document.createElement("hr"));
    const b = document.createElement("button"); b.textContent = e[0]; b.setAttribute("role", "menuitem"); if (e[2]) b.className = e[2];
    b.onclick = () => { hideMenu(); e[1](); }; menu.append(b);
  });
  menu.hidden = false;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(pos.left, innerWidth - w - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(pos.bottom, innerHeight - h - 8)) + "px";
  const first = $("button", menu); first && first.focus();
}
const hideMenu = () => { menu.hidden = true; };
document.addEventListener("click", (e) => { if (!menu.contains(e.target) && !e.target.closest(".kebab, #new-btn")) hideMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideMenu(); });
$("#new-btn").onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  showMenu([["New folder", doNewFolder], ["Upload files", () => $("#file-input").click()]], { left: r.left, bottom: r.bottom + 4 });
};
$("#user-btn").onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu([[state.user.email, () => {}], "-", ["Sign out", signOut]], { left: r.left - 160, bottom: r.bottom + 4 }); };
$("#layout-btn").onclick = () => { state.layout = state.layout === "grid" ? "list" : "grid"; localStorage.setItem("layout", state.layout); render(); };
$("#empty-trash").onclick = guard(async () => {
  if (!(await confirmBox("Empty trash?", "Everything in the trash will be permanently deleted. This can't be undone.", "Empty trash"))) return;
  await api("/api/trash", { method: "DELETE" }); toast("Trash emptied"); load();
});
$("#menu-toggle").onclick = () => $("#sidebar").classList.toggle("open");
$("#nav").onclick = () => $("#sidebar").classList.remove("open");
let st; $("#search").oninput = (e) => { clearTimeout(st); st = setTimeout(() => { state.q = e.target.value; load(); }, 250); };

// the My Drive link accepts drops to move items to the root
dropTarget($('#nav a[data-view="my"]'), null);
document.addEventListener("keydown", (e) => {
  if (!state.selected || e.target.closest("input, .modal")) return;
  const it = byId(state.selected); if (!it) return;
  if (e.key === "Delete" || e.key === "Backspace") state.view === "trash" ? doDelete(it) : doTrash(it);
  if (e.key === "F2") doRename(it);
  if (e.key === "Enter") openItem(it);
});

/* ---------------------------------------------------------------- upload */
function uploadFiles(files) {
  if (state.view !== "my" || state.q) { /* uploads go to the current folder, or the root from other views */ }
  const parent = state.view === "my" ? state.folder : null;
  const panel = $("#uploads"); panel.hidden = false;
  if (!$(".head", panel)) panel.innerHTML = `<div class="head"><span>Uploads</span><button class="link" id="up-close">Close</button></div>`;
  $("#up-close").onclick = () => { panel.hidden = true; panel.innerHTML = ""; };
  let pending = files.length;
  [...files].forEach((file) => {
    const row = document.createElement("div"); row.className = "item";
    row.innerHTML = `<div class="name">${esc(file.name)}</div><div class="bar"><i></i></div>`; panel.append(row);
    const fd = new FormData(); fd.append("file", file); fd.append("parent_id", parent ?? "");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/files"); xhr.setRequestHeader("Authorization", "Bearer " + state.token);
    const bar = $("i", row);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.style.width = (e.loaded / e.total) * 100 + "%"; };
    xhr.onload = () => {
      if (xhr.status === 200) bar.style.width = "100%";
      else { bar.classList.add("err"); bar.style.width = "100%"; let d = ""; try { d = JSON.parse(xhr.responseText).detail; } catch {} row.insertAdjacentHTML("beforeend", `<div class="error">${esc(typeof d === "string" ? d : "Upload failed.")}</div>`); }
      if (--pending === 0) { load(); setTimeout(() => { if (!$(".error", panel)) { panel.hidden = true; panel.innerHTML = ""; } }, 2500); }
    };
    xhr.onerror = () => { bar.classList.add("err"); row.insertAdjacentHTML("beforeend", `<div class="error">Network error. Check your connection and retry.</div>`); if (--pending === 0) load(); };
    xhr.send(fd);
  });
}
$("#file-input").onchange = (e) => { if (e.target.files.length) uploadFiles(e.target.files); e.target.value = ""; };
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
window.addEventListener("dragenter", (e) => { if (hasFiles(e)) { dragDepth++; $("#drop-overlay").hidden = false; } });
window.addEventListener("dragleave", (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $("#drop-overlay").hidden = true; } });
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $("#drop-overlay").hidden = true;
  if (state.token && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
});

/* ---------------------------------------------------------------- boot */
async function boot() {
  if (!state.token) return showAuth();
  try { state.user = (await api("/api/me")).user; } catch { return showAuth(); }
  $("#auth").hidden = true; $("#app").hidden = false;
  $("#user-btn").textContent = (state.user.name || state.user.email)[0].toUpperCase();
  load();
}
setMode(false);
boot();
