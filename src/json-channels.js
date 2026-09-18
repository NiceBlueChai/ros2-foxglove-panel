/**
 * foxglove-ros-adapter@0.5.1 的 JSON-encoding 补丁。
 *
 * 问题：`Ros.createSubscription(channel, cb)` 无条件用 `@foxglove/rosmsg` 的
 * MessageReader（CDR 二进制）来解析消息，完全忽略了 `channel.encoding`。
 * 而 foxglove_bridge 会广播一类 **JSON 编码**的内置话题：
 *
 *   /foxglove_bridge/sysinfo   schemaName=foxglove.SystemInfo  encoding="json"
 *
 * 它的 `schema` 是 JSON-Schema 文本（以 `{` 开头），喂给只认 ROS .msg 语法的
 * rosmsg 解析器必然抛 `Could not parse line: '{'`，订阅永远收不到数据。
 *
 * 处理：在适配器实例上包一层 createSubscription —— 判定为 json 编码时，
 * 直接把 payload 按 UTF-8 解码成 JSON 返回，绕开 CDR reader。
 *
 * 用法：`new Ros(...)` 之后立刻调用 `patchJsonChannels(ros)`。
 */

/** 判定某个 channel 是不是「JSON 编码」而非 CDR */
function isJsonChannel(channel) {
  if (!channel) return false;
  if (channel.encoding === "json") return true;
  // 兼容：有些版本把编码放 schemaEncoding，或只有 JSON-Schema 文本
  if (channel.schemaEncoding === "jsonschema") return true;
  const schema = typeof channel.schema === "string" ? channel.schema.trimStart() : "";
  return schema.startsWith("{") && /"\$schema"|"title"|"type"\s*:/.test(schema);
}

/** 识别适配器内部的订阅表（不同小版本字段名略有出入，做兼容查找） */
function findSubscriptionTable(ros) {
  for (const key of ["subscriptions", "_subscriptions"]) {
    const t = ros?.[key];
    if (t instanceof Map) return t;
  }
  return null;
}

/**
 * 给适配器打补丁。幂等：重复调用只打一次。
 * @param {object} ros  `new Ros({url})` 的实例
 * @returns {object} 同一个实例（便于链式调用）
 */
export function patchJsonChannels(ros) {
  if (!ros || ros.__jsonChannelPatched) return ros;
  ros.__jsonChannelPatched = true;

  const original = ros.createSubscription?.bind(ros);
  const subscriptions = findSubscriptionTable(ros);

  if (typeof original !== "function" || !subscriptions) {
    // 找不到内部结构就静默跳过，不影响其余功能
    console.warn("[json-channel] 适配器内部结构不符合预期，跳过补丁");
    return ros;
  }

  ros.createSubscription = function createSubscription(channel, callback) {
    if (!isJsonChannel(channel)) return original(channel, callback);

    // 自己建订阅：复用协议层，但 reader 换成 JSON 解码
    const subscriptionId = this.protocol.subscribe(channel.id);
    const sub = {
      subscriptionId,
      channelId: channel.id,
      callbacks: new Set([callback]),
      // 与 CDR reader 保持同样的接口面，只是解码方式不同
      reader: {
        readMessage(data) {
          const text = new TextDecoder().decode(data);
          return JSON.parse(text);
        },
      },
    };
    subscriptions.set(subscriptionId, sub);

    // 让协议的 message 事件能找到这条订阅（适配器在 handler 里查同一张表）
    for (const key of ["subscriptionsByTopic", "_subscriptionsByTopic"]) {
      const byTopic = this[key];
      if (byTopic instanceof Map) { byTopic.set(channel.topic, sub); break; }
    }
    return sub;
  };

  return ros;
}

/** 列出当前连接里所有 JSON 编码的话题（调试用） */
export function listJsonChannels(ros) {
  const out = [];
  for (const ch of ros?.channels?.values() ?? []) {
    if (isJsonChannel(ch)) out.push({ topic: ch.topic, schemaName: ch.schemaName, encoding: ch.encoding });
  }
  return out;
}
