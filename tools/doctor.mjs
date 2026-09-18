/**
 * 一键体检：从「网络能否到达」到「bridge 是否在监听」到「能不能握手」，
 * 逐层排查，直接给出下一步该做什么。
 *
 * 跑法：
 *   node tools/doctor.mjs                      # 探默认 192.168.16.179:8765
 *   node tools/doctor.mjs 192.168.1.50:8765    # 探指定主机
 *   ROS_BRIDGE_URL=ws://10.0.0.7:8765 node tools/doctor.mjs
 */
import { WebSocket } from "ws";
import { createConnection } from "node:net";

const DEFAULT_TARGET = process.env.ROS_BRIDGE_URL || "ws://192.168.16.179:8765";

/** 把各种写法归一成 { host, port } */
function parseTarget(raw) {
  const s = raw.includes("://") ? raw : `ws://${raw}`;
  const u = new URL(s);
  return { host: u.hostname, port: Number(u.port || 8765), url: `ws://${u.hostname}:${u.port || 8765}` };
}

const ok = (s) => `\x1b[32m✔\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✖\x1b[0m ${s}`;
const warn = (s) => `\x1b[33m!\x1b[0m ${s}`;
const dim = (s) => `\x1b[90m${s}\x1b[0m`;

/** TCP 层探测端口是否有人监听 */
function probeTcp(host, port, timeout = 4000) {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const done = (result) => { try { sock.destroy(); } catch {} resolve(result); };
    sock.setTimeout(timeout);
    sock.on("connect", () => done({ open: true }));
    sock.on("timeout", () => done({ open: false, reason: "超时（端口无响应，可能被防火墙丢包）" }));
    sock.on("error", (e) => done({ open: false, reason: e.code === "ECONNREFUSED" ? "端口未监听（ECONNREFUSED）" : `${e.code ?? e.message}` }));
  });
}

/** 尝试 Foxglove WebSocket 握手 */
function probeWs(url, timeout = 6000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (settled) return; settled = true; try { ws?.close(); } catch {} resolve(r); };
    let ws;
    try {
      // foxglove_bridge 认这两个子协议之一
      ws = new WebSocket(url, ["foxglove.sdk.v1", "foxglove.websocket.v1"]);
    } catch (e) {
      return finish({ ok: false, reason: e.message });
    }
    const timer = setTimeout(() => finish({ ok: false, reason: `握手超时（>${timeout}ms）` }), timeout);
    ws.on("open", () => {
      clearTimeout(timer);
      // 等 serverInfo 帧，确认对面真是 foxglove_bridge
      const infoTimer = setTimeout(() => finish({ ok: true, serverInfo: null }), 2500);
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.op === "serverInfo") {
            clearTimeout(infoTimer);
            finish({ ok: true, serverInfo: msg });
          }
        } catch { /* 忽略非 JSON 帧 */ }
      });
    });
    ws.on("error", (e) => { clearTimeout(timer); finish({ ok: false, reason: e.message }); });
    ws.on("close", (code) => { clearTimeout(timer); finish({ ok: false, reason: `连接被关闭（code ${code}）` }); });
  });
}

/** 发一个原始 HTTP 升级请求，看对端到底回不回话、回什么。
 *  bridge 正常时至少回 `HTTP/1.1 400 Bad Request`；
 *  收到 0 字节直接断开 = 端口上听着的不是 bridge。 */
function probeHandshake(host, port, timeout = 6000) {
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; try { s.destroy(); } catch {} resolve(r); };
    const s = createConnection({ host, port });
    s.setTimeout(timeout);
    s.on("connect", () => {
      s.write([
        "GET / HTTP/1.1",
        `Host: ${host}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Protocol: foxglove.websocket.v1",
        "", "",
      ].join("\r\n"));
    });
    s.on("data", (d) => { buf += d.toString("latin1"); });
    s.on("timeout", () => done({ replied: buf.length > 0, text: buf }));
    s.on("error", () => done({ replied: buf.length > 0, text: buf }));
    s.on("close", () => done({ replied: buf.length > 0, text: buf }));
    setTimeout(() => done({ replied: buf.length > 0, text: buf }), timeout + 500);
  });
}

const target = parseTarget(process.argv[2] || DEFAULT_TARGET);

console.log(`\n体检目标：${target.url}\n${"─".repeat(46)}`);

let failed = false;

// ① 主机可达性
console.log(dim("① 主机可达性"));
console.log(`   目标主机 ${target.host}`);

// ② TCP 端口
console.log(dim("\n② 端口监听"));
const tcp = await probeTcp(target.host, target.port);
if (tcp.open) {
  console.log(ok(`TCP ${target.port} 端口开放`));
} else {
  failed = true;
  console.log(bad(`TCP ${target.port} 不通 — ${tcp.reason}`));
}

// ③ 原始握手：确认端口上听的真是 bridge
console.log(dim("\n③ 对端应答（确认是 foxglove_bridge）"));
let looksLikeBridge = false;
if (!tcp.open) {
  console.log(warn("跳过（端口都不通）"));
} else {
  const hs = await probeHandshake(target.host, target.port);
  if (!hs.replied) {
    console.log(bad("端口能连上，但发请求后对端 0 字节直接断开 — 不像 foxglove_bridge"));
    console.log(dim("   典型原因：端口被别的进程占了 / bridge 启动后又退出了 / 中间有代理或端口转发"));
  } else {
    const firstLine = hs.text.split("\r\n")[0] ?? "";
    looksLikeBridge = /400 Bad Request/.test(hs.text);
    if (looksLikeBridge) {
      console.log(ok(`对端正常应答：${firstLine}`));
      console.log(dim("   （400 是预期的 —— 该端点只接受 WebSocket 升级，不处理普通 GET）"));
    } else {
      console.log(warn(`对端有应答，但不像 foxglove_bridge：${firstLine}`));
      console.log(dim(`   ${hs.text.slice(0, 200).replace(/\r?\n/g, " ")}`));
    }
  }
}

// ④ WebSocket 握手
console.log(dim("\n④ WebSocket 握手"));
if (!tcp.open) {
  console.log(warn("跳过（端口都不通，握手必然失败）"));
} else {
  const ws = await probeWs(target.url);
  if (ws.ok) {
    console.log(ok("握手成功，已收到 serverInfo"));
    const info = ws.serverInfo ?? {};
    const caps = Array.isArray(info.capabilities) ? info.capabilities : [];
    console.log(dim(`   服务名: ${info.name ?? "(未提供)"}`));
    console.log(dim(`   能力: ${caps.length ? caps.join(", ") : "(未提供)"}`));
    if (info.supportedEncodings?.length) {
      console.log(dim(`   编码: ${info.supportedEncodings.join(", ")}`));
    }
  } else {
    failed = true;
    console.log(bad(`握手失败 — ${ws.reason}`));
  }
}

// ⑤ 结论 + 下一步
console.log(`\n${"─".repeat(46)}`);
if (!failed) {
  console.log(ok("结论：连接正常，面板可以直接用。\n"));
} else if (tcp.open && !looksLikeBridge) {
  console.log(bad("结论：8765 端口有人听着，但对面不是 foxglove_bridge（或它已异常）。\n"));
  console.log("   到机器人主机上逐条执行：\n");
  console.log("   1. 看端口到底被谁占了：");
  console.log(dim(`        sudo ss -ltnp | grep ${target.port}`));
  console.log("   2. 看 bridge 进程还在不在：");
  console.log(dim("        ps aux | grep foxglove_bridge"));
  console.log("   3. 若进程已死 —— 看它退出原因并重启：");
  console.log(dim("        ros2 launch foxglove_bridge foxglove_bridge_launch.xml \\"));
  console.log(dim("             port:=8765 include_hidden:=true"));
  console.log("   4. 若端口被无关进程占用 —— 换端口或杀掉占用者：");
  console.log(dim("        ros2 launch foxglove_bridge foxglove_bridge_launch.xml \\"));
  console.log(dim("             port:=8766 include_hidden:=true"));
  console.log(dim(`        # 然后面板地址改成 ws://${target.host}:8766\n`));
} else {
  console.log(bad("结论：连接不通。按下面顺序处理：\n"));
  console.log("   1. 到机器人主机上确认 bridge 进程还在：");
  console.log(dim("        ps aux | grep foxglove_bridge"));
  console.log("   2. 没在跑就启动它（include_hidden 别省）：");
  console.log(dim("        ros2 launch foxglove_bridge foxglove_bridge_launch.xml \\"));
  console.log(dim("             port:=8765 include_hidden:=true"));
  console.log("   3. 在机器人主机本机自测端口有没有真在听：");
  console.log(dim(`        ss -ltnp | grep ${target.port}`));
  console.log("   4. 若本机在听、外面连不上 → 防火墙放行：");
  console.log(dim(`        sudo ufw allow ${target.port}/tcp`));
  console.log("   5. 也可能是 IP 变了，确认机器人当前地址：");
  console.log(dim("        ip -4 addr | grep inet\n"));
}

process.exit(failed ? 1 : 0);
