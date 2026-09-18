/* 通用小工具 */

export const $ = (id) => document.getElementById(id);

/**
 * 安全 JSON 序列化：处理 BigInt / TypedArray / 循环引用。
 *
 * TypedArray 转成普通数组，保留真实数值（否则长度一长就变成
 * `<1024 bytes: [...]>` 这种摘要，看不出内容）。
 * 超长数组（>512）才退化摘要，避免页面被点云刷爆。
 */
const TYPED_ARRAY_SUMMARY_THRESHOLD = 512;

export function toJson(v, indent = 2) {
  const seen = new WeakSet();
  return JSON.stringify(
    v,
    (_k, val) => {
      if (typeof val === "bigint") return val.toString();

      if (ArrayBuffer.isView(val) && !(val instanceof DataView)) {
        const arr = Array.from(val);
        if (arr.length <= TYPED_ARRAY_SUMMARY_THRESHOLD) return arr;
        const head = arr.slice(0, 24);
        return `<${val.constructor.name} 长度 ${arr.length}: [${head.join(", ")}, …]>`;
      }

      if (val instanceof DataView) return `<DataView ${val.byteLength} bytes>`;

      if (val && typeof val === "object") {
        if (seen.has(val)) return "<循环引用>";
        seen.add(val);
      }
      return val;
    },
    indent,
  );
}

/** 帧率统计器（滑动 1 秒窗口） */
export function makeRateMeter(windowMs = 1000, max = 100) {
  let marks = [];
  return {
    tick() {
      const now = performance.now();
      marks.push(now);
      if (marks.length > max) marks = marks.filter((t) => now - t < windowMs);
    },
    get rate() { return marks.length; },
    reset() { marks = []; },
  };
}

/** 手动节流：距上次调用不足 intervalMs 则跳过 */
export function makeThrottle(intervalMs) {
  let last = 0;
  return (fn) => {
    const now = performance.now();
    if (now - last < intervalMs) return false;
    last = now;
    fn();
    return true;
  };
}

/** 粗略估算对象序列化后的字节数 */
export function byteSize(v) {
  try { return new Blob([toJson(v, 0)]).size; } catch { return 0; }
}

/** HTML 转义，防止注入 */
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/** 时间戳格式化 */
export function nowTime() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

/** 数值格式化：小数量化显示 */
export function fmtNum(v) {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return "0";
  if (Math.abs(v) >= 100) return v.toFixed(1);
  if (Math.abs(v) >= 1) return v.toFixed(3);
  return v.toPrecision(4);
}
