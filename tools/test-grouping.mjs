/* 单测 buildTree / renderTree 的分组逻辑（不依赖网络与 DOM 渲染细节） */
import { buildTree } from "../src/grouping.js";

const items = [
  { name: "/at/robot/move_joint" },
  { name: "/at/robot/move_line" },
  { name: "/at/robot/get_pos" },
  { name: "/at/data/process_list_query" },
  { name: "/at/data/oem_query" },
  { name: "/at/system/status" },
  { name: "/rosapi/topics" },
  { name: "/rosapi/nodes" },
  { name: "/tf" },
  { name: "/client_count" },
];

const t = buildTree(items, (x) => x.name);

function dump(node, indent = 0) {
  const pad = "  ".repeat(indent);
  console.log(`${pad}${node.label}  (${node.count})  full=${node.full}`);
  for (const c of node.nodes) dump(c, indent + 1);
  for (const l of node.leaves) console.log(`${pad}  · ${l.name}`);
}

console.log("=== 顶层组 ===");
for (const n of t.nodes) dump(n);
console.log("\n=== 顶层叶子 ===");
for (const l of t.leaves) console.log("  · " + l.name);

// 断言
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ✔ " + name); }
  else { fail++; console.log("  ✖ " + name + (detail ? " — " + detail : "")); }
};

console.log("\n=== 断言 ===");
const at = t.nodes.find((n) => n.label === "at");
check("顶层有 at 组", Boolean(at));
check("at 组 6 项 (robot 3 + data 2 + system 1)", at?.count === 6, `实际 ${at?.count}`);

const robot = at?.nodes.find((n) => n.label === "robot");
check("at 下有 robot 子组", Boolean(robot));
check("robot 子组 3 项", robot?.count === 3, `实际 ${robot?.count}`);
check("robot 下有 3 个叶子（move_joint/move_line/get_pos）",
  robot?.leaves.length === 3,
  `实际 ${robot?.leaves.map(l => l.name).join(", ")}`);
check("robot 的 full 路径正确", robot?.full === "/at/robot", `实际 ${robot?.full}`);

const data = at?.nodes.find((n) => n.label === "data");
check("at 下有 data 子组", Boolean(data));
check("data 子组 2 项", data?.count === 2, `实际 ${data?.count}`);

const rosapi = t.nodes.find((n) => n.label === "rosapi");
check("顶层有 rosapi 组", Boolean(rosapi));
check("rosapi 下叶子直接落地（深度不够再拆）", rosapi?.leaves.length === 2,
  `实际 ${rosapi?.leaves.length}`);

check("根命名空间条目 /tf 落地在顶层叶子",
  t.leaves.some((l) => l.name === "/tf"),
  `顶层叶子: ${t.leaves.map(l => l.name).join(", ")}`);
check("根命名空间条目 /client_count 落地在顶层叶子",
  t.leaves.some((l) => l.name === "/client_count"));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
