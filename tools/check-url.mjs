/**
 * 验证「默认地址」的解析优先级：
 *   ?host= 参数  >  localStorage  >  代码里的默认值
 *
 * 跑法：node tools/check-url.mjs
 */
import { JSDOM } from "jsdom";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const FALLBACK = "ws://192.168.16.179:8765";

const cases = [
  // 无参数、无 localStorage → 用代码默认值
  { page: "http://localhost:5173/", want: FALLBACK },
  { page: "http://10.20.30.40:5173/", want: FALLBACK },
  // ?host= 覆盖默认值（带不带 ws:// 都要能用）
  { page: "http://robot-host:5173/?host=192.168.1.50:8765", want: "ws://192.168.1.50:8765" },
  { page: "http://robot-host:5173/?host=192.168.1.50", want: "ws://192.168.1.50" },
  { page: "http://robot-host:5173/?host=ws://10.0.0.9:9000", want: "ws://10.0.0.9:9000" },
  // ?host= 优先级高于 localStorage
  { page: "http://robot-host:5173/?host=10.0.0.9:9000", want: "ws://10.0.0.9:9000", stored: "ws://stale:1111" },
  // localStorage 优先级高于默认值
  { page: "http://robot-host:5173/", want: "ws://remembered:8765", stored: "ws://remembered:8765" },
];

let pass = 0, fail = 0;
let i = 0;
for (const { page, want, stored } of cases) {
  const dom = new JSDOM("<!doctype html><html></html>", { url: page });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  for (const [k, v] of [
    ["navigator", dom.window.navigator],
    ["location", dom.window.location],
    ["localStorage", dom.window.localStorage],
  ]) {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  if (stored) dom.window.localStorage.setItem("ros.url", stored);

  // 加 query 让 ESM 缓存失效，每次重新求值
  const mod = await import(pathToFileURL(resolve(process.cwd(), "src/ros.js")).href + `?case=${i++}`);
  const got = mod.resolveUrl();
  const ok = got === want;
  ok ? pass++ : fail++;
  const note = stored ? `  [localStorage=${stored}]` : "";
  console.log(`  ${ok ? "✔" : "✖"} ${page}${note}`);
  if (!ok) console.log(`      期望 ${want}，实际 ${got}`);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
