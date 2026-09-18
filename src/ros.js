import { Ros } from "foxglove-ros-adapter";
import { patchJsonChannels } from "./json-channels.js";

/**
 * 默认连接地址。
 *
 * 这台机器上的 foxglove_bridge 固定在 192.168.16.179:8765，就把它当作默认值。
 * 换部署环境时不用改这里 —— 三种方式都能覆盖：
 *   1. `.env.local` 里写 VITE_ROS_BRIDGE_URL=ws://<新地址>:<端口>
 *   2. 页面顶栏输入框 / URL 参数 `?host=`（存 localStorage，下次自动复用）
 *   3. 代码里改 DEFAULT_URL 这一个常量
 */
export const DEFAULT_URL = import.meta.env?.VITE_ROS_BRIDGE_URL || "ws://192.168.16.179:8765";

/** 从 URL 参数 ?host= 或 localStorage 取地址，都没有就用默认值 */
export function resolveUrl() {
  const q = new URLSearchParams(location.search).get("host");
  if (q) return q.startsWith("ws") ? q : `ws://${q}`;
  return localStorage.getItem("ros.url") || DEFAULT_URL;
}

/* ────────────────────────────────────────────────────────────
   话题 / 服务 / 动作 清单
   ──────────────────────────────────────────────────────────── */

/**
 * 列出全部话题。
 *
 * 注意：`getTopicsForType()` 是**精确类型匹配**，不支持 "*" 通配
 * （传通配符会静默返回 `[]`，很容易误判成「bridge 没广播话题」）。
 * 适配器内部维护的 `ros.channels`（Map<channelId, channel>）才是唯一真实来源。
 */
export function listTopics(ros) {
  const out = [];
  for (const ch of ros.channels?.values() ?? []) {
    if (ch?.topic) out.push({ name: ch.topic, type: ch.schemaName ?? "", id: ch.id, channel: ch });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 列出全部服务 */
export function listServices(ros) {
  const out = [];
  for (const [name, s] of ros.servicesByName ?? new Map()) {
    out.push({ name, type: s?.type ?? s?.schemaName ?? "" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 列出全部动作。
 *
 * action 通过隐藏的 `_action/send_goal` 服务暴露，且需要 bridge 以
 * `include_hidden:=true` 启动。未开启时返回空数组（不是错误）。
 */
export function listActions(ros) {
  const out = [];
  for (const name of ros.servicesByName?.keys() ?? []) {
    if (name.endsWith("/_action/send_goal")) {
      const base = name.slice(0, -"/_action/send_goal".length);
      // send_goal 服务类型形如 <pkg>/action/<Name>_SendGoal，从中还原 action 类型
      const svcType = ros.servicesByName.get(name)?.type ?? "";
      const type = svcType.replace(/_SendGoal$/, "");
      out.push({ name: base, type, sendGoalService: name });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* ────────────────────────────────────────────────────────────
   连接（带自动重连）
   ──────────────────────────────────────────────────────────── */

export function connect(url, onStatus = () => {}) {
  let ros = null;
  let closedByUser = false;
  let retryTimer = null;
  let attempt = 0;

  const open = () => {
    onStatus({ state: attempt === 0 ? "connecting" : "reconnecting", detail: url });
    ros = new Ros({ url });
    // 适配器用 CDR 解析所有消息，但 /foxglove_bridge/sysinfo 等话题是 JSON 编码的。
    // 不补这一刀，订阅它们会抛 `Could not parse line: '{'` 并永远没数据。
    patchJsonChannels(ros);

    ros.on("connection", () => {
      attempt = 0;
      onStatus({ state: "open", detail: url });
    });
    ros.on("close", () => {
      if (closedByUser) return;
      onStatus({ state: "closed", detail: "连接断开" });
      scheduleRetry();
    });
    ros.on("error", (err) => {
      onStatus({ state: "error", detail: String(err?.message ?? err ?? "未知错误") });
    });
  };

  const scheduleRetry = () => {
    if (closedByUser || retryTimer) return;
    const delay = Math.min(1000 * 2 ** attempt, 8000);
    attempt += 1;
    onStatus({ state: "reconnecting", detail: `${delay / 1000}s 后重试（第 ${attempt} 次）` });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      try { ros?.close(); } catch { /* ignore */ }
      open();
    }, delay);
  };

  open();

  return {
    get current() { return ros; },
    close() {
      closedByUser = true;
      if (retryTimer) clearTimeout(retryTimer);
      try { ros?.close(); } catch { /* ignore */ }
    },
  };
}

/* ────────────────────────────────────────────────────────────
   服务调用
   ──────────────────────────────────────────────────────────── */

/** 把服务类型名转成对应的 request 类型，如 srv/ATBool → srv/ATBool_Request */
export function requestTypeFor(serviceType) {
  if (!serviceType) return "";
  return serviceType.endsWith("_Request") ? serviceType : `${serviceType}_Request`;
}
