"use strict";
/* ===================== state ===================== */
let REPO = null;
let COMMITS = [];          // [{hash, parents[], author, email, date, subject, refs[]}]
let BRANCHES = [];         // [{refname, kind, name, sha, head}]
let WORKSTATUS = null;     // {branch, staged[], unstaged[], untracked[], counts}
let wdDiffCache = new Map(); // workfile cache: "staged\0path" -> display text

/* ---- in-memory response cache ----------------------------------------------
 * Scope: this document only. The graph runs in the plugin's own iframe
 * (client.js renders /git-graph/index.html in an <iframe>), so a reload of the
 * DSH page, closing the tab, or closing the plugin destroys the whole frame and
 * every Map here with it. Nothing is written to localStorage/sessionStorage, so
 * no stale commit data can survive a restart — that is the "clear it when the
 * plugin closes" requirement, satisfied by construction rather than by cleanup
 * code that could miss a path.
 *
 * Commit data is immutable (a hash always identifies the same commit), so these
 * entries never need invalidation on their own. The only thing that can change
 * is the working tree, and that uses wdDiffCache, which is cleared explicitly on
 * every gitop/refresh.
 */
const DETAIL_CACHE = new Map();   // hash -> {info, diff}
const FILEDIFF_CACHE = new Map(); // hash\0file -> filediff response
const FILELOG_CACHE = new Map();  // file -> filelog response
const PAGE_LIMIT = 400;           // safety cap so a long session cannot grow unbounded
/* Working-tree diffs are much larger than commit metadata, so they get a
 * tighter cap: 80 × a few hundred KB stays bounded while still covering every
 * file of a typical dirty tree. */
const WD_CACHE_LIMIT = 80;
function cacheGet(map, key) {
  const v = map.get(key);
  if (v === undefined) return undefined;
  // LRU touch: re-insert so the newest entries survive the eviction below
  map.delete(key); map.set(key, v);
  return v;
}
function cacheSet(map, key, val, limit = PAGE_LIMIT) {
  map.set(key, val);
  if (map.size > limit) {
    // drop the oldest entry (Map keeps insertion order)
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
}
/** Drop every cached response. Called when cached data could have gone stale:
 *  repo switch, explicit refresh, and any successful gitop. */
function clearResponseCache() {
  DETAIL_CACHE.clear();
  FILEDIFF_CACHE.clear();
  FILELOG_CACHE.clear();
}
function loadStored(key, def) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? def : JSON.parse(v);
  } catch { return def; }
}
function saveStored(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ }
}
let WD_SHOW = loadStored("gg2-wdshow", { staged: true, unstaged: true, untracked: true }); // group visibility toggles
let WD_FOLDED = loadStored("gg2-wdfolded", false);      // whole panel collapsed
const WD_GROUP_FOLDED = new Set(loadStored("gg2-wdgroupfolded", [])); // folded group keys
const WD_SELECT = new Set(); // "groupKey\0path" of checkbox-selected rows
/* The one cursor. A mouse click and ↑/↓ both write this and nothing else.
 *
 * It used to be two cursors — `SELECTED` (hash, written by clicks) for the
 * highlighted row, and `KEY_IDX` (index into COMMITS, written by ↑/↓) for the
 * dashed outline. Clicking a row and then pressing ↓ restarted from the top of
 * the list, because the keyboard cursor had never been told where the mouse
 * went. Worse, KEY_IDX was an index into `COMMITS` but was computed from a
 * *filtered row list*, so with a branch filter or a collapsed group the outline
 * could sit on a commit that was not even the one last pressed.
 *
 * A hash is also the only stable identity here: indices shift under filtering,
 * folding and pagination, so any index-based cursor needs re-syncing after
 * every render. */
let SELECTED = null;
let SEARCH = "";
let FILTER = "all";        // "all" | "multi"
let HIGHLIGHT = null;      // branch sha highlighted via legend click (others ghosted)

const ROW_H = 40, LANE_W = 30, X0 = 26, Y0 = 46, NODE_R = 6;
const LANE_COLORS = [
  "#58a6ff", "#3fb950", "#d29922", "#bc8cff", "#f778ba", "#39c5cf",
  "#f85149", "#7ee787", "#ffa198", "#a5d6ff", "#e3b341", "#79c0ff"
];
const AUTHOR_COLORS = [
  "#f0883e", "#3fb950", "#d29922", "#bc8cff", "#f778ba", "#39c5cf",
  "#58a6ff", "#7ee787", "#ffa198", "#a5d6ff", "#e3b341", "#f85149"
];
function authorColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AUTHOR_COLORS[h % AUTHOR_COLORS.length];
}

/* Branch color of a commit: HEAD branch green, other local branches in order,
 * remotes grey, shared history follows the HEAD branch. The cache lives until
 * the commit/branch set changes (load / loadMore / reloadGraphLight). */
const BRANCH_PALETTE = LANE_COLORS.filter((c) => c !== "#3fb950");
let BRANCH_COLOR_CACHE = null;
function branchColorOf(hash) {
  if (BRANCH_COLOR_CACHE) return BRANCH_COLOR_CACHE.get(hash) || "#8b949e";
  const cache = new Map();
  const headB = BRANCHES.find((b) => b.head);
  if (headB) {
    const set = reachable(headB.sha);
    for (const h of set) cache.set(h, "#3fb950");
  }
  const locals = BRANCHES.filter((b) => b.kind === "local" && !b.head);
  for (let i = 0; i < locals.length; i++) {
    const set = reachable(locals[i].sha);
    const color = BRANCH_PALETTE[i % BRANCH_PALETTE.length];
    for (const h of set) if (!cache.has(h)) cache.set(h, color);
  }
  const remotes = BRANCHES.filter((b) => b.kind === "remote");
  for (const b of remotes) {
    const set = reachable(b.sha);
    for (const h of set) if (!cache.has(h)) cache.set(h, "#6e7681");
  }
  BRANCH_COLOR_CACHE = cache;
  return cache.get(hash) || "#8b949e";
}

const $ = (id) => document.getElementById(id);
let COMMIT_MAP = null;
let COMMIT_MAP_SRC = null;
let COMMIT_MAP_LEN = -1;
/** Hash -> commit, rebuilt only when the COMMITS array is replaced or grows.
 *  The old version allocated a fresh Map on every call, and renderLaneGraph()
 *  called it once PER NODE — O(n²) Map insertions on a loaded history. */
function byHash() {
  if (COMMIT_MAP && COMMIT_MAP_SRC === COMMITS && COMMIT_MAP_LEN === COMMITS.length) return COMMIT_MAP;
  COMMIT_MAP = new Map(COMMITS.map((c) => [c.hash, c]));
  COMMIT_MAP_SRC = COMMITS;
  COMMIT_MAP_LEN = COMMITS.length;
  return COMMIT_MAP;
}

/* ===================== theme (8 style presets, ported from 拾光记) ===================== */
// themePref: 'auto' | 'dark' | 'light' | 'sakura' | 'ocean' | 'forest' | 'night' | 'candy' | 'business' | 'starry' | 'tech'
const THEMES = ["auto", "dark", "light", "sakura", "ocean", "forest", "night", "candy", "business", "starry", "tech"];
const THEME_LABELS = { auto: "自动", dark: "深色", light: "浅色", sakura: "🌸 樱花", ocean: "🌊 海洋", forest: "🌲 森林", night: "🌙 夜空", candy: "🍬 糖果", business: "💼 商务", starry: "✨ 星河", tech: "🤖 科技" };
const THEME_CLASSES = ["gg-theme-sakura", "gg-theme-ocean", "gg-theme-forest", "gg-theme-night", "gg-theme-candy", "gg-theme-business", "gg-theme-starry", "gg-theme-tech"];
/* Theme is stored as JSON like every other key (saveStored), but it used to be
 * written raw (`localStorage.setItem("gg2-theme", themePref)`). Reading it back
 * raw meant the JSON-quoted form `"ocean"` failed `THEMES.includes`, so the key
 * was DELETED and the theme fell back to auto on the next load — the "switching
 * tabs resets my settings" report. Accept both forms and normalise to one. */
function readStoredTheme() {
  let raw = null;
  try { raw = localStorage.getItem("gg2-theme"); } catch { return "auto"; }
  if (!raw) return "auto";
  let val = raw;
  try { val = JSON.parse(raw); } catch { /* legacy: stored unquoted */ }
  if (THEMES.includes(val)) return val;
  // v0.8 removed violet/sunset presets; drop leftovers so they cannot keep
  // poisoning the read (this is the only place they are cleared).
  try { localStorage.removeItem("gg2-theme"); } catch { /* ignore */ }
  return "auto";
}
let themePref = readStoredTheme();

function parentIsDark() {
  try {
    const d = window.parent.document.body.dataset.dsDarkTheme;
    return d === undefined || (d !== "false" && d !== "");
  } catch { return true; }
}
function currentStyleId() {
  // which style preset is active ('' for auto/dark/light)
  if (THEME_CLASSES.includes("gg-theme-" + themePref)) return themePref;
  return "";
}
function applyTheme() {
  const root = document.documentElement;
  root.classList.remove("gg-light", ...THEME_CLASSES);
  if (themePref === "auto") root.classList.toggle("gg-light", !parentIsDark());
  else if (themePref === "light") root.classList.add("gg-light");
  else if (themePref !== "dark") root.classList.add("gg-theme-" + themePref);
  renderBgDecor();
  // Full settings sync, not just the picker: the gear's "not at default" dot is
  // derived from the theme too, and refreshing only the picker left the dot on
  // screen after switching back to a default theme.
  syncSettingsState();
}

/* decorative background layer, ported from 拾光记 renderBgDecor */
function renderBgDecor() {
  const box = $("ggDeco");
  if (!box) return;
  box.innerHTML = "";
  const style = currentStyleId();
  if (!style) return; // auto/dark/light have no ambient decoration
  const rnd = (a, b) => a + Math.random() * (b - a);
  const add = (cls, st, txt) => {
    const i = document.createElement("i");
    i.className = cls;
    Object.assign(i.style, st || {});
    if (txt) i.textContent = txt;
    box.appendChild(i);
    return i;
  };
  if (style === "starry" || style === "night") {
    const n = style === "starry" ? 56 : 36;
    const sc = "#fff";
    for (let i = 0; i < n; i++) {
      const cls = "star" + (i % 6 === 0 ? " l" : i % 5 === 0 ? " glow" : i % 3 === 0 ? " s" : "");
      add(cls, { left: rnd(0, 96) + "%", top: rnd(0, 94) + "%", animationDelay: rnd(0, 3.5) + "s", animationDuration: rnd(1.8, 4.5) + "s", background: sc, color: sc });
    }
    add("moon", { right: rnd(10, 34) + "px", top: rnd(56, 130) + "px" });
    for (let i = 0; i < 3; i++) add("meteor", { right: rnd(4, 38) + "%", top: rnd(2, 20) + "%", animationDelay: rnd(1.2, 7) + "s" });
    if (style === "starry") add("earth", { right: "-30px", bottom: "-58px" });
  } else if (style === "sakura") {
    for (let i = 0; i < 36; i++) {
      const sz = i % 8 === 0 ? "xl" : i % 4 === 0 ? "l" : i % 5 === 0 ? "s" : "";
      const pc = i % 3 === 0 ? { "--pc1": "#ffc1d8", "--pc2": "#ff8fb3" } : i % 3 === 1 ? { "--pc1": "#ffd6e5", "--pc2": "#ff9ec7" } : { "--pc1": "#ff9db8", "--pc2": "#f76b95" };
      add("petal " + sz, { left: rnd(2, 95) + "%", top: rnd(0, 70) + "%", animationDelay: rnd(0, 9) + "s", animationDuration: rnd(6, 16) + "s", ...pc });
    }
  } else if (style === "ocean") {
    add("wave", {});
    add("wave w2", {});
    for (let i = 0; i < 4; i++) add("sunbeam", { left: rnd(8, 72) + "%", animationDelay: rnd(0, 4) + "s", animationDuration: rnd(6, 9) + "s" });
    for (let i = 0; i < 5; i++) add("ripple", { left: rnd(5, 90) + "%", bottom: rnd(8, 32) + "%", animationDelay: rnd(0, 5) + "s", animationDuration: rnd(5, 8) + "s" });
    for (let i = 0; i < 28; i++) {
      const sz = i % 4 === 0 ? "l" : i % 4 === 1 ? "s" : "";
      add("bubble " + sz, { left: rnd(2, 96) + "%", animationDelay: rnd(0, 9) + "s", animationDuration: rnd(7, 15) + "s" });
    }
    for (let i = 0; i < 5; i++) add("fish" + (i === 2 || i === 4 ? " s" : ""), { top: rnd(52, 80) + "%", animationDelay: rnd(0, 6) + "s", animationDuration: rnd(12, 18) + "s" }, i % 2 ? "🐠" : "🐟");
  } else if (style === "forest") {
    add("tree xl", { left: rnd(-4, 14) + "%" });
    add("tree", { left: rnd(72, 96) + "%" });
    add("tree s", { left: rnd(30, 64) + "%" });
    add("tree xs", { left: rnd(60, 86) + "%" });
    add("grass", { left: rnd(0, 20) + "%" });
    add("grass", { left: rnd(38, 60) + "%" });
    add("grass", { left: rnd(74, 96) + "%" });
    for (let i = 0; i < 12; i++) add("leaf", { left: rnd(2, 95) + "%", top: rnd(0, 60) + "%", animationDelay: rnd(0, 11) + "s", animationDuration: rnd(9, 17) + "s" });
    for (let i = 0; i < 10; i++) add("firefly", { left: rnd(3, 95) + "%", top: rnd(6, 80) + "%", animationDelay: rnd(0, 6) + "s", animationDuration: rnd(5, 9) + "s" });
    for (let i = 0; i < 2; i++) add("butterfly", { left: rnd(14, 78) + "%", top: rnd(14, 46) + "%", animationDelay: rnd(0, 5) + "s", animationDuration: rnd(9, 14) + "s" }, "🦋");
    for (let i = 0; i < 4; i++) add("mushroom", { left: rnd(8, 88) + "%", bottom: rnd(2, 10) + "%", animationDelay: rnd(0, 3) + "s", animationDuration: rnd(4, 7) + "s" }, i % 2 ? "🍄" : "🌸");
  } else if (style === "candy") {
    const cs = ["#ffb74d", "#ff8fb3", "#7ec8e3", "#81c784", "#b39ddb", "#ff9a76", "#4fc3f7", "#f48fb1"];
    for (let i = 0; i < 28; i++) add("dot" + (i % 4 === 0 ? " l" : ""), { left: rnd(2, 96) + "%", top: rnd(5, 93) + "%", background: cs[i % cs.length], animationDelay: rnd(0, 4) + "s", animationDuration: rnd(4, 8) + "s", width: rnd(7, 18) + "px", height: rnd(7, 18) + "px" });
    add("rainbow", {});
    const cb = ["#ff9a76", "#ff8fb3", "#7ec8e3", "#81c784", "#ffd54f", "#b39ddb"];
    for (let i = 0; i < 18; i++) add("ribbon", { left: rnd(2, 94) + "%", background: cb[i % cb.length], animationDelay: rnd(0, 6) + "s", animationDuration: rnd(7, 12) + "s" });
    for (let i = 0; i < 10; i++) add("lollipop", { left: rnd(4, 92) + "%", top: rnd(0, 40) + "%", animationDelay: rnd(0, 5) + "s", animationDuration: rnd(7, 12) + "s" }, "🍭");
  } else if (style === "tech") {
    for (let i = 0; i < 6; i++) add("signal" + (i ? " s" + (i % 3 + 1) : ""), { left: rnd(6, 74) + "%", top: rnd(6, 74) + "%" });
    add("gear", { right: "22px", top: "16%" }, "⚙️");
    add("gear g2", { left: "14px", bottom: "14%" }, "🔩");
    for (let i = 0; i < 12; i++) {
      add("circuit", { left: rnd(3, 50) + "%", top: rnd(8, 84) + "%", width: rnd(80, 200) + "px", animationDelay: rnd(0, 2.5) + "s" });
      if (i % 2 === 0) add("circuit.v", { left: rnd(55, 95) + "%", top: rnd(6, 70) + "%", animationDelay: rnd(0, 3) + "s" });
    }
    for (let i = 0; i < 24; i++) {
      add("circuit-node", { left: rnd(4, 93) + "%", top: rnd(5, 90) + "%", animationDelay: rnd(0, 1.8) + "s" });
      if (i % 3 === 0) add("chip", { left: rnd(4, 93) + "%", top: rnd(5, 90) + "%", animationDelay: rnd(0, 3) + "s" });
    }
  } else if (style === "business") {
    for (let i = 0; i < 14; i++) add("geo" + (i % 3 === 0 ? " circle" : ""), { left: rnd(4, 90) + "%", top: rnd(6, 88) + "%", animationDelay: rnd(0, 5) + "s", width: rnd(26, 46) + "px", height: rnd(26, 46) + "px" });
    add("glass", { left: rnd(6, 20) + "%", top: rnd(12, 40) + "%" });
    add("glass", { left: rnd(72, 88) + "%", top: rnd(16, 34) + "%" });
    add("glass", { left: rnd(20, 40) + "%", top: rnd(58, 80) + "%" });
    add("glass", { left: rnd(58, 70) + "%", top: rnd(60, 76) + "%" });
    add("glass bar", { left: rnd(30, 58) + "%", top: rnd(26, 60) + "%" });
    for (let i = 0; i < 12; i++) add("particle" + (i % 3 === 0 ? " line" : ""), { left: rnd(4, 92) + "%", top: rnd(8, 86) + "%", animationDelay: rnd(0, 4) + "s", width: rnd(5, 6) + "px", height: rnd(5, 6) + "px" });
  }
}
function followParentTheme() {
  try {
    const parent = window.parent.document.body;
    new MutationObserver(() => { if (themePref === "auto") applyTheme(); })
      .observe(parent, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
  } catch { /* cross-origin: keep default dark */ }
}

/* ===================== settings dialog =====================
 * The per-repo view (grouped / flat) and the theme are both set-once, rarely
 * revisited choices. They used to sit in the header as `▤ 平铺` and `◐ 主题`,
 * which put two permanent buttons in the most expensive strip of the page for
 * two controls a user touches once. They now live one level down, behind the
 * gear, leaving the header for things you act on while reading history.
 *
 * "二级页面" here is a full dialog rather than a dropdown: the theme list is 11
 * entries and needs the room, and a dropdown crowded next to the filter and
 * date popovers would be a third layer of the same pattern. */
const THEME_SWATCHES = {
  auto: "linear-gradient(135deg,#2b3440 50%,#dfe6ee 50%)",
  dark: "#12171f",
  light: "#f7f9fb",
  sakura: "#ff9ec7",
  ocean: "#4aa8d8",
  forest: "#4caf50",
  night: "#28284a",
  candy: "#ffb74d",
  business: "#7f9aa6",
  starry: "#3a2a7a",
  tech: "#00b0ff",
};
/* Plain names for the picker. THEME_LABELS carries the emoji as well, and using
 * it here printed both a colour chip and an emoji for the same theme — two
 * symbols for one meaning, and the emoji is the one that does not preview
 * anything. The emoji survive in the tooltip and the README. */
const THEME_NAMES = {
  auto: "自动", dark: "深色", light: "浅色", sakura: "樱花", ocean: "海洋",
  forest: "森林", night: "夜空", candy: "糖果", business: "商务",
  starry: "星河", tech: "科技",
};
let settingsBuilt = false;
function buildSettings() {
  if (settingsBuilt) return;
  settingsBuilt = true;
  const box = $("stThemes");
  for (const id of THEMES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "st-theme";
    b.dataset.theme = id;
    b.title = "主题：" + THEME_LABELS[id];
    const sw = document.createElement("span");
    sw.className = "sw";
    sw.style.background = THEME_SWATCHES[id] || "#666";
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = THEME_NAMES[id] || id;
    b.appendChild(sw);
    b.appendChild(nm);
    b.addEventListener("click", () => setTheme(id));
    box.appendChild(b);
  }
  for (const b of $("stView").querySelectorAll("button")) {
    b.addEventListener("click", () => setFlatMode(b.dataset.view === "flat"));
  }
}
function syncThemePicker() {
  const box = $("stThemes");
  if (!box) return;
  for (const b of box.children) b.classList.toggle("on", b.dataset.theme === themePref);
}
/* One setter for both entry points; the header has no theme control any more,
 * so a stale `.on` here is the only way the picker could disagree with reality. */
function setTheme(id) {
  if (!THEMES.includes(id) || id === themePref) return;
  themePref = id;
  // Use saveStored (JSON) like every other key — writing the raw string here was
  // what made the read path reject its own value and fall back to auto.
  saveStored("gg2-theme", themePref);
  prefsSync({ "gg2-theme": themePref });
  applyTheme();
}
function syncSettingsState() {
  const seg = $("stView");
  if (seg) for (const b of seg.querySelectorAll("button")) b.classList.toggle("on", (b.dataset.view === "flat") === FLAT_MODE);
  syncThemePicker();
  const gear = $("btnSettings");
  if (gear) {
    const custom = themePref !== "auto" && themePref !== "dark";
    gear.classList.toggle("dot", custom || FLAT_MODE);
    gear.title = "设置（视图、主题、快捷键）" + (custom || FLAT_MODE ? " · 有非默认项" : "");
  }
}
function toggleSettings(force) {
  const d = $("settingsDlg");
  const show = force !== undefined ? force : !d.classList.contains("show");
  if (show) { buildSettings(); syncSettingsState(); }
  d.classList.toggle("show", show);
}
$("btnSettings").addEventListener("click", (ev) => { ev.stopPropagation(); toggleSettings(); });
$("stClose").addEventListener("click", () => toggleSettings(false));
$("stShortcut").addEventListener("click", () => { toggleSettings(false); toggleShortcutDlg(true); });
$("settingsDlg").addEventListener("click", (ev) => { if (ev.target === $("settingsDlg")) toggleSettings(false); });

/* ===================== api ===================== */
/* Server ops that mutate state. These must be sent as POST: a cross-site page
 * can point an <img>/<a> at a GET URL and have the browser fire it, but it
 * cannot make the browser issue a POST without a CORS preflight (which the
 * server never grants). The server enforces the same list. */
const WRITE_OPS = new Set(["gitop", "autoupdate", "addrepo", "prefswrite"]);

async function api(op, extra = {}) {
  const p = new URLSearchParams();
  p.set("op", op);
  if (REPO) p.set("repo", REPO);
  // Graph fetches inherit the ordering of the current view unless the caller
  // pinned one explicitly. Injected here rather than at each call site so the
  // first page, "load more", and the light reload can never disagree — a
  // mismatch would splice two different orderings into one list.
  const params = (op === "graph" && extra.order === undefined)
    ? { order: FLAT_MODE ? "date" : "topo", ...extra }
    : extra;
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const item of v) p.append(k, item);
    else if (v !== undefined && v !== null && v !== "") p.set(k, v);
  }
  const init = WRITE_OPS.has(op)
    ? {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }
    : undefined;
  const res = await fetch("/git-graph/api?" + p.toString(), init);
  return res.json();
}

/* ===================== helpers ===================== */
function relTime(iso) {
  try {
    const t = new Date(iso).getTime();
    const d = Date.now() - t;
    if (isNaN(t)) return "";
    if (d < 60e3) return "刚刚";
    if (d < 3600e3) return Math.floor(d / 60e3) + " 分钟前";
    if (d < 86400e3) return Math.floor(d / 3600e3) + " 小时前";
    if (d < 30 * 86400e3) return Math.floor(d / 86400e3) + " 天前";
    const m = new Date(t);
    return (m.getFullYear() === new Date().getFullYear() ? "" : m.getFullYear() + "年") + (m.getMonth() + 1) + "月" + m.getDate() + "日";
  } catch { return ""; }
}
function short7(h) { return h.slice(0, 7); }
function laneColor(l) { return LANE_COLORS[l % LANE_COLORS.length]; }

/**
 * Normalize branch rows. Newer server splits fields with %09 (tab); an older
 * running server emits literal %x1f inside one field — recover from that too.
 */
function normalizeBranch(b) {
  const raw = b.refname || "";
  if (raw.includes("%x1f")) {
    const parts = raw.split("%x1f");
    const refname = parts[0];
    return {
      refname,
      kind: refname.startsWith("refs/tags/") ? "tag" : refname.startsWith("refs/remotes/") ? "remote" : "local",
      name: refname.replace(/^refs\/(heads|remotes|tags)\//, ""),
      sha: parts[1] || "",
      head: (parts[2] || "").trim() === "*",
    };
  }
  return b;
}

/** Set of commits reachable from tip (BFS over parents). */
function reachable(tip) {
  const map = byHash();
  const seen = new Set();
  const stack = [tip];
  while (stack.length) {
    const h = stack.pop();
    if (seen.has(h)) continue;
    const c = map.get(h);
    if (!c) continue;
    seen.add(h);
    for (const p of c.parents) stack.push(p);
  }
  return seen;
}

/* ===================== filter ===================== */
const CHECKED_SET = new Set(); // branch shas kept visible when FILTER === "multi"
/* Branch filter, stored as the list of branches the user turned OFF.
 *
 * Storing the *hidden* set (rather than the visible one) is what makes a newly
 * created branch visible by default — it is simply absent from the blacklist.
 * With the old "store the checked ones" scheme every new branch was invisible
 * until manually ticked, which read as "my branches disappeared".
 *
 * `null` = nothing hidden = show everything (the default).
 * Persisted on the server (see prefsSync) so it survives DSH port changes,
 * which wipe localStorage because it is origin-scoped. */
let HIDDEN_REFS = loadStored("gg2-bfilter-hidden", null);
/* Legacy key from the "store visible" era. Read once for migration, then the
 * new key takes over; see migrateLegacyFilter(). */
const LEGACY_VISIBLE_REFS = loadStored("gg2-bfilter", null);
/* Pagination: the first screen only needs a short list, and every extra page is
 * an extra `git log` process (~200ms+ on Windows), so the initial fetch is kept
 * small and later pages are bigger — scrolling down is already an explicit
 * "I want more" gesture, so it can afford a larger batch than the first paint. */
const PAGE_INITIAL = 50;  // commits loaded on first paint
const PAGE_MORE = 100;    // commits loaded per scroll/load-more step
let LOADED = 0;           // commits loaded so far
let TOTAL = 0;            // total commits in the repo
let REPO_LIST = [];       // available repos for the switcher
let ADDED_REPOS = loadStored("gg2-repos", []);   // repos added by the user via "打开文件夹" (persisted)
let PICK_PATH = "";  // folder picker: currently browsed path
let PICK_PARENT = null; // folder picker: authoritative parent path from the server (null = at a root)
let PICK_ROOT = null; // folder picker: git root containing PICK_PATH (null = not in a repo)
function visibleSet() {
  if (FILTER === "all") return null;
  if (FILTER === "multi") {
    // 严格语义：只显示「已勾选分支」可达的提交；全部不勾选 → 空列表（不回落全显）
    const union = new Set();
    for (const b of BRANCHES) {
      if (b.kind === "tag") continue;
      if (CHECKED_SET.has(b.sha)) {
        const s = reachable(b.sha);
        for (const h of s) union.add(h);
      }
    }
    return union;
  }
  return reachable(FILTER);
}

/* ===================== graph render ===================== */
/* (long-chain folding removed — branch-group folding covers it) */

/* ===== branch-group rows: each branch (incl. the HEAD mainline) gets a foldable group header ===== */
let BRANCH_FOLDED = new Set(loadStored("gg2-brfolded", [])); // refnames of collapsed branch groups
let BRANCH_FOLD_DEFAULTED = false; // one-time: fold every branch group on very first load
/* Flat view: every commit on one continuous timeline, no branch group headers.
 * Default OFF — the grouped view is the primary way to read the history ("what
 * is on this branch"). Flat mode is the opt-in view that comes with the lane
 * graph, because lanes can only stay continuous when nothing splits the rows. */
let FLAT_MODE = loadStored("gg2-flat", false);
/* Honours a stored value from an earlier build of this feature: flat used to be
 * the default while it was being built, so a stale `true` would silently keep the
 * lane view on. The flag is separate from `gg2-flat` so "the user chose flat" can
 * be told apart from "flat was only ever the development default".
 *
 * It MUST also be persisted server-side (see prefsLoad): localStorage is
 * origin-scoped and this plugin shares the DSH origin, so a web-port change wipes
 * the flag, the one-time reset re-runs, and the user's view choice is silently
 * reverted. */
const FLAT_DEFAULT_MIGRATED = loadStored("gg2-flat-reset", false);

function buildRows(vis) {
  const rows = []; // {type:'commit', hash} | {type:'head', refname, name, tip, count, head?}
  const seen = new Set();
  const map = byHash();

  // Flat mode: COMMITS is already in topo order, so emit it as-is. Still apply
  // the branch filter (vis) — flat means "no grouping", not "no filtering".
  if (FLAT_MODE) {
    for (const c of COMMITS) {
      if (!map.has(c.hash)) continue;
      if (vis && !vis.has(c.hash)) continue;
      rows.push({ type: "commit", hash: c.hash });
    }
    return rows;
  }

  const headB = BRANCHES.find((b) => b.head) || BRANCHES.find((b) => b.kind === "local");
  // With an active branch filter, a branch whose tip is not visible must not
  // mark its commits as seen — otherwise a visible branch that shares those
  // commits (e.g. feature/x pointing at an ancestor of the hidden HEAD) would
  // end up with an empty chain and its rows would vanish.
  if (headB && !(vis && !vis.has(headB.sha))) {
    const chain = [];
    let cur = headB.sha;
    while (cur && map.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = map.get(cur).parents[0] || null;
    }
    if (chain.length) {
      rows.push({ type: "head", refname: headB.refname, name: headB.name, tip: chain[0], count: chain.length, head: true });
      if (!BRANCH_FOLDED.has(headB.refname)) {
        for (const h of chain) rows.push({ type: "commit", hash: h });
      }
    }
  }
  for (const b of BRANCHES) {
    if (b.kind !== "local" || (headB && b.refname === headB.refname)) continue;
    if (vis && !vis.has(b.sha)) continue; // filtered-out branch: hide its group
    const chain = [];
    let cur = b.sha;
    while (cur && map.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      const p = map.get(cur).parents[0] || null;
      if (p && seen.has(p)) break; // merged into an already-shown commit
      cur = p;
    }
    if (!chain.length) continue;
    rows.push({ type: "head", refname: b.refname, name: b.name, tip: chain[0], count: chain.length });
    if (!BRANCH_FOLDED.has(b.refname)) {
      for (const h of chain) rows.push({ type: "commit", hash: h });
    }
  }
  // remote branches: same treatment, so remote-only commits get their own
  // foldable group instead of vanishing (or being buried in the leftovers).
  // Even a fully-synced remote branch (chain empty) still gets a group header
  // so origin/* is always visible; it just shows a "synced" hint when open.
  for (const b of BRANCHES) {
    if (b.kind !== "remote") continue;
    if (vis && !vis.has(b.sha)) continue;
    const chain = [];
    let cur = b.sha;
    while (cur && map.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      const p = map.get(cur).parents[0] || null;
      if (p && seen.has(p)) break; // merged into an already-shown commit
      cur = p;
    }
    const synced = !chain.length;
    // label: "已同步" only when the remote tip equals a same-named local branch;
    // otherwise the commits are all already shown under another group -> "已包含"
    let syncedLabel = "已包含";
    if (synced) {
      const short = b.name.replace(/^[^/]+\//, ""); // origin/main -> main
      const localTwin = BRANCHES.find((lb) => lb.kind === "local" && lb.name === short);
      if (localTwin && localTwin.sha === b.sha) syncedLabel = "已同步";
    }
    rows.push({ type: "head", refname: b.refname, name: b.name, tip: b.sha, count: synced ? 0 : chain.length, synced, syncedLabel });
    if (!synced && !BRANCH_FOLDED.has(b.refname)) {
      for (const h of chain) rows.push({ type: "commit", hash: h });
    }
  }
  // leftovers (should not happen with --all; with a filter they belong to
  // hidden branches, so drop them unless they are inside the visible set)
  for (const c of COMMITS) {
    if (!seen.has(c.hash) && (!vis || vis.has(c.hash))) {
      seen.add(c.hash);
      rows.push({ type: "commit", hash: c.hash });
    }
  }
  return rows;
}

/** Ctrl+B: collapse/expand every branch group at once. */
function toggleBranchGroups() {
  const refs = BRANCHES.filter((b) => b.kind === "local" || b.kind === "remote").map((b) => b.refname);
  if (!refs.length) return;
  const allFolded = refs.every((r) => BRANCH_FOLDED.has(r));
  for (const r of refs) {
    if (allFolded) BRANCH_FOLDED.delete(r);
    else BRANCH_FOLDED.add(r);
  }
  saveStored("gg2-brfolded", [...BRANCH_FOLDED]);
  render();
}

/* ---- lane graph geometry ----------------------------------------------------
 * Spacing tuned against a real 4-lane repo: rows are ~53px tall, so 30px per
 * lane keeps the S-curves gently sloped instead of near-vertical. The gutter
 * grows with the lane count and a single-lane repo still gets a slim gutter.
 */
const LANE_STEP = 30;
const LANE_PAD = 22;
function graphGutterWidth() {
  const layout = ensureLayout();
  return Math.max(56, LANE_PAD * 2 + Math.max(1, layout.laneCount - 1) * LANE_STEP + 8);
}

/** Draw lanes + nodes for every visible commit row as ONE svg overlay.
 *  `rowEls` maps commit hash -> the row element, so the vertical positions come
 *  from the browser's real layout (row heights can differ when a message wraps
 *  or the detail panel pushes things around). */
function renderLaneGraph(list, rowEls) {
  const old = list.querySelector("#laneSvg");
  if (old) old.remove();
  // Grouped mode has no gutter and no continuous timeline, so there is nothing
  // to draw. Bail out before touching layout: this also keeps `ensureLayout`
  // (a full O(n) pass) from running for a graph that will not be shown.
  if (!FLAT_MODE) return;
  if (!rowEls.size) return;

  const layout = ensureLayout();
  const width = graphGutterWidth();
  const listRect = list.getBoundingClientRect();
  const color = (i) => LANE_COLORS[i % LANE_COLORS.length];

  // node centre in list-local coordinates
  const nodePos = new Map();   // row index -> {x, y, hash}
  for (const node of layout.nodes) {
    const el = rowEls.get(node.hash);
    if (!el) continue;                       // filtered out or not rendered
    const r = el.getBoundingClientRect();
    if (!r.height) continue;
    nodePos.set(node.row, {
      x: LANE_PAD + node.lane * LANE_STEP,
      y: r.top - listRect.top + r.height / 2,
      hash: node.hash,
      lane: node.lane,
      colour: node.colour,
    });
  }
  if (!nodePos.size) return;

  const height = list.scrollHeight;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.id = "laneSvg";
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  // --- edges: each edge joins a row to the NEXT row, so y1/y2 come from the
  // two neighbouring nodes. Edges whose endpoints are off-screen (a row hidden
  // by a filter) are skipped rather than drawn across the gap.
  for (const e of layout.edges) {
    const a = nodePos.get(e.row);
    const b = nodePos.get(e.row + 1);
    if (!a || !b) continue;
    const x1 = LANE_PAD + e.fromLane * LANE_STEP;
    const x2 = LANE_PAD + e.toLane * LANE_STEP;
    const y1 = a.y;
    const y2 = b.y;
    let d;
    if (x1 === x2) {
      d = `M ${x1} ${y1} L ${x2} ${y2}`;
    } else {
      // Smooth S-curve: the horizontal move happens near the vertical midpoint,
      // which is what makes a fork read as "leaving the lane" rather than as a
      // diagonal slash. Control points at 50% keep both ends tangent-vertical.
      const span = y2 - y1;
      const curve = Math.max(8, span * 0.5);
      d = `M ${x1} ${y1} C ${x1} ${y1 + curve}, ${x2} ${y2 - curve}, ${x2} ${y2}`;
    }
    const shadow = document.createElementNS(NS, "path");
    shadow.setAttribute("class", "lane-shadow");
    shadow.setAttribute("d", d);
    svg.appendChild(shadow);

    const line = document.createElementNS(NS, "path");
    line.setAttribute("class", "lane-line");
    line.setAttribute("d", d);
    line.setAttribute("stroke", color(e.colour));
    if (e.missingParent) line.setAttribute("stroke-dasharray", "3 3");
    svg.appendChild(line);
  }

  // --- nodes on top of the edges
  // One map for all nodes: byHash() used to allocate a fresh Map of every
  // commit on each iteration, which is O(n²) Map inserts on a loaded history.
  const map = byHash();
  for (const [, p] of nodePos) {
    const c = map.get(p.hash);
    const isHead = c && c.refs.some((r) => r.head);
    const hit = document.createElementNS(NS, "circle");
    hit.setAttribute("class", "lane-hit");
    hit.setAttribute("cx", p.x);
    hit.setAttribute("cy", p.y);
    hit.setAttribute("r", "10");
    hit.dataset.hash = p.hash;
    hit.addEventListener("click", (ev) => { ev.stopPropagation(); selectCommit(p.hash); });
    svg.appendChild(hit);

    const node = document.createElementNS(NS, "circle");
    node.dataset.hash = p.hash;
    node.setAttribute("class", "lane-node" + (isHead ? " head" : "") + (SELECTED === p.hash ? " sel" : ""));
    node.setAttribute("cx", p.x);
    node.setAttribute("cy", p.y);
    node.setAttribute("r", SELECTED === p.hash ? "6.5" : "4.8");
    node.setAttribute("fill", isHead ? "var(--bg2)" : color(p.colour));
    if (isHead) node.setAttribute("stroke", color(p.colour));
    svg.appendChild(node);
  }

  list.appendChild(svg);
}

/* ---- branch tips at the end of each lane ------------------------------------
 * Where a branch's history leaves the visible list, pin its name to that point
 * in the gutter. Without this the labels only exist inline on the row that
 * happens to carry the ref, so a branch whose tip scrolled far away is
 * invisible — and in flat mode the tip row is often not where the eye is.
 *
 * Rendered as absolutely-positioned HTML (not SVG text) so the pills reuse the
 * normal .cl-ref styling and stay crisp at any zoom.
 */
function render() {
  // Branch colours are invalidated when the commit/branch set changes (load,
  // loadMore, reloadGraphLight), not on every filter or selection repaint.
  const map = byHash();
  const vis = visibleSet();
  const hlSet = HIGHLIGHT ? reachable(HIGHLIGHT) : null;
  const ROWS = buildRows(vis);
  const list = $("commitList");
  list.innerHTML = "";

  const commitRows = [];
  let prevCommitEl = null;
  let pendingHead = null;   // group header waiting for its first surviving commit
  const commitRowEls = new Map();   // hash -> row element (for lane geometry)

  // Pre-compute, per branch group, how many of its commits survive the filters.
  // This cannot walk ROWS: buildRows() omits commit rows for collapsed groups,
  // so a filtered match hiding inside a collapsed group would be invisible here
  // and the header (the only thing on screen) would be dropped. Walk each
  // branch's first-parent chain directly instead.
  // Counted per branch, NOT deduplicated across branches: a local branch and its
  // remote twin reach the same commits, and both headers should stay visible.
  const groupCounts = new Map();   // refname -> surviving commit count
  if (filtersActive()) {
    for (const b of BRANCHES) {
      if (b.kind !== "local" && b.kind !== "remote") continue;
      if (vis && !vis.has(b.sha)) continue;
      let n = 0;
      let cur = b.sha;
      const local = new Set();
      while (cur && map.has(cur) && !local.has(cur)) {
        local.add(cur);
        if (passesFilters(map.get(cur))) n++;
        cur = map.get(cur).parents[0] || null;
      }
      groupCounts.set(b.refname, n);
    }
  }

  for (let i = 0; i < ROWS.length; i++) {
    const r = ROWS[i];
    if (r.type === "head") {
      // hide the whole group when its branch is filtered out
      if (vis && !vis.has(r.tip)) continue;
      if (filtersActive()) {
        // Show the header only when this group still has matching commits.
        // When expanded, the first surviving commit emits it (pendingHead) so
        // it stays attached to its rows; when collapsed there are no commit
        // rows at all, so emit it here.
        if ((groupCounts.get(r.refname) || 0) === 0) continue;
        if (BRANCH_FOLDED.has(r.refname)) {
          list.appendChild(buildHeadRow(r));
        } else {
          pendingHead = pendingHead || r;
        }
        continue;
      }
      list.appendChild(buildHeadRow(r));
      continue;
    }
    const c = map.get(r.hash);
    if (!c) continue;
    if (!passesFilters(c)) continue;          // search / time range: hide it
    if ((vis && !vis.has(c.hash)) || (hlSet && !hlSet.has(c.hash))) continue;
    // first surviving commit of a group: emit its header now
    if (pendingHead) { list.appendChild(buildHeadRow(pendingHead)); pendingHead = null; }
    const row = buildCommitRow(c);
    list.appendChild(row);
    commitRowEls.set(c.hash, row);
    commitRows.push(row);
    if (prevCommitEl) prevCommitEl.classList.remove("last");
    row.classList.add("last");
    prevCommitEl = row;
  }
  // line joining: each row's graph line connects to the previous visible commit
  for (let i = 0; i < commitRows.length; i++) {
    const row = commitRows[i];
    if (i === 0) row.classList.add("first");
    if (commitRows.length === 1) row.classList.add("solo");
  }

  // Draw the lane graph once over the whole list. Runs after the rows are in the
  // DOM because the geometry is read back from their real positions.
  renderLaneGraph(list, commitRowEls);

  // Empty result: distinguish "branch filter hid everything" from "search/date
  // filter matched nothing", because the way back differs.
  //
  // commitRows === 0 alone does NOT mean "nothing to show": with every group
  // collapsed the list legitimately holds only headers, and a filtered view may
  // still have matching commits hidden inside collapsed groups. Flat mode has no
  // collapsed groups, so there 0 rows really does mean empty.
  //
  // matchingTotal comes from groupCounts, which only exists in grouped mode;
  // flat mode counts the surviving commits directly.
  const anyCollapsed = !FLAT_MODE && BRANCHES.some(
    (b) => (b.kind === "local" || b.kind === "remote") && BRANCH_FOLDED.has(b.refname),
  );
  const matchingTotal = filtersActive()
    ? (FLAT_MODE
        ? ROWS.filter((r) => r.type === "commit").length
        : [...groupCounts.values()].reduce((a, b) => a + b, 0))
    : null;
  const nothingToShow = filtersActive()
    ? matchingTotal === 0
    : (commitRows.length === 0 && !anyCollapsed);
  if (nothingToShow && FILTER === "multi") {
    const hint = document.createElement("div");
    hint.className = "cl-filter-empty";
    hint.style.cssText = "color:var(--text3);text-align:center;padding:26px 12px 18px;font-size:12.5px;line-height:1.9";
    const msg = document.createElement("div");
    msg.textContent = hiddenCount() >= branchCount()
      ? "所有分支都被隐藏了 —— 勾选任意分支即可显示其提交"
      : "当前筛选下没有可显示的提交 —— 你隐藏的分支可能承载了全部历史";
    hint.appendChild(msg);
    const btn = document.createElement("button");
    btn.textContent = "恢复全选";
    btn.style.cssText = "margin-top:10px;height:28px;padding:0 16px;border:1px solid var(--border);border-radius:7px;background:var(--bg3);color:var(--text);cursor:pointer;font-size:12px";
    btn.addEventListener("click", () => {
      HIDDEN_REFS = [];
      for (const b of document.querySelectorAll(".fBranch")) b.checked = true;
      applyFilter();
    });
    hint.appendChild(btn);
    list.appendChild(hint);
  } else if (nothingToShow && filtersActive()) {
    // Search / time range excluded every loaded commit.
    const hint = document.createElement("div");
    hint.className = "cl-filter-empty";
    hint.style.cssText = "color:var(--text3);text-align:center;padding:26px 12px 18px;font-size:12.5px;line-height:1.9";
    const msg = document.createElement("div");
    const bits = [];
    if (SEARCH) bits.push(`关键词「${SEARCH}」`);
    if (DATE_FROM && DATE_TO) bits.push(`${DATE_FROM} ~ ${DATE_TO}`);
    else if (DATE_FROM) bits.push(`${DATE_FROM} 之后`);
    else if (DATE_TO) bits.push(`${DATE_TO} 之前`);
    msg.textContent = `没有符合 ${bits.join(" + ")} 的提交`;
    hint.appendChild(msg);
    const btn = document.createElement("button");
    btn.textContent = "清除筛选";
    btn.style.cssText = "margin-top:10px;height:28px;padding:0 16px;border:1px solid var(--border);border-radius:7px;background:var(--bg3);color:var(--text);cursor:pointer;font-size:12px";
    btn.addEventListener("click", clearFilters);
    hint.appendChild(btn);
    list.appendChild(hint);
  }

  // large-repo pagination: the next page is normally fetched by scrolling to the
  // bottom (see the #graphWrap scroll handler); the button stays as a fallback
  // for short viewports where the list never grows tall enough to scroll.
  if (hasMore()) {
    const more = document.createElement("div");
    more.className = "cl-more";
    const b = document.createElement("button");
    // TOTAL is 0 while the background count is still in flight; don't print "x / 0"
    b.textContent = TOTAL > 0
      ? `加载更多（已显示 ${LOADED} / ${TOTAL}）`
      : `加载更多（已显示 ${LOADED}）`;
    b.addEventListener("click", async () => {
      b.disabled = true;
      b.textContent = "加载中…";
      await loadMore();
    });
    more.appendChild(b);
    list.appendChild(more);
  }

  renderLegend();
}

/** Move the one visible selection without rebuilding the list.
 *  Selection only changes `.sel` on a row and its lane node; a full render()
 *  rebuilt every row and the branch-colour map on every click / arrow key.
 *  Returns false when the hash has no row (filtered, collapsed, another page),
 *  so the caller can fall back to a full render and keep the state visible. */
function applySelection(hash) {
  const list = $("commitList");
  // A commit can rarely be rendered under more than one group; select every
  // row with this hash so the visual state matches what a full render would do.
  const targets = hash ? [...list.querySelectorAll(`.cl-row[data-hash="${hash}"]`)] : [];
  if (hash && !targets.length) return false;
  for (const el of list.querySelectorAll(".cl-row.sel")) el.classList.remove("sel");
  for (const el of targets) el.classList.add("sel");
  for (const el of list.querySelectorAll("#laneSvg .lane-node.sel")) {
    el.classList.remove("sel");
    el.setAttribute("r", "4.8");
  }
  if (hash) {
    for (const node of list.querySelectorAll(`#laneSvg .lane-node[data-hash="${hash}"]`)) {
      node.classList.add("sel");
      node.setAttribute("r", "6.5");
    }
  }
  return true;
}

/* Is there plausibly another page? TOTAL === 0 means "not known yet" (the count
 * is fetched in the background), which must NOT be treated as "nothing left" or
 * the load-more button and scroll-loading would both disappear until it lands. */
function hasMore() {
  if (PAGINATION_EXHAUSTED) return false;
  if (TOTAL > 0) return TOTAL > LOADED;
  return true;
}

/* Auto-pagination: fetch the next page when the user scrolls near the bottom.
 * Uses the #graphWrap scroll box (that is the overflow container, so window
 * scroll events never fire here).
 *
 * Only an actual scroll gesture loads more. In particular, do NOT fill up a list
 * that is too short to scroll: branch groups are collapsed by default, so the
 * first screen is only a handful of headers — auto-filling it would silently pull
 * every page before the user asked, which is what pagination is meant to avoid.
 * When the list cannot scroll, the "加载更多" button below it is the affordance. */
let AUTO_LOAD_QUEUED = false;
function maybeAutoLoad() {
  if (AUTO_LOAD_QUEUED) return;
  AUTO_LOAD_QUEUED = true;
  requestAnimationFrame(() => {
    AUTO_LOAD_QUEUED = false;
    if (!hasMore()) return;
    const wrap = $("graphWrap");
    const sentinel = document.querySelector("#commitList .cl-more");
    if (!wrap || !sentinel) return;
    if (wrap.scrollHeight <= wrap.clientHeight + 4) return; // nothing to scroll yet
    const wr = wrap.getBoundingClientRect();
    const sr = sentinel.getBoundingClientRect();
    // trigger when the load-more area is within 300px of the visible bottom
    if (sr.top - wr.bottom < 300) loadMore();
  });
}

/** Fetch the commit count in the background and update the "load more" label.
 *  Split out of the first graph page so the first paint does not wait for a
 *  second git spawn (each spawn costs ~870ms inside the DSH host process here). */
let TOTAL_PENDING = false;
/* A server that predates the `count` op answers unknown-op. Remember it once so
 * we fall back to the old behaviour (ask graph to include the total) instead of
 * 400-ing on every refresh — and, more importantly, so `TOTAL` does not stay
 * stuck at the page size and silently hide every later commit. */
let COUNT_OP_OK = true;
async function refreshTotal() {
  if (TOTAL_PENDING) return;
  TOTAL_PENDING = true;
  try {
    if (COUNT_OP_OK) {
      const r = await api("count");
      if (r.ok && r.total > 0) {
        const before = TOTAL;
        TOTAL = r.total;
        // Only re-render when the label actually changes; a needless render()
        // would rebuild the whole list and reset the scroll position.
        if (TOTAL !== before) {
          render();
          renderStats();
        }
        return;
      }
      COUNT_OP_OK = false;   // old host: fall through to the legacy path
    }
    // legacy host: the total only comes from a graph page that computes it
    const g = await api("graph", { limit: PAGE_INITIAL, skip: 0 });
    if (g.ok && g.total > 0) {
      const before = TOTAL;
      TOTAL = g.total;
      if (TOTAL !== before) { render(); renderStats(); }
    }
  } catch { /* ignore */ } finally {
    TOTAL_PENDING = false;
  }
}

/** Fetch the next page of commits and re-render.
 *  Guarded so a scroll burst cannot fire several overlapping pages: while a
 *  fetch is in flight further calls return immediately. */
let LOADING_MORE = false;
/* Set when a page comes back with nothing new: the server says there is more but
 * the same commits are already loaded (e.g. a force-push landing mid-scroll).
 * Without this the auto-loader would re-request the same page forever. */
let PAGINATION_EXHAUSTED = false;
async function loadMore() {
  if (LOADING_MORE || !hasMore()) return;
  LOADING_MORE = true;
  try {
    // Pass the total we already know so the server can skip `rev-list --count`
    // on every later page (one git spawn instead of two).
    const g = await api("graph", { limit: PAGE_MORE, skip: LOADED, total: TOTAL || 0 });
    if (!g.ok) return;
    const map = byHash();
    const fresh = (g.commits || []).filter((c) => !map.has(c.hash));
    if (!fresh.length) {
      // Nothing new for this offset; stop auto-loading instead of spinning.
      PAGINATION_EXHAUSTED = true;
      return;
    }
    COMMITS.push(...fresh);
    LOADED = COMMITS.length;
    TOTAL = g.total || LOADED;
    BRANCH_COLOR_CACHE = null;
    render();
  } catch { /* ignore */ } finally {
    LOADING_MORE = false;
  }
}

function buildCommitRow(c) {
  const row = document.createElement("div");
  // Single source of truth: SELECTED drives BOTH the background highlight and
  // the dashed outline, so "the row the keyboard continues from" and "the row
  // whose detail is open" can never drift apart.
  row.className = "cl-row" + (SELECTED === c.hash ? " sel" : "");
  row.dataset.hash = c.hash;
  const color = branchColorOf(c.hash);

  // Lane gutter exists ONLY in flat mode: that is where one continuous SVG is
  // drawn across the whole list. In grouped mode the rows are split by branch
  // headers, so a lane drawing would necessarily break at every header — the
  // user asked for no graph there at all, rather than a broken-looking one.
  if (FLAT_MODE) {
    const graph = document.createElement("div");
    graph.className = "cl-graph";
    graph.style.width = graphGutterWidth() + "px";
    row.appendChild(graph);
  }

  const body = document.createElement("div");
  body.className = "cl-body";
  const line1 = document.createElement("div");
  line1.className = "cl-line1";
  // Refs come FIRST: a branch/tag label is the shortest, most scannable part of
  // the row, so putting it at a fixed left position makes the column readable at
  // a glance. Trailing them after the subject pushed them to wherever the
  // message happened to end, which is far from the eye's left-to-right scan.
  if (c.refs.length) {
    const refs = document.createElement("span");
    refs.className = "cl-refs";
    for (const ref of c.refs) {
      const kind = ref.head ? "head" : ref.kind;
      const pill = document.createElement("span");
      pill.className = "cl-ref " + kind;
      pill.textContent = ref.name;
      refs.appendChild(pill);
    }
    line1.appendChild(refs);
  }
  const msg = document.createElement("span");
  msg.className = "cl-msg";
  msg.textContent = c.subject || "";
  msg.title = c.subject || "";
  line1.appendChild(msg);
  body.appendChild(line1);
  const line2 = document.createElement("div");
  line2.className = "cl-line2";
  const author = document.createElement("span");
  author.className = "cl-author";
  author.textContent = c.author;
  line2.appendChild(author);
  line2.appendChild(document.createTextNode(" · " + relTime(c.date) + " · "));
  const hash = document.createElement("span");
  hash.className = "cl-hash";
  hash.textContent = short7(c.hash);
  line2.appendChild(hash);
  body.appendChild(line2);
  row.appendChild(body);

  row.addEventListener("click", (ev) => {
    ev.stopPropagation();
    selectCommit(c.hash);
  });
  row.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openContextMenu(ev.clientX, ev.clientY, c);
  });
  row.addEventListener("mouseenter", (ev) => showTip(ev, c));
  row.addEventListener("mousemove", (ev) => moveTip(ev));
  row.addEventListener("mouseleave", hideTip);
  return row;
}

function buildHeadRow(r) {
  const row = document.createElement("div");
  const folded = BRANCH_FOLDED.has(r.refname);
  row.className = "cl-head" + (folded ? "" : " open");
  const caret = document.createElement("span");
  caret.className = "cl-caret";
  caret.textContent = "▶";
  row.appendChild(caret);
  const dot = document.createElement("span");
  dot.className = "cl-head-dot";
  dot.style.background = branchColorOf(r.tip);
  row.appendChild(dot);
  const name = document.createElement("span");
  name.className = "cl-head-name";
  name.textContent = r.name;
  row.appendChild(name);
  if (r.head) {
    const badge = document.createElement("span");
    badge.className = "cl-head-badge";
    badge.textContent = "HEAD";
    row.appendChild(badge);
  }
  const count = document.createElement("span");
  count.className = "cl-head-count";
  if (r.synced) {
    count.textContent = r.syncedLabel || "已同步";
    count.classList.add("cl-synced");
  } else {
    count.textContent = `${r.count} 个提交`;
  }
  row.appendChild(count);
  const tip = document.createElement("span");
  tip.className = "cl-head-tip";
  const map = byHash();
  const tipC = map.get(r.tip);
  if (tipC) tip.textContent = (tipC.subject || "") + " · " + relTime(tipC.date);
  row.appendChild(tip);
  row.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (BRANCH_FOLDED.has(r.refname)) BRANCH_FOLDED.delete(r.refname);
    else BRANCH_FOLDED.add(r.refname);
    saveStored("gg2-brfolded", [...BRANCH_FOLDED]);
    render();
  });
  row.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openBranchCtxMenu(ev.clientX, ev.clientY, r);
  });
  return row;
}

function computeMainline(map) {
  // HEAD branch mainline: follow first-parent from the commit that carries HEAD ref
  const set = new Set();
  const headCommit = COMMITS.find((c) => c.refs.some((r) => r.head));
  let cur = headCommit ? headCommit.hash : COMMITS.length ? COMMITS[0].hash : null;
  while (cur && map.has(cur)) {
    set.add(cur);
    const c = map.get(cur);
    cur = c.parents[0] || null;
  }
  return set;
}

function matches(c) {
  if (!SEARCH) return true;   // no query = everything matches
  const q = SEARCH.toLowerCase();
  return (c.subject || "").toLowerCase().includes(q)
    || (c.author || "").toLowerCase().includes(q)
    || c.hash.toLowerCase().includes(q)
    || (c.email || "").toLowerCase().includes(q);
}

/* ---- date range filter -----------------------------------------------------
 * A real date interval rather than a rolling "last N days" preset: the user
 * picks a start and/or an end date. Either side may be empty (open-ended), and
 * both empty means "no time limit". Dates are stored as plain YYYY-MM-DD so a
 * saved filter stays meaningful, while comparisons happen on local day
 * boundaries — a commit at 23:50 on the end date still belongs to that day. */
let DATE_FROM = loadStored("gg2-datefrom", "");   // "" | "YYYY-MM-DD"
let DATE_TO = loadStored("gg2-dateto", "");       // "" | "YYYY-MM-DD"

/** Milliseconds for the start of a local day (00:00:00.000). */
function dayStart(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
}
/** Milliseconds for the end of a local day (23:59:59.999), so the whole day counts. */
function dayEnd(ymd) {
  const s = dayStart(ymd);
  return Number.isNaN(s) ? NaN : s + 86400e3 - 1;
}
function withinDateRange(c) {
  if (!DATE_FROM && !DATE_TO) return true;
  const t = Date.parse(c.date || "");
  if (!Number.isFinite(t)) return true;            // unparsable date: don't hide it
  if (DATE_FROM) {
    const lo = dayStart(DATE_FROM);
    if (Number.isFinite(lo) && t < lo) return false;
  }
  if (DATE_TO) {
    const hi = dayEnd(DATE_TO);
    if (Number.isFinite(hi) && t > hi) return false;
  }
  return true;
}

/** Single source of truth for "should this commit be shown?".
 *  Search and the date range are *filters* (non-matching commits are hidden),
 *  not highlights — a query that merely tints rows leaves the user scrolling
 *  through everything they did not ask for. */
function passesFilters(c) {
  return matches(c) && withinDateRange(c);
}
function filtersActive() {
  return Boolean(SEARCH) || Boolean(DATE_FROM) || Boolean(DATE_TO);
}

function renderLegend() {
  const lg = $("legend");
  lg.innerHTML = "";
  const items = [];
  const headBranch = BRANCHES.find((b) => b.head) || BRANCHES.find((b) => b.kind === "local");
  if (headBranch) items.push({ color: "#3fb950", label: "HEAD · " + headBranch.name, sha: headBranch.sha });
  const locals = BRANCHES.filter((b) => b.kind === "local" && !b.head);
  const remotes = BRANCHES.filter((b) => b.kind === "remote");
  const tags = BRANCHES.filter((b) => b.kind === "tag");
  for (let i = 0; i < locals.length; i++) items.push({ color: BRANCH_PALETTE[i % BRANCH_PALETTE.length], label: locals[i].name, sha: locals[i].sha });
  for (let i = 0; i < Math.min(3, remotes.length); i++) items.push({ color: "#6e7681", label: "⤴ " + remotes[i].name, sha: remotes[i].sha });
  if (tags.length) items.push({ color: "var(--yellow)", label: "● " + tags.length + " 个标签" });
  for (const it of items.slice(0, 8)) {
    const span = document.createElement("span");
    span.className = "lg" + (it.sha && HIGHLIGHT === it.sha ? " lg-on" : "");
    if (it.sha) {
      span.style.cursor = "pointer";
      span.title = "点击高亮该分支路径";
      span.addEventListener("click", (ev) => {
        ev.stopPropagation();
        HIGHLIGHT = HIGHLIGHT === it.sha ? null : it.sha;
        render();
      });
    }
    const i = document.createElement("i");
    i.style.background = it.color;
    span.appendChild(i);
    span.appendChild(document.createTextNode(it.label));
    lg.appendChild(span);
  }
}

/* ===================== (branch tree removed: merged into the graph view;
 * branch listing/filtering lives in the ☑ 分支过滤 menu) ===================== */

/* ===================== lane layout (real git graph) =====================
 * Ported from the "reserved point" strategy used by VS Code Git Graph (and
 * implemented the same way in WhitePlusMS/dsh-git-graph). A branch owns a
 * continuous path down its own lane; a merge path reuses the point already
 * reserved by its target parent branch. Without reservations unrelated lanes
 * shift diagonally on every following row, which is what makes naive lane
 * assignment look wrong.
 *
 * Pure function: commits in -> { nodes, edges, laneCount } out. No DOM access,
 * so it can be unit-tested and reused by any renderer.
 *
 * `missingParent` marks an edge whose parent is outside the loaded window
 * (pagination!). The renderer draws those dashed instead of implying the
 * history ends there.
 */
const LANE_NULL = -1;

function layoutGraph(commits) {
  const index = new Map();
  commits.forEach((c, i) => index.set(c.hash, i));

  // Vertex state: parents resolved to indices, plus booking slots per lane.
  const vertices = commits.map((c, id) => ({
    id,
    commit: c,
    parents: (c.parents || []).map((p) => (index.has(p) ? index.get(p) : LANE_NULL)),
    connections: [],   // lane -> { target, colour } reserved by a passing edge
    branch: undefined, // colour id once claimed
    lane: 0,
    nextLane: 0,
    nextParent: 0,
  }));

  const branches = [];  // { colour, edges[], end }
  const branchEnds = []; // colour -> last row it was used on

  const nextPointOf = (v) => ({ lane: v.nextLane, row: v.id });
  const pointOf = (v) => ({ lane: v.lane, row: v.id });

  const connectPoint = (v, target, colour) => {
    for (let lane = 0; lane < v.connections.length; lane++) {
      const c = v.connections[lane];
      if (c && c.target === target && c.colour === colour) return { lane, row: v.id };
    }
    return undefined;
  };
  const reservePoint = (v, lane, target, colour) => {
    if (lane !== v.nextLane) return;
    v.nextLane += 1;
    v.connections[lane] = { target, colour };
  };
  const addEdge = (br, from, to, missingParent) => {
    br.edges.push({
      fromLane: from.lane,
      toLane: to.lane,
      row: from.row,
      colour: br.colour,
      missingParent: Boolean(missingParent),
    });
  };
  const availableColour = (startAt) => {
    for (let colour = 0; colour < branchEnds.length; colour++) {
      const end = branchEnds[colour];
      if (end !== undefined && startAt > end) return colour;
    }
    branchEnds.push(0);
    return branchEnds.length - 1;
  };

  function determinePath(startAt) {
    let row = startAt;
    let vertex = vertices[row];
    if (!vertex) return;

    let parent = vertex.parents[vertex.nextParent];
    let lastPoint = vertex.branch === undefined ? nextPointOf(vertex) : pointOf(vertex);

    // A merge can join a branch that already exists further down: follow that
    // branch until its reserved connection point shows up instead of opening a
    // new lane.
    if (
      parent !== undefined && parent !== LANE_NULL &&
      vertex.parents.length > 1 && vertex.branch !== undefined &&
      vertices[parent] && vertices[parent].branch !== undefined
    ) {
      const parentBranch = vertices[parent].branch;
      const targetBranch = branches[parentBranch];
      if (targetBranch === undefined) return;
      let found = false;
      for (row = startAt + 1; row < vertices.length; row++) {
        const cur = vertices[row];
        if (!cur) continue;
        const connected = connectPoint(cur, parent, parentBranch);
        const curPoint = connected || nextPointOf(cur);
        found = connected !== undefined;
        addEdge(targetBranch, lastPoint, curPoint, false);
        reservePoint(cur, curPoint.lane, parent, parentBranch);
        lastPoint = curPoint;
        if (found) { vertex.nextParent += 1; break; }
      }
      if (!found) vertex.nextParent += 1;
      return;
    }

    const br = { colour: availableColour(startAt), edges: [], end: row };
    branches.push(br);

    if (vertex.branch === undefined) {
      vertex.branch = br.colour;
      vertex.lane = lastPoint.lane;
    }
    reservePoint(vertex, lastPoint.lane, vertex.id, br.colour);

    // Root commit: the lane ends here even if more history follows below.
    if (parent === undefined) {
      branchEnds[br.colour] = startAt;
      return;
    }

    for (row = startAt + 1; row < vertices.length; row++) {
      const cur = vertices[row];
      if (!cur) continue;
      const curPoint = (parent === cur.id && cur.branch !== undefined) ? pointOf(cur) : nextPointOf(cur);
      addEdge(br, lastPoint, curPoint, parent === LANE_NULL);
      reservePoint(cur, curPoint.lane, parent ?? LANE_NULL, br.colour);
      lastPoint = curPoint;

      if (parent === cur.id) {
        vertex.nextParent += 1;
        const parentAlreadyOnBranch = cur.branch !== undefined;
        if (!parentAlreadyOnBranch) {
          cur.branch = br.colour;
          cur.lane = curPoint.lane;
        }
        // Walk on from the parent: `vertex` becomes the parent, and its own
        // nextParent counter decides which of ITS parents to follow next.
        vertex = cur;
        parent = vertex.parents[vertex.nextParent];
        if (parent === undefined || parentAlreadyOnBranch) break;
      }
    }
    if (row >= vertices.length && parent === LANE_NULL) vertex.nextParent += 1;
    br.end = row;
    branchEnds[br.colour] = row;
  }

  let row = 0;
  while (row < vertices.length) {
    const v = vertices[row];
    if (v && (v.branch === undefined || v.nextParent < v.parents.length)) {
      determinePath(row);
    } else {
      row += 1;
    }
  }

  const nodes = vertices.map((v) => ({
    hash: v.commit.hash,
    lane: v.lane,
    row: v.id,
    colour: v.branch ?? 0,
  }));
  const edges = branches.flatMap((b) => b.edges);
  const laneCount = Math.max(
    1,
    ...nodes.map((n) => n.lane + 1),
    ...edges.map((e) => Math.max(e.fromLane, e.toLane) + 1),
  );
  return { nodes, edges, laneCount };
}

/* Cached layout for the current COMMITS array; invalidated on reload. */
let CACHE_LAYOUT = null;
let CACHE_LAYOUT_SIG = "";
function ensureLayout() {
  const sig = COMMITS.length + ":" + (COMMITS[0] ? COMMITS[0].hash : "");
  if (CACHE_LAYOUT && CACHE_LAYOUT_SIG === sig) return CACHE_LAYOUT;
  CACHE_LAYOUT = layoutGraph(COMMITS);
  CACHE_LAYOUT_SIG = sig;
  return CACHE_LAYOUT;
}

/* ===================== interactions ===================== */
const tip = document.createElement("div");
tip.className = "tooltip";
tip.style.display = "none";
document.body.appendChild(tip);
function showTip(ev, c) {
  tip.innerHTML = "";
  const refs = c.refs.length ? c.refs.map((r) => r.name).join(", ") : "—";
  tip.appendChild(document.createTextNode(`${c.hash}  ${c.subject}`));
  const sub = document.createElement("div");
  sub.className = "tt-sub";
  sub.textContent = `${c.author} · ${c.date}  |  refs: ${refs}`;
  tip.appendChild(sub);
  tip.style.display = "block";
  moveTip(ev);
}
function moveTip(ev) {
  tip.style.left = (ev.clientX + 14) + "px";
  tip.style.top = (ev.clientY + 12) + "px";
}
function hideTip() { tip.style.display = "none"; }

/* No left-drag panning and no wheel zoom: the graph scrolls naturally with the
 * mouse wheel (graphWrap is overflow:auto). */

/* ===================== detail ===================== */
/* Detail panel width is user-resizable (splitter scrub), persisted in localStorage.
   DEFAULTS stay CSS-driven via --gg-detail-w so the stylesheet remains the source
   of truth; the stored value only overrides it once the user drags. */
const DETAIL_W_DEFAULT = 430, DETAIL_W_MIN = 260;
let DETAIL_W = (() => {                       // null = use CSS default
  const v = Number(loadStored("gg2-detailw", null));
  return Number.isFinite(v) && v > 0 ? v : null;
})();
function detailWMax() {
  const w = $("main").clientWidth || 0;
  // keep the graph usable: leave room for the commit list + workdir header buttons
  return Math.max(DETAIL_W_MIN, Math.min(1200, w - 520));
}
/** Suppress the width transition for one frame, so programmatic width changes
 *  (restore / reset / window resize) don't animate. */
function withoutDetailAnim(fn) {
  const el = $("detail");
  el.classList.add("no-anim");
  fn();
  // drop the flag on the next frame: within the same task the browser would
  // still coalesce both class changes and animate nothing.
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("no-anim")));
}
function applyDetailWidth(px) {
  if (px === null) {
    document.documentElement.style.removeProperty("--gg-detail-w");
    DETAIL_W = null;
    return;
  }
  const v = Math.max(DETAIL_W_MIN, Math.min(detailWMax(), Math.round(px)));
  DETAIL_W = v;
  document.documentElement.style.setProperty("--gg-detail-w", v + "px");
}
/* Open/close helper: keeps #main.detail-open in sync (drives the splitter). */
function setDetailOpen(open) {
  $("detail").classList.toggle("open", open);
  $("main").classList.toggle("detail-open", open);
}
async function selectCommit(hash, scroll = false) {
  SELECTED = hash;
  // Selection only changes .sel classes; repainting the whole list (and
  // rebuilding the branch-colour map) made every click / arrow key do O(n) DOM
  // work. If the target has no row (filtered/collapsed/not loaded), fall back
  // to a full render so the cursor state still has a visible owner.
  if (!applySelection(hash)) render();
  if (scroll) scrollToNode(hash);
  setDetailOpen(true);
  const d = $("dContent");
  // Re-opening a commit that was already viewed is instant: no git process at
  // all. Commit data is immutable, so a hit never needs revalidation.
  const hit = cacheGet(DETAIL_CACHE, hash);
  if (hit) { renderDetail(hit.info, hit.diff); return; }
  d.innerHTML = "";
  const loading = document.createElement("div");
  loading.className = "empty";
  loading.textContent = "加载详情…";
  d.appendChild(loading);
  try {
    // Root commits have no parent and therefore no diff. When the parent list
    // is already loaded, skip the second git process entirely; otherwise start
    // both requests at once and drop the diff if show reveals a root commit.
    const known = byHash().get(hash);
    const knownRoot = Boolean(known && known.parents.length === 0);
    let diffFailed = false;
    const diffP = knownRoot ? null : api("diff", { hash }).catch(() => { diffFailed = true; return null; });
    const info = await api("show", { hash });
    if (!info.ok) { d.textContent = "加载失败: " + (info.error || "?"); return; }
    const diff = diffP && info.parents.length ? await diffP : null;
    // don't cache failures; a transient git error should be retryable. A root
    // commit's null diff is valid, so that case is always cacheable.
    if (!diffFailed || info.parents.length === 0) cacheSet(DETAIL_CACHE, hash, { info, diff });
    // the user may have clicked another commit while this was in flight
    if (SELECTED !== hash) return;
    renderDetail(info, diff);
  } catch (err) {
    d.textContent = "加载失败: " + err.message;
  }
}
function scrollToNode(hash) {
  const row = $("commitList").querySelector(`.cl-row[data-hash="${hash}"]`);
  if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
}
function renderDetail(info, diff) {
  const d = $("dContent");
  d.innerHTML = "";
  const meta = document.createElement("div");
  meta.className = "dmeta";
  const rows = [
    ["提交", info.hash],
    ["作者", `${info.author} <${info.email}>`],
    ["时间", info.date],
    ["父提交", (info.parents.length ? info.parents.join(", ") : "(root)")]
  ];
  for (const [k, v] of rows) {
    const b = document.createElement("b"); b.textContent = k;
    const s = document.createElement("span"); s.textContent = v;
    if (k === "提交") { s.className = "hash"; s.title = "点击复制"; s.addEventListener("click", () => navigator.clipboard?.writeText(v).catch(() => {})); }
    meta.appendChild(b); meta.appendChild(s);
  }
  d.appendChild(meta);

  const body = document.createElement("div");
  body.className = "dbody";
  const msg = document.createElement("div");
  msg.className = "msg";
  if (info.subject) {
    const subj = document.createElement("span");
    subj.className = "subj";
    subj.textContent = info.subject;
    msg.appendChild(subj);
  }
  if (info.body) msg.appendChild(document.createTextNode("\n" + info.body));
  body.appendChild(msg);

  if (info.stat) {
    const sec = document.createElement("div");
    sec.className = "section";
    sec.textContent = "变更统计（点击文件名看单个文件 diff）";
    body.appendChild(sec);
    const pre = document.createElement("pre");
    pre.className = "stat";
    const fileRow = document.createElement("div");
    fileRow.className = "stat-files";
    for (const line of String(info.stat).split("\n")) {
      const row = document.createElement("div");
      row.className = "sf-row";
      const m = line.match(/^\s*(.+?)\s*\|\s*(\d+)(.*)$/);
      if (m && !line.includes("files changed") && !line.includes("file changed") && !line.trim().startsWith("--")) {
        let fname = m[1].trim();
        // rename "a => b" keeps the new name
        if (fname.includes("=>")) fname = fname.split("=>")[1].trim();
        const fileSpan = document.createElement("span");
        fileSpan.className = "sf-file";
        fileSpan.textContent = fname;
        fileSpan.title = "点击查看该文件 diff";
        fileSpan.addEventListener("click", () => showFileDiff(info.hash, fname, row));
        const histSpan = document.createElement("span");
        histSpan.className = "sf-file sf-hist";
        histSpan.textContent = "📜";
        histSpan.title = "查看该文件的历史提交";
        histSpan.addEventListener("click", () => showFileHist(fname, row));
        const restSpan = document.createElement("span");
        restSpan.className = "sf-rest";
        restSpan.textContent = line.slice(line.indexOf("|"));
        row.appendChild(fileSpan);
        row.appendChild(histSpan);
        row.appendChild(restSpan);
      } else {
        row.textContent = line;
      }
      fileRow.appendChild(row);
    }
    body.appendChild(fileRow);
    body.appendChild(pre);
  }
  if (diff && diff.ok) {
    const sec = document.createElement("div");
    sec.className = "section";
    sec.textContent = diff.truncated ? "Diff（过长已截断）" : "Diff";
    body.appendChild(sec);
    if (diff.diff && diff.diff.trim()) {
      const pre = document.createElement("pre");
      pre.className = "diff";
      highlightDiff(pre, diff.diff);
      body.appendChild(pre);
    } else {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "（无差异内容）";
      body.appendChild(e);
    }
  }
  d.appendChild(body);
}
$("dClose").addEventListener("click", () => {
  setDetailOpen(false);
  SELECTED = null;
  render();
});

/* ---------- splitter: drag to resize the detail panel ---------- */
/* Pointer Events cover mouse + touch + pen; the grip is only hit-testable while
   the panel is open (CSS), so no extra state guard is needed before a drag. */
(() => {
  const grip = $("detailGrip");
  let startX = 0, startW = 0, moved = false, dragging = false;
  const currentW = () => $("detail").getBoundingClientRect().width || DETAIL_W_DEFAULT;
  function onMove(ev) {
    if (!dragging) return;
    const dx = ev.clientX - startX;
    if (Math.abs(dx) > 1) moved = true;
    applyDetailWidth(startW - dx); // dragging left => wider panel
  }
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    grip.classList.remove("dragging");
    document.body.classList.remove("gg-col-resize");
    // drop the no-anim flag on the next frame: removing it in the same task as
    // the last width change would let the transition animate from a stale width
    requestAnimationFrame(() => $("detail").classList.remove("no-anim"));
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
    if (moved) saveStored("gg2-detailw", DETAIL_W);
  }
  grip.addEventListener("pointerdown", (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    dragging = true;
    moved = false;
    startX = ev.clientX;
    startW = currentW();
    grip.classList.add("dragging");
    document.body.classList.add("gg-col-resize");
    $("detail").classList.add("no-anim");
    try { grip.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
  });
  // double-click: back to the stylesheet default
  grip.addEventListener("dblclick", () => {
    withoutDetailAnim(() => applyDetailWidth(null));
    try { localStorage.removeItem("gg2-detailw"); } catch { /* ignore */ }
  });
  // keyboard affordance for accessibility (grip is focusable)
  grip.addEventListener("keydown", (ev) => {
    const step = ev.shiftKey ? 40 : 12;
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    withoutDetailAnim(() => applyDetailWidth(currentW() + (ev.key === "ArrowLeft" ? step : -step)));
    saveStored("gg2-detailw", DETAIL_W);
  });
  // keep the stored width legal when the window shrinks
  window.addEventListener("resize", () => {
    if (DETAIL_W !== null) withoutDetailAnim(() => applyDetailWidth(DETAIL_W));
    positionDateMenu();   // re-clamp an open date popover into the new viewport
    positionFilterMenu(); // same for the branch filter menu (narrow layouts)
    relayoutWdBody();
  });
  if (DETAIL_W !== null) withoutDetailAnim(() => applyDetailWidth(DETAIL_W)); // restore on load
})();

/* Show a single file's diff inside the detail panel (async). */
async function showFileDiff(hash, file, rowEl) {
  const d = $("dContent");
  // Toggling a block off must not cost a request: check first, fetch later.
  const existing = d.querySelector(".sf-diff-block[data-file='" + CSS.escape(file) + "']");
  if (existing) { existing.remove(); return; } // toggle off
  rowEl.classList.add("sf-loading");
  try {
    const key = hash + "\0" + file;
    let res = cacheGet(FILEDIFF_CACHE, key);
    if (!res) {
      res = await api("filediff", { hash, file });
      if (res.ok) cacheSet(FILEDIFF_CACHE, key, res);
    }
    rowEl.classList.remove("sf-loading");
    // the panel may have moved on to another commit while this was in flight
    if (SELECTED !== hash) return;
    const block = document.createElement("div");
    block.className = "sf-diff-block";
    block.dataset.file = file;
    const head = document.createElement("div");
    head.className = "sf-diff-head";
    const name = document.createElement("span");
    name.textContent = file;
    const close = document.createElement("span");
    close.className = "sf-diff-close";
    close.textContent = "✕";
    close.addEventListener("click", () => block.remove());
    head.appendChild(name);
    head.appendChild(close);
    block.appendChild(head);
    const pre = document.createElement("pre");
    pre.className = "diff";
    if (res.ok) {
      highlightDiff(pre, res.diff || "（无差异）");
    } else {
      pre.textContent = "加载失败: " + (res.error || "?");
    }
    block.appendChild(pre);
    d.appendChild(block);
    block.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    rowEl.classList.remove("sf-loading");
    alert("加载失败: " + err.message);
  }
}

/** File history: list every commit touching the file (--follow). */
async function showFileHist(file, rowEl) {
  const d = $("dContent");
  // toggle-off before fetching, same as showFileDiff
  const existing = d.querySelector(".sf-hist-block[data-file='" + CSS.escape(file) + "']");
  if (existing) { existing.remove(); return; } // toggle off
  rowEl.classList.add("sf-loading");
  try {
    let res = cacheGet(FILELOG_CACHE, file);
    if (!res) {
      res = await api("filelog", { file });
      if (res.ok) cacheSet(FILELOG_CACHE, file, res);
    }
    rowEl.classList.remove("sf-loading");
    const block = document.createElement("div");
    block.className = "sf-diff-block sf-hist-block";
    block.dataset.file = file;
    const head = document.createElement("div");
    head.className = "sf-diff-head";
    const name = document.createElement("span");
    name.textContent = "📜 " + file + " 的历史提交";
    const close = document.createElement("span");
    close.className = "sf-diff-close";
    close.textContent = "✕";
    close.addEventListener("click", () => block.remove());
    head.appendChild(name);
    head.appendChild(close);
    block.appendChild(head);
    const list = document.createElement("div");
    if (!res.ok || !res.commits.length) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = res.error || "（该文件没有提交历史）";
      list.appendChild(e);
    } else {
      for (const c of res.commits) {
        const r = document.createElement("div");
        r.className = "sf-hist-row";
        const msg = document.createElement("span");
        msg.className = "sf-hist-msg";
        msg.textContent = c.subject || "";
        const meta = document.createElement("span");
        meta.className = "sf-hist-meta";
        meta.textContent = short7(c.hash) + " · " + relTime(c.date) + " · " + c.author;
        r.appendChild(msg);
        r.appendChild(meta);
        r.addEventListener("click", () => selectCommit(c.hash));
        list.appendChild(r);
      }
    }
    block.appendChild(list);
    d.appendChild(block);
    block.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    rowEl.classList.remove("sf-loading");
    alert("加载失败: " + err.message);
  }
}

/* ===================== workdir modal (VSCode-style) ===================== */
/* ===================== workdir panel (persistent, top of the graph) ===================== */
let WD_SIG = null;   // last applied workstatus shape, for the 5s poll

/** Stable JSON of everything the panel displays. The old auto-refresh
 *  compared only {branch, counts}, so editing an already-dirty file (counts
 *  unchanged) never repainted the file list. */
function workstatusSig(ws) {
  if (!ws) return "";
  const files = (list) => (list || []).map((f) => [
    f.path, f.oldPath || "", f.code || "",
    f.added === undefined ? null : f.added,
    f.deleted === undefined ? null : f.deleted,
    f.binary ? 1 : 0,
  ]);
  return JSON.stringify([
    ws.branch || "",
    ws.counts || {},
    files(ws.staged), files(ws.unstaged), files(ws.untracked),
  ]);
}

/** Apply an already-fetched workstatus response: cache signature, invalidate
 *  per-file diffs when asked, and repaint the panel. Shared by the manual
 *  refresh and the poll so both paths agree on what "changed" means. */
function applyWorkstatus(ws, clearDiffs) {
  WD_SIG = workstatusSig(ws);
  WORKSTATUS = ws;
  if (clearDiffs) wdDiffCache.clear();
  renderWorkdir();
  renderStatusLine();
  renderStats();
}

/** Fetch workstatus, then render the top panel + status line. */
async function refreshWorkdir() {
  const panel = $("wdPanel");
  panel.innerHTML = "";
  const loading = document.createElement("div");
  loading.className = "wd-clean";
  loading.textContent = "加载工作区状态…";
  panel.appendChild(loading);
  try {
    const ws = await api("workstatus");
    if (!ws.ok) { panel.innerHTML = ""; return; }
    applyWorkstatus(ws, false);
  } catch { /* ignore */ }
}

function renderWorkdir() {
  const panel = $("wdPanel");
  panel.innerHTML = "";
  const ws = WORKSTATUS;
  const total = ws.counts.staged + ws.counts.unstaged + ws.counts.untracked;

  const top = document.createElement("div");
  top.className = "wd-top";
  const caret = document.createElement("span");
  caret.className = "wd-caret";
  caret.textContent = "▶";
  top.appendChild(caret);
  const title = document.createElement("span");
  title.className = "wd-title";
  title.textContent = "未提交改动";
  top.appendChild(title);
  const counts = document.createElement("span");
  counts.className = "wd-counts";
  counts.textContent = `已暂存 ${ws.counts.staged} · 更改 ${ws.counts.unstaged} · 未跟踪 ${ws.counts.untracked}`;
  top.appendChild(counts);
  const sp = document.createElement("span");
  sp.className = "sp";
  top.appendChild(sp);

  // working-tree write actions
  const stageAllBtn = document.createElement("button");
  stageAllBtn.type = "button";
  stageAllBtn.textContent = "全部暂存";
  stageAllBtn.title = "暂存所有未暂存/未跟踪的更改";
  stageAllBtn.addEventListener("click", (ev) => { ev.stopPropagation(); runGitOp("stage-all"); });
  top.appendChild(stageAllBtn);

  const commitBtn = document.createElement("button");
  commitBtn.type = "button";
  commitBtn.textContent = "提交";
  commitBtn.title = "提交更改到本地仓库";
  commitBtn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const total = WORKSTATUS ? WORKSTATUS.counts.staged + WORKSTATUS.counts.unstaged + WORKSTATUS.counts.untracked : 0;
    if (!total) { alert("没有可提交的改动"); return; }
    const r = await commitDialog();
    if (r && r.message) runGitOp("commit", { message: r.message, all: r.all ? 1 : 0 }, true);
  });
  top.appendChild(commitBtn);
  // disable write buttons while the working tree is clean
  if (total === 0) {
    stageAllBtn.disabled = true;
    commitBtn.disabled = true;
    stageAllBtn.title = "工作区没有可暂存的改动";
    commitBtn.title = "工作区没有可提交的改动";
  }

  // group visibility dropdown (已暂存 / 更改 / 未跟踪)
  const filterWrap = document.createElement("div");
  filterWrap.className = "wd-filterWrap";
  const filterBtn = document.createElement("button");
  filterBtn.type = "button";
  filterBtn.textContent = "☑ 分组";
  filterBtn.title = "选择显示哪些分组";
  filterBtn.setAttribute("aria-haspopup", "true");
  filterBtn.setAttribute("aria-expanded", "false");
  const menu = document.createElement("div");
  menu.className = "wd-menu";
  filterBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setWdMenuOpen(menu, !menu.classList.contains("show"));
  });
  const mkToggle = (key, label) => {
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = WD_SHOW[key];
    cb.addEventListener("change", () => {
      WD_SHOW[key] = cb.checked;
      saveStored("gg2-wdshow", WD_SHOW);
      renderWdGroups(body);
    });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(label));
    menu.appendChild(lab);
  };
  mkToggle("staged", "已暂存");
  mkToggle("unstaged", "更改");
  mkToggle("untracked", "未跟踪");
  menu.addEventListener("click", (ev) => ev.stopPropagation());
  filterWrap.appendChild(filterBtn);
  filterWrap.appendChild(menu);
  top.appendChild(filterWrap);

  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "↻ 刷新";
  refresh.title = "重新加载未提交改动";
  refresh.addEventListener("click", (ev) => { ev.stopPropagation(); refreshWorkdir(); });
  top.appendChild(refresh);
  // clicking anywhere else on the bar folds/unfolds the whole panel (like a branch group)
  top.addEventListener("click", () => {
    WD_FOLDED = !WD_FOLDED;
    saveStored("gg2-wdfolded", WD_FOLDED);
    panel.classList.toggle("folded", WD_FOLDED);
  });
  panel.appendChild(top);

  // batch action bar (shown when rows are checked)
  const batch = document.createElement("div");
  batch.className = "wd-batch";
  batch.style.display = "none";
  panel.appendChild(batch);

  const body = document.createElement("div");
  body.className = "wd-body";
  panel.appendChild(body);
  panel.classList.toggle("folded", WD_FOLDED);
  renderWdGroups(body);
  updateBatchBar();
}

/** Render the three groups (staged / changes / untracked) into the panel body. */
/** Rows shown before the file list starts scrolling.
 *  10 rows is about the height of the panel at a normal window size; past that
 *  the list would push the commit graph down by a full screen. */
const MAX_WD_ROWS = 10;

/** Cap the file list at MAX_WD_ROWS rows and let it scroll internally.
 *  Measured from real offsets rather than a hardcoded row height: rows carry a
 *  badge, a checkbox, variable padding and (when opened) a diff, and the group
 *  heads between them take space too. Clamping at the top of row 11 keeps
 *  exactly 10 rows visible however they are distributed across groups.
 *  Collapsed groups are skipped — their rows measure 0 and would drag the cap
 *  up to a nonsense value. */
function layoutWdBody(body) {
  if (!body) return;
  body.classList.remove("scrolls");
  body.style.maxHeight = "";
  const rows = [...body.querySelectorAll(".wd-row")].filter((r) => r.offsetParent !== null);
  if (rows.length <= MAX_WD_ROWS) return;
  const bodyTop = body.getBoundingClientRect().top;
  const h = rows[MAX_WD_ROWS].getBoundingClientRect().top - bodyTop;
  if (!(h > 0)) return;
  body.classList.add("scrolls");
  body.style.maxHeight = Math.ceil(h) + "px";
}

/** Rebuild the groups, then re-apply the row cap (the cap depends on what the
 *  list now holds, so it cannot be set once at mount time). */
/** Re-measure the cap for the mounted panel, if there is one.
 *  Callers: window resize, and row/group toggles. Cheap enough to run
 *  directly — it only reads layout, and it bails before touching the DOM when
 *  the list is short. */
function relayoutWdBody() {
  const body = $("wdPanel").querySelector(".wd-body");
  if (body) layoutWdBody(body);
}

function renderWdGroups(body) {
  renderWdGroupsRows(body);
  layoutWdBody(body);
}

function renderWdGroupsRows(body) {
  body.innerHTML = "";
  const ws = WORKSTATUS;
  const total = ws.counts.staged + ws.counts.unstaged + ws.counts.untracked;
  if (!total) {
    const clean = document.createElement("div");
    clean.className = "wd-clean";
    clean.textContent = "✓ 工作区干净";
    body.appendChild(clean);
    return;
  }

  const groups = [
    { key: "staged", title: "已暂存", items: ws.staged, staged: "1" },
    { key: "unstaged", title: "更改", items: ws.unstaged, staged: "0" },
    { key: "untracked", title: "未跟踪", items: ws.untracked.map((f) => ({ path: f.path, code: "?" })), staged: "untracked" }
  ];
  for (const g of groups) {
    if (!WD_SHOW[g.key] || !g.items.length) continue;
    const wrap = document.createElement("div");
    wrap.className = "wd-group" + (WD_GROUP_FOLDED.has(g.key) ? " folded" : "");
    const gh = document.createElement("div");
    gh.className = "wd-head";
    const gcaret = document.createElement("span");
    gcaret.className = "wd-caret";
    gcaret.textContent = "▶";
    gh.appendChild(gcaret);
    gh.appendChild(document.createTextNode(g.title));
    const gn = document.createElement("span");
    gn.className = "wd-n";
    gn.textContent = "(" + g.items.length + ")";
    gh.appendChild(gn);
    gh.addEventListener("click", () => {
      if (WD_GROUP_FOLDED.has(g.key)) WD_GROUP_FOLDED.delete(g.key);
      else WD_GROUP_FOLDED.add(g.key);
      saveStored("gg2-wdgroupfolded", [...WD_GROUP_FOLDED]);
      wrap.classList.toggle("folded");
      // Folding a group changes which row is the 11th: re-measure the cap.
      layoutWdBody(body);
    });
    wrap.appendChild(gh);
    for (const it of g.items) {
      const row = document.createElement("div");
      row.className = "wd-row";
      const key = g.key + "\u0000" + it.path;
      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "wd-check";
      check.checked = WD_SELECT.has(key);
      check.title = "勾选后可批量操作";
      check.addEventListener("change", () => {
        if (check.checked) WD_SELECT.add(key);
        else WD_SELECT.delete(key);
        updateBatchBar();
      });
      check.addEventListener("click", (ev) => ev.stopPropagation());
      row.appendChild(check);
      const badge = document.createElement("span");
      badge.className = "wd-badge " + (it.code === "?" ? "q" : it.code);
      badge.textContent = it.code === "?" ? "?" : it.code;
      row.appendChild(badge);
      const path = document.createElement("span");
      path.className = "wd-path";
      path.textContent = it.path;
      path.title = (it.oldPath ? it.oldPath + " → " : "") + it.path;
      if (it.oldPath) {
        const old = document.createElement("span");
        old.className = "wd-old";
        old.textContent = "  ← " + it.oldPath;
        path.appendChild(old);
      }
      row.appendChild(path);
      if (it.code !== "?" && it.binary) {
        const b = document.createElement("span");
        b.className = "wd-binary";
        b.textContent = "二进制";
        row.appendChild(b);
      } else if (it.code !== "?") {
        const c = document.createElement("span");
        c.className = "wd-counts";
        const a = document.createElement("span");
        a.className = "add";
        a.textContent = "+" + (it.added ?? 0);
        const d = document.createElement("span");
        d.className = "del";
        d.textContent = "−" + (it.deleted ?? 0);
        c.appendChild(a);
        c.appendChild(document.createTextNode("  "));
        c.appendChild(d);
        row.appendChild(c);
      }
      // per-row write actions
      const acts = document.createElement("span");
      acts.className = "wd-acts";
      const mkAct = (label, fn, danger) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        if (danger) b.className = "danger";
        b.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); });
        acts.appendChild(b);
      };
      if (g.key === "staged") {
        mkAct("取消暂存", () => runGitOp("unstage", { file: it.path }));
        mkAct("还原", () => discardConfirm([it.path]), true);
      } else {
        mkAct("暂存", () => runGitOp("stage", { file: it.path }));
        if (g.key === "unstaged") mkAct("还原", () => discardConfirm([it.path]), true);
      }
      row.appendChild(acts);
      const diffBox = document.createElement("div");
      diffBox.className = "wd-diff";
      const pre = document.createElement("pre");
      pre.textContent = "加载中…";
      diffBox.appendChild(pre);
      row.appendChild(diffBox);
      row.addEventListener("click", () => {
        const open = row.classList.contains("open");
        if (open) { row.classList.remove("open"); return; }
        row.classList.add("open");
        loadWdFile(it, g.staged, pre);
        // Deliberately NOT re-measuring here. The row count is unchanged, so
        // the cap stays where it was and the panel keeps its height; the diff
        // simply scrolls inside the list. Re-measuring would inflate the cap
        // using the placeholder diff ("加载中…"), and then the real content
        // would land below a clip line that no longer matches anything.
      });
      wrap.appendChild(row);
    }
    body.appendChild(wrap);
  }
}

/** Load one file's diff (or content for untracked) on demand; cached. */
async function loadWdFile(item, staged, pre) {
  const key = staged + "\u0000" + item.path;
  const cached = cacheGet(wdDiffCache, key);
  if (cached) { renderWdText(pre, cached.text, cached.isDiff); return; }
  try {
    const res = await api("workfile", { file: item.path, staged, ...(item.oldPath ? { old: item.oldPath } : {}) });
    let text = "";
    let isDiff = false;
    if (!res.ok) {
      text = "加载失败: " + (res.error || "?");
    } else if (res.isDir) {
      text = "（未跟踪目录）";
    } else if (res.binary) {
      text = "（二进制文件，不显示内容）";
    } else if (res.content !== undefined) {
      text = res.content.trim() ? res.content : "（空文件）";
      if (res.truncated) text = "（内容过长已截断）\n" + text;
    } else {
      text = res.diff || "（无差异）";
      isDiff = true;
      if (res.truncated) text = "（diff 过长已截断）\n" + text;
    }
    cacheSet(wdDiffCache, key, { text, isDiff }, WD_CACHE_LIMIT);
    renderWdText(pre, text, isDiff);
  } catch (err) {
    pre.textContent = "加载失败: " + err.message;
  }
}

function renderWdText(pre, text, isDiff) {
  if (isDiff) highlightDiff(pre, text);
  else pre.textContent = text;
}

/** Above this many lines, diff colouring costs more than it is worth. */
const MAX_HIGHLIGHT_LINES = 3000;
/** Render unified-diff text into a <pre> with line-level coloring. */
function highlightDiff(pre, text) {
  pre.textContent = "";
  if (!text) return;
  const raw = String(text);
  const lines = raw.split("\n");
  // One <span> per line means tens of thousands of DOM nodes on a big diff;
  // past this cap show the same text as a single text node instead.
  if (lines.length > MAX_HIGHLIGHT_LINES) { pre.textContent = raw; return; }
  const frag = document.createDocumentFragment();
  for (const line of lines) {
    const span = document.createElement("span");
    span.style.display = "block";
    span.textContent = line || " ";
    let cls = "";
    if (line.startsWith("@@")) cls = "df-hunk";
    else if (/^(diff --git|index |new file mode|deleted file mode|similarity index|rename from|rename to|copy from|copy to|old mode|new mode|Binary files)/.test(line)) cls = "df-head";
    else if (line.startsWith("+++") || line.startsWith("---")) cls = "df-meta";
    else if (line.startsWith("+")) cls = "df-add";
    else if (line.startsWith("-")) cls = "df-del";
    if (cls) span.className = cls;
    frag.appendChild(span);
  }
  pre.appendChild(frag);
}

/** Escape text for safe interpolation into HTML.
 *  File paths, tag names and branch names come from the repository, not from
 *  this page, so they are untrusted: a repo may contain a file called
 *  `x<img src=x onerror=...>.txt` (legal on Linux/macOS). Any string that ends
 *  up inside an innerHTML template must go through this. */
function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Confirm dialog (destructive actions). Resolves true/false.
 *  `bodyHtml` is raw HTML: callers must pass escHtml() for any repo-derived
 *  text they interpolate. */
function confirmDialog(title, bodyHtml, danger, okLabel) {
  return new Promise((resolve) => {
    const d = $("ggDlg");
    $("ggDlgTitle").textContent = title;
    $("ggDlgBody").innerHTML = bodyHtml;
    const ok = $("ggDlgOk");
    ok.className = danger ? "danger" : "primary";
    ok.textContent = okLabel || (danger ? "确认还原" : "确认");
    const finish = (v) => {
      d.classList.remove("show");
      ok.onclick = null;
      $("ggDlgCancel").onclick = null;
      resolve(v);
    };
    ok.onclick = () => finish(true);
    $("ggDlgCancel").onclick = () => finish(false);
    d.classList.add("show");
  });
}

/** Commit dialog: message input + include-all checkbox. Resolves {message, all} or null. */
function commitDialog(paths) {
  return new Promise((resolve) => {
    const d = $("commitDlg");
    const body = $("commitDlgBody");
    body.innerHTML = "";
    const ws = WORKSTATUS;
    const p = document.createElement("div");
    if (paths && paths.length) {
      p.textContent = "将提交选中的 " + paths.length + " 个文件（其余改动不受影响）";
    } else {
      const parts = [];
      if (ws.counts.staged) parts.push("已暂存 " + ws.counts.staged + " 个文件");
      if (ws.counts.unstaged) parts.push("未暂存 " + ws.counts.unstaged + " 个文件");
      if (ws.counts.untracked) parts.push("未跟踪 " + ws.counts.untracked + " 个文件");
      p.textContent = "将提交" + (parts.length ? "：" + parts.join("、") : "（当前没有可提交的改动）");
    }
    body.appendChild(p);
    const ta = document.createElement("textarea");
    ta.placeholder = "提交信息（必填），例如：修复登录 bug";
    body.appendChild(ta);
    const aiRow = document.createElement("div");
    aiRow.className = "ai-row";
    const aiBtn = document.createElement("button");
    aiBtn.type = "button";
    aiBtn.className = "ai-btn";
    aiBtn.textContent = "✨ AI 生成提交信息";
    aiBtn.title = "根据当前改动自动生成（基于 diff 统计的启发式建议，可编辑后提交）";
    const aiTip = document.createElement("span");
    aiTip.className = "ai-tip";
    aiTip.textContent = "";
    aiRow.appendChild(aiBtn);
    aiRow.appendChild(aiTip);
    body.appendChild(aiRow);
    aiBtn.addEventListener("click", async () => {
      aiBtn.disabled = true;
      aiTip.textContent = "分析中…";
      try {
        const res = await api("suggestmsg");
        if (!res.ok) { aiTip.textContent = "生成失败: " + (res.error || "?"); return; }
        if (!res.candidates || !res.candidates.length) { aiTip.textContent = "当前没有可提交的改动"; return; }
        ta.value = res.candidates[0];
        ta.focus();
        aiTip.textContent = "已生成 " + res.candidates.length + " 条建议，可修改";
      } catch (err) {
        aiTip.textContent = "生成失败: " + err.message;
      } finally {
        aiBtn.disabled = false;
      }
    });
    const lab = document.createElement("label");
    lab.className = "ck";
    const ck = document.createElement("input");
    ck.type = "checkbox";
    ck.checked = true;
    lab.appendChild(ck);
    lab.appendChild(document.createTextNode("同时暂存所有未暂存/未跟踪的更改（相当于全部提交）"));
    body.appendChild(lab);
    if (paths && paths.length) lab.style.display = "none"; // selective commit uses only the picked files
    const finish = (v) => {
      d.classList.remove("show");
      $("commitDlgOk").onclick = null;
      $("commitDlgCancel").onclick = null;
      resolve(v);
    };
    $("commitDlgOk").onclick = () => {
      if (!ta.value.trim()) {
        ta.style.borderColor = "var(--red)";
        ta.focus();
        return; // keep the dialog open
      }
      finish({ message: ta.value.trim(), all: ck.checked });
    };
    $("commitDlgCancel").onclick = () => finish(null);
    d.classList.add("show");
    ta.focus();
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        if (ta.value.trim()) $("commitDlgOk").click();
      }
    });
  });
}

/* ---- batch actions (checkbox multi-select) ---- */
function updateBatchBar() {
  const batch = $("wdPanel").querySelector(".wd-batch");
  if (!batch) return;
  batch.innerHTML = "";
  const n = WD_SELECT.size;
  batch.style.display = n ? "" : "none";
  if (!n) return;
  const info = document.createElement("span");
  info.className = "wd-batch-info";
  info.textContent = "已选 " + n + " 个文件";
  batch.appendChild(info);
  const selected = [...WD_SELECT].map((k) => {
    const i = k.indexOf("\u0000");
    return { group: k.slice(0, i), path: k.slice(i + 1) };
  });
  const mk = (label, fn, danger) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (danger) b.className = "danger";
    b.addEventListener("click", fn);
    batch.appendChild(b);
  };
  mk("暂存选中", () => batchOp("stage", selected, ["unstaged", "untracked"]));
  mk("取消暂存选中", () => batchOp("unstage", selected, ["staged"]));
  mk("还原选中", () => discardConfirm(selected.map((s) => s.path)), true);
  mk("忽略选中", () => ignoreConfirm(selected.map((s) => s.path)), true);
  mk("提交选中", () => commitSelected(selected));
  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "✕";
  clear.title = "清除选择";
  clear.addEventListener("click", () => {
    WD_SELECT.clear();
    renderWdGroups($("wdPanel").querySelector(".wd-body"));
    updateBatchBar();
  });
  batch.appendChild(clear);
}

/** Run a batch action on the selected rows that belong to the given groups. */
function batchOp(action, selected, groups) {
  const paths = selected.filter((s) => groups.includes(s.group)).map((s) => s.path);
  if (!paths.length) { alert("当前选择中没有可执行此操作的文件"); return; }
  WD_SELECT.clear();
  runGitOp(action, { file: paths });
}

/** Ignore confirmation: add to .gitignore; tracked files are untracked (kept on disk). */
async function ignoreConfirm(paths) {
  const ok = await confirmDialog(
    "忽略选中",
    "将把这些文件<b>加入 .gitignore</b>；已跟踪的文件会<b>取消跟踪（文件保留在磁盘上）</b>：" +
      "<div class='dlg-list'>" + paths.map(escHtml).join("\n") + "</div>",
    true
  );
  if (ok) { WD_SELECT.clear(); runGitOp("ignore", { file: paths }); }
}

/** Commit only the selected files. */
async function commitSelected(selected) {
  const paths = selected.map((s) => s.path);
  const r = await commitDialog(paths);
  if (r && r.message) {
    WD_SELECT.clear();
    runGitOp("commit", { message: r.message, file: paths }, true);
  }
}

/** Discard confirmation for one or more paths. */
async function discardConfirm(paths) {
  const ok = await confirmDialog(
    "还原更改",
    "以下文件将被<b>还原到最近一次提交（HEAD）</b>，当前所有修改（含已暂存）都会<b>永久丢失</b>且不可恢复：" +
      "<div class='dlg-list'>" + paths.map(escHtml).join("\n") + "</div>",
    true
  );
  if (ok) runGitOp("discard", { file: paths });
}

// dialogs: click the backdrop (but not the box) to cancel; Esc handled in keydown
$("ggDlg").addEventListener("click", (ev) => { if (ev.target === $("ggDlg")) $("ggDlgCancel").click(); });
$("commitDlg").addEventListener("click", (ev) => { if (ev.target === $("commitDlg")) $("commitDlgCancel").click(); });

/** Run a write operation, then refresh the panel (+ graph for commits). */
async function runGitOp(action, params, needGraph) {
  try {
    const res = await api("gitop", { action, ...params });
    if (!res.ok) { alert("操作失败: " + (res.error || "?")); return false; }
    WD_SELECT.clear();
    wdDiffCache.clear();
    clearResponseCache();   // a commit/tag/branch write can change what details show
    await refreshWorkdir();
    if (needGraph) await reloadGraphLight();
    return true;
  } catch (err) {
    alert("操作失败: " + err.message);
    return false;
  }
}

/** Light reload of graph + branches (no workspace re-resolution). */
async function reloadGraphLight() {
  try {
    const [graph, branches] = await Promise.all([
      api("graph", { limit: PAGE_INITIAL, skip: 0, count: 0 }),
      api("branches")
    ]);
    if (graph.ok) {
      COMMITS = graph.commits;
      // count=0 means graph.total is 0 here; keep the total we already knew
      // instead of collapsing it to the page length.
      TOTAL = graph.total || Math.max(TOTAL, COMMITS.length);
    }
    LOADED = COMMITS.length;
    PAGINATION_EXHAUSTED = false;   // fresh page list: pagination may run again
    if (branches.ok) BRANCHES = branches.branches.map(normalizeBranch);
    BRANCH_COLOR_CACHE = null;
    if (!graph.total) refreshTotal();
    REFS_SIG = null;   // we just reloaded: re-baseline the change-detection probe
    fillFilterMenu();
    SELECTED = null;
    setDetailOpen(false);
    render();
    renderStats();
  } catch { /* ignore */ }
}

/* ===================== status line ===================== */
/** Top stats bar: commits / branches / authors / uncommitted / tags. */
function renderStats() {
  const bar = $("statsBar");
  if (!bar) return;
  const totalCommits = TOTAL || COMMITS.length;
  const authors = new Set(COMMITS.map((c) => c.author || "?")).size;
  const locals = BRANCHES.filter((b) => b.kind === "local").length;
  const remotes = BRANCHES.filter((b) => b.kind === "remote").length;
  const tags = BRANCHES.filter((b) => b.kind === "tag").length;
  const u = WORKSTATUS ? WORKSTATUS.counts.staged + WORKSTATUS.counts.unstaged + WORKSTATUS.counts.untracked : 0;
  bar.innerHTML = "";
  const mk = (label, val) => {
    const s = document.createElement("span");
    s.appendChild(document.createTextNode(label + " "));
    const n = document.createElement("span");
    n.className = "st-num";
    n.textContent = val;
    s.appendChild(n);
    bar.appendChild(s);
  };
  mk("提交", totalCommits);
  mk("本地分支", locals);
  mk("远程分支", remotes);
  mk("标签", tags);
  mk("作者", authors);
  mk("未提交", u);
}

function renderStatusLine() {
  const ws = WORKSTATUS;
  const el = $("statusLine");
  el.innerHTML = "";
  const b = document.createElement("span");
  b.className = "branch";
  b.textContent = "分支: " + (ws.branch || "?");
  el.appendChild(b);
  const total = ws.counts.staged + ws.counts.unstaged + ws.counts.untracked;
  if (total > 0) {
    const dirty = document.createElement("span");
    dirty.className = "dirty";
    dirty.textContent = `◌ 未提交改动：已暂存 ${ws.counts.staged} · 更改 ${ws.counts.unstaged} · 未跟踪 ${ws.counts.untracked}`;
    dirty.addEventListener("click", () => {
      $("wdPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    el.appendChild(dirty);
  } else {
    const clean = document.createElement("span");
    clean.className = "clean";
    clean.textContent = "✓ 工作区干净";
    el.appendChild(clean);
  }
  // version badge pinned to the right end of the status bar
  const ver = document.createElement("span");
  ver.className = "gg-version";
  ver.id = "ggVersion";
  ver.title = "插件版本，点击检查更新";
  ver.textContent = "v" + (UPDATE_STATE && UPDATE_STATE.current ? UPDATE_STATE.current : "?");
  ver.addEventListener("click", () => checkForUpdate(false));
  el.appendChild(ver);
}

/* ===================== load ===================== */
const SID_PARAM = new URLSearchParams(location.search).get("sid") || ""; // hosting session id
let SESSION_WS = ""; // resolved workspace path of the hosting session
/* Follow the hosting session's working copy.
 *
 * The iframe's ?sid is fixed when the element is created, and DSH keeps the same
 * iframe element while the user switches working copies — the document is not
 * recreated, so without this poll the graph would keep showing the repo of
 * whichever workspace happened to be active when the tab was first opened.
 *
 * resolveSessionWs() already prefers the entry whose sessionId matches ?sid and
 * otherwise falls back to the most recently active session, so polling works
 * both when a sid is present and when the panel is opened standalone. */
let WS_CHECK_BUSY = false;
async function checkSessionWorkspace() {
  if (WS_CHECK_BUSY) return;
  if (document.hidden) return;               // no point polling a hidden tab
  WS_CHECK_BUSY = true;
  try {
    const ws = await resolveSessionWs();
    if (ws && ws !== SESSION_WS) {
      SESSION_WS = ws;
      // A different working copy means a different repository. Cached responses
      // are keyed by commit hash / file path, which are unique per repository, so
      // they must go. The "last picked repo" memory is already keyed per
      // workspace, so it needs no clearing — and reloading with the new ws makes
      // the graph follow the switch.
      clearResponseCache();
      await load(ws);
    }
  } catch { /* ignore transient failures */ } finally {
    WS_CHECK_BUSY = false;
  }
}

/**
 * Resolve the hosting session's cwd via the DSH internal session.list Remote.
 * Wire format (typert gateway): POST /api/session/<method>, message.method is
 * "namespace/method", and payload carries exactly one named "args" field
 * ({ args: { _request: {} } }). The old dotted form ("session.list") never
 * reaches the gateway table — it returns 404 and the workspace stays empty.
 */
async function resolveSessionWs() {
  try {
    const res = await fetch("/api/session/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "gg-" + Date.now(),
        method: "session/list",
        payload: { args: { _request: {} } }
      })
    });
    const j = await res.json();
    const items =
      (j && j.result && j.result.value && j.result.value.items) ||
      (j && j.result && j.result.value && Array.isArray(j.result.value) ? j.result.value : []) ||
      (j && Array.isArray(j.items) ? j.items : []);
    // Exact match first: the iframe carries the hosting session id (?sid=).
    if (SID_PARAM) {
      const entry = items.find((s) => s.sessionId === SID_PARAM);
      if (entry && entry.cwd) return entry.cwd;
    }
    // Fallback: no sid (page opened directly) or no match — pick the most
    // recently active non-blank session that has a cwd, so the graph still
    // lands on the latest conversation's workspace automatically.
    const latest = items
      .filter((s) => !s.blank && s.cwd)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    if (latest && latest.cwd) return latest.cwd;
    return "";
  } catch (err) {
    console.warn("[git-graph] session/list failed:", err);
    return "";
  }
}

/** 当前对话不是 git 仓库：显示空态，不显示图谱。 */
function showEmpty(ws) {
  $("loading").classList.add("hidden");
  setDetailOpen(false);
  COMMITS = [];
  BRANCHES = [];
  BRANCH_COLOR_CACHE = null;
  $("wdPanel").innerHTML = "";
  $("commitList").innerHTML = "";
  $("legend").innerHTML = "";
  $("statsBar").innerHTML = "";
  $("repoLabel").textContent = "—";
  $("repoLabel").title = "";
  $("emptyPath").textContent = ws || "";
  $("emptyPath").title = ws || "";
  // 工作区路径已知时提供「在当前对话目录下查找 Git 仓库」一键扫描
  const scanBtn = $("btnScanDir");
  scanBtn.classList.toggle("gg-none", !ws);
  scanBtn.disabled = false;
  $("scanResults").innerHTML = "";
  $("esTitle").textContent = "当前对话区域不是 Git 仓库";
  $("esSub").textContent = "该对话的工作区没有 git 仓库。可以点击下方按钮浏览并打开其他文件夹的 Git 仓库。";
  $("emptyState").classList.remove("hidden");
}
function hideEmpty() {
  $("emptyState").classList.add("hidden");
}

/* "Last repo picked" memory is scoped to the session's working copy.
 *
 * It used to be a single global key, which meant: switch the working copy from A
 * to B, and the graph would still open repo A (the remembered pick) as long as A
 * was anywhere in the allow-list — the graph looked like it ignored the switch.
 * Keying it by workspace keeps each working copy's own pick while guaranteeing
 * that a switch is followed. Returns the raw key so callers stay simple. */
function curRepoKey() {
  return "gg2-currepo:" + (SESSION_WS || "");
}
function loadCurRepo() {
  return loadStored(curRepoKey(), "");
}
function saveCurRepo(v) {
  saveStored(curRepoKey(), v);
}

async function load(wsOverride) {
  // A workspace switch and a user-triggered refresh can overlap; running two
  // loads at once would let the slower one win and paint the wrong repo.
  if (load.INFLIGHT) return;
  load.INFLIGHT = true;
  $("loading").classList.remove("hidden");
  hideEmpty();
  try {
    // Restore UI preferences from the server before the first render, so the
    // branch filter is already applied when the graph paints (localStorage may
    // have been wiped by a port change).
    if (!PREFS_LOADED) await prefsLoad();
    // wsOverride comes from checkSessionWorkspace(), which has already resolved
    // the new cwd; preferring it avoids a redundant (and potentially stale)
    // second resolution racing with the poller.
    if (wsOverride !== undefined) SESSION_WS = wsOverride;
    else if (!SESSION_WS) SESSION_WS = await resolveSessionWs();
    const ws = SESSION_WS;
    // 重新注册用户通过「打开文件夹」添加过的仓库（服务端内存态重启后重置）
    const saved = ADDED_REPOS.filter(Boolean);
    const repos = await api("repos", Object.assign({}, ws ? { ws } : {}, saved.length ? { add: saved } : {}));
    if (!repos.ok || !repos.repos.length) {
      // 没有任何可用仓库：显示空态并引导用「打开文件夹」添加
      showEmpty(SESSION_WS || "");
      $("esTitle").textContent = "尚未添加 Git 仓库";
      $("esSub").textContent = "当前没有可用的 Git 仓库。点击下方按钮（或顶部「📂 打开」）浏览磁盘，选择任意文件夹的 Git 仓库：";
      return;
    }
    // 当前对话在非 git 工作区：没有用户主动添加的仓库时显示空态（不回落配置仓库）
    if (SESSION_WS && !repos.wsIsGit && !saved.length) {
      showEmpty(SESSION_WS);
      return;
    }
    // 当前仓库：上次选择的 > 会话工作区根 > 用户添加的第一个 > 服务端默认
    const available = repos.repos;
    let current = repos.current;
    const last = loadCurRepo();
    if (last && available.includes(last)) current = last;
    else if (repos.wsIsGit && repos.wsRoot) current = repos.wsRoot;
    else if (saved.length) {
      const f = available.find((r) => r === saved[0]);
      if (f) current = f;
    }
    if (!current || !available.includes(current)) current = available[0];
    // Switching repos invalidates every cached response: keys are commit hashes
    // and file paths, which are unique per repository.
    if (current !== REPO) clearResponseCache();
    REPO = current;
    $("repoLabel").textContent = REPO;
    $("repoLabel").title = REPO;
    // repo switcher (hidden when only one repo); show the folder name, full path in title
    const sw = $("repoSwitch");
    REPO_LIST = available;
    sw.innerHTML = "";
    const usedShort = new Set();
    for (const r of REPO_LIST) {
      const o = document.createElement("option");
      const short = (r.split("/").pop() || r);
      if (usedShort.has(short)) { o.textContent = r; }
      else { usedShort.add(short); o.textContent = short; }
      o.title = r;
      o.value = r;
      if (r === REPO) o.selected = true;
      sw.appendChild(o);
    }
    sw.style.display = REPO_LIST.length > 1 ? "" : "none";
    const [graph, branches] = await Promise.all([
      api("graph", { limit: PAGE_INITIAL, skip: 0, count: 0 }),
      api("branches")
    ]);
    if (!graph.ok) {
      // 仓库当前不可用（配置失效/权限等）：显示空态并引导用「打开文件夹」选择。
      $("loading").classList.add("hidden");
      showEmpty(SESSION_WS || "");
      $("esTitle").textContent = "当前仓库不可用";
      $("esSub").textContent = "无法读取仓库：" + (graph.error || "?") + "。可以点击下方按钮（或顶部「📂 打开」）打开其他文件夹的 Git 仓库：";
      return;
    }
    COMMITS = graph.commits;
    TOTAL = graph.total || COMMITS.length;   // provisional; refreshTotal() fills in the real count
    LOADED = COMMITS.length;
    PAGINATION_EXHAUSTED = false;   // fresh page list: pagination may run again
    BRANCHES = branches.ok ? branches.branches.map(normalizeBranch) : [];
    BRANCH_COLOR_CACHE = null;
    migrateLegacyFilter();              // old visible-list scheme -> hidden-list
    if (!graph.total) refreshTotal();   // first page rendered without waiting for the count
    // 首次加载（尚无任何折叠偏好存储时）默认折叠全部分支组：
    // 只显示分组头，点击组头才展开该组提交；仅执行一次，之后尊重用户手动状态。
    if (!BRANCH_FOLD_DEFAULTED && !localStorage.getItem("gg2-brfolded")) {
      BRANCH_FOLD_DEFAULTED = true;
      for (const b of BRANCHES) {
        if (b.kind === "local" || b.kind === "remote") BRANCH_FOLDED.add(b.refname);
      }
      saveStored("gg2-brfolded", [...BRANCH_FOLDED]);
    }
    fillFilterMenu();
    // Nothing is selected until the user clicks or presses ↑/↓. Seeding a cursor
    // here would draw the dashed box on the first row of every load, which reads
    // as "this row is selected" when nothing was selected.
    SELECTED = null;
    setDetailOpen(false);
    REFS_SIG = null;   // full load: let the next poll re-baseline
    render();
    renderStats();
    refreshWorkdir();
    if (COMMITS.length) {
      setTimeout(() => scrollToNode(COMMITS[0].hash), 120);
    }
    // silent update check after the graph is usable
    setTimeout(() => checkForUpdate(true), 800);
  } catch (err) {
    $("loading").textContent = "加载失败: " + err.message;
  } finally {
    $("loading").classList.add("hidden");
    load.INFLIGHT = false;
  }
}

/* ===================== 打开文件夹：浏览磁盘并添加任意 Git 仓库 ===================== */
function pickCell(text) {
  const d = document.createElement("div");
  d.className = "pd-empty";
  d.textContent = text;
  return d;
}
/** 刷新文件夹选择列表（盘符视图或目录视图）。 */
async function browseDir(path) {
  const list = $("pdList");
  list.innerHTML = "";
  list.appendChild(pickCell("加载中…"));
  $("pdOpen").disabled = true;
  try {
    const res = await api("listdir", { path: path || "" });
    list.innerHTML = "";
    if (!res || !res.ok) {
      PICK_ROOT = null;
      PICK_PARENT = null;
      list.appendChild(pickCell("加载失败：" + ((res && res.error) || "?")));
      $("pdHint").textContent = "";
      updatePickOpen();
      return;
    }
    PICK_PATH = res.path || path || "";
    PICK_PARENT = res.parent || null;
    PICK_ROOT = res.root || null;
    $("pdPath").textContent = res.path || (res.drives && res.drives.length ? "选择驱动器" : "");
    $("pdPath").title = res.path || "";
    $("pdUp").disabled = !PICK_PARENT;
    if (res.drives && res.drives.length) {
      for (const d of res.drives) {
        const row = document.createElement("div");
        row.className = "pd-item";
        const ico = document.createElement("span");
        ico.className = "pd-ico";
        ico.textContent = "💽";
        const nm = document.createElement("span");
        nm.className = "pd-name";
        nm.textContent = d;
        row.appendChild(ico);
        row.appendChild(nm);
        row.addEventListener("click", () => browseDir(d));
        list.appendChild(row);
      }
    } else {
      for (const d of (res.dirs || [])) {
        const row = document.createElement("div");
        row.className = "pd-item" + (d.name.startsWith(".") ? " pd-hidden" : "");
        const ico = document.createElement("span");
        ico.className = "pd-ico";
        ico.textContent = d.git ? "🗂️" : "📁";
        const nm = document.createElement("span");
        nm.className = "pd-name";
        nm.textContent = d.name;
        row.appendChild(ico);
        row.appendChild(nm);
        if (d.git) {
          const g = document.createElement("span");
          g.className = "pd-git";
          g.textContent = "git";
          row.appendChild(g);
        }
        row.addEventListener("click", () => browseDir(d.path));
        list.appendChild(row);
      }
      if (res.truncated) list.appendChild(pickCell("目录较多，仅显示前 500 个"));
      if (!res.readable) list.appendChild(pickCell("无法读取此目录（可能没有权限）"));
      if (!res.dirs.length && res.readable) list.appendChild(pickCell("此文件夹下没有子目录"));
    }
    updatePickOpen();
  } catch (err) {
    list.innerHTML = "";
    list.appendChild(pickCell("加载失败：" + err.message));
    PICK_ROOT = null;
    PICK_PARENT = null;
    updatePickOpen();
  }
}
function updatePickOpen() {
  const open = $("pdOpen");
  const hint = $("pdHint");
  open.disabled = !PICK_ROOT;
  hint.textContent = PICK_ROOT
    ? (PICK_ROOT === PICK_PATH ? "✓ 当前文件夹就是 Git 仓库" : "✓ 位于仓库内，将打开：" + PICK_ROOT)
    : "此文件夹不是 Git 仓库（可继续进入子目录）";
  hint.title = PICK_ROOT || "";
}
async function openDirPicker() {
  $("pickdirDlg").classList.add("show");
  $("pdList").innerHTML = "";
  PICK_PATH = "";
  PICK_PARENT = null;
  PICK_ROOT = null;
  $("pdUp").disabled = true;
  await browseDir("");
}
async function openPickPath() {
  if (!PICK_ROOT) return;
  const btn = $("pdOpen");
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "打开中…";
  try {
    const res = await api("addrepo", { path: PICK_PATH });
    if (!res.ok) { alert("无法添加该仓库：" + (res.error || "?")); return; }
    if (!ADDED_REPOS.includes(res.repo)) {
      ADDED_REPOS.push(res.repo);
      saveStored("gg2-repos", ADDED_REPOS);
    }
    saveCurRepo(res.repo);
    $("pickdirDlg").classList.remove("show");
    if (REPO === res.repo) return; // 已在查看此仓库，仅关闭对话框
    wdDiffCache.clear();
    REPO = res.repo;
    await load();
  } catch (err) {
    alert("无法添加该仓库：" + err.message);
  } finally {
    btn.disabled = !PICK_ROOT;
    btn.textContent = orig;
  }
}
$("btnOpenDir").addEventListener("click", openDirPicker);
$("btnOpenDirEmpty").addEventListener("click", openDirPicker);

/* ---- 空态一键扫描：在当前对话目录（及浅层子目录）中查找 Git 仓库 ---- */
async function scanForRepos() {
  const btn = $("btnScanDir");
  const list = $("scanResults");
  if (!SESSION_WS) return;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "扫描中…";
  list.innerHTML = "";
  try {
    const res = await api("findrepos", { ws: SESSION_WS });
    if (!res.ok) { alert("扫描失败：" + (res.error || "?")); return; }
    const repos = res.repos || [];
    if (!repos.length) {
      const none = document.createElement("div");
      none.className = "es-scan-none";
      none.textContent = "（未找到 Git 仓库，可点击上方「📂 打开文件夹」手动浏览）";
      list.appendChild(none);
      return;
    }
    for (const r of repos) {
      const row = document.createElement("button");
      row.className = "es-scan-item";
      row.textContent = r;
      row.title = "打开 " + r;
      row.addEventListener("click", () => openScannedRepo(r));
      list.appendChild(row);
    }
  } catch (err) {
    alert("扫描失败：" + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}
async function openScannedRepo(repo) {
  const res = await api("addrepo", { path: repo });
  if (!res.ok) { alert("无法添加该仓库：" + (res.error || "?")); return; }
  if (!ADDED_REPOS.includes(res.repo)) {
    ADDED_REPOS.push(res.repo);
    saveStored("gg2-repos", ADDED_REPOS);
  }
  saveCurRepo(res.repo);
  wdDiffCache.clear();
  REPO = res.repo;
  await load();
}
$("btnScanDir").addEventListener("click", scanForRepos);
$("pdClose").addEventListener("click", () => $("pickdirDlg").classList.remove("show"));
$("pdUp").addEventListener("click", () => browseDir(PICK_PARENT || ""));
$("pdOpen").addEventListener("click", openPickPath);
$("pickdirDlg").addEventListener("click", (ev) => { if (ev.target === $("pickdirDlg")) $("pdClose").click(); });

/* ===================== server-backed prefs ===================== */
/* localStorage is origin-scoped and the DSH web port changes between launches,
 * so anything kept there silently resets on a restart. UI preferences are
 * mirrored to the server (a small JSON next to the plugin) and re-read on load,
 * which is what makes the branch filter survive a port change.
 * localStorage stays the fast path; the server copy wins when they disagree. */
let PREFS_LOADED = false;
/* A host that predates the prefs ops answers 403/unknown-op. Remember that once
 * and fall back to localStorage-only, so an un-restarted host does not emit a
 * failed request on every filter change. */
let PREFS_OP_OK = true;
function prefsSync(patch) {
  if (!PREFS_LOADED || !PREFS_OP_OK) return;   // do not clobber the server copy before we read it
  try {
    api("prefswrite", { set: JSON.stringify(patch) }).then((r) => {
      if (r && r.ok === false) PREFS_OP_OK = false;
    }).catch(() => { /* best effort */ });
  } catch { /* ignore */ }
}
async function prefsLoad() {
  try {
    const r = await api("prefs");
    if (!r.ok || !r.prefs) { PREFS_OP_OK = false; PREFS_LOADED = true; return false; }
    PREFS_OP_OK = true;
    const p = r.prefs;
    let changed = false;

    // --- branch filter -------------------------------------------------------
    if (Array.isArray(p["gg2-bfilter"])) {
      HIDDEN_REFS = p["gg2-bfilter"];
      saveStored("gg2-bfilter-hidden", HIDDEN_REFS);
      changed = true;
    } else if (HIDDEN_REFS === null && LEGACY_VISIBLE_REFS !== null) {
      // Migrate the old "store the visible ones" scheme once: everything that
      // was not visibly checked becomes hidden.
      // Cannot compute without BRANCHES; deferred to migrateLegacyFilter().
    }

    // --- date range -----------------------------------------------------------
    if (typeof p["gg2-datefrom"] === "string") {
      DATE_FROM = p["gg2-datefrom"];
      saveStored("gg2-datefrom", DATE_FROM);
    }
    if (typeof p["gg2-dateto"] === "string") {
      DATE_TO = p["gg2-dateto"];
      saveStored("gg2-dateto", DATE_TO);
    }

    // --- flat mode ------------------------------------------------------------
    // Grouped is the default; flat is the opt-in view that carries the lane graph.
    //
    // The one-time "flat was the development default" reset used to be gated by a
    // flag that lived ONLY in localStorage. That store is origin-scoped, and the
    // plugin shares the DSH origin, so every web-port change wiped it — and the
    // reset then re-ran and overwrote the user's choice with `false`, on the
    // client and (once the guard was lifted) on the server. The flag is now
    // persisted server-side too, and an explicit `gg2-flat` on the server counts
    // as proof of a deliberate choice, so a real selection is never reset.
    const hasServerFlat = typeof p["gg2-flat"] === "boolean";
    const migrationDone = FLAT_DEFAULT_MIGRATED === true || p["gg2-flat-reset"] === true || hasServerFlat;
    const pending = {};
    if (!migrationDone) {
      FLAT_MODE = false;
      saveStored("gg2-flat", false);
      saveStored("gg2-flat-reset", true);
      pending["gg2-flat"] = false;
      pending["gg2-flat-reset"] = true;
    } else {
      if (FLAT_DEFAULT_MIGRATED !== true) saveStored("gg2-flat-reset", true);
      if (hasServerFlat) {
        FLAT_MODE = p["gg2-flat"];
        saveStored("gg2-flat", FLAT_MODE);
      }
    }
    syncFlatBtn();

    // --- other remembered UI state ------------------------------------------
    for (const key of ["gg2-wdshow", "gg2-wdfolded", "gg2-wdgroupfolded", "gg2-brfolded"]) {
      if (p[key] !== undefined) { saveStored(key, p[key]); }
    }
    if (p["gg2-wdshow"] !== undefined) WD_SHOW = p["gg2-wdshow"];
    if (p["gg2-wdfolded"] !== undefined) WD_FOLDED = p["gg2-wdfolded"];
    if (Array.isArray(p["gg2-wdgroupfolded"])) {
      WD_GROUP_FOLDED.clear();
      for (const k of p["gg2-wdgroupfolded"]) WD_GROUP_FOLDED.add(k);
    }
    if (Array.isArray(p["gg2-brfolded"])) {
      BRANCH_FOLDED.clear();
      for (const k of p["gg2-brfolded"]) BRANCH_FOLDED.add(k);
    }

    // --- theme ---------------------------------------------------------------
    // themePref was already computed from localStorage at parse time, but after a
    // port change that store is empty, so the server value has to be applied to
    // the *variable* as well — writing it to localStorage only (as this loop used
    // to) restored it for the NEXT load and left this one on auto.
    if (THEMES.includes(p["gg2-theme"])) {
      themePref = p["gg2-theme"];
      saveStored("gg2-theme", themePref);
    }
    applyTheme();

    PREFS_LOADED = true;
    // Write the flat-migration marker once it is safe to do so: prefsSync refuses
    // to run before PREFS_LOADED, which is exactly why the old call site (inside
    // the migration branch) silently dropped it — the guard was still false.
    if (Object.keys(pending).length) prefsSync(pending);
    return changed;
  } catch {
    PREFS_LOADED = true;   // never block startup on the pref store
    return false;
  }
}
/** One-time migration from the legacy visible-list scheme. Needs BRANCHES, so
 *  it runs after the first branches fetch. */
function migrateLegacyFilter() {
  if (HIDDEN_REFS !== null || LEGACY_VISIBLE_REFS === null) return;
  const visible = LEGACY_VISIBLE_REFS;
  const refs = BRANCHES.filter((b) => b.kind === "local" || b.kind === "remote").map((b) => b.refname);
  HIDDEN_REFS = refs.filter((r) => !visible.includes(r));
  saveStored("gg2-bfilter-hidden", HIDDEN_REFS);
  try { localStorage.removeItem("gg2-bfilter"); } catch { /* ignore */ }
}

/* Counts used by the empty-filter hint. */
function branchCount() {
  return BRANCHES.filter((b) => b.kind === "local" || b.kind === "remote").length;
}
function hiddenCount() {
  if (!HIDDEN_REFS || !HIDDEN_REFS.length) return 0;
  const refs = new Set(BRANCHES.map((b) => b.refname));
  return HIDDEN_REFS.filter((r) => refs.has(r)).length;   // ignore refs that no longer exist
}

/* ---- branch checkbox filter ---- */
function fillFilterMenu() {
  const box = $("fmBranches");
  box.innerHTML = "";
  const groups = [
    { key: "local", title: "本地分支", items: BRANCHES.filter((b) => b.kind === "local") },
    { key: "remote", title: "远程分支", items: BRANCHES.filter((b) => b.kind === "remote") }
  ];
  for (const grp of groups) {
    if (!grp.items.length) continue;
    const title = document.createElement("div");
    title.className = "fm-group";
    title.textContent = grp.title;
    box.appendChild(title);
    for (const b of grp.items) {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "fBranch";
      cb.dataset.sha = b.sha;
      cb.dataset.ref = b.refname;
      // Restore from the hidden-list: only explicitly turned-off branches are
      // unchecked, so a branch created since the filter was saved shows up.
      cb.checked = !(HIDDEN_REFS && HIDDEN_REFS.includes(b.refname));
      const dot = document.createElement("span");
      dot.className = "fm-dot";
      dot.style.background = branchColorOf(b.sha);
      label.appendChild(cb);
      label.appendChild(dot);
      label.appendChild(document.createTextNode(b.name + (b.head ? " (HEAD)" : "")));
      label.addEventListener("click", (ev) => ev.stopPropagation());
      cb.addEventListener("change", applyFilter);
      box.appendChild(label);
    }
  }
  applyFilter();
}
function applyFilter() {
  const boxes = [...document.querySelectorAll(".fBranch")];
  // No checkboxes means BRANCHES is not available (the branches fetch failed, or
  // the repo has no refs yet). Deriving state from an empty DOM would conclude
  // "nothing is hidden" and persist `[]`, so one transient git failure would wipe
  // the saved selection from the server — the user's filter would be gone for
  // good. Render unfiltered for this paint (a branch filter cannot be evaluated
  // without branch data) and leave the stored list untouched so it re-applies
  // when the branches load.
  if (boxes.length === 0) {
    FILTER = "all";
    CHECKED_SET.clear();
    render();
    return;
  }
  const hidden = boxes.filter((b) => !b.checked).map((b) => b.dataset.ref);
  const anyHidden = hidden.length > 0;
  $("fAll").checked = !anyHidden;
  // Always record what is hidden (empty array = nothing hidden). Keeping an
  // explicit [] rather than collapsing to null preserves "user chose to hide
  // everything" as a distinct state from "never configured".
  const prev = HIDDEN_REFS;
  HIDDEN_REFS = hidden;
  FILTER = anyHidden ? "multi" : "all";
  CHECKED_SET.clear();
  if (anyHidden) {
    for (const b of boxes) if (b.checked) CHECKED_SET.add(b.dataset.sha);
  }
  // Only persist a real change. fillFilterMenu() calls this on every load, so
  // writing unconditionally meant a prefswrite on every page load.
  if (JSON.stringify(prev) !== JSON.stringify(hidden)) {
    saveStored("gg2-bfilter-hidden", HIDDEN_REFS);
    prefsSync({ "gg2-bfilter": HIDDEN_REFS });   // server copy survives port changes
  }
  render();
}
$("fAll").addEventListener("change", () => {
  const all = $("fAll").checked;
  for (const b of document.querySelectorAll(".fBranch")) b.checked = all;
  applyFilter();
});
$("btnFilter").addEventListener("click", (ev) => {
  ev.stopPropagation();
  const open = !$("filterMenu").classList.contains("show");
  setFilterMenuOpen(open);
  if (open) positionFilterMenu();
});
/* The filter menu is `position: absolute; right: 0` under its trigger, which
 * holds only while the trigger is far enough from the left edge. At ≤560px the
 * header wraps to two rows and `.hd-center` switches to `justify-content:
 * flex-start`, so the trigger sits near the left and a 200px menu pinned by its
 * right edge hangs off the screen (measured at 520px: left = -100, i.e. half the
 * menu unreachable). Clamp it into the viewport the same way the date panel is
 * clamped — but only when needed, so the normal case keeps the neat
 * right-aligned look. */
function positionFilterMenu() {
  const menu = $("filterMenu");
  if (!menu.classList.contains("show")) return;
  menu.style.left = "";
  menu.style.right = "";
  const r = menu.getBoundingClientRect();
  const pad = 8;
  if (r.left >= pad && r.right <= innerWidth - pad) return;
  // The menu is absolutely positioned inside .filterWrap (its offsetParent), so
  // a viewport coordinate must be converted before it is written to `left`.
  // Writing the viewport value directly would shift it by the wrap's offset.
  const parent = menu.offsetParent;
  const px = parent ? parent.getBoundingClientRect().left : 0;
  const leftViewport = Math.min(Math.max(pad, r.left), Math.max(pad, innerWidth - pad - r.width));
  menu.style.left = Math.round(leftViewport - px) + "px";
  menu.style.right = "auto";
}


/* Flat / grouped view. Flat mode drops the branch group headers so the lane
 * graph runs continuously — a header row has no commit node, which would
 * otherwise leave a visible gap in every lane crossing it.
 *
 * The control now lives in Settings, but the two values are absolute
 * ("grouped" / "flat") rather than a toggle: the segmented control shows both
 * options at once, so a click means "be this", not "flip that". A toggle would
 * have needed the button to be rotated by every state change, and a mis-click
 * would then be indistinguishable from a double-click. */
function setFlatMode(on) {
  on = Boolean(on);
  if (on !== FLAT_MODE) {
    FLAT_MODE = on;
    saveStored("gg2-flat", FLAT_MODE);
    prefsSync({ "gg2-flat": FLAT_MODE });
    render();
  }
  syncSettingsState();
}
/* Kept as the name every call site already uses (prefs restore, startup). */
function syncFlatBtn() { syncSettingsState(); }
/* Outside-click dismissal for the header/panel popovers is in ONE capture-phase
 * listener; see dismissPopovers() below the date panel, because closing the date
 * panel has to commit (or keep) its draft. */
function setFilterMenuOpen(open) {
  $("filterMenu").classList.toggle("show", open);
  $("btnFilter").setAttribute("aria-expanded", open ? "true" : "false");
}
/** The wd-panel group menu is built per render, so it is closed by element
 *  rather than by id; its trigger is the sibling button right before it. */
function setWdMenuOpen(menu, open) {
  if (!menu) return;
  menu.classList.toggle("show", open);
  const btn = menu.previousElementSibling;
  if (btn && btn.tagName === "BUTTON") btn.setAttribute("aria-expanded", open ? "true" : "false");
}


/* ===================== events ===================== */
/* Busy state for an icon-only button. `textContent = "拉取中…"` used to carry the
 * in-flight signal; that is no longer available because the button's only child
 * is now an <svg> and assigning textContent would delete it. The rotation of the
 * glyph plus `aria-busy` carries the same information without the text. */
function setBusy(btn, busy, label) {
  btn.classList.toggle("busy", busy);
  btn.disabled = busy;
  btn.setAttribute("aria-busy", busy ? "true" : "false");
  if (label) btn.title = label;
}
$("btnRefresh").addEventListener("click", load);

/** Fetch remote refs (git fetch --all --prune), then refresh graph + branches. */
$("btnFetch").addEventListener("click", async () => {
  const b = $("btnFetch");
  const idle = b.title;
  setBusy(b, true, "拉取中…");
  try {
    const res = await api("gitop", { action: "fetch" });
    if (!res.ok) { alert("拉取失败: " + (res.error || "?")); return; }
    await reloadGraphLight();
    refreshWorkdir();
  } catch (err) {
    alert("拉取失败: " + err.message);
  } finally {
    setBusy(b, false, idle);
  }
});

/** Push the current branch to origin (confirm first). */
$("btnPush").addEventListener("click", async () => {
  const ws = WORKSTATUS;
  const branch = ws && ws.branch ? ws.branch : "";
  const ok = await confirmDialog(
    "推送到远程",
    "将把当前分支 <b>" + escHtml(branch || "HEAD") + "</b> 推送到 <b>origin</b>（会影响云端仓库，请确认）：",
    false, "确认推送"
  );
  if (!ok) return;
  const b = $("btnPush");
  const idle = b.title;
  setBusy(b, true, "推送中…");
  try {
    const res = await api("gitop", { action: "push", branch });
    if (!res.ok) { alert("推送失败: " + (res.error || "?")); return; }
    alert(res.summary || "推送成功");
  } catch (err) {
    alert("推送失败: " + err.message);
  } finally {
    setBusy(b, false, idle);
  }
});
$("repoSwitch").addEventListener("change", (ev) => {
  const v = ev.target.value;
  if (!v || v === REPO) return;
  REPO = v;
  saveCurRepo(v);
  $("repoLabel").textContent = v;
  $("repoLabel").title = v;
  wdDiffCache.clear();
  reloadGraphLight();
  refreshWorkdir();
});

/* ---- self-update: check GitHub for a newer tag, offer one-click update ---- */
let UPDATE_STATE = null; // {current, latest, hasUpdate, managed}
async function checkForUpdate(silent) {
  const btn = $("btnUpdate");
  try {
    const res = await api("checkupdate");
    if (!res.ok) { if (!silent) alert("检查更新失败: " + (res.error || "?")); return; }
    UPDATE_STATE = res;
    // keep the version badge in the status bar in sync
    const ver = $("ggVersion");
    if (ver && res.current) ver.textContent = "v" + res.current;
    if (res.managed === "git") {
      // Plugin dir is a git checkout (link:/dev mount): never overwrite files
      // the user owns through git — upgrades go through `git pull`.
      btn.classList.add("gg-none");
      if (!silent) alert("插件以 git 工作区形式挂载，请在插件仓库目录执行 git pull 更新（当前 v" + (res.current || "?") + "）");
      return;
    }
    if (res.hasUpdate && res.latest) {
      // The badge used to grow to "🔄 新版本 vX.Y", which re-widened the right
      // group and shifted the centred filters every time a release landed.
      // An accent tint plus the version in the tooltip keeps the width fixed.
      btn.classList.remove("gg-none");
      btn.classList.add("has-upd");
      btn.title = "发现新版本 " + res.latest + "（当前 " + (res.current || "?") + "），点击一键更新";
      btn.setAttribute("aria-label", "发现新版本 " + res.latest + "，点击更新");
    } else if (!silent) {
      btn.classList.add("gg-none");
      alert("已是最新版本（" + (res.current || "?") + "）");
    }
  } catch (err) {
    if (!silent) alert("检查更新失败: " + err.message);
  }
}
$("btnUpdate").addEventListener("click", async () => {
  if (!UPDATE_STATE || !UPDATE_STATE.hasUpdate) { checkForUpdate(false); return; }
  const ok = await confirmDialog(
    "发现新版本",
    "当前版本 <b>" + escHtml(UPDATE_STATE.current || "?") + "</b>，最新版本 <b>" + escHtml(UPDATE_STATE.latest) +
      "</b>。将自动从 GitHub 下载并替换插件文件，<b>完成后需要重启 DeepSeek Harness 才能生效</b>。继续？",
    false, "立即更新"
  );
  if (!ok) return;
  const btn = $("btnUpdate");
  const idle = btn.title;
  setBusy(btn, true, "更新中…");
  try {
    const res = await api("autoupdate", { tag: UPDATE_STATE.latest });
    if (!res.ok) { alert("更新失败: " + (res.error || "?")); return; }
    alert("更新完成！请重启 DeepSeek Harness 使新版本生效。");
    btn.classList.add("gg-none");
  } catch (err) {
    alert("更新失败: " + err.message);
  } finally {
    setBusy(btn, false, idle);
  }
});

let searchTimer = null;
$("searchBox").addEventListener("input", (ev) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    SEARCH = ev.target.value.trim();
    updateSearchCount();
    render();
  }, 200);
});

/* Match count reflects the *filtered* result set, matching what the list shows. */
function updateSearchCount() {
  if (!filtersActive()) { $("searchCount").textContent = ""; return; }
  const n = COMMITS.filter(passesFilters).length;
  $("searchCount").textContent = `${n} 条匹配`;
}

/** Reset search + date range (the "no results" escape hatch). */
function clearFilters() {
  SEARCH = "";
  DATE_FROM = "";
  DATE_TO = "";
  $("searchBox").value = "";
  // The popover keeps its own draft; clearing the live state without it would
  // leave the chips showing a range that is no longer filtering anything.
  dFrom = "";
  dTo = "";
  dDirty = false;
  syncDateDraftUI();
  renderCalendar();
  saveStored("gg2-datefrom", "");
  saveStored("gg2-dateto", "");
  prefsSync({ "gg2-datefrom": "", "gg2-dateto": "" });
  updateSearchCount();
  render();
}

/* ---- date range popover ---- */
/* The range is edited as a DRAFT (dFrom/dTo) and only copied into the live
 * DATE_FROM/DATE_TO by applyDateRange(). The calendar grid writes to whichever
 * end `dEnd` names, so a two-click range ("从" then "到") needs no second
 * picker and no modal re-entry — the popover stays open across both clicks. */
let dFrom = "";
let dTo = "";
let dEnd = "from";                                  // which chip the calendar writes
let dView = { y: new Date().getFullYear(), m: new Date().getMonth() };  // first of the visible month
let dDirty = false;                                  // draft differs from applied

function openDateDraft() {
  dFrom = DATE_FROM || "";
  dTo = DATE_TO || "";
  dDirty = false;
  // Resume at the start of the current range, else at the newest month that can
  // actually hold commits; opening on an empty future month makes the picker
  // look broken.
  const now = new Date();
  let anchor = dFrom || dTo;
  if (!anchor) {
    const newest = /^(\d{4})-(\d{2})/.exec((COMMITS[0] && COMMITS[0].date) || "");
    anchor = newest ? newest[1] + "-" + newest[2] + "-01" : ymdLocal(now);
  }
  const mm = /^(\d{4})-(\d{2})/.exec(anchor);
  dView = mm
    ? { y: Number(mm[1]), m: Number(mm[2]) - 1 }
    : { y: now.getFullYear(), m: now.getMonth() };
  // Starting on "从" would overwrite the start whenever it is already set and the
  // end is not: the useful default is the end that is still open.
  dEnd = dFrom && !dTo ? "to" : "from";
  syncDateDraftUI();
  renderCalendar();
}

function dateDraftChip() {
  const open = dEnd;
  $("dateFromChip").classList.toggle("active", open === "from");
  $("dateFromChip").setAttribute("aria-pressed", String(open === "from"));
  $("dateToChip").classList.toggle("active", open === "to");
  $("dateToChip").setAttribute("aria-pressed", String(open === "to"));
}

function syncDateDraftUI() {
  // Display joins the stored YYYY-MM-DD into the shorter 2026/11/05: eight digits
  // and two separators in a 300px panel leaves no margin, and the slashes match
  // the calendar header.
  const fmt = (v) => (v ? v.replace(/-/g, "/") : "不限");
  $("dateFromVal").textContent = fmt(dFrom);
  $("dateToVal").textContent = fmt(dTo);
  $("dateFromChip").classList.toggle("empty", !dFrom);
  $("dateToChip").classList.toggle("empty", !dTo);
  dateDraftChip();
  // "应用" is the commit point, so it has to show whether there is anything to commit.
  $("dateApply").classList.toggle("primary", dDirty);
  $("dateApply").textContent = dDirty ? "应用" : "关闭";
}

/** Set the end the calendar is editing; picking both ends in order needs no mode
 *  switch, but an explicit click always wins over the automatic advance. */
function setDateEnd(which) {
  dEnd = which;
  dateDraftChip();
  const v = which === "from" ? dFrom : dTo;
  const m = /^(\d{4})-(\d{2})/.exec(v);
  if (m) { dView = { y: Number(m[1]), m: Number(m[2]) - 1 }; renderCalendar(); }
}

/** Clicking a day writes that day to the active end and advances to the other
 *  one while the other is empty. Order is normalised on apply, so the user never
 *  has to think about which one they clicked first. */
function pickDay(ymd) {
  // renderCalendar() rebuilds the grid, which destroys the focused <button>. A
  // keyboard user pressing Enter on a day would lose focus to <body> and the
  // arrow keys would stop working, so re-apply focus to the same date.
  const hadFocus = document.activeElement && document.activeElement.classList
    && document.activeElement.classList.contains("dm-day");
  if (dEnd === "from") {
    dFrom = ymd;
    if (!dTo) { dEnd = "to"; } else if (dTo < dFrom) { dFrom = dTo; dTo = ymd; }
  } else {
    dTo = ymd;
    if (!dFrom) { dEnd = "from"; } else if (dTo < dFrom) { dTo = dFrom; dFrom = ymd; }
  }
  dDirty = dFrom !== (DATE_FROM || "") || dTo !== (DATE_TO || "");
  syncDateDraftUI();
  renderCalendar();
  if (hadFocus) {
    const el = $("dmGrid").querySelector(`[data-ymd="${ymd}"]`);
    if (el) { for (const b of $("dmGrid").querySelectorAll(".dm-day")) b.tabIndex = -1; el.tabIndex = 0; el.focus(); }
  }
}

function renderCalendar() {
  const y = dView.y, m = dView.m;
  $("dmTitle").textContent = `${y} 年 ${m + 1} 月`;
  const grid = $("dmGrid");
  grid.innerHTML = "";
  const first = new Date(y, m, 1);
  const lead = (first.getDay() + 6) % 7;             // Monday-first column index
  const start = new Date(y, m, 1 - lead);
  const todayYmd = ymdLocal(new Date());
  const lo = dFrom && dTo && dFrom > dTo ? dTo : dFrom;
  const hi = dFrom && dTo && dFrom > dTo ? dFrom : dTo;
  const frag = document.createDocumentFragment();
  // Roving tabindex: 42 day buttons would otherwise be 42 tab stops. Only the
  // active end (or today, when it is in view) is tabbable; arrow keys inside the
  // grid move focus and hand the tab stop over.
  const active = dEnd === "from" ? dFrom : dTo;
  let tabYmd = active && active.slice(0, 7) === `${y}-${String(m + 1).padStart(2, "0")}` ? active : "";
  if (!tabYmd && todayYmd.slice(0, 7) === `${y}-${String(m + 1).padStart(2, "0")}`) tabYmd = todayYmd;
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const ymd = ymdLocal(d);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dm-day";
    b.textContent = String(d.getDate());
    b.dataset.ymd = ymd;
    b.tabIndex = -1;
    b.setAttribute("aria-label", `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`);
    if (d.getMonth() !== m) b.classList.add("other");
    if (ymd === todayYmd) { b.classList.add("today"); b.setAttribute("aria-current", "date"); }
    if (lo && hi && ymd > lo && ymd < hi) b.classList.add("inrange");
    if (ymd === dFrom || ymd === dTo) { b.classList.add("sel"); b.setAttribute("aria-pressed", "true"); }
    if (!tabYmd && i === lead) tabYmd = ymd;
    frag.appendChild(b);
  }
  grid.appendChild(frag);
  const tab = grid.querySelector(`[data-ymd="${tabYmd || ""}"]`) || grid.querySelector(".dm-day");
  if (tab) tab.tabIndex = 0;
}

function shiftMonth(delta) {
  const d = new Date(dView.y, dView.m + delta, 1);
  dView = { y: d.getFullYear(), m: d.getMonth() };
  renderCalendar();
}

function ymdLocal(d) {
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
function fillDateInputs() {
  // Kept as the name the rest of the file calls (clearFilters, boot): refresh the
  // draft from the live state and repaint whatever is on screen.
  dFrom = DATE_FROM || "";
  dTo = DATE_TO || "";
  dDirty = false;
  syncDateDraftUI();
  renderCalendar();
}
function applyDateRange() {
  let from = dFrom, to = dTo;
  // Swap silently when the user picked them backwards; a rejection dialog here
  // would be more annoying than just honouring the obvious intent.
  if (from && to && dayStart(from) > dayEnd(to)) { const t = from; from = to; to = t; }
  DATE_FROM = from;
  DATE_TO = to;
  dFrom = from;
  dTo = to;
  dDirty = false;
  fillDateInputs();
  $("btnDate").classList.toggle("on", Boolean(DATE_FROM || DATE_TO));
  saveStored("gg2-datefrom", DATE_FROM);
  saveStored("gg2-dateto", DATE_TO);
  prefsSync({ "gg2-datefrom": DATE_FROM, "gg2-dateto": DATE_TO });
  setDateMenuOpen(false);
  updateSearchCount();
  render();
}
/* The panel is anchored under its trigger, but a 300 × 420px popover does not fit
 * on a phone in landscape, and the trigger moves when the header wraps. So it is
 * positioned explicitly (fixed coordinates, clamped into the viewport) instead of
 * relying on `right: 0; top: 32px`: below the trigger when there is room, above
 * it when there is not, and pinned with a scroll if neither side fits. */
function positionDateMenu() {
  const menu = $("dateMenu");
  if (!menu.classList.contains("show")) return;
  const trigger = $("btnDate").getBoundingClientRect();
  menu.style.right = "auto";
  menu.style.maxHeight = "";
  menu.style.overflowY = "";
  const pad = 8;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  // Horizontal: right-align with the trigger, then clamp into the viewport.
  const left = Math.min(Math.max(trigger.right - w, pad), Math.max(pad, innerWidth - pad - w));
  const roomBelow = innerHeight - trigger.bottom - 6 - pad;
  const roomAbove = trigger.top - 6 - pad;
  let top;
  if (h <= roomBelow) top = trigger.bottom + 6;
  else if (h <= roomAbove) top = trigger.top - 6 - h;
  else if (h <= innerHeight - 2 * pad) top = Math.max(pad, Math.min(trigger.bottom + 6, innerHeight - pad - h));
  else {
    // Taller than the viewport (very short window): pin to the top and scroll.
    top = pad;
    menu.style.maxHeight = (innerHeight - 2 * pad) + "px";
    menu.style.overflowY = "auto";
  }
  menu.style.left = Math.round(left) + "px";
  menu.style.top = Math.round(top) + "px";
}
/* The date panel's `show` flag is mirrored onto the trigger's aria-expanded so
 * the panel's state is not colour-only. Every open/close path goes through
 * these two helpers — there used to be six bare classList calls, which is how
 * aria-expanded would have drifted out of sync. */
function setDateMenuOpen(open) {
  $("dateMenu").classList.toggle("show", open);
  $("btnDate").setAttribute("aria-expanded", open ? "true" : "false");
}
$("btnDate").addEventListener("click", (ev) => {
  ev.stopPropagation();
  const wasOpen = $("dateMenu").classList.contains("show");
  if (wasOpen) {
    // Closing without applying must not silently keep the draft: the chips
    // would show dates the list is not filtered by.
    if (dDirty) applyDateRange(); else setDateMenuOpen(false);
    return;
  }
  openDateDraft();
  setDateMenuOpen(true);
  positionDateMenu();
});
$("dateMenu").addEventListener("click", (ev) => ev.stopPropagation());
$("dateApply").addEventListener("click", () => {
  if (dDirty) applyDateRange(); else setDateMenuOpen(false);
});
$("dateClear").addEventListener("click", () => {
  dFrom = "";
  dTo = "";
  dEnd = "from";
  dDirty = Boolean(DATE_FROM || DATE_TO);
  syncDateDraftUI();
  renderCalendar();
  if (dDirty) applyDateRange(); else setDateMenuOpen(false);
});
$("dateFromChip").addEventListener("click", () => setDateEnd("from"));
$("dateToChip").addEventListener("click", () => setDateEnd("to"));
$("dmPrev").addEventListener("click", () => shiftMonth(-1));
$("dmNext").addEventListener("click", () => shiftMonth(1));
$("dmPrevY").addEventListener("click", () => shiftMonth(-12));
$("dmNextY").addEventListener("click", () => shiftMonth(12));
$("dmToday").addEventListener("click", () => {
  const d = new Date();
  dView = { y: d.getFullYear(), m: d.getMonth() };
  pickDay(ymdLocal(d));
});
$("dmGrid").addEventListener("click", (ev) => {
  const b = ev.target.closest(".dm-day");
  if (b) pickDay(b.dataset.ymd);
});
/* Arrow keys inside the grid move the focus (and the visible month when they
 * cross its edge) without picking a date — the same contract as a native
 * calendar. Picking stays on click/Enter/Space. */
$("dmGrid").addEventListener("keydown", (ev) => {
  const cur = ev.target.closest(".dm-day");
  if (!cur) return;
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[ev.key];
  if (step === undefined) return;
  ev.preventDefault();
  const base = ev.target.dataset.ymd;
  const [y0, m0, d0] = base.split("-").map(Number);
  const next = new Date(y0, m0 - 1, d0 + step);
  if (next.getFullYear() !== dView.y || next.getMonth() !== dView.m) {
    dView = { y: next.getFullYear(), m: next.getMonth() };
    renderCalendar();
  }
  const ymd = ymdLocal(next);
  const el = $("dmGrid").querySelector(`[data-ymd="${ymd}"]`);
  if (el) { for (const b of $("dmGrid").querySelectorAll(".dm-day")) b.tabIndex = -1; el.tabIndex = 0; el.focus(); }
});
/* Relative presets fill BOTH ends, so they go straight through the draft and
 * need an explicit apply — the user still confirms, and the "swap reversed
 * range" logic stays in one place (applyDateRange). They use ymdLocal (defined
 * above) so the arithmetic stays on the local calendar: never toISOString(),
 * which is UTC and would be a day off east of Greenwich late in the evening. */
for (const qb of document.querySelectorAll("#dateMenu .dm-quick button")) {
  qb.addEventListener("click", () => {
    const days = Number(qb.dataset.days) || 0;
    if (!days) return;
    const today = new Date();
    const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
    dFrom = ymdLocal(from);
    dTo = ymdLocal(today);
    dDirty = true;
    dView = { y: today.getFullYear(), m: today.getMonth() };
    dEnd = "from";
    syncDateDraftUI();
    renderCalendar();
  });
}
/* ---- outside-click dismissal for every popover -----------------------------
 * ONE listener, registered in the CAPTURE phase, on purpose.
 *
 * It used to be three separate bubble-phase `click` handlers (filter menu, wd
 * group menu, date panel) each doing `if (!ev.target.closest(...)) close()`.
 * Those never fired for a large part of the page, because the things the user
 * actually clicks next — a commit row, a branch group header, the "全部暂存"
 * button — call ev.stopPropagation() so their own click cannot be double-handled
 * by an ancestor. stopPropagation (unlike stopImmediatePropagation on the same
 * element) stops the event on its way UP, but capture runs on the way DOWN, from
 * window inward, before any row handler exists on the path. So the popover is
 * dismissed first, and the row still gets its click afterwards.
 *
 * Verified failure before this change (real Chrome, real commit rows):
 *   open branch filter -> click a commit row   => menu stayed open
 *   open date panel    -> click a commit row   => panel stayed open
 * Worse, in the date case the draft was applied LATER, at whatever unrelated
 * click happened to reach document first — the list re-filtered against dates
 * the user had already walked away from.
 *
 * The rule for "inside": a click counts as inside its popover when it lands in
 * the popover itself OR on its trigger. The trigger must count, otherwise
 * pressing the trigger to toggle the panel closed would first be closed by this
 * listener and then immediately re-opened by the trigger's own handler.
 *
 * Why pointerdown and not click: a `disabled` <button> dispatches NO mouse and
 * NO click event at all — it only gets pointer events. The wd panel toolbar
 * disables "全部暂存" / "提交" whenever the worktree has nothing in that state,
 * so with a clean tree a click on them is silently swallowed and the filter menu
 * stayed open (real case: 全部暂存 is `disabled` on a clean worktree and produced
 * zero events, verified by instrumenting mousedown/mouseup/click at window
 * capture — the log stayed empty). pointerdown fires on disabled controls, and
 * dismissing on it is also the earlier, less surprising moment: the popover is
 * gone by the time the target reacts.
 *
 * pointerdown is paired with a click listener, because a keyboard-activated
 * click (Enter on a focused button) produces no pointerdown. No de-duplication
 * flag is needed for the menus: every branch is guarded by its own `.show`
 * class, so the second event finds nothing open and does nothing.
 *
 * The date draft is the one place where the two phases must behave differently,
 * and it is NOT a detail — it is a regression that was caught by testing:
 * committing the draft re-renders the commit list. If that happens during
 * pointerdown, every `.cl-row` is destroyed before mouseup, so mouseup lands on
 * a detached node, no click is synthesised, and the commit the user pressed is
 * silently NOT selected (measured: SELECTED stayed null and the detail panel
 * never opened). Scheduling the commit with setTimeout(0) from pointerdown is
 * just as broken: the timer runs before mouseup, so it has the same effect.
 *
 * What does work is committing during the CLICK phase: the event path is fixed
 * at dispatch time, so a row removed by the re-render still receives the click
 * that is already in flight (measured: the row's own listener ran, SELECTED was
 * correct). Hence:
 *   - pointerdown: close the panel, remember that a commit is owed;
 *   - click:       commit it (this also covers keyboard activation, where the
 *                  panel is still open because no pointer sequence ran);
 *   - pointerup:   fallback for a press-drag-release that never produces a
 *                  click, scheduled a tick later so a real click wins first.
 * The filter and wd menus only toggle a class, so they close on pointerdown —
 * the earlier moment, which also means they are gone before the target reacts. */
let dateDraftOwed = false;
function commitOwedDateDraft() {
  if (!dateDraftOwed) return;
  dateDraftOwed = false;
  if (dDirty) applyDateRange();
}
function dismissPopovers(ev, phase) {
  const t = ev.target;
  if (!(t instanceof Node)) return;

  if ($("filterMenu").classList.contains("show") && !t.closest(".filterWrap")) {
    setFilterMenuOpen(false);
  }
  const wdMenu = document.querySelector("#wdPanel .wd-menu.show");
  if (wdMenu && !t.closest(".wd-filterWrap")) setWdMenuOpen(wdMenu, false);
  if ($("dateMenu").classList.contains("show") && !t.closest(".dateWrap")) {
    // Closing by clicking outside keeps what the user picked: a draft that was
    // only ever visible in this panel would be lost silently otherwise.
    if (!dDirty) setDateMenuOpen(false);
    else if (phase === "click") applyDateRange();
    else { setDateMenuOpen(false); dateDraftOwed = true; }
  }
  if ($("ctxMenu").classList.contains("show") && !t.closest("#ctxMenu")) hideContextMenu();
}
window.addEventListener("pointerdown", (ev) => dismissPopovers(ev, "pointerdown"), true);
window.addEventListener("click", (ev) => { dismissPopovers(ev, "click"); commitOwedDateDraft(); }, true);
window.addEventListener("pointerup", () => { setTimeout(commitOwedDateDraft, 0); }, true);


/* ---- context menu ---- */
function openContextMenu(x, y, c) {
  const menu = $("ctxMenu");
  menu.innerHTML = "";
  const title = document.createElement("div");
  title.className = "cm-title";
  title.textContent = short7(c.hash) + "  " + (c.subject || "");
  menu.appendChild(title);
  const mk = (label, key, fn) => {
    const item = document.createElement("div");
    item.className = "cm-item";
    const txt = document.createElement("span");
    txt.textContent = label;
    item.appendChild(txt);
    if (key) {
      const k = document.createElement("span");
      k.className = "cm-key";
      k.textContent = key;
      item.appendChild(k);
    }
    item.addEventListener("click", () => { hideContextMenu(); fn(); });
    menu.appendChild(item);
  };
  mk("复制提交哈希", "Ctrl+C", () => {
    navigator.clipboard?.writeText(c.hash).catch(() => {});
  });
  mk("复制提交消息", "", () => {
    navigator.clipboard?.writeText(c.subject || "").catch(() => {});
  });
  mk("复制 哈希 + 消息", "", () => {
    navigator.clipboard?.writeText(c.hash + " " + (c.subject || "")).catch(() => {});
  });
  mk("查看详情 / diff", "Enter", () => {
    selectCommit(c.hash);
  });
  mk("🏷️ 打标签…", "", () => openTagDlg(c.hash));
  mk("🌿 从此提交新建分支…", "", () => openBranchDlg(c.hash));
  mk("🌐 打开 GitHub 提交页", "", () => openGithubCommit(c.hash));
  mk("复制仓库路径", "", () => {
    navigator.clipboard?.writeText(REPO || "").catch(() => {});
  });
  mk("在文件管理器中打开", "", () => {
    api("reveal").catch(() => {});
  });
  menu.classList.add("show");
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 10) + "px";
  menu.style.top = Math.min(y, window.innerHeight - r.height - 10) + "px";
}
function hideContextMenu() {
  $("ctxMenu").classList.remove("show");
}
/* No `click` listener here: the context menu is dismissed by the single
 * capture-phase dismissPopovers() listener, for the same reason the other
 * popovers are. `blur` stays — leaving the window with a menu pinned to the
 * viewport should still close it, and blur does not bubble. */
window.addEventListener("blur", hideContextMenu);

/* ---- branch-group context menu: switch / push / delete / fetch ---- */
function openBranchCtxMenu(x, y, r) {
  const menu = $("ctxMenu");
  menu.innerHTML = "";
  const title = document.createElement("div");
  title.className = "cm-title";
  title.textContent = r.name;
  menu.appendChild(title);
  const mk = (label, key, fn) => {
    const item = document.createElement("div");
    item.className = "cm-item";
    const txt = document.createElement("span");
    txt.textContent = label;
    item.appendChild(txt);
    if (key) {
      const k = document.createElement("span");
      k.className = "cm-key";
      k.textContent = key;
      item.appendChild(k);
    }
    item.addEventListener("click", () => { hideContextMenu(); fn(); });
    menu.appendChild(item);
  };
  const isRemote = r.refname.startsWith("refs/remotes/");
  const branchName = isRemote
    ? r.refname.replace(/^refs\/remotes\/[^/]+\//, "")
    : r.refname.replace(/^refs\/heads\//, "");
  if (isRemote) {
    mk("⬇ 拉取远程更新", "", () => runFetch());
    mk("复制远程分支名", "", () => {
      navigator.clipboard?.writeText(r.refname.replace(/^refs\/remotes\//, "")).catch(() => {});
    });
  } else {
    mk("🔄 切换到该分支", "", () => checkoutBranch(branchName));
    mk("⬆ 推送该分支", "", () => pushBranch(branchName));
    mk("🗑️ 删除该分支", "", () => deleteBranch(branchName, !!r.head));
  }
  menu.classList.add("show");
  const rr = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rr.width - 10) + "px";
  menu.style.top = Math.min(y, window.innerHeight - rr.height - 10) + "px";
}

async function runFetch() {
  const res = await api("gitop", { action: "fetch" });
  if (!res.ok) { alert("拉取失败: " + (res.error || "?")); return; }
  await reloadGraphLight();
  refreshWorkdir();
}

async function checkoutBranch(name) {
  const ws = WORKSTATUS;
  if (ws && (ws.counts.staged || ws.counts.unstaged || ws.counts.untracked)) {
    const ok = await confirmDialog(
      "切换分支",
      "当前有<b>未提交的改动</b>，切换分支可能导致这些改动被带入或冲突。确定切换到 <b>" + escHtml(name) + "</b> 吗？",
      false, "确认切换"
    );
    if (!ok) return;
  }
  const res = await api("gitop", { action: "checkout", name });
  if (!res.ok) { alert("切换失败: " + (res.error || "?")); return; }
  await reloadGraphLight();
  refreshWorkdir();
}

async function pushBranch(name) {
  const ok = await confirmDialog(
    "推送分支",
    "将把本地分支 <b>" + escHtml(name) + "</b> 推送到 <b>origin</b>（会影响云端仓库，请确认）：",
    false, "确认推送"
  );
  if (!ok) return;
  const res = await api("gitop", { action: "push", branch: name });
  if (!res.ok) { alert("推送失败: " + (res.error || "?")); return; }
  alert(res.summary || "推送成功");
}

async function deleteBranch(name, isHead) {
  if (isHead) { alert("不能删除当前所在的 HEAD 分支"); return; }
  const ok = await confirmDialog(
    "删除分支",
    "确定删除本地分支 <b>" + escHtml(name) + "</b>？（已合并的分支可删除；未合并的会失败）",
    true, "确认删除"
  );
  if (!ok) return;
  const res = await api("gitop", { action: "delete-branch", name });
  if (!res.ok) { alert("删除失败: " + (res.error || "?")); return; }
  await reloadGraphLight();
  refreshWorkdir();
}

/* ---- tag dialog: create / rename / delete tags on one commit ---- */
function openTagDlg(hash) {
  return new Promise((resolve) => {
    const d = $("tagDlg");
    const body = $("tagDlgBody");
    body.innerHTML = "";
    const p = document.createElement("div");
    p.innerHTML = "给提交 <b>" + short7(hash) + "</b> 创建或管理轻量标签（不会推送到远程）：";
    body.appendChild(p);
    // existing tags on this commit
    const commit = COMMITS.find((c) => c.hash === hash);
    const myTags = (commit && Array.isArray(commit.refs) ? commit.refs : [])
      .filter((r) => r.kind === "tag").map((r) => r.name);
    const tagList = document.createElement("div");
    tagList.className = "tag-list";
    const rerenderTags = () => {
      tagList.innerHTML = "";
      if (!myTags.length) {
        const none = document.createElement("div");
        none.className = "tag-none";
        none.textContent = "该提交暂无标签";
        tagList.appendChild(none);
        return;
      }
      for (const t of myTags) {
        const row = document.createElement("div");
        row.className = "tag-row";
        const nm = document.createElement("span");
        nm.className = "tag-name";
        nm.textContent = t;
        row.appendChild(nm);
        const btns = document.createElement("span");
        btns.className = "tag-acts";
        const mkBtn = (label, title, fn) => {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = label;
          b.title = title;
          b.addEventListener("click", fn);
          btns.appendChild(b);
        };
        mkBtn("✎", "改名", () => {
          input.value = t;
          renameHint.textContent = "正在给 「" + t + "」 改名，输入新名字后点「改名」或回车";
          renameHint.style.display = "";
          renaming = t;
          $("tagDlgOk").textContent = "改名";
          input.focus();
        });
        mkBtn("✕", "删除", () => {
          const safe = escHtml(t);
          confirmDialog("删除标签", "确定删除标签 <b>" + safe + "</b>？（仅删除本地标签，不会推送远程）", true, "确认删除").then((ok) => {
            if (!ok) return;
            api("gitop", { action: "tag-delete", name: t }).then((res) => {
              if (!res.ok) { alert("删除标签失败: " + (res.error || "?")); return; }
              const i = myTags.indexOf(t);
              if (i >= 0) myTags.splice(i, 1);
              rerenderTags();
              wdDiffCache.clear();
              reloadGraphLight();
            });
          });
        });
        row.appendChild(btns);
        tagList.appendChild(row);
      }
    };
    body.appendChild(tagList);
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "新标签名，例如 v1.0.0 / 正式版";
    input.style.cssText = "width:100%;margin-top:10px;padding:8px 10px;border:1px solid var(--border);border-radius:7px;background:var(--bg);color:var(--text);font-size:12.5px;outline:none";
    body.appendChild(input);
    const renameHint = document.createElement("div");
    renameHint.className = "tag-rename-hint";
    renameHint.style.display = "none";
    body.appendChild(renameHint);
    let renaming = null;
    rerenderTags();
    const finish = (v) => {
      d.classList.remove("show");
      $("tagDlgOk").onclick = null;
      $("tagDlgCancel").onclick = null;
      resolve(v);
    };
    const doOk = async () => {
      const val = input.value.trim();
      if (!val) {
        input.style.borderColor = "var(--red)";
        input.focus();
        return;
      }
      const res = renaming
        ? await api("gitop", { action: "tag-rename", name: renaming, newname: val, hash })
        : await api("gitop", { action: "tag", name: val, hash });
      if (!res.ok) { alert((renaming ? "改名失败" : "打标签失败") + ": " + (res.error || "?")); return; }
      if (renaming) {
        const i = myTags.indexOf(renaming);
        if (i >= 0) myTags[i] = val;
        renaming = null;
        renameHint.style.display = "none";
        input.value = "";
        $("tagDlgOk").textContent = "创建标签";
        rerenderTags();
        wdDiffCache.clear();
        reloadGraphLight();
      } else {
        finish(true);
        wdDiffCache.clear();
        await reloadGraphLight();
      }
    };
    $("tagDlgOk").onclick = doOk;
    $("tagDlgOk").textContent = "创建标签";
    $("tagDlgCancel").onclick = () => finish(false);
    d.classList.add("show");
    input.focus();
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && input.value.trim()) doOk();
    });
  });
}
$("tagDlg").addEventListener("click", (ev) => { if (ev.target === $("tagDlg")) $("tagDlgCancel").click(); });

/* ---- branch dialog (write: lightweight branch from commit) ---- */
function openBranchDlg(hash) {
  return new Promise((resolve) => {
    const d = $("branchDlg");
    const body = $("branchDlgBody");
    body.innerHTML = "";
    const p = document.createElement("div");
    p.innerHTML = "在提交 <b>" + short7(hash) + "</b> 处创建一个新分支（不会切换、不会推送远程）：";
    body.appendChild(p);
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "分支名，例如 feature/login";
    input.style.cssText = "width:100%;margin-top:10px;padding:8px 10px;border:1px solid var(--border);border-radius:7px;background:var(--bg);color:var(--text);font-size:12.5px;outline:none";
    body.appendChild(input);
    const finish = (v) => {
      d.classList.remove("show");
      $("branchDlgOk").onclick = null;
      $("branchDlgCancel").onclick = null;
      resolve(v);
    };
    $("branchDlgOk").onclick = async () => {
      if (!input.value.trim()) {
        input.style.borderColor = "var(--red)";
        input.focus();
        return;
      }
      finish(true);
      const res = await api("gitop", { action: "branch", name: input.value.trim(), hash });
      if (!res.ok) { alert("创建分支失败: " + (res.error || "?")); return; }
      wdDiffCache.clear();
      await reloadGraphLight();
    };
    $("branchDlgCancel").onclick = () => finish(false);
    d.classList.add("show");
    input.focus();
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && input.value.trim()) $("branchDlgOk").click();
    });
  });
}
$("branchDlg").addEventListener("click", (ev) => { if (ev.target === $("branchDlg")) $("branchDlgCancel").click(); });

/* ---- open commit page on GitHub (via origin remote URL) ---- */
async function openGithubCommit(hash) {
  const res = await api("remoteinfo");
  if (!res.ok || !res.web) { alert("未配置远程仓库（origin），无法打开 GitHub 提交页"); return; }
  window.open(res.web + "/commit/" + hash, "_blank");
}

/* ---- shortcut panel (Ctrl+/) ---- */
const SHORTCUTS = [
  ["↑ / ↓ 或 j / k", "从当前选中（含鼠标点选的）向上/下切换提交，并同步打开详情"],
  ["鼠标点击", "选中提交、打开详情；之后 ↑/↓ 从这里继续"],
  ["Enter", "重新打开当前选中提交的详情（方向键已自动打开，按习惯保留）"],
  ["Ctrl+C", "复制提交哈希"],
  ["Esc", "关闭弹窗 / 详情面板"],
  ["Ctrl+/", "打开 / 关闭本快捷键面板"],
  ["Ctrl+F", "聚焦搜索框"],
  ["Ctrl+B", "折叠 / 展开分支分组"],
  ["拖动详情分隔条", "调整提交详情面板宽度（双击恢复默认）"],
  ["双击提交", "复制提交哈希"],
];
function fillShortcuts() {
  const box = $("shortcutDlgBody");
  if (box.dataset.filled) return;
  box.dataset.filled = "1";
  for (const [key, desc] of SHORTCUTS) {
    const row = document.createElement("div");
    row.className = "sc-row";
    const k = document.createElement("span");
    k.className = "sc-key";
    k.textContent = key;
    const d = document.createElement("span");
    d.textContent = desc;
    row.appendChild(k);
    row.appendChild(d);
    box.appendChild(row);
  }
}
function toggleShortcutDlg(force) {
  const d = $("shortcutDlg");
  const show = force !== undefined ? force : !d.classList.contains("show");
  if (show) fillShortcuts();
  d.classList.toggle("show", show);
}
$("shortcutDlgClose").addEventListener("click", () => toggleShortcutDlg(false));
$("shortcutDlg").addEventListener("click", (ev) => { if (ev.target === $("shortcutDlg")) toggleShortcutDlg(false); });

/* ---- scroll-driven pagination ------------------------------------------------
 * #graphWrap is the scroll container (it has overflow:auto), so the listener goes
 * there — a window scroll listener would never fire inside the plugin iframe.
 * maybeAutoLoad() is throttled through requestAnimationFrame so a fast scroll
 * cannot queue multiple pages. */
$("graphWrap").addEventListener("scroll", maybeAutoLoad, { passive: true });

/* ---- release the response cache when the plugin closes ---------------------
 * The cache lives in plain Maps owned by this document, so tearing the frame
 * down (tab close, page reload, plugin unmount) already frees it. `pagehide`
 * is fired for both unload and bfcache transitions; clearing here also matters
 * for the bfcache case, where the Maps would otherwise be resurrected with the
 * page and could hold data from a since-changed repository. */
window.addEventListener("pagehide", clearResponseCache);
window.addEventListener("beforeunload", clearResponseCache);

/* ---- auto refresh: poll workstatus + head while the page is visible ---- */
let AUTO_REFRESHING = false;
/* Last ref-tip signature seen by the auto-refresh tick. null = not sampled yet.
 * Reset to null after a full reload so the next tick just re-baselines. */
let REFS_SIG = null;
/* Does this server understand the `head` op? Detected once, so a not-yet-restarted
 * host falls back to the old graph probe instead of 400-ing on every tick. */
let HEAD_OP_OK = true;
/* Pre-`head` change probe (kept for hosts that have not been restarted yet). */
async function pollGraphFallback() {
  const lg = await api("graph", { limit: 1, skip: 0 });
  if (lg.ok && lg.commits && lg.commits.length) {
    const newest = lg.commits[0].hash;
    const old = COMMITS.length ? COMMITS[0].hash : null;
    if (newest !== old || (lg.total || 0) !== TOTAL) await reloadGraphLight();
  }
}
async function autoRefreshTick() {
  if (document.hidden) return;            // only refresh when the tab is visible
  if (AUTO_REFRESHING) return;
  if (!REPO) return;                      // empty state: no repo to poll (avoids 400 noise)
  AUTO_REFRESHING = true;
  try {
    // Working tree changes (cheap).
    const ws = await api("workstatus");
    if (ws.ok && workstatusSig(ws) !== WD_SIG) {
      // Reuse the response we just fetched instead of calling refreshWorkdir(),
      // which issued a second identical workstatus request (and a second git
      // process) on every detected change.
      applyWorkstatus(ws, true);
    }
    // New commits / branch moves: compare a lightweight ref-tip signature.
    // The old code called graph {limit:1, skip:0}, which still ran three git
    // processes (symbolic-ref + rev-list --count + log) — ~670ms per tick.
    // The `head` op answers the same question with a single for-each-ref.
    // A stale server (plugin not restarted yet) answers unknown-op; remember
    // that once and fall back, rather than 400-ing on every tick.
    if (HEAD_OP_OK) {
      const g = await api("head");
      if (g.ok) {
        const sig = g.sig || "";
        if (REFS_SIG === null) {
          REFS_SIG = sig;                     // first tick: just remember baseline
        } else if (sig !== REFS_SIG) {
          REFS_SIG = sig;
          await reloadGraphLight();
        }
      } else if (g.error === "unknown-op") {
        HEAD_OP_OK = false;                   // old host: stop asking, use the fallback
        await pollGraphFallback();
      }
    } else {
      await pollGraphFallback();
    }
  } catch { /* ignore transient failures */ }
  finally { AUTO_REFRESHING = false; }
}
setInterval(autoRefreshTick, 5000);
/* Separate cadence: following the session's working copy is a different concern
 * from refreshing the current repo, and it must not be blocked by the
 * auto-refresh guard (a reload in flight would otherwise starve it). */
setInterval(checkSessionWorkspace, 3000);

/* ---- keyboard navigation ----
 * The list is read back from the DOM rather than recomputed from buildRows().
 * buildRows() only knows about branch folding; render() additionally drops rows
 * via passesFilters() and the legend highlight. Recomputing here meant the
 * cursor could be moved onto a commit that had no row on screen (search filter
 * active, or a branch highlighted via the legend) — the arrow key appeared to
 * do nothing, or jumped two commits at once. Whatever is in the DOM *is* what
 * the user can see and step through. */
function kbdVisibleList() {
  return [...$("commitList").querySelectorAll(".cl-row")].map((el) => el.dataset.hash);
}
window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    if ($("pickdirDlg").classList.contains("show")) { $("pdClose").click(); return; }
    if ($("dateMenu").classList.contains("show")) {
      // Escape discards the draft instead of applying it — the one place a
      // half-made range (a start with no end) can be abandoned.
      setDateMenuOpen(false);
      fillDateInputs();
      return;
    }
    // The two dropdowns had no Escape path at all: once open, only a mouse
    // click could dismiss them, so a keyboard user was stuck with the panel
    // covering the list (the date panel owns the arrow keys while open).
    if ($("filterMenu").classList.contains("show")) { setFilterMenuOpen(false); return; }
    const openWd = document.querySelector("#wdPanel .wd-menu.show");
    if (openWd) { setWdMenuOpen(openWd, false); return; }
    if ($("settingsDlg").classList.contains("show")) { toggleSettings(false); return; }
    if ($("shortcutDlg").classList.contains("show")) { toggleShortcutDlg(false); return; }
    if ($("ggDlg").classList.contains("show")) { $("ggDlgCancel").click(); return; }
    if ($("commitDlg").classList.contains("show")) { $("commitDlgCancel").click(); return; }
    if ($("tagDlg").classList.contains("show")) { $("tagDlgCancel").click(); return; }
    if ($("branchDlg").classList.contains("show")) { $("branchDlgCancel").click(); return; }
    if ($("ctxMenu").classList.contains("show")) { hideContextMenu(); return; }
    if ($("detail").classList.contains("open")) { $("dClose").click(); return; }
  }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target && ev.target.tagName || "");
  // Ctrl+/ stays live inside a modal — it is the documented way to toggle the
  // shortcut panel, and that panel IS a modal.
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key === "/") {
    ev.preventDefault();
    toggleSettings(false);
    toggleShortcutDlg();
    return;
  }
  // A modal owns the keyboard: without this, ↑/↓ would scroll the commit list
  // and open commit details behind the settings dialog while the user is only
  // trying to reach its buttons.
  if ($("settingsDlg").classList.contains("show") || $("shortcutDlg").classList.contains("show")) return;
  // The date popover owns the arrow keys while it is open: the grid has its own
  // handler, and without this the same ↑/↓ would also step the commit selection
  // behind the panel (the list is still visible next to it).
  if ($("dateMenu").classList.contains("show")) return;
  // Ctrl+ shortcuts (global; not while typing in an input)
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey) {
    if (!typing) {
      if (ev.key === "f" || ev.key === "F") {
        ev.preventDefault();
        const sb = $("searchBox");
        if (sb) { sb.focus(); sb.select(); }
        return;
      }
      if (ev.key === "b" || ev.key === "B") {
        ev.preventDefault();
        toggleBranchGroups();
        return;
      }
    }
  }
  // skip when typing in the search box
  if (ev.target === $("searchBox")) return;
  const list = kbdVisibleList();
  if (!list.length) return;
  // Arrow keys move AND open the commit in one step. A cursor that only moved a
  // dashed outline forced a pointless Enter — in a history browser the thing you
  // are stepping through is the detail, not a selection to be confirmed.
  //
  // The step always starts from SELECTED, which the mouse writes too. Clicking
  // row 5 and pressing ↓ now lands on row 6, whatever the list length is and
  // whether or not a filter is active. `list.indexOf` may return -1 (the
  // selected commit is not currently rendered — filtered out, inside a
  // collapsed branch, or beyond the loaded page); in that case ↓ starts at the
  // top and ↑ at the bottom, so the key always produces a visible move rather
  // than doing nothing.
  //
  // selectCommit() renders and scrolls, so no render() call is needed here.
  const cur = SELECTED === null ? -1 : list.indexOf(SELECTED);
  if (ev.key === "ArrowDown" || ev.key === "j") {
    ev.preventDefault();
    const i = cur < 0 ? 0 : Math.min(list.length - 1, cur + 1);
    selectCommit(list[i], true);
  } else if (ev.key === "ArrowUp" || ev.key === "k") {
    ev.preventDefault();
    const i = cur < 0 ? list.length - 1 : Math.max(0, cur - 1);
    selectCommit(list[i], true);
  } else if (ev.key === "Enter") {
    // Kept as a no-op confirmation of the current row: harmless, and some people
    // still press it out of habit after arriving with the mouse.
    if (SELECTED) {
      ev.preventDefault();
      selectCommit(SELECTED);
    }
  }
});
window.addEventListener("dblclick", (ev) => {
  const node = ev.target.closest && ev.target.closest(".gg-node");
  if (!node) return;
  const hash = node.dataset.hash;
  navigator.clipboard?.writeText(hash).catch(() => {});
});

/* Reflect the restored date filter in the UI before the first paint, so a saved
 * range is visible (button highlighted, inputs filled) rather than silent. */
fillDateInputs();
$("btnDate").classList.toggle("on", Boolean(DATE_FROM || DATE_TO));
syncFlatBtn();
followParentTheme();
applyTheme();
/* Prove the stylesheet really applied before dropping the boot-failure notice.
 * That notice covers one specific mismatch: index.html is read from disk on
 * every request, but the routes for app.css/app.js only exist in the newer
 * index.js — so after an update and before a restart both assets 404 and the
 * page shows an unstyled, inert skeleton. Testing a computed value is the only
 * honest check: `document.styleSheets.length` also counts a sheet that failed
 * to parse, and a 404 HTML body can get counted as a sheet by some browsers. */
(function clearBootNotice() {
  /* Read a sentinel that only app.css defines. Testing colours was wrong: the
     gradient themes set --bg to a gradient on <html>, so <body> stays
     transparent there and every colour-based probe concluded "no stylesheet"
     — which made this notice appear on perfectly healthy loads in 8 of the 11
     themes. A custom property is either defined by the sheet or it is not. */
  const ready = getComputedStyle(document.documentElement)
    .getPropertyValue("--gg-page-ready").trim();
  const notice = $("bootFail");
  if (ready === "1") {
    if (notice) notice.remove();
    return;
  }
  /* Stylesheet missing: keep the notice, it is the entire message to the user.
   * It also needs re-pinning. The rule that makes it `position: fixed` lives in
   * that same missing stylesheet, so here it sits in normal flow — and this
   * script still runs the app, whose selectCommit()/detail scrolling carries the
   * notice off-screen (measured: scrollY 2312, notice top -2304, invisible).
   * Re-pin it through CSSOM: a `style` *attribute* would be blocked by
   * `style-src 'self'`, but CSSOM writes are not subject to that directive. */
  if (!notice) return;
  Object.assign(notice.style, {
    position: "fixed", top: "12px", left: "12px", right: "12px",
    zIndex: "2147483647", opacity: "1", margin: "0",
    padding: "14px 16px", borderRadius: "8px", boxSizing: "border-box",
    background: "#fffbe6", color: "#1c2430", border: "1px solid #d29922",
  });
})();
load();