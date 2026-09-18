/**
 * 列表分组渲染（支持任意层级钻取）。
 *
 * 按 ROS 命名空间逐层拆分：
 *   /at/robot/move_joint  →  /at  ┐
 *   /at/robot/move_line   →  /at  ├─→ /at/robot ┐
 *   /at/robot/get_pos     →  /at  ┘             ├─→ move_joint（叶子，可点）
 *   /at/data/xxx          →  /at ─→ /at/data  ──┘
 *
 * 关键点：只对「该前缀下还有更深路径」的条目继续拆组，
 * 已经是叶子的直接当条目。这样 /at（372 项）不会一次性倒出来。
 */

/** 取路径的第 depth 层（depth 从 1 开始） */
function seg(name, depth) {
  const parts = name.split("/").filter(Boolean);
  return parts.length >= depth ? parts[depth - 1] : null;
}

/** 路径有多深（/a/b/c → 3） */
function depthOf(name) {
  return name.split("/").filter(Boolean).length;
}

/**
 * 构建树。
 * @returns {{ nodes: Array, leaves: Array }}
 *   nodes: [{ label, full, count, nodes, leaves }]
 *   leaves: 该层直接落地的条目
 */
export function buildTree(items, getName = (x) => x.name, depth = 1, prefix = "") {
  const groups = new Map();
  const leaves = [];

  for (const it of items) {
    const name = getName(it);
    const d = depthOf(name);

    // 已到最后一层，或结构异常 → 当叶子
    const key = d <= depth ? null : seg(name, depth);
    if (key == null) {
      leaves.push(it);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  const nodes = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, list]) => {
      const full = `${prefix}/${key}`;
      const child = buildTree(list, getName, depth + 1, full);
      return {
        label: key,
        full,
        count: list.length,
        nodes: child.nodes,
        leaves: child.leaves,
      };
    });

  return { nodes, leaves };
}

/**
 * 渲染可钻取的列表。
 *
 * @param {HTMLElement} host
 * @param {Array} items           扁平条目
 * @param {object} opts
 *   - getName: (item) => string
 *   - renderItem: (item) => HTMLElement
 *   - openPaths: Set<string>      已展开的路径（调用方持有，跨重绘保留）
 *   - forceExpand: boolean        筛选态强制全展开
 *   - onToggle: () => void
 */
export function renderTree(host, items, opts) {
  const {
    getName = (x) => x.name,
    renderItem,
    openPaths,
    forceExpand = false,
    onToggle = () => {},
  } = opts;

  const tree = buildTree(items, getName);
  const frag = document.createDocumentFragment();

  const walk = (node, parentFrag, depth = 0) => {
    const open = forceExpand || openPaths.has(node.full);

    const head = document.createElement("button");
    head.className = "group-head" + (open ? " open" : "");
    head.type = "button";
    head.dataset.path = node.full;
    // 顶层组直接显示 /at；深层节点只显示本层段，避免缩进过长
    if (depth > 0) head.dataset.depth = String(depth);

    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = "▶";

    const gname = document.createElement("span");
    gname.className = "gname";
    // 顶层显示完整路径（/at），深层只显示本层段（robot），完整路径放 title
    gname.textContent = depth === 0 ? node.full : node.label;
    head.title = `${node.full}  （${node.count} 项）`;

    const gcount = document.createElement("span");
    gcount.className = "gcount";
    gcount.textContent = String(node.count);

    head.append(caret, gname, gcount);
    head.addEventListener("click", () => {
      if (forceExpand) return;
      if (openPaths.has(node.full)) openPaths.delete(node.full);
      else openPaths.add(node.full);
      onToggle();
    });
    parentFrag.appendChild(head);

    if (!open) return;

    const body = document.createElement("div");
    body.className = "group-body";
    // 子组优先，同级叶子排后面
    for (const child of node.nodes) walk(child, body, depth + 1);
    for (const leaf of node.leaves) body.appendChild(renderItem(leaf));
    parentFrag.appendChild(body);
  };

  // 顶层组：显示 /at 这类前缀，而不是光秃秃的 at
  for (const node of tree.nodes) walk(node, frag, 0);
  for (const leaf of tree.leaves) frag.appendChild(renderItem(leaf));

  host.replaceChildren(frag);
}

/** 判断分组是否有意义（只有一层且没有可拆的子路径时，不如平铺） */
export function hasDepth(items, getName = (x) => x.name, minDepth = 3) {
  return items.some((it) => depthOf(getName(it)) >= minDepth);
}
