/**
 * 无头 DOM 验证：用 jsdom 加载真实 index.html + 前端模块，
 * 捕获控制台报错、验证列表渲染、模拟点击订阅与调用服务。
 *
 * 跑法：
 *   node tools/e2e.mjs
 *   ROS_BRIDGE_URL=ws://192.168.1.50:8765 node tools/e2e.mjs
 *
 * 注意：本脚本针对特定 bridge 写了不少断言（话题名 / 服务名 / 动作数）。
 * 换到别的 ROS 2 系统上跑会大量失败，那是预期的 —— 改断言即可。
 */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

/** 目标 bridge：环境变量优先，否则由 main.js 自己按页面 host 推断 */
const BRIDGE = process.env.ROS_BRIDGE_URL;

const html = readFileSync(resolve(root, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://localhost:5173/", pretendToBeVisual: true });

// 把 jsdom 的全局注入 Node 环境，让前端模块能拿到 document / window
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
// 指定了 bridge 就写进 localStorage（main.js 的 resolveUrl 会读它）
if (BRIDGE) window.localStorage.setItem("ros.url", BRIDGE);
// Node 22 的 navigator/location 是只读 getter，必须用 defineProperty 覆盖
for (const [key, val] of [
  ["navigator", window.navigator],
  ["location", window.location],
  ["localStorage", window.localStorage],
  ["HTMLElement", window.HTMLElement],
]) {
  try {
    Object.defineProperty(globalThis, key, { value: val, configurable: true, writable: true });
  } catch { /* 某些环境不可覆盖，忽略 */ }
}

const errors = [];
const warns = [];
window.addEventListener("error", (e) => errors.push("window.error: " + e.message));
const origError = console.error;
console.error = (...a) => { errors.push("console.error: " + a.map(String).join(" ")); origError(...a); };
const origWarn = console.warn;
console.warn = (...a) => { warns.push(a.map(String).join(" ")); origWarn(...a); };

// navigator.clipboard 在 jsdom 里没有
Object.defineProperty(window.navigator, "clipboard", {
  value: { writeText: async () => {} },
  configurable: true,
});

// Blob / URL.createObjectURL 兜底
if (!globalThis.Blob) globalThis.Blob = class { constructor(p) { this.size = JSON.stringify(p).length; } };
if (!window.URL.createObjectURL) window.URL.createObjectURL = () => "blob:fake";
if (!window.URL.revokeObjectURL) window.URL.revokeObjectURL = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = (...a) => console.log(...a);
let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; log(`  ✔ ${name}`); }
  else { fail++; log(`  ✖ ${name}${detail ? " — " + detail : ""}`); }
};

const $id = (id) => window.document.getElementById(id);
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
/** 当前列表里的组头 / 叶子 */
const heads = () => [...$id("list").querySelectorAll(".group-head")];
const leaves = () => [...$id("list").querySelectorAll(".item")];
/** 某组头是否处于展开态 */
const isOpen = (h) => Boolean(h?.classList.contains("open"));

/**
 * 展开全部组，直到出现目标叶子（最多 4 层）。
 * 分组模式下叶子藏在折叠组里，得先钻进去才能点。
 */
async function expandUntilVisible(name, { maxRounds = 12 } = {}) {
  for (let i = 0; i < maxRounds; i++) {
    const hit = leaves().find((l) => l.querySelector(".name")?.textContent === name);
    if (hit) return hit;
    // 优先展开「其下可能包含目标」的组：拿组头的 data-path 前缀比对
    const closed = heads().filter((h) => !isOpen(h));
    const cand = closed.find((h) => name.startsWith(h.dataset.path + "/")) ?? closed[0];
    if (!cand) return null;
    click(cand);
    await sleep(250);
  }
  return leaves().find((l) => l.querySelector(".name")?.textContent === name) ?? null;
}

/** 保证处于平铺模式（按需要点开关） */
function setFlat(flat) {
  const btn = $id("groupToggle");
  const isFlat = btn.textContent === "平铺";
  if (isFlat !== flat) btn.click();
}

/** 保证处于分组模式 */
function setGrouped() { setFlat(false); }

(async () => {
  log("=== 加载前端模块 ===");
  let mod;
  try {
    mod = await import(pathToFileURL(resolve(root, "src/main.js")).href);
  } catch (e) {
    log("✖ 模块加载失败:", e.message);
    log(e.stack);
    process.exit(1);
  }
  log("  模块加载成功\n");

  const $ = $id;

  // ── 1. DOM 结构 ──
  log("=== 1. DOM 结构 ===");
  for (const id of ["statusDot", "statusText", "urlInput", "connectBtn", "tabs", "list", "content", "meta", "chart"]) {
    check(`#${id} 存在`, Boolean($(id)));
  }

  // ── 2. 等连接 ──
  log("\n=== 2. 建立连接（最多 10s）===");
  let connected = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if ($("statusDot")?.classList.contains("open")) { connected = true; break; }
  }
  check("状态灯变为 open", connected, `当前 class=${$("statusDot")?.className}`);
  log(`  状态文字: ${$("statusText")?.textContent}`);

  if (!connected) {
    log("\n✖ 未能连接，后续测试跳过");
    report();
    process.exit(1);
  }

  await sleep(2500); // 等清单加载

  // ── 3. 计数（数量随 bridge 配置变化，这里只做合理性校验）──
  log("\n=== 3. 清单计数 ===");
  const cTopics = Number($("cntTopics").textContent);
  const cServices = Number($("cntServices").textContent);
  const cActions = Number($("cntActions").textContent);
  log(`  话题 ${cTopics} · 服务 ${cServices} · 动作 ${cActions}`);
  check(`话题数 > 0`, cTopics > 0, `实际 ${cTopics}`);
  check(`服务数 > 0`, cServices > 0, `实际 ${cServices}`);
  check(`动作数 = 10（bridge 已开 include_hidden）`, cActions === 10, `实际 ${cActions}`);

  // ── 4. 话题列表（分组模式下，叶子藏在折叠组里）──
  log("\n=== 4. 话题列表 ===");
  // 先看默认（分组）视图：组头 + 顶层叶子应覆盖全部话题
  const topLeafNames = leaves().map((i) => i.querySelector(".name")?.textContent);
  const topHeadSum = heads().reduce((s, h) => s + Number(h.querySelector(".gcount")?.textContent ?? 0), 0);
  log(`  分组视图: ${heads().length} 组 + ${topLeafNames.length} 顶层叶子`);
  check("分组视图覆盖全部话题（组头计数 + 顶层叶子 = 总数）",
    topHeadSum + topLeafNames.length === cTopics,
    `${topHeadSum} + ${topLeafNames.length} vs ${cTopics}`);
  check("顶层叶子含 /tf", topLeafNames.includes("/tf"));

  // 切平铺，验证全部条目都能渲染出来
  setFlat(true);
  await sleep(500);
  const flatNames = leaves().map((i) => i.querySelector(".name")?.textContent);
  check(`平铺渲染全部 ${cTopics} 项`, flatNames.length === cTopics, `实际 ${flatNames.length}`);
  check("包含 /at/robot/get_real_time_status", flatNames.includes("/at/robot/get_real_time_status"));
  check("包含 /tf", flatNames.includes("/tf"));

  // ── 5. 订阅话题 ──
  // 注意：机器人端目前只有 /rosout 与 /foxglove_bridge/sysinfo 在真实发布数据，
  // /tf 与各 /at/* 话题虽被广播但零帧（已在服务端确认）。所以拿有数据的话题验证：
  //   /foxglove_bridge/sysinfo —— 顺带回归 JSON 编码通道的解析（encoding="json"）
  log("\n=== 5. 订阅活跃话题 ===");

  // 5a. 普通 CDR 话题
  const target = leaves().find((i) => i.querySelector(".name")?.textContent === "/rosout");
  check("找到 /rosout 话题行", Boolean(target));
  if (target) {
    click(target);
    await sleep(2500);
    const meta = $("meta").textContent;
    log(`  /rosout meta: ${meta}`);
    check("/rosout 显示帧数/Hz", /帧/.test(meta) && /Hz/.test(meta), meta);
    const frames = Number(meta.match(/帧\s*(\d+)/)?.[1] ?? 0);
    check("/rosout 收到帧数 > 0", frames > 0, `实际 ${frames}`);
    check("/rosout JSON 已解码", ($("content").textContent || "").length > 10,
      $("content").textContent.slice(0, 60));
  }

  // 5b. JSON 编码话题（回归适配器 createSubscription 忽略 encoding 的 bug）
  const sysinfo = leaves().find((i) => i.querySelector(".name")?.textContent === "/foxglove_bridge/sysinfo");
  check("找到 /foxglove_bridge/sysinfo 话题行", Boolean(sysinfo));
  if (sysinfo) {
    click(sysinfo);
    await sleep(2500);
    const meta = $("meta").textContent;
    log(`  sysinfo meta: ${meta}`);
    check("JSON 编码话题能收到帧（补丁生效）",
      Number(meta.match(/帧\s*(\d+)/)?.[1] ?? 0) > 0, meta);
    check("JSON 编码话题按 JSON 解码，而非 CDR 报错",
      /process_memory|total_cpu|num_cpus/.test($("content").textContent),
      $("content").textContent.slice(0, 80));
  }

  // 5c. 验证柱状图在「无可绘字段」时给出明确提示而不是静默空白。
  // 注意：SVG <text> 的内容取不到 textContent（jsdom 不渲染 SVG 文本节点），
  // 所以改看 chartHint 文案 + svg 子节点数。
  const chartSvg = $("chart");
  const chartHint = $("chartHint").textContent;
  log(`  chartHint: ${chartHint} · svg 子节点 ${chartSvg.childNodes.length}`);
  check("数值视图始终有内容（柱子或提示）",
    chartSvg.querySelectorAll("rect").length > 0 || chartSvg.childNodes.length > 0,
    `rect ${chartSvg.querySelectorAll("rect").length} / 子节点 ${chartSvg.childNodes.length}`);
  check("数值视图给出了具体说明", chartHint.length > 0, chartHint);
  check("操作按钮已生成", $("viewActions").querySelectorAll("button").length >= 4,
    `按钮数 ${$("viewActions").querySelectorAll("button").length}`);

  // ── 6. 服务页签 ──
  log("\n=== 6. 服务页签 ===");
  const svcTab = [...$("tabs").querySelectorAll(".tab")].find((t) => t.dataset.tab === "services");
  svcTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(600);

  // 平铺模式下按名点选（服务 479 项，分组态下叶子藏在折叠组里）
  setFlat(true);
  await sleep(500);
  const svcItems = leaves();
  check(`平铺渲染 ${cServices} 项`, svcItems.length === cServices, `实际 ${svcItems.length}`);
  check("平铺态无组头", heads().length === 0, `组头 ${heads().length}`);

  // 切回分组，验证覆盖完整性
  setGrouped();
  await sleep(500);
  const sHeadSum = heads().reduce((s, h) => s + Number(h.querySelector(".gcount")?.textContent ?? 0), 0);
  const sTopLeaves = leaves().length;
  check("服务分组出多个顶层组", heads().length > 1, `组头 ${heads().length}`);
  check("分组视图覆盖全部服务（组头计数 + 顶层叶子 = 总数）",
    sHeadSum + sTopLeaves === cServices, `${sHeadSum} + ${sTopLeaves} vs ${cServices}`);

  // 回到平铺继续后面的按名查找
  setFlat(true);
  await sleep(500);

  // 找到 get_parameters 服务并选中
  const eyeSvc = leaves().find((i) => i.querySelector(".name")?.textContent === "/at/camera_node/get_parameters");
  check("找到 /at/camera_node/get_parameters", Boolean(eyeSvc));
  if (eyeSvc) {
    eyeSvc.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(600);
    const svcMeta = $("meta").textContent;
    log(`  meta: ${svcMeta}`);
    const inputs = $("content").querySelectorAll(".field input, .field select, .field textarea");
    check("自动生成了请求表单字段", inputs.length > 0, `字段数 ${inputs.length}`);

    // 填 names 字段
    const nameInput = $("content").querySelector('input[data-field="names"]');
    if (nameInput) {
      nameInput.value = "use_sim_time";
      const callBtn = [...$("content").querySelectorAll("button")].find((b) => b.textContent === "调用服务");
      check("存在「调用服务」按钮", Boolean(callBtn));
      if (callBtn) {
        callBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        await sleep(3000);
        const result = $("content").querySelector(".code:last-of-type")?.textContent ?? "";
        const statusTag = [...$("content").querySelectorAll(".tag")].map((t) => t.textContent).join(" | ");
        log(`  状态: ${statusTag}`);
        log(`  响应片段: ${result.slice(0, 160).replace(/\n/g, " ")}`);
        check("服务调用成功（含 values 字段）", result.includes("values") || /成功/.test(statusTag),
          statusTag);
      }
    }
  }

  // ── 7. 参数页签（动态枚举真实参数）──
  log("\n=== 7. 参数页签 ===");
  const pTab = [...$("tabs").querySelectorAll(".tab")].find((t) => t.dataset.tab === "params");
  pTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(600);

  let paramItems = [...$("list").querySelectorAll(".item")];
  check("发现参数节点", paramItems.length > 0, `${paramItems.length} 项`);
  const nodeNames = paramItems.filter((i) => i.querySelector(".name")?.style.fontWeight === "600")
    .map((i) => i.querySelector(".name").textContent);
  check("发现 /rosbridge_websocket 节点", nodeNames.includes("/rosbridge_websocket"),
    `已有: ${nodeNames.slice(0, 6).join(", ")}`);

  // 展开 /rosbridge_websocket，应动态拉出真实参数
  const rosbridgeHead = paramItems.find((i) => i.querySelector(".name")?.textContent === "/rosbridge_websocket");
  check("找到 /rosbridge_websocket 节点行", Boolean(rosbridgeHead));
  if (rosbridgeHead) {
    rosbridgeHead.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(3000); // 等 list_parameters 返回

    paramItems = [...$("list").querySelectorAll(".item")];
    const paramNames = paramItems.map((i) => i.querySelector(".name")?.textContent);
    log(`  展开后列表项: ${paramItems.length}`);
    log(`  参数名 (前 12): ${paramNames.slice(0, 14).join(", ")}`);

    check("动态枚举出真实参数（非硬编码）",
      paramNames.includes("send_action_goals_in_new_thread"),
      `未找到 send_action_goals_in_new_thread; 实际: ${paramNames.slice(0, 10).join(", ")}`);
    check("含 websocket_ping_interval", paramNames.includes("websocket_ping_interval"));
    check("参数数量 >= 15", paramNames.length >= 15, `实际 ${paramNames.length}`);

    // 点进去读值
    const target = paramItems.find((i) => i.querySelector(".name")?.textContent === "send_action_goals_in_new_thread");
    if (target) {
      target.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await sleep(2500);
      const valBox = $("content").querySelector(".code");
      log(`  读取值: ${valBox?.textContent?.slice(0, 60)}`);
      check("参数读取成功", /true|false|\d/.test(valBox?.textContent ?? ""));
    }
  }

  // ── 8. TF 页签 ──
  log("\n=== 8. TF 页签 ===");
  const tfTab = [...$("tabs").querySelectorAll(".tab")].find((t) => t.dataset.tab === "tf");
  tfTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(600);
  const tfMeta = $("meta").textContent;
  const tfContent = $("content").textContent;
  log(`  meta: ${tfMeta}`);
  log(`  content: ${tfContent.slice(0, 100).replace(/\n/g, " ")}`);
  check("TF 面板已挂载（有订阅控制按钮）",
    [...$("viewActions").querySelectorAll("button")].some((b) => /订阅/.test(b.textContent)));
  check("已自动开始订阅并给出等待提示",
    /已订阅/.test(tfMeta) && /等待数据|尚未收到/.test(tfMeta + tfContent),
    tfMeta);

  // ── 9. 动作页签 ──
  log("\n=== 9. 动作页签 ===");
  const aTab = [...$("tabs").querySelectorAll(".tab")].find((t) => t.dataset.tab === "actions");
  aTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(600);

  const actItems = leaves();
  log(`  动作列表项: ${actItems.length}（组头 ${heads().length}）`);
  const actNames = actItems.map((i) => i.querySelector(".name")?.textContent);
  log(`  动作名: ${actNames.join(", ")}`);
  check(`动作列表渲染 ${cActions} 项`, actItems.length === cActions, `实际 ${actItems.length}`);
  check("含 /at/robot/move_joint", actNames.includes("/at/robot/move_joint"));
  check("少于 20 项时回退平铺（设计如此，避免过度分组）",
    cActions >= 20 || heads().length === 0, `动作 ${cActions} 组头 ${heads().length}`);
  check("动作类型显示为 action 类型",
    /action\//.test(actItems[0]?.querySelector(".type")?.textContent ?? ""),
    actItems[0]?.querySelector(".type")?.textContent);

  // 选中一个动作，验证目标输入表单生成
  if (actItems.length) {
    actItems[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(500);
    check("动作面板生成了 goal 输入区",
      $("content").querySelectorAll("textarea").length > 0,
      `textarea ${$("content").querySelectorAll("textarea").length}`);
    check("有「发送目标」按钮",
      [...$("content").querySelectorAll("button")].some((b) => b.textContent === "发送目标"));
  }

  // ── 10. 分组开关回归 ──
  log("\n=== 10. 分组开关 ===");
  const gTab = [...$("tabs").querySelectorAll(".tab")].find((t) => t.dataset.tab === "services");
  click(gTab);
  await sleep(500);
  setGrouped();
  await sleep(400);
  check("服务页签：分组模式下有组头", heads().length > 1, `${heads().length}`);
  const beforeExpand = leaves().length;
  const expandable = heads().find((h) => Number(h.querySelector(".gcount")?.textContent ?? 0) > 0);
  click(expandable);
  await sleep(400);
  check("点击组头后叶子增多",
    leaves().length > beforeExpand || heads().length > 2,
    `${beforeExpand} → ${leaves().length}, 组头 ${heads().length}`);
  check("开关文案为「分组」", $("groupToggle").textContent === "分组", $("groupToggle").textContent);
  const atHead = heads().find((h) => h.dataset.path === "/at");
  check("/at 组存在且可定位", Boolean(atHead), `组头路径: ${heads().map((h) => h.dataset.path).slice(0, 4).join(", ")}`);

  // 用钻取助手找到深层叶子，验证一次点击即选中（回归历史 bug）
  const deepLeaf = await expandUntilVisible("/at/camera_node/get_parameters");
  check("钻取能定位深层服务", Boolean(deepLeaf));
  if (deepLeaf) {
    click(deepLeaf);
    await sleep(700);
    const activeOnce = leaves().some(
      (i) => i.querySelector(".name")?.textContent === "/at/camera_node/get_parameters" && i.classList.contains("active")
    );
    check("深层叶子一次点击即高亮", activeOnce);
    check("右侧标题切到该服务",
      $("viewTitle").textContent.includes("/at/camera_node/get_parameters"),
      $("viewTitle").textContent);
  }

  // 参数 / TF 页签不该显示分组开关
  const pTab2 = [...$("tabs").querySelectorAll(".tab")].find((t) => t.dataset.tab === "params");
  click(pTab2);
  await sleep(400);
  check("参数页签隐藏分组开关", $("groupToggle").style.display === "none");
  const tfTab2 = [...$("tabs").querySelectorAll(".tab")].find((t) => t.dataset.tab === "tf");
  click(tfTab2);
  await sleep(400);
  check("TF 页签隐藏分组开关", $("groupToggle").style.display === "none");

  report();
  process.exit(fail > 0 ? 1 : 0);
})();

function report() {
  console.log("\n" + "═".repeat(50));
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  if (errors.length) {
    console.log(`\n捕获到 ${errors.length} 条运行时错误:`);
    for (const e of errors.slice(0, 12)) console.log("  ! " + e);
  } else {
    console.log("无运行时错误 ✔");
  }
  console.log("═".repeat(50));
}
