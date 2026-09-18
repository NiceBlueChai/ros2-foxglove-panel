# ROS 2 Foxglove 控制面板

[English](README.md) · **简体中文**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)
![No ROS required](https://img.shields.io/badge/ROS_installation-not_required-success.svg)

基于 [`foxglove-ros-adapter`](https://github.com/noah-wardlow/foxglove-ros-adapter) **直连**
`foxglove_bridge`，替代 `roslibjs` + `rosbridge_server` 的组合，
走 Foxglove WebSocket 协议 + CDR 二进制帧。

覆盖话题 / 服务 / 参数 / 动作 / TF 五类能力，不依赖 ROS 环境、不依赖特定机器人 ——
纯浏览器端，填入任意 `foxglove_bridge` 地址即可对接任意 ROS 2 系统。

| | |
|---|---|
| **协议** | Foxglove WebSocket（`foxglove.sdk.v1`）+ CDR 二进制帧 |
| **核心依赖** | [`foxglove-ros-adapter`](https://github.com/noah-wardlow/foxglove-ros-adapter)，`roslib` 的 drop-in 替代品 |
| **运行环境** | 纯浏览器端，Node.js ≥ 18 仅用于开发与构建 |
| **许可证** | [MIT](LICENSE) |

**默认地址**：`ws://192.168.16.179:8765`（可在运行时或构建时覆盖，见[第 5 节](#5-填-bridge-地址)）

> **为什么不用 roslibjs？** `roslibjs` + `rosbridge_server` 那条路传的是 JSON 序列化消息，
> 且要在机器人上多跑一个 Python 进程。直连 `foxglove_bridge` 拿到的是 CDR 二进制帧
> （带宽占用小得多），并且服务 / 动作 / 参数的完整自省能力都是现成的，
> 机器人侧还少一个进程要维护。

## 快速开始

### 0. 前置条件

只需要 Node.js ≥ 18（实测 22.22.2 可用）。本地**不需要**装 ROS。

```bash
node -v     # 应输出 v18 以上
```

### 1. 装依赖

```bash
npm install
```

> 若报 `ERESOLVE`，说明 `@foxglove/rosmsg2-serialization` 版本不对，
> 必须是 `^3.0.0`（见下方[「踩过的坑 5」](#5-peer-依赖版本要对齐)）。

### 2. 在机器人/主机上启动 bridge

如果你的机器上还没跑 `foxglove_bridge`：

```bash
sudo apt install ros-$ROS_DISTRO-foxglove-bridge

ros2 launch foxglove_bridge foxglove_bridge_launch.xml port:=8765 include_hidden:=true
```

`include_hidden:=true` **不能省** —— 否则 Actions 相关的隐藏服务与话题不会广播到
WebSocket（`ros2 action list` 仍然看得到，因为那条路走 DDS，容易误判）。

### 3. 体检连接

```bash
npm run doctor
# 或指定地址
node tools/doctor.mjs 192.168.1.50:8765
```

四层逐级探测（主机 → 端口 → 对端应答 → WebSocket 握手），不通时直接给出该敲的命令。

一切正常时长这样：

```
✔ TCP 8765 端口开放
✔ 对端正常应答：HTTP/1.1 400 Bad Request      ← 400 是预期的
✔ 握手成功，已收到 serverInfo
✔ 结论：连接正常，面板可以直接用。
```

> 若报 **「端口能连上，但发请求后对端 0 字节直接断开」**：说明该端口上听着的不是
> foxglove_bridge（端口被占 / bridge 已退出 / 中间有代理），按脚本输出的命令排查。

### 4. 启动

```bash
npm run dev
```

```
  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.x.x:5173/
```

浏览器打开 **http://localhost:5173/**，顶栏状态灯变**绿**即为连接成功。
`dev` 脚本已带 `--host`，同局域网其他机器可用 `Network` 那行的地址访问。

### 5. 填 bridge 地址

默认连 **`ws://192.168.16.179:8765`**（写死在 `src/ros.js` 的 `DEFAULT_URL`，
可用 `.env.local` 覆盖）。换别的 bridge 用下面任意一种：

| 优先级 | 方式 | 做法 |
|---|---|---|
| 1 | URL 参数 | `http://localhost:5173/?host=192.168.1.50:8765` |
| 2 | localStorage | 顶栏输入框填过就自动记住，下次打开复用 |
| 3 | 构建时注入 | `.env.local` 写 `VITE_ROS_BRIDGE_URL=ws://192.168.1.50:8765` 后重新 `npm run build` |
| 4 | 改源码 | 改 `src/ros.js` 的 `DEFAULT_URL` 一个常量 |

前两种是运行时的，改完立刻生效；后两种适合固定部署。
`?host=` 可省略 `ws://` 前缀，脚本会自动补。

命令行工具同理，优先级是 `--url=` > `ROS_BRIDGE_URL` > 默认值：

```bash
node cli.mjs --url=ws://192.168.1.50:8765 --all
ROS_BRIDGE_URL=ws://192.168.1.50:8765 node cli.mjs --all
```

`tools/` 下的脚本参数形式类似，多数也接受直接传地址：
`node tools/doctor.mjs 192.168.1.50:8765`

### 6. 生产构建（可选）

```bash
npm run build      # 产物输出到 dist/
npm run preview    # 本地预览构建产物
```

`dist/` 是纯静态文件，扔到任意 Web 服务器（nginx / `python -m http.server`）即可。
部署到别的环境时，记得把 `VITE_ROS_BRIDGE_URL` 写进 `.env.local` 再构建，
或运行时用 `?host=` 指定。

## 功能

五个页签：

| 页签 | 能力 |
|---|---|
| **话题** | 列出全部 channel；订阅实时解码；JSON 预览（10Hz 节流）；数值数组自动柱状图；暂停/录制/复制 |
| **服务** | 列出全部服务；**按 .srv schema 自动生成请求表单**；调用并展示响应耗时 |
| **参数** | 从服务名反推节点；展开时调 `list_parameters` **动态枚举真实参数**；读取/写入 |
| **动作** | 列出全部 action；发送 goal、实时反馈、结果、取消 |
| **TF 帧树** | 订阅 `/tf` + `/tf_static`，构建父子帧树，查看变换矩阵 |

列表左侧工具条有「**分组 / 平铺**」开关（状态存 localStorage）：开启时按 ROS 命名空间
逐层钻取（`/ns` → `sub` → `leaf`），点组头展开/收起，组头右侧显示条目数；
筛选时自动强制展开所有命中路径。条目少于 20 项时自动回退平铺，避免过度分组。

数值视图遵循中文习惯：**正红负绿**，零值灰。

## 命令行工具

```bash
node cli.mjs                              # 列出所有话题
node cli.mjs --services                   # 列出服务
node cli.mjs --all                        # 全部清单
node cli.mjs /rosout                      # 订阅并打印 5 帧
node cli.mjs /rosout rcl_interfaces/msg/Log 20
node cli.mjs --url=ws://192.168.1.50:8765 --all
```

## 排障脚本

`tools/` 下的脚本，遇到问题时按顺序尝试：

| 脚本 | 用途 |
|---|---|
| `npm run doctor` | **连接体检**（主机/端口/对端应答/握手 四层），不通时给下一步命令 |
| `node tools/raw-advertise.mjs [主机:端口]` | 绕过适配器读原始协议帧，确认 bridge 到底广播了什么 |
| `node tools/probe-live.mjs [秒数] [主机:端口]` | 扫全部话题，找出**哪些真的在发数据** |
| `node tools/probe-listparams.mjs [节点…]` | 试 `list_parameters`，排查参数枚举为空的问题 |

```bash
node tools/doctor.mjs 192.168.1.50:8765
node tools/probe-live.mjs 5 192.168.1.50:8765       # 每话题监听 5 秒
node tools/probe-listparams.mjs /my_node
ROS_BRIDGE_URL=ws://192.168.1.50:8765 node tools/raw-advertise.mjs
```

### 自动化测试

```bash
npm run test:offline              # 不需要连 bridge（地址推断 + 分组逻辑）
npm test                          # 全部（需要 bridge 可达）
npm run test:e2e                  # 端到端：真实连接 + 真实 DOM
npm run test:grouping             # 分组交互 + 纯逻辑单测
```

| 套件 | 需要 bridge | 说明 |
|---|---|---|
| `tools/check-url.mjs` | 否 | 验证地址解析优先级（7 断言） |
| `tools/test-grouping.mjs` | 否 | 命名空间树纯逻辑（12 断言） |
| `tools/e2e.mjs` | **是** | 五页签 + 订阅 + 服务调用 + 参数（60 断言） |
| `tools/check-grouping-ui.mjs` | **是** | 分组交互（41 断言） |

端到端套件用 **jsdom** 加载真实 `index.html` 和前端模块，会真的去连 bridge 并模拟点击。
换个 bridge 就跑：`ROS_BRIDGE_URL=ws://192.168.1.50:8765 npm run test:e2e`。

> 端到端测试里针对特定系统写了一些断言（话题名、服务名、动作数）。
> 换到别的机器人上会大量失败 —— 那是预期的，改断言即可，**逻辑本身是通用的**。
> 不想改就让 `npm run test:offline` 只跑通用部分。

## 关键实现说明（踩过的坑）

这些都是适配器或协议层面的坑，跟具体机器人无关，换任何 ROS 2 系统都会遇到。

### 1. `getTopicsForType()` 不支持通配符

适配器实现是**精确类型匹配**：

```js
getTopicsForType(messageType, onSuccess) {
  const canonical = normalizeRosType(messageType, "msg");
  for (const ch of this.channels.values()) {
    if (normalizeRosType(ch.schemaName, "msg") === canonical) topics.push(ch.topic);
  }
}
```

传 `"*"` 会静默返回 `[]`，极易误判成「bridge 没广播话题」。
列全量话题请直接读 `ros.channels`（`Map<channelId, channel>`，`advertise` 帧到达时填充）。

### 2. 解码后的定长数组是 **TypedArray**，不是普通对象

`float64[6]` 解码出来是 `Float64Array`，不是 `{"0":0,...}`。判断时若用
`typeof v === "object" && !ArrayBuffer.isView(v)` 就会把它漏掉（本项目踩过，导致柱状图一直空白）。

统一处理三种形态：

```js
if (ArrayBuffer.isView(v)) → Array.from(v)     // TypedArray（主路径）
else if (Array.isArray(v)) → v                 // 普通数组
else if (数字键对象)       → 按 key 排序取值    // JSON 化之后
```

同理，`JSON.stringify(Float64Array)` 会输出 `{"0":0,...}` 而不是数组，
所以 `toJson()` 里要显式展开，否则页面显示不出真实数值、字节数也算成 0。

### 3. 服务的请求定义在 `service.request`，不在 `service.schema`

```
service.request = { encoding, schemaName, schemaEncoding, schema }
service.response = { ... }
```

`schema` 是完整的 `.srv` 展开（含 `====` 分隔线和 `MSG:` 依赖段），
解析顶层请求字段时必须**在第一个 `====` 处截断**，否则会把依赖类型当成字段。

部分 bridge 版本对 `/rosapi/*` 服务只广播 response 定义、request 为空字符串，
这类服务无法自动生成表单，页面会明确提示。

### 4. 参数列表要动态枚举，不要硬编码

ROS 2 每个节点自带 `<node>/list_parameters` 服务，空请求 `{}` 就能拿到真实参数名：

```js
new Service({ ros, name: `${node}/list_parameters`,
              serviceType: "rcl_interfaces/srv/ListParameters_Request" })
  .callService({}, res => res.result.names)   // string[]
```

节点名从 `<node>/get_parameters` 这类服务反推（bridge 无节点列表接口）。
注意节点名可能是多级路径（如 `/ns/sub/node`），正则要贪婪匹配到最后一个 `/`。

### 5. peer 依赖版本要对齐

`foxglove-ros-adapter@0.5.1` 要求 `@foxglove/rosmsg2-serialization@^3.0.0`，
装成 1.x 会触发 `ERESOLVE`。

### 6. `ROS2TFClient` 在无 TF 数据时会抛错

内部对空值没兜住（`Cannot read properties of undefined (reading 'replace')`），
本项目不依赖它，自行订阅 `/tf` / `/tf_static` 维护帧树。

### 7. 适配器无视 `channel.encoding`，JSON 话题必然解析失败

`createSubscription()` 无条件构造 CDR 的 `MessageReader`：

```js
createSubscription(channel, callback) {
  const reader = this.getReader(channel.schemaName, channel.schema);  // 只用 rosmsg 解 CDR
  ...
}
```

但 bridge 会广播**内置的 JSON 编码话题**，最典型的是 `/foxglove_bridge/sysinfo`：

```
topic=/foxglove_bridge/sysinfo
schemaName=foxglove.SystemInfo
encoding="json"
schema={"$schema":"https://json-schema.org/draft/2020-12/schema", ...}
```

`schema` 是 **JSON-Schema 文本**，喂给只认 ROS `.msg` 语法的 rosmsg 解析器，
必然抛 `Could not parse line: '{'`（被适配器 try/catch 吞成 `console.warn`，
表现为「订阅成功但永远 0 帧」，极难定位）。

`src/json-channels.js` 在 `new Ros()` 后立刻打补丁：判定 `encoding === "json"`
就换成 `JSON.parse(new TextDecoder().decode(data))`，绕开 CDR reader。
这是通用问题 —— 凡是用 foxglove_bridge 的项目都会遇到。

### 8. 高亮状态只能有一个数据源

「点两次才高亮」的根因是 `selected` 在 `main.js` 和 `panel-params.js` 里各存一份、互不同步：
第一次点击只更新了主模块的变量，面板读的是自己那份旧值，第二次才追上。

修法：面板不持有选中态，改由主模块注入判断函数。

```js
// main.js
params.bindParamList({
  isParamSelected: (node, name) => selected?.node === node && selected?.name === name,
});
```

`src/style.css` 里也补了 `.list .item.active` / `.param-row.active` 两级选择器兜底，
避免分组容器内样式不生效。

### 9. 分组渲染会让「列表项数」不再等于「条目总数」

叶子藏在折叠组里，`querySelectorAll(".item").length` 只统计**可见**部分。
写断言时要用「组头计数之和 + 顶层叶子数 = 总数」校验覆盖完整性，
按名点选前先切平铺或逐层展开（`tools/e2e.mjs` 里的 `expandUntilVisible()`）。

## 已知限制

- bridge 未授权 `clientPublish` 时，本面板只做订阅与控制调用，不发布自定义话题
- 无 schema 的话题无法解码，页面会标注
- `Topic#advertise()` / `unadvertise()` 是 no-op，首次 `publish()` 时惰性 advertise
- `compression` / `queue_size` / `latch` / `reconnect_on_close` 仅接受但被忽略
- 客户端无法 advertise service（bridge 只暴露服务端服务）
- `/rosapi/*` 部分服务无 request 定义，无法调用

## 目录结构

```
.
├── index.html            单页结构（五页签）
├── cli.mjs               命令行工具
├── src/
│   ├── main.js           入口：连接、计数、列表渲染调度、页签切换
│   ├── ros.js            连接（含自动重连）与话题/服务/动作清单
│   ├── json-channels.js  补丁：修复适配器不认 JSON 编码话题的问题
│   ├── grouping.js       命名空间树构建与可钻取列表渲染
│   ├── schema.js         .srv / .msg 定义解析
│   ├── service-call.js   共享的服务调用封装
│   ├── util.js           toJson / 节流 / 速率计 等通用工具
│   ├── panel-topics.js   话题面板
│   ├── panel-services.js 服务面板
│   ├── panel-params.js   参数面板
│   ├── panel-actions.js  动作面板
│   ├── panel-tf.js       TF 帧树
│   └── style.css
├── tools/                doctor + 排障脚本 + 自动化测试
└── dist/                 构建产物（已 gitignore，不提交）
```

## 贡献

欢迎 Issue / PR。改动前端逻辑后请先跑 `npm run test:offline`（离线，不需要 bridge）；
手边有 bridge 的话跑 `npm test` 更稳妥。新增的通用坑欢迎补进[「踩过的坑」](#关键实现说明踩过的坑)一节 ——
这一节是本文档最有价值的部分。

## 许可证

[MIT](LICENSE) © 2026 NiceBlueChai

## 致谢

- [foxglove-ros-adapter](https://github.com/noah-wardlow/foxglove-ros-adapter) —— 本项目的地基
- [Foxglove](https://foxglove.dev/) —— WebSocket 协议与 `foxglove_bridge`
