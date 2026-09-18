/**
 * 绕过适配器，直接读 Foxglove WebSocket 协议的原始 JSON 帧，
 * 看 bridge 到底广播了什么（advertise / serverInfo 等）。
 *
 * 用途：当适配器层行为可疑时（列表数量对不上、话题找不到），
 * 用这层原始视角确认问题出在 bridge 侧还是适配器侧。
 *
 * 跑法：
 *   node tools/raw-advertise.mjs                    # 默认 192.168.16.179:8765
 *   node tools/raw-advertise.mjs 192.168.1.50:8765  # 指定主机
 */
const raw = process.argv[2] ?? process.env.ROS_BRIDGE_URL ?? "ws://192.168.16.179:8765";
const URL = raw.startsWith("ws") ? raw : `ws://${raw}`;

const channels = [];
const services = [];
const ops = {};

const ws = new WebSocket(URL, ["foxglove.sdk.v1", "foxglove.websocket.v1"]);

ws.onopen = () => console.log(`已连 ${URL}\nproto = ${ws.protocol}`);
ws.onerror = (e) => { console.error("连接错误:", e?.message ?? e); process.exit(1); };

ws.onmessage = (e) => {
  const txt = typeof e.data === "string" ? e.data : Buffer.from(e.data).toString("utf8");
  if (txt[0] !== "{") return; // 二进制数据帧，跳过
  let m;
  try { m = JSON.parse(txt); } catch { return; }
  ops[m.op] = (ops[m.op] ?? 0) + 1;

  if (m.op === "advertise") {
    for (const c of m.channels ?? []) channels.push(c);
    for (const s of m.services ?? []) services.push(s);
  }
  if (m.op === "serverInfo") {
    console.log("serverInfo:");
    console.log(`  name: ${m.name ?? "(无)"}`);
    console.log(`  capabilities: ${(m.capabilities ?? []).join(", ") || "(无)"}`);
    if (m.supportedEncodings?.length) console.log(`  encodings: ${m.supportedEncodings.join(", ")}`);
  }
};

setTimeout(() => {
  console.log("\n收到的 op 统计:", JSON.stringify(ops));
  console.log(`\nchannels: ${channels.length}`);
  for (const c of channels) {
    const sch = c.schemaName ?? c.schema ?? "?";
    console.log(`  [${String(c.id).padStart(3)}] ${String(c.topic).padEnd(46)} ${sch}  enc=${c.encoding ?? "?"}`);
  }
  console.log(`\nservices: ${services.length}`);
  for (const s of services.slice(0, 30)) console.log(`  ${s.name}  ${s.type ?? s.schemaName ?? ""}`);
  if (services.length > 30) console.log(`  … 其余 ${services.length - 30} 个省略`);
  process.exit(0);
}, 3000);
