import { connect, resolveUrl, listTopics, listServices, listActions } from "./ros.js";
import { $, esc } from "./util.js";
import { renderTree, hasDepth } from "./grouping.js";
import * as topics from "./panel-topics.js";
import * as services from "./panel-services.js";
import * as params from "./panel-params.js";
import * as actions from "./panel-actions.js";
import * as tf from "./panel-tf.js";

const STATUS_LABEL = {
  connecting: "连接中…", reconnecting: "重连中…", open: "已连接",
  closed: "已断开", error: "连接错误",
};

const els = {
  dot: $("statusDot"), statusText: $("statusText"),
  url: $("urlInput"), connect: $("connectBtn"), disconnect: $("disconnectBtn"),
  tabs: $("tabs"), filter: $("filter"), list: $("list"), groupToggle: $("groupToggle"),
  cntTopics: $("cntTopics"), cntServices: $("cntServices"), cntActions: $("cntActions"),
  viewTitle: $("viewTitle"), meta: $("meta"), content: $("content"), viewActions: $("viewActions"),
};

let link = null;
let activeTab = "topics";
let selected = null;     // 当前选中项
let cache = { topics: [], services: [], actions: [], nodes: [] };
let servicesFull = [];   // 原始服务对象（含 request schema），用于表单生成

/** 分组模式开关，以及各页签的展开状态（跨重绘保留） */
let grouped = localStorage.getItem("ros.grouped") !== "0";
const expanded = {
  topics: new Set(),
  services: new Set(),
  actions: new Set(),
};

const ctx = {
  get ros() { return link?.current; },
  listTopics: () => cache.topics,
  findService: (name) => servicesFull.find((s) => s.name === name),
};

/* ── 状态栏 ── */
function setStatus({ state, detail }) {
  els.dot.className = `dot ${state}`;
  const label = STATUS_LABEL[state] ?? state;
  els.statusText.textContent = detail ? `${label} · ${detail}` : label;
  els.disconnect.disabled = state !== "open";
  els.connect.disabled = state === "connecting" || state === "reconnecting";
}

/* ── 连接 ── */
function start(url) {
  link?.close();
  selected = null;
  cache = { topics: [], services: [], actions: [], nodes: [] };
  servicesFull = [];
  params.resetParamCache();
  localStorage.setItem("ros.url", url);
  els.url.value = url;
  els.list.innerHTML = `<p class="empty">连接中…</p>`;
  updateCounts();

  link = connect(url, setStatus);
  const ros = link.current;
  if (ros) {
    ros.on("channelsChanged", () => { refreshTopics(); refreshServices(); });
    ros.on("servicesChanged", () => { refreshServices(); refreshActions(); });
    ros.on("connection", () => setTimeout(() => { refreshAll(); }, 400));
  }
  setTimeout(refreshAll, 900);
  setTimeout(refreshAll, 2200);
}

function refreshAll() {
  refreshTopics();
  refreshServices();
  refreshActions();
}

function refreshTopics() {
  if (!ctx.ros) return;
  const next = listTopics(ctx.ros);
  if (!changed(next, cache.topics)) return;
  cache.topics = next;
  updateCounts();
  if (activeTab === "topics") renderList();
}

function refreshServices() {
  if (!ctx.ros) return;
  servicesFull = listServicesRaw(ctx.ros);
  const next = servicesFull.map((s) => ({ name: s.name, type: s.type }));
  if (!changed(next, cache.services)) return;
  cache.services = next;
  cache.nodes = params.discoverNodes(next);
  updateCounts();
  if (activeTab === "services" || activeTab === "params") renderList();
}

function refreshActions() {
  if (!ctx.ros) return;
  const next = listActions(ctx.ros);
  cache.actions = next;
  updateCounts();
  if (activeTab === "actions") renderList();
}

function listServicesRaw(ros) {
  const out = [];
  for (const [name, s] of ros.servicesByName ?? new Map()) {
    out.push({ name, type: s?.type ?? "", request: s?.request, response: s?.response });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function changed(a, b) {
  return a.length !== b.length || a.some((x, i) => x.name !== b[i]?.name);
}

function updateCounts() {
  els.cntTopics.textContent = String(cache.topics.length);
  els.cntServices.textContent = String(cache.services.length);
  els.cntActions.textContent = String(cache.actions.length);
}

/* ── 列表渲染 ── */
function renderList() {
  const q = els.filter.value.trim().toLowerCase();
  const match = (r) => !q || r.name.toLowerCase().includes(q) || (r.type || "").toLowerCase().includes(q);

  if (activeTab === "params") {
    renderParamList(q);
    return;
  }
  if (activeTab === "tf") {
    tf.mountTf();
    return;
  }

  // 构造 { name, type, active, data } 行
  let rows = [];
  if (activeTab === "topics") {
    rows = cache.topics.map((t) => topics.topicListItem(t, t.name === selected?.name));
  } else if (activeTab === "services") {
    rows = cache.services.map((s) => services.serviceListItem(s, s.name === selected?.name));
  } else if (activeTab === "actions") {
    rows = cache.actions.map((a) => actions.actionListItem(a, a.name === selected?.name));
  }

  rows = rows.filter(match);

  if (!rows.length) {
    const connected = els.dot.classList.contains("open");
    els.list.innerHTML = `<p class="empty">${connected ? (q ? "无匹配项" : "该 bridge 未广播任何条目") : "连接后加载"}</p>`;
    return;
  }

  const mkItem = (r) => {
    const btn = document.createElement("button");
    btn.className = "item" + (r.active ? " active" : "");
    const n = document.createElement("span");
    n.className = "name";
    n.textContent = r.name;
    const t = document.createElement("span");
    t.className = "type";
    t.textContent = r.type || "";
    btn.append(n, t);
    if (r.type) btn.title = r.type;
    btn.addEventListener("click", () => pick(r.data));
    return btn;
  };

  // 平铺模式，或条目太少/太浅不值得分组
  if (!grouped || rows.length < 20 || !hasDepth(rows, (r) => r.name)) {
    const frag = document.createDocumentFragment();
    for (const r of rows) frag.appendChild(mkItem(r));
    els.list.replaceChildren(frag);
    return;
  }

  // 分组模式：按命名空间逐层钻取
  // 筛选时强制全展开，否则命中的条目会藏在折叠组里看不见
  renderTree(els.list, rows, {
    getName: (r) => r.name,
    renderItem: mkItem,
    openPaths: expanded[activeTab],
    forceExpand: Boolean(q),
    onToggle: renderList,
  });
}

/** 分组开关的可用性（TF/参数页签不用它） */
function updateGroupToggle() {
  const usable = activeTab === "topics" || activeTab === "services" || activeTab === "actions";
  els.groupToggle.style.display = usable ? "" : "none";
  els.groupToggle.classList.toggle("on", grouped);
  els.groupToggle.textContent = grouped ? "分组" : "平铺";
  els.groupToggle.title = grouped
    ? "当前：按第一层命名空间分组（点击切换为平铺）"
    : "当前：平铺显示（点击切换为分组）";
}

/* 参数列表交给 panel-params 自己渲染（含动态枚举） */
function renderParamList(q) {
  params.renderParamList(q);
}

/* ── 选中项分发 ── */
function pick(data) {
  selected = data;
  renderList();
  if (activeTab === "topics") topics.selectTopic(data);
  else if (activeTab === "services") services.selectService(data);
  else if (activeTab === "params") params.selectParam(data);
  else if (activeTab === "actions") actions.selectAction(data);
}

/* ── 标签切换 ── */
function switchTab(tab) {
  activeTab = tab;
  selected = null;
  els.filter.value = "";
  els.filter.placeholder = tab === "params" ? "筛选节点/参数…" : "筛选…";

  for (const b of els.tabs.querySelectorAll(".tab")) {
    b.classList.toggle("active", b.dataset.tab === tab);
  }

  // 卸载其他面板
  topics.unmountTopics();
  services.unmountServices();
  params.unmountParams();
  actions.unmountActions();
  if (tab !== "tf") tf.unmountTf();

  // 挂载目标面板
  topics.setTopicsVisible(tab === "topics");
  updateGroupToggle();
  if (tab === "tf") tf.mountTf();
  else renderList();
}

/* ── 事件绑定 ── */
els.connect.addEventListener("click", () => start(els.url.value.trim() || resolveUrl()));
els.disconnect.addEventListener("click", () => {
  link?.close();
  setStatus({ state: "closed", detail: "已手动断开" });
});
els.url.addEventListener("keydown", (e) => { if (e.key === "Enter") els.connect.click(); });
els.filter.addEventListener("input", renderList);
els.groupToggle.addEventListener("click", () => {
  grouped = !grouped;
  localStorage.setItem("ros.grouped", grouped ? "1" : "0");
  updateGroupToggle();
  renderList();
});
els.tabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (btn) switchTab(btn.dataset.tab);
});

/* ── 初始化 ── */
topics.initTopics(ctx);
services.initServices(ctx);
params.initParams(ctx);
actions.initActions(ctx);
tf.initTf(ctx);

// 参数面板需要反向调用 main 的渲染/选中逻辑
params.bindParamList({
  renderList: () => { if (activeTab === "params") renderList(); },
  onPick: (p) => pick(p),
  isOpen: () => els.dot.classList.contains("open"),
  getNodes: () => cache.nodes,
  getServiceType: (name) => servicesFull.find((s) => s.name === name)?.type ?? null,
  // 高亮判断统一走 main 的 selected，保证点击一次即刻生效
  isParamSelected: (node, name) => selected?.node === node && selected?.name === name,
});

els.url.value = resolveUrl();
updateGroupToggle();
start(els.url.value);

if (import.meta.env?.DEV) {
  window.__ctx = ctx;
  window.__cache = () => cache;
}
