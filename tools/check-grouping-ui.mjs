/**
 * 分组 UI 端到端验证：真实 DOM + 真实连接，走服务页签验证
 * 「分组 / 平铺」开关、逐层展开、叶子选中、筛选强制展开。
 *
 * 跑法：
 *   node tools/check-grouping-ui.mjs
 *   ROS_BRIDGE_URL=ws://192.168.1.50:8765 node tools/check-grouping-ui.mjs
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
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
// 指定了 bridge 就写进 localStorage（main.js 的 resolveUrl 会读它）
if (BRIDGE) window.localStorage.setItem("ros.url", BRIDGE);
for (const [key, val] of [
  ["navigator", window.navigator],
  ["location", window.location],
  ["localStorage", window.localStorage],
  ["HTMLElement", window.HTMLElement],
]) {
  try {
    Object.defineProperty(globalThis, key, { value: val, configurable: true, writable: true });
  } catch { /* ignore */ }
}

const errors = [];
window.addEventListener("error", (e) => errors.push("window.error: " + e.message));
const origError = console.error;
console.error = (...a) => { errors.push("console.error: " + a.map(String).join(" ")); origError(...a); };

Object.defineProperty(window.navigator, "clipboard", {
  value: { writeText: async () => {} },
  configurable: true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; log(`  ✔ ${name}`); }
  else { fail++; log(`  ✖ ${name}${detail ? " — " + detail : ""}`); }
};

const $ = (id) => window.document.getElementById(id);
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const heads = () => [...$("list").querySelectorAll(".group-head")];
const items = () => [...$("list").querySelectorAll(".item")];
/** 按 label 找组头（顶层组显示 /at，深层组只显示本段） */
const headByLabel = (label) => heads().find((h) => h.querySelector(".gname")?.textContent === label);
const labels = () => heads().map((h) => h.querySelector(".gname")?.textContent);

(async () => {
  log("=== 加载前端模块 ===");
  try {
    await import(pathToFileURL(resolve(root, "src/main.js")).href);
  } catch (e) {
    log("✖ 模块加载失败:", e.message, "\n", e.stack);
    process.exit(1);
  }
  log("  模块加载成功\n");

  log("=== 1. 建立连接 ===");
  let connected = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if ($("statusDot")?.classList.contains("open")) { connected = true; break; }
  }
  check("状态灯 open", connected, `class=${$("statusDot")?.className}`);
  if (!connected) { report(); process.exit(1); }
  await sleep(2500);

  // 保证从「分组」模式开始
  window.localStorage.setItem("ros.grouped", "1");

  log("\n=== 2. 工具条按钮 ===");
  const toggle = $("groupToggle");
  check("#groupToggle 存在", Boolean(toggle));
  check("话题页签下按钮可见", toggle.style.display !== "none");

  log("\n=== 3. 切到服务页签（分组模式）===");
  const svcTab = [...$("tabs").querySelectorAll(".tab")].find((t) => t.dataset.tab === "services");
  click(svcTab);
  await sleep(700);

  const cServices = Number($("cntServices").textContent);
  check("服务数 > 0", cServices > 0, `实际 ${cServices}`);

  const topHeads = heads();
  check("渲染出组头（数量 > 1）", topHeads.length > 1, `组头数 ${topHeads.length}`);
  check("无展开时列表不直接倒出全部条目",
    items().length === 0 || items().length < cServices,
    `条目 ${items().length} / 总计 ${cServices}`);

  const topLabels = labels();
  log(`  顶层组: ${topLabels.join(", ")}`);
  check("含顶层组 /at", topLabels.includes("/at"), topLabels.join(", "));
  check("含顶层组 /rosapi", topLabels.includes("/rosapi"), topLabels.join(", "));
  check("顶层组名均为绝对路径（以 / 开头）",
    topLabels.every((l) => l.startsWith("/")),
    topLabels.slice(0, 6).join(", "));

  // 顶层组计数之和 + 顶层叶子 = 总数
  const sumCounts = topHeads.reduce((s, h) => s + Number(h.querySelector(".gcount").textContent), 0);
  check("组头计数之和 + 顶层叶子 = 服务总数",
    sumCounts + items().length === cServices,
    `${sumCounts} + ${items().length} vs ${cServices}`);

  const atHead = headByLabel("/at");
  const atCount = atHead ? Number(atHead.querySelector(".gcount").textContent) : -1;
  log(`  /at 组计数: ${atCount}`);
  check("/at 组计数 > 300（服务确实扎堆在 /at 下）", atCount > 300, `at=${atCount} total=${cServices}`);

  log("\n=== 4. 展开顶层组 /at ===");
  click(atHead);
  await sleep(400);
  check("/at 组头切换为 open 类",
    headByLabel("/at")?.classList.contains("open"),
    `class=${headByLabel("/at")?.className}`);

  const subHeads = heads();
  const subLabels = labels();
  check("展开后出现第二层子组", subHeads.length > topHeads.length,
    `${topHeads.length} → ${subHeads.length}`);
  check("出现子组 data 或 robot",
    subLabels.includes("data") || subLabels.includes("robot"),
    subLabels.slice(0, 10).join(", "));
  // 只看嵌套在 /at 组体内部的组头：它们必须是相对段（robot / data …），
  // 顶层那些兄弟组（/rosapi 等）不在 /at 的 body 里，天然带 /，要排除
  const atBody = headByLabel("/at")?.nextElementSibling;
  const nestedLabels = atBody?.classList.contains("group-body")
    ? [...atBody.querySelectorAll(":scope > .group-head .gname")].map((e) => e.textContent)
    : [];
  log(`  嵌套在 /at 内的第二层组: ${nestedLabels.join(", ")}`);
  check("第二层组名是相对段（不含 /）",
    nestedLabels.length > 0 && nestedLabels.every((l) => !l.includes("/")),
    nestedLabels.filter((l) => l.includes("/")).join(", ") || "(空)");

  log("\n=== 5. 展开第二层 /at/robot ===");
  const robotHead = headByLabel("robot");
  check("找到 robot 子组", Boolean(robotHead));
  if (robotHead) {
    const before = items().length;
    click(robotHead);
    await sleep(400);
    check("robot 子组切换为 open 类",
      headByLabel("robot")?.classList.contains("open"),
      `class=${headByLabel("robot")?.className}`);

    const subSub = labels();
    log(`  展开 robot 后的全部组名: ${subSub.join(", ")}`);

    // 叶子应该出现了
    const leafNames = items().map((i) => i.querySelector(".name")?.textContent);
    log(`  叶子数 ${leafNames.length}（展开前 ${before}）`);
    check("展开后出现可点叶子", leafNames.length > before,
      `${before} → ${leafNames.length}`);
    check("叶子名以 /at/robot/ 开头",
      leafNames.length === 0 || leafNames.every((n) => n.startsWith("/at/robot/")),
      leafNames.slice(0, 5).join(", "));

    log("\n=== 6. 点击叶子选中 ===");
    if (leafNames.length) {
      const clickedName = leafNames[0];
      click(items()[0]);
      await sleep(900);
      check("叶子获得 active 类",
        items().some((i) => i.querySelector(".name")?.textContent === clickedName && i.classList.contains("active")),
        `点击的是 ${clickedName}`);
      const meta = $("meta").textContent;
      const svc = $("content").textContent;
      log(`  meta: ${meta}`);
      log(`  content: ${svc.slice(0, 100).replace(/\n/g, " ")}`);
      // meta 显示的是服务类型，服务名在表单/标题里
      const title = $("viewTitle").textContent;
      log(`  viewTitle: ${title}`);
      check("右侧详情区已切换到该服务",
        title.includes(clickedName) || svc.includes(clickedName) || /srv\//.test(meta),
        `title=${title} meta=${meta}`);
      check("生成了请求表单或 schema 展示",
        $("content").querySelectorAll(".field, .code").length > 0);
    }
  }

  log("\n=== 7. 折叠回去 ===");
  if (robotHead) {
    click(headByLabel("robot"));
    await sleep(300);
    check("robot 组已收起", !headByLabel("robot")?.classList.contains("open"));
    const after = items().map((i) => i.querySelector(".name")?.textContent);
    check("收起后该组叶子消失",
      after.every((n) => !n.startsWith("/at/robot/")),
      after.slice(0, 5).join(", "));
  }

  log("\n=== 8. 切到平铺模式 ===");
  click(toggle);
  await sleep(500);
  check("按钮文案变为「平铺」", toggle.textContent === "平铺", toggle.textContent);
  check("平铺模式无组头", heads().length === 0, `组头 ${heads().length}`);
  check(`平铺渲染全部 ${cServices} 项`, items().length === cServices, `实际 ${items().length}`);
  const flatNames = items().map((i) => i.querySelector(".name")?.textContent);
  check("平铺含 /at/camera_node/get_parameters",
    flatNames.includes("/at/camera_node/get_parameters"));

  log("\n=== 9. 切回分组并验证持久化 ===");
  click(toggle);
  await sleep(500);
  check("按钮文案变回「分组」", toggle.textContent === "分组", toggle.textContent);
  check("重新出现组头", heads().length > 1, `${heads().length}`);
  check("展开状态被保留（/at 仍展开）",
    Boolean(headByLabel("/at")?.classList.contains("open")));

  log("\n=== 10. 筛选强制全展开 ===");
  const filter = $("filter");
  filter.value = "move_joint";
  filter.dispatchEvent(new window.Event("input", { bubbles: true }));
  await sleep(500);

  const fNames = items().map((i) => i.querySelector(".name")?.textContent);
  log(`  筛选结果 ${fNames.length} 项: ${fNames.slice(0, 6).join(", ")}`);
  check("筛选命中 /at/robot/move_joint",
    fNames.includes("/at/robot/move_joint"),
    fNames.join(", "));
  check("筛选态下组头也展开（数据可见）",
    heads().every((h) => h.classList.contains("open")) || heads().length === 0);

  filter.value = "";
  filter.dispatchEvent(new window.Event("input", { bubbles: true }));
  await sleep(400);

  log("\n=== 11. 话题/动作页签也支持分组 ===");
  const tTab = [...$("tabs").querySelectorAll(".tab")].find((t) => t.dataset.tab === "topics");
  click(tTab);
  await sleep(600);
  check("话题页签：按钮可见", $("groupToggle").style.display !== "none");
  check("话题页签：渲染出组头或无组（条目少时不分组）",
    heads().length > 0 || items().length > 0,
    `组头 ${heads().length} 条目 ${items().length}`);

  const aTab = [...$("tabs").querySelectorAll(".tab")].find((t) => t.dataset.tab === "actions");
  click(aTab);
  await sleep(600);
  const cActions = Number($("cntActions").textContent);
  log(`  动作总数 ${cActions} · 组头 ${heads().length} · 条目 ${items().length}`);
  check("动作页签：分组按钮可见", $("groupToggle").style.display !== "none");
  // 10 个动作 < 20 阈值 → 按设计回退为平铺，这是预期行为
  check("动作少于 20 项时回退为平铺（设计如此）",
    cActions >= 20 || heads().length === 0,
    `动作 ${cActions} 组头 ${heads().length}`);
  check(`动作页签渲染出 ${cActions} 项`, items().length === cActions, `实际 ${items().length}`);
  check("含 /at/robot/move_joint",
    items().map((i) => i.querySelector(".name")?.textContent).includes("/at/robot/move_joint"));

  const pTab = [...$("tabs").querySelectorAll(".tab")].find((t) => t.dataset.tab === "params");
  click(pTab);
  await sleep(600);
  check("参数页签：分组按钮隐藏", $("groupToggle").style.display === "none");

  const tfTab = [...$("tabs").querySelectorAll(".tab")].find((t) => t.dataset.tab === "tf");
  click(tfTab);
  await sleep(600);
  check("TF 页签：分组按钮隐藏", $("groupToggle").style.display === "none");

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
