/**
 * 扫一遍所有话题，统计哪些**真的在发数据**。
 *
 * 用途：bridge 广播的话题列表 ≠ 有数据的话题列表。机器人没在跑的时候，
 * 一大堆话题挂在列表里但一帧都不出，很容易误以为是面板坏了。
 *
 * 跑法：
 *   node tools/probe-live.mjs                          # 默认 192.168.16.179:8765，每话题 3 秒
 *   node tools/probe-live.mjs 5                        # 每个订 5 秒
 *   node tools/probe-live.mjs 3 192.168.1.50:8765      # 指定 bridge 地址
 */
import { Ros, Topic } from "foxglove-ros-adapter";

const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const DWELL_SEC = Number(args[0]) > 0 ? Number(args[0]) : 3;
const URL = process.env.ROS_BRIDGE_URL ?? (args[1] ? `ws://${args[1].replace(/^ws:\/\//, "")}` : "ws://192.168.16.179:8765");

const ros = new Ros({ url: URL });

const channels = () => [...(ros.channels?.values() ?? [])].filter((c) => c?.topic);

ros.on("connection", () => {
  setTimeout(() => {
    const chans = channels().filter((c) => c.schemaName);
    const skipped = channels().length - chans.length;
    console.log(`已连 ${URL}`);
    console.log(`共 ${channels().length} 个话题${skipped ? `（${skipped} 个无 schema，跳过）` : ""}`);
    console.log(`每话题监听 ${DWELL_SEC} 秒…\n`);

    const counters = new Map();
    const topics = [];

    for (const ch of chans) {
      try {
        const t = new Topic({ ros, name: ch.topic, messageType: ch.schemaName });
        let n = 0;
        t.subscribe(() => { n++; });
        counters.set(ch.topic, () => n);
        topics.push(t);
      } catch (e) {
        counters.set(ch.topic, () => -1); // 订阅失败（schema 无法解析等）
        console.warn(`  ! ${ch.topic} 订阅异常: ${e.message}`);
      }
    }

    setTimeout(() => {
      const rows = [...counters.entries()]
        .map(([name, get]) => ({ name, n: get() }))
        .sort((a, b) => b.n - a.n);

      console.log("帧数（按活跃度排序）：");
      for (const { name, n } of rows) {
        const shown = n < 0 ? "  ERR" : String(n).padStart(5);
        console.log(`  ${shown}  ${name}`);
      }

      const live = rows.filter((r) => r.n > 0);
      const failed = rows.filter((r) => r.n < 0);
      console.log(`\n活跃 ${live.length} / ${rows.length}` + (failed.length ? `（${failed.length} 个订阅报错）` : ""));
      if (!live.length) {
        console.log("\n没有任何话题在发数据 —— 确认机器人侧的节点/驱动是否已启动。");
      }

      for (const t of topics) { try { t.unsubscribe(); } catch {} }
      try { ros.close(); } catch {}
      process.exit(0);
    }, DWELL_SEC * 1000);
  }, 900); // 等 advertise 广播完
});

ros.on("error", (e) => console.error("连接错误:", e?.message ?? e));
setTimeout(() => { console.error(`\n✖ ${URL} 连接超时，先跑 npm run doctor 体检`); process.exit(1); }, (DWELL_SEC + 8) * 1000);
