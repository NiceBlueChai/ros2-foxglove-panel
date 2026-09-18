# ROS 2 Foxglove Panel

**English** · [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)
![No ROS required](https://img.shields.io/badge/ROS_installation-not_required-success.svg)

A zero-install web control panel for ROS 2. It talks **directly** to `foxglove_bridge` over the
Foxglove WebSocket protocol with CDR-encoded binary frames — no `roslibjs`, no `rosbridge_server`,
no ROS installation on the client.

Topics, services, parameters, actions and the TF tree — all in the browser. Point it at any
`foxglove_bridge` endpoint and it works.

| | |
|---|---|
| **Protocol** | Foxglove WebSocket (`foxglove.sdk.v1`) + CDR binary frames |
| **Core dependency** | [`foxglove-ros-adapter`](https://github.com/noah-wardlow/foxglove-ros-adapter) — a drop-in `roslib` replacement |
| **Runtime** | Browser only. Node.js ≥ 18 is needed for dev/build, not at runtime |
| **License** | [MIT](LICENSE) |

**Default endpoint**: `ws://192.168.16.179:8765` — overridable at runtime or build time, see
[section 5](#5-point-it-at-your-bridge).

> **Why not roslibjs?** The `roslibjs` + `rosbridge_server` stack ships JSON-serialized messages
> and needs a Python bridge on the robot. Going straight to `foxglove_bridge` gets you CDR binary
> frames (much lighter on bandwidth), full service/action/parameter introspection, and one less
> process to run on the robot.

## Quick Start

### 0. Prerequisites

Node.js ≥ 18 (tested on 22.22.2). You do **not** need ROS installed locally.

```bash
node -v     # should print v18 or above
```

### 1. Install dependencies

```bash
npm install
```

> If you hit `ERESOLVE`, your `@foxglove/rosmsg2-serialization` version is wrong — it must be
> `^3.0.0`. See [pitfall 5](#5-peer-dependency-versions-must-align).

### 2. Start the bridge on your robot / host

If `foxglove_bridge` isn't already running there:

```bash
sudo apt install ros-$ROS_DISTRO-foxglove-bridge

ros2 launch foxglove_bridge foxglove_bridge_launch.xml port:=8765 include_hidden:=true
```

`include_hidden:=true` is **not optional**. Without it, the hidden services and topics that back
ROS 2 actions are never advertised over the WebSocket. Note that `ros2 action list` will still
show your actions, because that path goes through DDS — a very easy way to misdiagnose.

### 3. Check the connection

```bash
npm run doctor
# or target a specific host
node tools/doctor.mjs 192.168.1.50:8765
```

Four-layer probe (host → port → peer response → WebSocket handshake). When something fails it
prints the exact command you should run next.

A healthy run looks like this:

```
✔ TCP port 8765 is open
✔ Peer responds: HTTP/1.1 400 Bad Request      ← 400 is expected here
✔ Handshake OK, serverInfo received
✔ Verdict: connection is healthy, the panel is ready.
```

> If you see **"port is reachable but the peer closes the connection with 0 bytes"**, whatever is
> listening on that port is *not* `foxglove_bridge` — the port is taken, the bridge exited, or a
> proxy sits in between. Follow the commands the script prints.

### 4. Run it

```bash
npm run dev
```

```
  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.x.x:5173/
```

Open **http://localhost:5173/**. The status light in the header turning **green** means you're
connected. The `dev` script already passes `--host`, so other machines on your LAN can use the
`Network` address.

### 5. Point it at your bridge

The default is **`ws://192.168.16.179:8765`**, hardcoded as `DEFAULT_URL` in `src/ros.js`.
Use any of the following to target a different bridge:

| Priority | Method | How |
|---|---|---|
| 1 | URL parameter | `http://localhost:5173/?host=192.168.1.50:8765` |
| 2 | localStorage | Type it into the header input once — it's remembered for next time |
| 3 | Build-time injection | Put `VITE_ROS_BRIDGE_URL=ws://192.168.1.50:8765` in `.env.local`, then `npm run build` |
| 4 | Source edit | Change the `DEFAULT_URL` constant in `src/ros.js` |

The first two apply at runtime and take effect immediately; the last two suit fixed deployments.
`?host=` may omit the `ws://` prefix — it's added automatically.

The CLI follows the same idea: `--url=` beats `ROS_BRIDGE_URL` beats the default.

```bash
node cli.mjs --url=ws://192.168.1.50:8765 --all
ROS_BRIDGE_URL=ws://192.168.1.50:8765 node cli.mjs --all
```

Scripts under `tools/` take arguments the same way, and most also accept a bare address:
`node tools/doctor.mjs 192.168.1.50:8765`

### 6. Production build (optional)

```bash
npm run build      # output goes to dist/
npm run preview    # preview the build locally
```

`dist/` is plain static files — drop it on any web server (nginx, `python -m http.server`, …).
When deploying to a different environment, either set `VITE_ROS_BRIDGE_URL` in `.env.local` before
building, or pass `?host=` at runtime.

## Features

Five tabs:

| Tab | What it does |
|---|---|
| **Topics** | Lists every channel; live decoded subscription; JSON preview (throttled to 10 Hz); automatic bar chart for numeric arrays; pause / record / copy |
| **Services** | Lists every service; **auto-generates the request form from the `.srv` schema**; calls it and shows the round-trip time |
| **Parameters** | Derives node names from service names; calls `list_parameters` on expand to **dynamically enumerate real params**; read and write |
| **Actions** | Lists every action; send a goal, stream feedback, get the result, cancel |
| **TF tree** | Subscribes to `/tf` + `/tf_static`, builds the parent/child frame tree, inspect transform matrices |

The toolbar above each list has a **Grouped / Flat** toggle (persisted to localStorage). In grouped
mode entries are drilled down by ROS namespace level by level (`/ns` → `sub` → `leaf`), group
headers expand/collapse on click and show the entry count. Filtering force-expands every matching
path. Lists shorter than 20 entries fall back to flat automatically, to avoid over-grouping.

Numeric views follow the Chinese market convention: **positive red, negative green**, zero grey.

## CLI

```bash
node cli.mjs                              # list all topics
node cli.mjs --services                   # list services
node cli.mjs --all                        # everything
node cli.mjs /rosout                      # subscribe and print 5 frames
node cli.mjs /rosout rcl_interfaces/msg/Log 20
node cli.mjs --url=ws://192.168.1.50:8765 --all
```

## Diagnostic scripts

Try these in order when something is off:

| Script | Purpose |
|---|---|
| `npm run doctor` | **Connection health check** (host / port / peer response / handshake). Prints the next command to run on failure |
| `node tools/raw-advertise.mjs [host:port]` | Reads raw protocol frames, bypassing the adapter, to see what the bridge actually advertises |
| `node tools/probe-live.mjs [seconds] [host:port]` | Scans every topic to find **which ones are actually publishing** |
| `node tools/probe-listparams.mjs [node…]` | Exercises `list_parameters` to debug empty parameter enumeration |

```bash
node tools/doctor.mjs 192.168.1.50:8765
node tools/probe-live.mjs 5 192.168.1.50:8765       # listen 5s per topic
node tools/probe-listparams.mjs /my_node
ROS_BRIDGE_URL=ws://192.168.1.50:8765 node tools/raw-advertise.mjs
```

### Automated tests

```bash
npm run test:offline              # no bridge needed (address resolution + grouping logic)
npm test                          # everything (requires a reachable bridge)
npm run test:e2e                  # end-to-end: real connection + real DOM
npm run test:grouping             # grouping interaction + pure unit tests
```

| Suite | Needs bridge | Notes |
|---|---|---|
| `tools/check-url.mjs` | No | Address resolution priority chain (7 assertions) |
| `tools/test-grouping.mjs` | No | Namespace tree, pure logic (12 assertions) |
| `tools/e2e.mjs` | **Yes** | Five tabs + subscriptions + service call + params (60 assertions) |
| `tools/check-grouping-ui.mjs` | **Yes** | Grouping interaction (41 assertions) |

The end-to-end suites load the real `index.html` and frontend modules through **jsdom**, actually
connect to the bridge, and simulate clicks. To run them against a different bridge:
`ROS_BRIDGE_URL=ws://192.168.1.50:8765 npm run test:e2e`.

> Some e2e assertions are written against a specific system (topic names, service names, action
> counts) and will fail on a different robot. **That's expected** — edit the assertions. The logic
> itself is generic. If you'd rather not, `npm run test:offline` covers the generic parts.

## Implementation notes (pitfalls we hit)

All of these live in the adapter or the protocol — none are specific to a particular robot. You'll
hit them on any ROS 2 system.

### 1. `getTopicsForType()` does not support wildcards

The adapter does **exact type matching**:

```js
getTopicsForType(messageType, onSuccess) {
  const canonical = normalizeRosType(messageType, "msg");
  for (const ch of this.channels.values()) {
    if (normalizeRosType(ch.schemaName, "msg") === canonical) topics.push(ch.topic);
  }
}
```

Passing `"*"` silently returns `[]`, which is very easy to misread as "the bridge advertised no
topics". To enumerate everything, read `ros.channels` directly (`Map<channelId, channel>`,
populated as `advertise` frames arrive).

### 2. Decoded fixed-length arrays are **TypedArrays**, not plain objects

`float64[6]` decodes to a `Float64Array`, not `{"0":0,…}`. A check like
`typeof v === "object" && !ArrayBuffer.isView(v)` will miss it entirely — which is exactly what
kept our bar chart blank for a while.

Handle all three shapes:

```js
if (ArrayBuffer.isView(v)) → Array.from(v)     // TypedArray (main path)
else if (Array.isArray(v)) → v                 // plain array
else if (numeric-keyed object) → sort by key   // after JSON round-trip
```

Same trap in serialization: `JSON.stringify(Float64Array)` emits `{"0":0,…}` rather than an array,
so `toJson()` has to expand it explicitly — otherwise the page shows no real values and the byte
count reads 0.

### 3. Service request definitions live in `service.request`, not `service.schema`

```
service.request  = { encoding, schemaName, schemaEncoding, schema }
service.response = { ... }
```

`schema` is the full expanded `.srv` (including the `====` separator and `MSG:` dependency
sections). When parsing the top-level request fields you must **truncate at the first `====`**,
or you'll treat dependency types as fields.

Some bridge versions advertise only a response definition for `/rosapi/*` services with an empty
request string. Those can't get an auto-generated form — the page says so explicitly.

### 4. Enumerate parameters dynamically — never hardcode

Every ROS 2 node ships a `<node>/list_parameters` service, and an empty request `{}` returns the
real parameter names:

```js
new Service({ ros, name: `${node}/list_parameters`,
              serviceType: "rcl_interfaces/srv/ListParameters_Request" })
  .callService({}, res => res.result.names)   // string[]
```

Node names are derived backwards from services like `<node>/get_parameters`, since the bridge
exposes no node list. Node names can be multi-level paths (`/ns/sub/node`), so the regex must
match greedily up to the last `/`.

### 5. Peer dependency versions must align

`foxglove-ros-adapter@0.5.1` requires `@foxglove/rosmsg2-serialization@^3.0.0`. Installing 1.x
triggers `ERESOLVE`.

### 6. `ROS2TFClient` throws when there's no TF data

It doesn't guard against empty values internally
(`Cannot read properties of undefined (reading 'replace')`). This project doesn't use it — we
subscribe to `/tf` and `/tf_static` ourselves and maintain the frame tree.

### 7. The adapter ignores `channel.encoding`, so JSON topics always fail to parse

`createSubscription()` unconditionally builds a CDR `MessageReader`:

```js
createSubscription(channel, callback) {
  const reader = this.getReader(channel.schemaName, channel.schema);  // CDR only
  ...
}
```

But the bridge advertises **built-in JSON-encoded topics**, the most common being
`/foxglove_bridge/sysinfo`:

```
topic=/foxglove_bridge/sysinfo
schemaName=foxglove.SystemInfo
encoding="json"
schema={"$schema":"https://json-schema.org/draft/2020-12/schema", ...}
```

That `schema` is **JSON-Schema text**, handed to a rosmsg parser that only understands ROS `.msg`
syntax. It necessarily throws `Could not parse line: '{'` — and the adapter swallows it into a
`console.warn`, so the visible symptom is "subscription succeeds but delivers 0 frames forever".
Extremely hard to track down.

`src/json-channels.js` patches this right after `new Ros()`: if `encoding === "json"`, it swaps in
`JSON.parse(new TextDecoder().decode(data))` and bypasses the CDR reader entirely. This is a
general problem — anyone building on `foxglove_bridge` will run into it.

### 8. Highlight state must have exactly one source of truth

The "have to click twice to highlight" bug came from `selected` existing in both `main.js` and
`panel-params.js`, out of sync: the first click only updated the main module's copy, while the
panel rendered from its own stale copy and only caught up on the second click.

The fix: panels don't own selection state. The main module injects a predicate instead.

```js
// main.js
params.bindParamList({
  isParamSelected: (node, name) => selected?.node === node && selected?.name === name,
});
```

`src/style.css` also gained two-level selectors (`.list .item.active` / `.param-row.active`) as a
fallback, so the style still applies inside grouping containers.

### 9. Grouped rendering breaks "number of list items == number of entries"

Leaves hide inside collapsed groups, so `querySelectorAll(".item").length` only counts the
**visible** subset. Assert coverage as "sum of group-header counts + top-level leaves == total",
and switch to flat (or expand level by level — see `expandUntilVisible()` in `tools/e2e.mjs`)
before clicking an entry by name.

## Known limitations

- Without `clientPublish` authorized on the bridge, the panel only subscribes and calls — it won't
  publish custom topics
- Topics without a schema can't be decoded; the page flags them
- `Topic#advertise()` / `unadvertise()` are no-ops; the first `publish()` advertises lazily
- `compression` / `queue_size` / `latch` / `reconnect_on_close` are accepted and ignored
- Clients can't advertise services (the bridge only exposes server-side services)
- Some `/rosapi/*` services ship no request definition and can't be called

## Project layout

```
.
├── index.html            Single-page shell (five tabs)
├── cli.mjs               Command-line tool
├── src/
│   ├── main.js           Entry: connection, counters, list render scheduling, tab switching
│   ├── ros.js            Connection (with auto-reconnect) + topic/service/action inventory
│   ├── json-channels.js  Patch: fixes the adapter's JSON-encoding blind spot
│   ├── grouping.js       Namespace tree building + drill-down list rendering
│   ├── schema.js         .srv / .msg definition parsing
│   ├── service-call.js   Shared service-call wrapper
│   ├── util.js           toJson / throttle / rate counter and friends
│   ├── panel-topics.js   Topics panel
│   ├── panel-services.js Services panel
│   ├── panel-params.js   Parameters panel
│   ├── panel-actions.js  Actions panel
│   ├── panel-tf.js       TF frame tree
│   └── style.css
├── tools/                doctor + diagnostic scripts + automated tests
└── dist/                 Build output (gitignored, not committed)
```

## Contributing

Issues and PRs welcome. After touching frontend logic, run `npm run test:offline` first (offline,
no bridge required); if you have a bridge handy, `npm test` is more thorough. If you hit a new
generic pitfall, please add it to the [pitfalls](#implementation-notes-pitfalls-we-hit) section —
that section is the most valuable part of this document.

## License

[MIT](LICENSE) © 2026 NiceBlueChai

## Acknowledgements

- [foxglove-ros-adapter](https://github.com/noah-wardlow/foxglove-ros-adapter) — the foundation this project is built on
- [Foxglove](https://foxglove.dev/) — the WebSocket protocol and `foxglove_bridge`
