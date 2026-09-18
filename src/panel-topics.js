/* 话题面板：订阅 + 数值视图 + JSON 预览 + 录制 */

import { Topic } from "foxglove-ros-adapter";
import { $, toJson, makeRateMeter, makeThrottle, byteSize, esc, nowTime, fmtNum } from "./util.js";

const RENDER_INTERVAL = 100; // 10Hz 渲染节流

let ctx = null;          // { ros, onStatus }
let active = null;       // { name, type }
let subscription = null; // Topic 实例
let meter = makeRateMeter();
let frameCount = 0;
let lastMsg = null;
let paused = false;
let recording = false;
let frames = [];
let recordTimer = null;
let recordStart = 0;

const els = {};

export function initTopics(context) {
  ctx = context;
  els.chart = $("chart");
  els.chartHint = $("chartHint");
  els.viewTitle = $("viewTitle");
  els.meta = $("meta");
  els.content = $("content");
  els.viewActions = $("viewActions");
  els.chartPanel = $("chartPanel");
}

/** 当前面板是否激活（话题页签默认激活） */
let visible = true;
export function setTopicsVisible(v) {
  visible = v;
  els.chartPanel.style.display = v ? "" : "none";
  // 切换回来时重绘一次
  if (v && lastMsg) drawChart(lastMsg);
}

export function unmountTopics() {
  stopSubscription();
  els.viewActions.innerHTML = "";
  els.content.innerHTML = `<p class="empty">选择左侧话题以查看数据</p>`;
  els.meta.textContent = "从左侧选一个话题开始订阅";
  els.chart?.replaceChildren();
}

/* ── 渲染列表项 ── */
export function topicListItem(t, isActive) {
  return {
    name: t.name,
    type: t.type || "无 schema",
    active: isActive,
    data: t,
  };
}

/* ── 选中话题 ── */
export function selectTopic(t) {
  stopSubscription();
  active = t;
  frameCount = 0;
  meter.reset();
  lastMsg = null;
  frames = [];
  recording = false;

  els.viewTitle.textContent = t.name;
  els.content.innerHTML = `<p class="empty">等待数据…</p>`;
  els.chart?.replaceChildren();

  if (!t.type) {
    els.meta.innerHTML = `<span class="tag warn">该 channel 未广播 schema，无法解码</span>`;
    renderActions();
    return;
  }

  try {
    subscription = new Topic({ ros: ctx.ros, name: t.name, messageType: t.type });
    const throttledPaint = makeThrottle(RENDER_INTERVAL);

    subscription.subscribe((msg) => {
      frameCount += 1;
      meter.tick();
      lastMsg = msg;
      if (recording) frames.push(msg);
      if (!paused) throttledPaint(() => paint(msg));
      paintMeta();
    });
    els.meta.innerHTML = `<span>${esc(t.type)}</span><span>已订阅，等待数据…</span>`;
  } catch (err) {
    els.meta.innerHTML = `<span class="tag err">订阅失败：${esc(err?.message ?? err)}</span>`;
  }
  renderActions();
}

function stopSubscription() {
  try { subscription?.unsubscribe(); } catch { /* ignore */ }
  subscription = null;
  if (recordTimer) { clearInterval(recordTimer); recordTimer = null; }
}

function paint(msg) {
  els.content.innerHTML = `<pre class="code">${esc(toJson(msg).slice(0, 60000))}</pre>`;
  if (visible) drawChart(msg);
}

function paintMeta() {
  const bytes = byteSize(lastMsg);
  els.meta.innerHTML =
    `<span><b>${esc(active.type)}</b></span>` +
    `<span>帧 <b>${frameCount}</b></span>` +
    `<span><b>${meter.rate}</b> Hz</span>` +
    `<span>~<b>${bytes}</b> B</span>` +
    `<span>${nowTime()}</span>` +
    (recording ? `<span class="tag err">录制中 ${frames.length}</span>` : "") +
    (paused ? `<span class="tag warn">已暂停</span>` : "");
}

function renderActions() {
  const bar = els.viewActions;
  bar.innerHTML = "";
  if (!active?.type) return;

  const mk = (label, cls, fn) => {
    const b = document.createElement("button");
    b.className = `sm ${cls}`;
    b.textContent = label;
    b.addEventListener("click", fn);
    bar.appendChild(b);
    return b;
  };

  mk(paused ? "继续" : "暂停", "ghost", (e) => {
    paused = !paused;
    e.target.textContent = paused ? "继续" : "暂停";
    if (!paused && lastMsg) paint(lastMsg);
    paintMeta();
  });

  const recBtn = mk("录制", "ghost", (e) => {
    recording = !recording;
    if (recording) {
      frames = [];
      recordStart = Date.now();
      e.target.textContent = "停止(0)";
      recordTimer = setInterval(() => {
        e.target.textContent = `停止(${frames.length})`;
        paintMeta();
      }, 500);
    } else {
      if (recordTimer) { clearInterval(recordTimer); recordTimer = null; }
      e.target.textContent = "录制";
      downloadRecording();
      paintMeta();
    }
  });
  recBtn.disabled = false;

  mk("复制 JSON", "ghost", async (e) => {
    if (lastMsg == null) return;
    try {
      await navigator.clipboard.writeText(toJson(lastMsg));
      e.target.textContent = "已复制";
    } catch { e.target.textContent = "复制失败"; }
    setTimeout(() => (e.target.textContent = "复制 JSON"), 1200);
  });

  mk("清空", "ghost", () => {
    frameCount = 0;
    meter.reset();
    frames = [];
    els.content.innerHTML = `<p class="empty">已清空</p>`;
    paintMeta();
  });
}

function downloadRecording() {
  if (!frames.length) return;
  const name = (active.name || "topic").replace(/[^\w.-]+/g, "_").replace(/^_/, "");
  const meta = {
    topic: active.name,
    type: active.type,
    frames: frames.length,
    startedAt: new Date(recordStart).toISOString(),
    durationMs: Date.now() - recordStart,
  };
  const blob = new Blob([JSON.stringify({ meta, data: frames }, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name}_${frames.length}frames.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

/* ── 数值视图：自动找数组字段画柱状图 ── */
const PREFERRED = ["joint_pos", "joint_v", "tcp_pos", "tcp_v", "position", "velocity", "point", "values"];

function findNumericArray(msg, depth = 0) {
  if (!msg || typeof msg !== "object" || depth > 3) return null;

  // 优先按已知字段名找
  for (const key of PREFERRED) {
    const hit = coerceArray(msg[key]);
    if (hit) return { key, nums: hit };
  }
  // 退而求其次：任何纯数字数组
  for (const [key, v] of Object.entries(msg)) {
    const hit = coerceArray(v);
    if (hit && hit.length >= 3) return { key, nums: hit };
  }
  // 递归一层
  for (const [key, v] of Object.entries(msg)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = findNumericArray(v, depth + 1);
      if (inner) return { key: `${key}.${inner.key}`, nums: inner.nums };
    }
  }
  return null;
}

/**
 * 把各种形态的定长数值数组统一成 number[]。
 *
 * 适配器解码后的形态有三种，都得支持：
 *   1. Float64Array / Int32Array 等 TypedArray（CDR 定长数组的默认形态）
 *   2. number[] 普通数组
 *   3. {"0":1,"1":2} 这类数字键对象（JSON 化之后的样子）
 */
function coerceArray(v) {
  if (v == null) return null;

  // TypedArray 优先（适配器解码 float64[6] 就是 Float64Array）
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    const nums = Array.from(v, Number);
    return validNums(nums);
  }
  if (Array.isArray(v)) {
    return validNums(v.map(Number));
  }
  if (typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
      const nums = keys.sort((a, b) => Number(a) - Number(b)).map((k) => Number(v[k]));
      return validNums(nums);
    }
  }
  return null;
}

function validNums(nums) {
  if (!nums || nums.length < 2) return null;
  if (!nums.every((n) => Number.isFinite(n))) return null;
  return nums;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** 创建 SVG 元素（用 DOM API 而非 innerHTML，兼容性更稳） */
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function drawChart(msg) {
  const svg = els.chart;
  if (!svg) return;
  svg.replaceChildren();

  const hit = findNumericArray(msg);
  if (!hit) {
    const t = svgEl("text", {
      x: 340, y: 24, "text-anchor": "middle",
      "font-size": 12, fill: "#9ca3af",
    });
    t.textContent = "无可视化数值数组";
    svg.appendChild(t);
    els.chartHint.textContent = "该消息中没有关节/位姿等数值数组";
    return;
  }

  const { key, nums } = hit;
  els.chartHint.textContent = `字段 ${key} · ${nums.length} 维`;

  const rowH = 24;
  const H = 34 + nums.length * rowH;
  const W = 680;
  const x0 = 62, barW = 400;
  const rawMax = Math.max(...nums.map(Math.abs));
  const allZero = rawMax < 1e-9;
  const maxAbs = allZero ? 1 : rawMax;

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  // 基线
  svg.appendChild(svgEl("line", { x1: x0, y1: 26, x2: x0, y2: H - 6, stroke: "#d1d5db" }));

  nums.forEach((v, i) => {
    const y = 34 + i * rowH;
    // 全 0 时画一条最小可见柱，直观表示"确实为 0"而非渲染失败
    const w = allZero ? 2 : Math.max(2, (Math.abs(v) / maxAbs) * barW);
    // 中文习惯：正红负绿，零值灰
    const color = v < 0 ? "#16a34a" : v > 0 ? "#dc2626" : "#cbd5e1";

    const label = svgEl("text", {
      x: x0 - 8, y: y + 12, "text-anchor": "end",
      "font-size": 10.5, fill: "#9ca3af", "font-family": "monospace",
    });
    label.textContent = `[${i}]`;
    svg.appendChild(label);

    svg.appendChild(svgEl("rect", {
      x: x0, y, width: barW, height: 13, rx: 3, fill: "#f0f2f5",
    }));
    svg.appendChild(svgEl("rect", {
      x: x0, y, width: w.toFixed(1), height: 13, rx: 3, fill: color,
    }));

    const val = svgEl("text", {
      x: x0 + barW + 8, y: y + 11,
      "font-size": 11, fill: "#1c1f23", "font-family": "monospace",
    });
    val.textContent = fmtNum(v);
    svg.appendChild(val);
  });
}
