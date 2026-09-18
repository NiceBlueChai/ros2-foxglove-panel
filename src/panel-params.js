/* 参数面板：按节点浏览参数，读取 / 写入 */

import { Param } from "foxglove-ros-adapter";
import { $, toJson, esc } from "./util.js";
import { callServiceOnce, normalizeRequestType } from "./service-call.js";

let ctx = null;
let active = null;      // { node, name }
let els = {};

export function initParams(context) {
  ctx = context;
  els.viewTitle = $("viewTitle");
  els.meta = $("meta");
  els.content = $("content");
  els.viewActions = $("viewActions");
  els.list = $("list");
}

/**
 * 从服务清单里推断出所有节点名。
 *
 * bridge 不提供节点列表接口，但每个 ROS 2 节点都会暴露 `<node>/get_parameters`
 * 这类参数服务，从服务名反推是可靠做法。
 *
 * 注意节点名可能是多级路径（如 `/at/camera_node`），所以用贪婪匹配到最后一个 `/`。
 */
const PARAM_SVC = /\/(get_parameters|set_parameters|list_parameters|describe_parameters|get_parameter_types)$/;

export function discoverNodes(services) {
  const nodes = new Set();
  for (const s of services) {
    if (!PARAM_SVC.test(s.name)) continue;
    const node = s.name.replace(PARAM_SVC, "");
    // 过滤掉 <node>/<sub> 这类更深层的参数服务（如 /node/sub/get_parameters）
    if (node) nodes.add(node);
  }
  return [...nodes].sort();
}

export function paramListItem(p, isActive) {
  return {
    name: p.label,
    type: p.type ?? "",
    active: isActive,
    data: p,
  };
}

export function unmountParams() {
  els.viewActions.innerHTML = "";
  els.content.innerHTML = `<p class="empty">选择左侧参数以读取或写入</p>`;
  els.meta.textContent = "从左侧选一个参数";
}

export function selectParam(p) {
  active = p;
  els.viewActions.innerHTML = "";
  els.viewTitle.textContent = p.label;

  els.meta.innerHTML = `<span>节点 <b>${esc(p.node)}</b></span><span>参数 <b>${esc(p.name)}</b></span>`;

  const wrap = document.createElement("div");
  wrap.className = "form";

  const valBox = document.createElement("div");
  valBox.className = "field";
  valBox.innerHTML = `<label>当前值</label>`;
  const valOut = document.createElement("pre");
  valOut.className = "code";
  valOut.textContent = "// 点击下方「读取」";
  valBox.appendChild(valOut);
  wrap.appendChild(valBox);

  const setTitle = document.createElement("div");
  setTitle.className = "section-title";
  setTitle.textContent = "写入新值";
  wrap.appendChild(setTitle);

  const setBox = document.createElement("div");
  setBox.className = "field";
  setBox.innerHTML = `<label>值 <span class="ty">bool / number / string / JSON 数组</span></label>`;
  const setInput = document.createElement("input");
  setInput.type = "text";
  setInput.placeholder = "例如 true、42、hello、[1,2,3]";
  setBox.appendChild(setInput);
  wrap.appendChild(setBox);

  const row = document.createElement("div");
  row.className = "row";
  const getBtn = document.createElement("button");
  getBtn.className = "primary";
  getBtn.textContent = "读取";
  const setBtn = document.createElement("button");
  setBtn.textContent = "写入";
  setBtn.disabled = true;
  const status = document.createElement("span");
  status.className = "tag";
  status.textContent = "就绪";
  row.append(getBtn, setBtn, status);
  wrap.appendChild(row);

  const note = document.createElement("p");
  note.className = "empty";
  note.textContent = "写入需要该节点以可写方式暴露参数，部分节点只读；写入失败会在上方提示。";
  wrap.appendChild(note);

  els.content.replaceChildren(wrap);

  const doGet = () => {
    status.className = "tag warn";
    status.textContent = "读取中…";
    const param = new Param({ ros: ctx.ros, name: `${p.node}:${p.name}` });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      status.className = "tag err";
      status.textContent = "超时";
      valOut.className = "code result-err";
      valOut.textContent = "// 读取超时（5s）";
    }, 5000);

    try {
      param.get(
        (v) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          status.className = "tag ok";
          status.textContent = "读取成功";
          valOut.className = "code result-ok";
          valOut.textContent = toJson(v);
          setInput.value = typeof v === "object" ? JSON.stringify(v) : String(v);
          setBtn.disabled = false;
        },
        (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          status.className = "tag err";
          status.textContent = "读取失败";
          valOut.className = "code result-err";
          valOut.textContent = String(e?.message ?? e);
        },
      );
    } catch (e) {
      clearTimeout(timer);
      status.className = "tag err";
      status.textContent = "异常";
      valOut.className = "code result-err";
      valOut.textContent = String(e.message);
    }
  };

  getBtn.addEventListener("click", doGet);

  setBtn.addEventListener("click", () => {
    let value;
    const raw = setInput.value.trim();
    try {
      value = parseParamValue(raw);
    } catch (e) {
      status.className = "tag err";
      status.textContent = "值格式错误";
      valOut.className = "code result-err";
      valOut.textContent = String(e.message);
      return;
    }

    status.className = "tag warn";
    status.textContent = "写入中…";
    const param = new Param({ ros: ctx.ros, name: `${p.node}:${p.name}` });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      status.className = "tag err";
      status.textContent = "写入超时";
    }, 5000);

    try {
      param.set(
        value,
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          status.className = "tag ok";
          status.textContent = "写入成功";
          setTimeout(doGet, 150);
        },
        (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          status.className = "tag err";
          status.textContent = "写入失败";
          valOut.className = "code result-err";
          valOut.textContent = String(e?.message ?? e);
        },
      );
    } catch (e) {
      clearTimeout(timer);
      status.className = "tag err";
      status.textContent = "异常";
      valOut.className = "code result-err";
      valOut.textContent = String(e.message);
    }
  });

  doGet();
}

/** 参数值解析：优先按字面量猜类型 */
function parseParamValue(raw) {
  if (raw === "") return "";
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  // 数字
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d*\.\d+([eE][-+]?\d+)?$/.test(raw)) return Number(raw);
  // JSON 结构
  if (/^[[{]/.test(raw)) {
    try { return JSON.parse(raw); } catch (e) { throw new Error(`JSON 解析失败：${e.message}`); }
  }
  return raw; // 字符串
}

/* ────────────────────────────────────────────────────────────
   参数列表：节点 → 动态枚举真实参数
   ──────────────────────────────────────────────────────────── */

/** 已展开的节点 */
const expanded = new Set();
/** node → { loading, names: string[], error } */
const nodeParams = new Map();

/** 由 main.js 注入的回调 */
let renderListProxy = () => {};
let pickParam = () => {};
let dotIsOpen = () => false;
let nodesProvider = () => [];
let serviceTypeOf = () => null;
/** 判断某参数是否被选中——唯一数据源在 main.js，避免两份状态不同步 */
let isSelected = () => false;

export function bindParamList({ renderList, onPick, isOpen, getNodes, getServiceType, isParamSelected }) {
  renderListProxy = renderList;
  pickParam = onPick;
  dotIsOpen = isOpen;
  nodesProvider = getNodes;
  serviceTypeOf = getServiceType;
  if (isParamSelected) isSelected = isParamSelected;
}

/**
 * 渲染参数列表。
 *
 * 节点从参数类服务名反推；节点下的**真实参数名**在展开时调
 * `<node>/list_parameters` 动态获取——不猜、不硬编码。
 */
export function renderParamList(q) {
  const nodes = nodesProvider().filter((n) => !q || n.toLowerCase().includes(q));

  if (!nodes.length) {
    els.list.innerHTML = `<p class="empty">${dotIsOpen() ? "未发现参数节点" : "连接后加载"}</p>`;
    return;
  }

  const frag = document.createDocumentFragment();
  for (const node of nodes) {
    const head = document.createElement("button");
    head.className = "item";
    const hn = document.createElement("span");
    hn.className = "name";
    hn.style.fontWeight = "600";
    hn.textContent = node;
    const hint = document.createElement("span");
    hint.className = "type";
    hint.textContent = expanded.has(node) ? "收起" : "点击展开参数列表";
    head.append(hn, hint);
    head.addEventListener("click", () => toggleNode(node));
    frag.appendChild(head);

    if (!expanded.has(node)) continue;
    const state = nodeParams.get(node);
    if (!state) continue;

    if (state.loading) { frag.appendChild(noteEl("加载中…")); continue; }
    if (state.error) { frag.appendChild(noteEl(state.error)); continue; }
    if (!state.names.length) { frag.appendChild(noteEl("该节点无参数")); continue; }

    const shown = q ? state.names.filter((p) => p.toLowerCase().includes(q)) : state.names;
    if (q && !shown.length && !node.toLowerCase().includes(q)) continue;

    for (const pname of shown) {
      const btn = document.createElement("button");
      const isActive = isSelected(node, pname);
      btn.className = "item" + (isActive ? " active" : "");
      btn.style.marginLeft = "12px";
      const n = document.createElement("span");
      n.className = "name";
      n.textContent = pname;
      btn.appendChild(n);
      btn.addEventListener("click", () => pickParam({ node, name: pname, label: `${node}:${pname}` }));
      frag.appendChild(btn);
    }
  }
  els.list.replaceChildren(frag);
}

function noteEl(text) {
  const p = document.createElement("p");
  p.className = "empty";
  p.style.marginLeft = "12px";
  p.textContent = text;
  return p;
}

/** 展开/收起节点；首次展开时拉取真实参数名单 */
function toggleNode(node) {
  if (expanded.has(node)) {
    expanded.delete(node);
    renderListProxy();
    return;
  }
  expanded.add(node);
  if (nodeParams.has(node)) {
    renderListProxy();
    return;
  }

  nodeParams.set(node, { loading: true, names: [], error: null });
  renderListProxy();

  const svcName = `${node}/list_parameters`;
  const svcType = serviceTypeOf(svcName) ?? "rcl_interfaces/srv/ListParameters";

  callServiceOnce(ctx.ros, svcName, svcType, {}, 8000)
    .then((res) => {
      // rcl_interfaces/srv/ListParameters 响应：{ result: { names: [...], prefixes: [...] } }
      const names = res?.result?.names ?? res?.names ?? [];
      nodeParams.set(node, { loading: false, names: [...names].sort(), error: null });
    })
    .catch((e) => {
      nodeParams.set(node, { loading: false, names: [], error: `列表获取失败：${e?.message ?? e}` });
    })
    .finally(() => renderListProxy());
}

/** 切换页签/重连时清空缓存 */
export function resetParamCache() {
  expanded.clear();
  nodeParams.clear();
}
