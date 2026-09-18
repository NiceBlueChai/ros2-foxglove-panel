#!/usr/bin/env node
/**
 * 命令行验证工具：连 foxglove_bridge，列出话题/服务/动作，或订阅一条话题打印几帧。
 *
 *   node cli.mjs                              # 列出话题
 *   node cli.mjs --services                   # 列出服务
 *   node cli.mjs --actions                    # 列出动作
 *   node cli.mjs --all                        # 全部清单
 *   node cli.mjs /joint_states                # 订阅该话题打印 5 帧
 *   node cli.mjs /imu sensor_msgs/msg/Imu 10  # 指定类型 + 帧数
 *
 * 地址优先级：命令行 --url=  >  环境变量 ROS_BRIDGE_URL  >  默认 ws://192.168.16.179:8765
 */
import { Ros, Topic } from "foxglove-ros-adapter";

const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith("--url="))?.slice(6);
const URL = urlArg ?? process.env.ROS_BRIDGE_URL ?? "ws://192.168.16.179:8765";

const ros = new Ros({ url: URL });
const log = (...a) => console.log(...a);

const fail = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};

/* ── 清单读取 ── */
const getTopics = () => {
  const out = [];
  for (const ch of ros.channels?.values() ?? []) {
    if (ch?.topic) out.push({ name: ch.topic, type: ch.schemaName ?? "", id: ch.id });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
};

const getServices = () => [...(ros.servicesByName ?? new Map())]
  .map(([name, s]) => ({ name, type: s?.type ?? "" }))
  .sort((a, b) => a.name.localeCompare(b.name));

const getActions = () => {
  const out = [];
  for (const [name, s] of ros.servicesByName ?? new Map()) {
    if (name.endsWith("/_action/send_goal")) {
      out.push({
        name: name.slice(0, -"/_action/send_goal".length),
        type: (s?.type ?? "").replace(/_SendGoal$/, ""),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
};

/* ── 启动 ── */
const boot = setTimeout(() => fail(`8 秒内无法连接 ${URL} —— 检查 bridge 是否在跑、防火墙是否放行`), 8000);

ros.on("error", (e) => log("! error:", e?.message ?? e));

ros.on("connection", () => {
  clearTimeout(boot);
  log(`✔ 已连接 ${URL}\n`);
  setTimeout(run, 900); // 等 advertise 广播
});

function run() {
  const flags = args.filter((a) => a.startsWith("--"));
  const positional = args.filter((a) => !a.startsWith("--"));

  if (flags.includes("--all")) {
    printTopics(); log();
    printServices(); log();
    printActions();
    return done();
  }
  if (flags.includes("--services")) { printServices(); return done(); }
  if (flags.includes("--actions")) { printActions(); return done(); }
  if (positional.length) return subscribeAndPrint(positional);

  printTopics();
  log("\n用法：");
  log("  node cli.mjs <话题名> [消息类型] [帧数]   # 订阅打印");
  log("  node cli.mjs --services | --actions | --all");
  log("  node cli.mjs --url=ws://<主机>:8765 ...   # 指定 bridge 地址");
  done();
}

function printTopics() {
  const list = getTopics();
  log(`话题 ${list.length} 个：`);
  for (const t of list) log(`  ${t.name.padEnd(50)} ${t.type || "(无 schema)"}`);
}

function printServices() {
  const list = getServices();
  log(`服务 ${list.length} 个：`);
  for (const s of list) log(`  ${s.name.padEnd(60)} ${s.type}`);
}

function printActions() {
  const list = getActions();
  log(`动作 ${list.length} 个：`);
  if (!list.length) {
    log("  （无）— 需要 bridge 以 include_hidden:=true 启动");
  }
  for (const a of list) log(`  ${a.name.padEnd(50)} ${a.type}`);
}

function subscribeAndPrint(positional) {
  const [topicArg, typeArg, countArg] = positional;
  const FRAMES = Number(countArg) || 5;

  const hit = getTopics().find((t) => t.name === topicArg);
  const type = typeArg || hit?.type;
  if (!type) fail(`找不到话题 ${topicArg} 的消息类型，请手动传入第二个参数`);

  log(`订阅 ${topicArg}  (${type})，取 ${FRAMES} 帧…\n`);
  const topic = new Topic({ ros, name: topicArg, messageType: type });

  let n = 0;
  const timer = setTimeout(() => fail(`${FRAMES} 帧未收齐（收到 ${n} 帧）——该话题可能不活跃`), 20000);

  topic.subscribe((msg) => {
    n += 1;
    log(`--- frame ${n} ---`);
    // TypedArray 要展开成数组才看得见真实数值
    log(JSON.stringify(msg, (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v);
      return v;
    }, 2));
    if (n >= FRAMES) {
      clearTimeout(timer);
      topic.unsubscribe();
      log(`\n✔ 收到 ${n} 帧，正常退出`);
      ros.close();
      process.exit(0);
    }
  });
}

function done() {
  ros.close();
  process.exit(0);
}

process.on("SIGINT", () => {
  ros.close();
  process.exit(130);
});
