/**
 * 验证 ROS 2 参数相关的服务调用（list_parameters / get_parameters）。
 *
 * 用途：参数面板靠 `<node>/list_parameters` 动态枚举参数名。
 * 若某个节点展开后是空的，用这个脚本单独试它的服务，看是请求格式问题还是服务端问题。
 *
 * 跑法：
 *   node tools/probe-listparams.mjs                       # 自动挑前 2 个参数节点
 *   node tools/probe-listparams.mjs /my_node              # 指定节点
 *   node tools/probe-listparams.mjs /my_node /other_node  # 指定多个
 *   ROS_BRIDGE_URL=ws://10.0.0.7:8765 node tools/probe-listparams.mjs
 */
import { Ros, Service } from "foxglove-ros-adapter";

const URL = process.env.ROS_BRIDGE_URL ?? "ws://192.168.16.179:8765";
const ros = new Ros({ url: URL });

const call = (name, serviceType, request, timeout = 8000) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve({ err: "TIMEOUT" }), timeout);
    try {
      const svc = new Service({ ros, name, serviceType });
      svc.callService(
        request,
        (res) => { clearTimeout(t); resolve({ ok: res }); },
        (e) => { clearTimeout(t); resolve({ err: e?.message ?? String(e) }); },
      );
    } catch (e) { clearTimeout(t); resolve({ err: "THROW " + e.message }); }
  });

const show = (v) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x), 1)?.slice(0, 700);

ros.on("connection", () =>
  setTimeout(async () => {
    const services = ros.servicesByName ?? new Map();

    // 目标节点：命令行指定，否则从服务名反推前 2 个
    let nodes = process.argv.slice(2).filter((a) => a.startsWith("/"));
    if (!nodes.length) {
      nodes = [...services.keys()]
        .filter((n) => n.endsWith("/list_parameters"))
        .map((n) => n.slice(0, -"/list_parameters".length))
        .slice(0, 2);
    }
    if (!nodes.length) {
      console.log("✖ bridge 里没有发现任何 <node>/list_parameters 服务");
      console.log("  —— 说明这些节点没起，或 bridge 没广播其服务。");
      process.exit(1);
    }

    console.log(`已连 ${URL}`);
    console.log(`待测节点：${nodes.join(", ")}\n`);

    for (const node of nodes) {
      const lp = services.get(`${node}/list_parameters`);
      console.log(`=== ${node} ===`);
      if (!lp) {
        console.log(`  ✖ 没有 ${node}/list_parameters 服务，跳过\n`);
        continue;
      }
      console.log(`  type: ${lp.type}`);
      console.log(`  request.schema: ${JSON.stringify(lp.request?.schema)?.slice(0, 300) ?? "(无)"}`);

      // rcl_interfaces/srv/ListParameters 的标准请求是 { prefixes: string[], depth: uint64 }
      for (const req of [{}, { prefixes: [], depth: 0 }, { prefixes: [""], depth: 1 }]) {
        const r = await call(`${node}/list_parameters`, lp.type, req);
        const names = r.ok?.result?.names ?? r.ok?.names;
        console.log(`  req=${JSON.stringify(req)} → ${r.ok ? `${names?.length ?? "?"} 个参数` : "✖ " + r.err}`);
        if (names?.length) console.log(`     ${names.slice(0, 8).join(", ")}${names.length > 8 ? ` … (+${names.length - 8})` : ""}`);
      }
      console.log();
    }
    process.exit(0);
  }, 900),
);

ros.on("error", (e) => console.error("连接错误:", e?.message ?? e));
setTimeout(() => { console.error(`✖ ${URL} 连接超时，先跑 npm run doctor 体检`); process.exit(1); }, 40000);
