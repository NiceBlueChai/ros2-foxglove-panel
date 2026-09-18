/* TF 面板：订阅 /tf 与 /tf_static，构建父子帧树并展示变换 */

import { Topic } from "foxglove-ros-adapter";
import { $, toJson, esc, nowTime } from "./util.js";

let ctx = null;
let els = {};
let tfTopic = null;
let staticTopic = null;
/** Map<childFrame, { parent, translation, rotation, stamp, isStatic }> */
let childToParent = new Map();
let activeFrame = null;
let mounted = false;

export function initTf(context) {
  ctx = context;
  els.viewTitle = $("viewTitle");
  els.meta = $("meta");
  els.content = $("content");
  els.viewActions = $("viewActions");
}

/** TF 面板没有"列表项"，用按钮控制订阅 */
export function tfListItem() {
  return null;
}

/**
 * 切走面板时**保持订阅**。
 * TF 数据量小，反复订阅/退订会在页签切换时闪断，体验更差；
 * 用户想停时点右上角「停止订阅」即可。
 */
export function unmountTf() {
  mounted = false;
  els.viewActions.innerHTML = "";
}

export function mountTf() {
  mounted = true;
  els.viewTitle.textContent = "TF 帧树";
  // 进入面板即自动订阅，避免用户以为坏了
  if (!tfTopic && !staticTopic) startTf();
  renderActions();
  render();
}

function renderActions() {
  const bar = els.viewActions;
  bar.innerHTML = "";
  const mk = (label, cls, fn) => {
    const b = document.createElement("button");
    b.className = `sm ${cls}`;
    b.textContent = label;
    b.addEventListener("click", fn);
    bar.appendChild(b);
    return b;
  };

  const running = Boolean(tfTopic || staticTopic);
  mk(running ? "停止订阅" : "开始订阅", running ? "danger" : "primary", () => {
    if (running) stopTf(); else startTf();
    renderActions();
    render();
  });
  mk("清空", "ghost", () => {
    childToParent = new Map();
    activeFrame = null;
    render();
  });
}

function startTf() {
  const ros = ctx.ros;
  const topics = ctx.listTopics();
  const tf = topics.find((t) => t.name === "/tf");
  const tfStatic = topics.find((t) => t.name === "/tf_static");

  const problems = [];
  if (!tf) problems.push("/tf 不存在");
  if (!tfStatic) problems.push("/tf_static 不存在");

  if (problems.length) {
    els.meta.innerHTML = `<span class="tag err">未找到 TF 话题：${esc(problems.join("、"))}</span>`;
    return;
  }

  const onMsg = (isStatic) => (msg) => {
    const list = msg?.transforms ?? [];
    for (const t of list) {
      const rec = {
        parent: t.header?.frame_id,
        translation: t.transform?.translation,
        rotation: t.transform?.rotation,
        stamp: t.header?.stamp,
        isStatic,
        updatedAt: Date.now(),
      };
      if (t.child_frame_id) childToParent.set(t.child_frame_id, rec);
    }
    render();
  };

  try {
    tfTopic = new Topic({ ros, name: "/tf", messageType: tf.type });
    tfTopic.subscribe(onMsg(false));
    staticTopic = new Topic({ ros, name: "/tf_static", messageType: tfStatic.type });
    staticTopic.subscribe(onMsg(true));
    els.meta.innerHTML = `<span class="tag ok">已订阅</span><span>等待 TF 数据…</span>`;
  } catch (e) {
    els.meta.innerHTML = `<span class="tag err">订阅失败：${esc(e.message)}</span>`;
  }
}

function stopTf() {
  try { tfTopic?.unsubscribe(); } catch { /* ignore */ }
  try { staticTopic?.unsubscribe(); } catch { /* ignore */ }
  tfTopic = null;
  staticTopic = null;
}

/* ── 渲染帧树 ── */
function render() {
  const frames = childToParent.size;
  const statics = [...childToParent.values()].filter((v) => v.isStatic).length;
  const running = Boolean(tfTopic || staticTopic);

  if (frames === 0) {
    els.meta.innerHTML = running
      ? `<span class="tag warn">已订阅 /tf 与 /tf_static</span>` +
        `<span>尚未收到 TF 数据</span>`
      : `<span>TF 订阅未启动</span>`;
    els.content.innerHTML = running
      ? `<p class="empty">已订阅 <code>/tf</code> 与 <code>/tf_static</code>，正在等待数据。<br><br>
         若长时间无数据，说明机器人端没有 TF 发布者（如 <code>robot_state_publisher</code>
         或静态变换节点）在运行 —— 话题存在但无人发布，属正常现象。</p>`
      : `<p class="empty">点击右上角「开始订阅」加载 TF 树</p>`;
    return;
  }

  els.meta.innerHTML =
    `<span>帧 <b>${frames}</b></span>` +
    `<span>静态 <b>${statics}</b></span>` +
    `<span>更新 ${nowTime()}</span>`;

  // 构建 parent → children
  const childrenOf = new Map();
  const allFrames = new Set();
  for (const [child, rec] of childToParent) {
    allFrames.add(child);
    if (rec.parent) {
      allFrames.add(rec.parent);
      if (!childrenOf.has(rec.parent)) childrenOf.set(rec.parent, []);
      childrenOf.get(rec.parent).push(child);
    }
  }
  // 根 = 没有父的帧（或父不在集合里）
  const roots = [...allFrames].filter((f) => !childToParent.get(f)?.parent ||
    !allFrames.has(childToParent.get(f).parent));

  const tree = document.createElement("div");
  const seen = new Set();
  const walk = (frame, host, depth) => {
    if (seen.has(frame) || depth > 12) return;
    seen.add(frame);

    const rec = childToParent.get(frame);
    const node = document.createElement("div");
    const label = document.createElement("span");
    label.className = "tf-node" + (frame === activeFrame ? " active" : "");
    label.textContent = frame + (rec?.isStatic ? "  (static)" : "");
    label.addEventListener("click", () => {
      activeFrame = frame;
      render();
    });
    node.appendChild(label);

    const kids = childrenOf.get(frame) ?? [];
    if (kids.length) {
      const box = document.createElement("div");
      box.className = "tf-children";
      for (const k of kids.sort()) walk(k, box, depth + 1);
      node.appendChild(box);
    }
    host.appendChild(node);
  };
  for (const r of roots.sort()) walk(r, tree, 0);

  // 未连到树上的孤立帧
  const orphans = [...childToParent.keys()].filter((f) => !seen.has(f));
  if (orphans.length) {
    const box = document.createElement("div");
    box.style.marginTop = "10px";
    box.innerHTML = `<div class="section-title">未连接帧</div>`;
    for (const f of orphans.sort()) {
      const s = document.createElement("span");
      s.className = "tf-node";
      s.textContent = f;
      s.addEventListener("click", () => { activeFrame = f; render(); });
      box.appendChild(s);
    }
    tree.appendChild(box);
  }

  // 选中帧的变换详情
  if (activeFrame) {
    const rec = childToParent.get(activeFrame);
    const detail = document.createElement("div");
    detail.style.marginTop = "14px";
    detail.innerHTML = `<div class="section-title">${esc(activeFrame)} ← ${esc(rec?.parent ?? "?")}</div>`;
    const pre = document.createElement("pre");
    pre.className = "code";
    pre.textContent = rec
      ? toJson({
          child_frame: activeFrame,
          parent_frame: rec.parent,
          is_static: rec.isStatic,
          translation: rec.translation,
          rotation: rec.rotation,
          stamp: rec.stamp,
        })
      : "// 无该帧的变换";
    detail.appendChild(pre);
    tree.appendChild(detail);
  }

  els.content.replaceChildren(tree);
}
