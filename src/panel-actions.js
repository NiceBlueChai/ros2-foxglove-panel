/* 动作面板：列出 action server，发送目标、订阅反馈、查看结果 */

import { ActionClient } from "foxglove-ros-adapter";
import { $, toJson, esc, nowTime } from "./util.js";

let ctx = null;
let active = null;
let client = null;
let els = {};

export function initActions(context) {
  ctx = context;
  els.viewTitle = $("viewTitle");
  els.meta = $("meta");
  els.content = $("content");
  els.viewActions = $("viewActions");
}

export function actionListItem(a, isActive) {
  return { name: a.name, type: a.type || "未知类型", active: isActive, data: a };
}

export function unmountActions() {
  try { client?.cancelGoal?.("__ui_unmount__"); } catch { /* ignore */ }
  client = null;
  els.viewActions.innerHTML = "";
  els.content.innerHTML = `<p class="empty">选择左侧动作以发送目标</p>`;
  els.meta.textContent = "从左侧选一个动作";
}

export function selectAction(a) {
  active = a;
  els.viewActions.innerHTML = "";
  els.viewTitle.textContent = a.name;
  els.meta.innerHTML = `<span><b>${esc(a.type)}</b></span><span class="tag">sendGoal → ${esc(a.sendGoalService)}</span>`;

  const wrap = document.createElement("div");
  wrap.className = "form";

  const reqTitle = document.createElement("div");
  reqTitle.className = "section-title";
  reqTitle.textContent = "目标（goal）JSON";
  wrap.appendChild(reqTitle);

  const goalArea = document.createElement("textarea");
  goalArea.rows = 5;
  goalArea.style.fontFamily = "var(--mono)";
  goalArea.placeholder = "{}";
  wrap.appendChild(goalArea);

  const row = document.createElement("div");
  row.className = "row";
  const sendBtn = document.createElement("button");
  sendBtn.className = "primary";
  sendBtn.textContent = "发送目标";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "danger";
  cancelBtn.textContent = "取消目标";
  cancelBtn.disabled = true;
  const status = document.createElement("span");
  status.className = "tag";
  status.textContent = "就绪";
  row.append(sendBtn, cancelBtn, status);
  wrap.appendChild(row);

  const fbTitle = document.createElement("div");
  fbTitle.className = "section-title";
  fbTitle.textContent = "反馈";
  wrap.appendChild(fbTitle);
  const fbBox = document.createElement("pre");
  fbBox.className = "code";
  fbBox.textContent = "// 等待反馈";
  wrap.appendChild(fbBox);

  const resTitle = document.createElement("div");
  resTitle.className = "section-title";
  resTitle.textContent = "结果";
  wrap.appendChild(resTitle);
  const resBox = document.createElement("pre");
  resBox.className = "code";
  resBox.textContent = "// 等待结果";
  wrap.appendChild(resBox);

  els.content.replaceChildren(wrap);

  let goalId = null;
  let fbCount = 0;

  sendBtn.addEventListener("click", async () => {
    let goal;
    try {
      goal = goalArea.value.trim() === "" ? {} : JSON.parse(goalArea.value);
    } catch (e) {
      status.className = "tag err";
      status.textContent = "goal JSON 格式错误";
      resBox.className = "code result-err";
      resBox.textContent = String(e.message);
      return;
    }

    sendBtn.disabled = true;
    status.className = "tag warn";
    status.textContent = "等待 action 可用…";

    try {
      // 等 action 端点就绪（bridge 需 include_hidden:=true，否则会一直等不到）
      const ready = await waitForAction(a.name, 5000);
      if (!ready) {
        status.className = "tag err";
        status.textContent = "action 端点不可用";
        resBox.className = "code result-err";
        resBox.textContent =
          `该 action 的隐藏端点未在 bridge 上广播。\n` +
          `服务端需要用 include_hidden:=true 启动 foxglove_bridge：\n\n` +
          `  ros2 launch foxglove_bridge foxglove_bridge_launch.xml include_hidden:=true`;
        sendBtn.disabled = false;
        return;
      }

      client = new ActionClient({ ros: ctx.ros, name: a.name, actionType: a.type });
      fbCount = 0;
      status.className = "tag warn";
      status.textContent = "已发送，等待反馈…";

      goalId = client.sendGoal(
        goal,
        (result) => {
          status.className = "tag ok";
          status.textContent = `完成 · ${nowTime()}`;
          resBox.className = "code result-ok";
          resBox.textContent = toJson(result);
          cancelBtn.disabled = true;
          sendBtn.disabled = false;
        },
        (feedback) => {
          fbCount += 1;
          fbBox.className = "code";
          fbBox.textContent = `// 第 ${fbCount} 次反馈 @ ${nowTime()}\n${toJson(feedback)}`;
          status.textContent = `运行中 · 反馈 ${fbCount}`;
        },
        (error) => {
          status.className = "tag err";
          status.textContent = "执行出错";
          resBox.className = "code result-err";
          resBox.textContent = toJson(error);
          cancelBtn.disabled = true;
          sendBtn.disabled = false;
        },
      );

      cancelBtn.disabled = false;
      cancelBtn.onclick = () => {
        try {
          client.cancelGoal(goalId);
          status.className = "tag warn";
          status.textContent = "已请求取消";
        } catch (e) {
          status.className = "tag err";
          status.textContent = `取消失败：${e.message}`;
        }
      };
    } catch (err) {
      status.className = "tag err";
      status.textContent = "发送失败";
      resBox.className = "code result-err";
      resBox.textContent = String(err?.message ?? err);
      sendBtn.disabled = false;
    }
  });
}

/** 轮询等待 action 端点出现（waitForAction 是回调式且无 Promise 版本） */
function waitForAction(name, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const t = setTimeout(() => finish(false), timeoutMs);

    const check = () => {
      try {
        if (ctx.ros.isActionAdvertised?.(name)) { clearTimeout(t); finish(true); }
      } catch { /* ignore */ }
    };
    check();
    if (done) return;

    const iv = setInterval(() => {
      check();
      if (done) { clearInterval(iv); clearTimeout(t); }
    }, 300);
    setTimeout(() => clearInterval(iv), timeoutMs + 100);
  });
}
