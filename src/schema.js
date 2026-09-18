/**
 * ROS 2 msg 定义字符串（ros2msg / IDL）→ 表单字段描述
 *
 * 输入形如：
 *   string[] names
 *   int32 mode 0
 *   geometry_msgs/msg/Point position
 *   float64[6] joint
 *
 * 输出 [{ name, baseType, isArray, arrayLen, defaultValue, path }]
 */

const PRIMITIVES = new Set([
  "bool", "byte", "char", "float32", "float64", "int8", "uint8",
  "int16", "uint16", "int32", "uint32", "int64", "uint64", "string", "wstring",
]);

export function isPrimitive(type) {
  return PRIMITIVES.has(type);
}

/** 数值型字段 → 默认 0；bool → false；string → "" */
export function defaultFor(baseType) {
  if (baseType === "bool") return false;
  if (baseType === "string" || baseType === "wstring") return "";
  if (isPrimitive(baseType)) return 0;
  return null;
}

/**
 * 解析 msg 定义，只取**顶层请求字段**。
 *
 * foxglove_bridge 给出的 request schema 是完整的 .srv 展开，形如：
 *
 *   string target_frame
 *   float64[3] point
 *   ================================================================================
 *   MSG: geometry_msgs/Point
 *   float64 x
 *   ...
 *
 * 第一个 `===` 之前才是请求本体，之后的都是依赖类型定义，必须截断丢弃。
 */
export function parseMessageSchema(schemaText) {
  const fields = [];
  if (typeof schemaText !== "string" || !schemaText.trim()) {
    return { fields, hasTopLevelFields: false };
  }

  // 1) 截断 `====` 分隔线之后的依赖类型展开（ROS 2 .srv/.msg 的拼接格式）
  let body = schemaText;
  const sep = body.search(/^={10,}\s*$/m);
  if (sep !== -1) body = body.slice(0, sep);

  // 2) 去掉 `MSG: pkg/Type` 之类的残留标记行
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter((l) => l && !l.startsWith("=") && !/^MSG:/i.test(l));

  for (const line of lines) {
    // type name  [default]
    const m = line.match(/^(\S+?)(\[(\d*)\])?\s+(\w+)\s*(.*)$/);
    if (!m) continue;

    const [, rawType, , arrLen, name, rest] = m;

    // 裸写 "std_msgs/Empty request" 这类，right-hand 不是字段名 → 跳过
    if (name === "request" && rawType.includes("/")) continue;

    const hashIdx = rawType.lastIndexOf("/");
    const baseType = hashIdx >= 0 ? rawType.slice(hashIdx + 1) : rawType;

    const isArray = arrLen !== undefined || rawType.includes("[");
    const fixedLen = arrLen && arrLen !== "" ? Number(arrLen) : null;

    let defaultValue = rest?.trim() ?? "";
    if (defaultValue === "") {
      defaultValue = isArray ? "" : String(defaultFor(baseType) ?? "");
    }

    fields.push({
      name,
      fullType: rawType,
      baseType,
      isArray,
      arrayLen: fixedLen,
      isNested: !isPrimitive(baseType) && !isArray,
      rawDefault: defaultValue,
    });
  }

  return { fields, hasTopLevelFields: fields.length > 0 };
}

/** 把 schemaName 里的服务类型还原为 request 类型 */
export function normalizeRequestType(serviceType) {
  if (!serviceType) return "";
  return serviceType.endsWith("_Request") ? serviceType : `${serviceType}_Request`;
}
