/* 服务面板：列出 449 个服务，按 schema 自动生成请求表单，调用并展示响应 */

import { $, toJson, esc, nowTime } from "./util.js";
import { parseMessageSchema, isPrimitive } from "./schema.js";
import { callServiceOnce } from "./service-call.js";

let ctx = null;
let active = null;
let els = {};

export function initServices(context) {
  ctx = context;
  els.viewTitle = $("viewTitle");
  els.meta = $("meta");
  els.content = $("content");
  els.viewActions = $("viewActions");
}

export function serviceListItem(s, isActive) {
  return { name: s.name, type: s.type || "未知类型", active: isActive, data: s };
}

export function unmountServices() {
  els.viewActions.innerHTML = "";
  els.content.innerHTML = `<p class="empty">选择左侧服务以调用</p>`;
  els.meta.textContent = "从左侧选一个服务";
}

export function selectService(s) {
  active = s;
  els.viewActions.innerHTML = "";
  els.viewTitle.textContent = s.name;

  // bridge 广播的请求定义字段名是 s.request（不是 s.requestSchema）
  const full = ctx.findService(s.name);
  const reqSchema = full?.request;
  const schemaText = reqSchema?.schema ?? "";
  const { fields } = parseMessageSchema(schemaText);

  const hasSchema = fields.length > 0;
  const schemaMissing = !schemaText.trim();

  els.meta.innerHTML =
    `<span><b>${esc(s.type)}</b></span>` +
    (schemaMissing
      ? `<span class="tag warn">bridge 未广播请求定义，无法自动生成表单</span>`
      : `<span class="tag ok">${fields.length} 个请求字段</span>`);

  const wrap = document.createElement("div");
  wrap.className = "form";

  // ── 请求表单 ──
  if (schemaMissing) {
    wrap.innerHTML += `
      <div class="section-title">请求参数</div>
      <p class="empty">该服务由 bridge 广播时缺少 <code>request</code> 定义，
      只能手动填 JSON。可直接尝试空对象 <code>{}</code>（无参服务）。</p>`;
  } else if (!hasSchema) {
    wrap.innerHTML += `
      <div class="section-title">请求参数</div>
      <p class="empty">该服务请求体为空（无参调用）。</p>`;
  }

  const inputs = [];
  for (const f of fields) {
    const box = document.createElement("div");
    box.className = "field";
    const label = document.createElement("label");
    label.innerHTML = `${esc(f.name)} <span class="ty">${esc(f.fullType)}${f.isArray ? "[]" : ""}</span>`;
    box.appendChild(label);

    let input;
    const typeHint = f.isArray ? "数组，用逗号分隔（空 = []）" : f.isNested ? "嵌套类型，填 JSON" : "";

    if (f.baseType === "bool") {
      input = document.createElement("select");
      input.innerHTML = `<option value="false">false</option><option value="true">true</option>`;
    } else if (f.isNested || (f.isArray && !isPrimitive(f.baseType))) {
      input = document.createElement("textarea");
      input.rows = 2;
      input.placeholder = f.isArray ? "[ {...}, {...} ]" : `{ }`;
    } else if (f.isArray) {
      input = document.createElement("input");
      input.type = "text";
      input.placeholder = "例如 1.0, 2.0, 3.0";
    } else if (isPrimitive(f.baseType)) {
      input = document.createElement("input");
      input.type = (f.baseType === "string" || f.baseType === "wstring") ? "text" : "number";
      if (f.baseType !== "string" && f.baseType !== "wstring") input.step = "any";
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.placeholder = "JSON";
    }

    if (input.tagName !== "SELECT") input.value = f.rawDefault ?? "";
    input.dataset.field = f.name;
    box.appendChild(input);
    if (typeHint) {
      const h = document.createElement("span");
      h.className = "hintline";
      h.textContent = typeHint;
      box.appendChild(h);
    }
    wrap.appendChild(box);
    inputs.push({ f, input });
  }

  // ── 原始 JSON 兜底 ──
  const rawTitle = document.createElement("div");
  rawTitle.className = "section-title";
  rawTitle.textContent = "原始请求 JSON（留空则用上方表单值）";
  wrap.appendChild(rawTitle);

  const rawArea = document.createElement("textarea");
  rawArea.rows = 3;
  rawArea.placeholder = "{}";
  rawArea.style.fontFamily = "var(--mono)";
  wrap.appendChild(rawArea);

  // ── 调用按钮 ──
  const row = document.createElement("div");
  row.className = "row";
  const callBtn = document.createElement("button");
  callBtn.className = "primary";
  callBtn.textContent = "调用服务";
  const status = document.createElement("span");
  status.className = "tag";
  status.textContent = "就绪";
  row.append(callBtn, status);
  wrap.appendChild(row);

  const resultTitle = document.createElement("div");
  resultTitle.className = "section-title";
  resultTitle.textContent = "响应";
  wrap.appendChild(resultTitle);

  const resultBox = document.createElement("pre");
  resultBox.className = "code";
  resultBox.textContent = "// 尚未调用";
  wrap.appendChild(resultBox);

  els.content.replaceChildren(wrap);

  // ── 提交 ──
  callBtn.addEventListener("click", async () => {
    let request;
    const raw = rawArea.value.trim();
    if (raw) {
      try {
        request = JSON.parse(raw);
      } catch (e) {
        status.className = "tag err";
        status.textContent = "JSON 格式错误";
        resultBox.className = "code result-err";
        resultBox.textContent = String(e.message);
        return;
      }
    } else {
      try {
        request = buildRequest(inputs);
      } catch (e) {
        status.className = "tag err";
        status.textContent = "表单取值失败";
        resultBox.className = "code result-err";
        resultBox.textContent = String(e.message);
        return;
      }
    }

    callBtn.disabled = true;
    status.className = "tag warn";
    status.textContent = "调用中…";
    resultBox.className = "code";
    resultBox.textContent = `// 请求 ${nowTime()}\n${JSON.stringify(request, null, 2)}`;

    const t0 = performance.now();
    try {
      const res = await callServiceOnce(ctx.ros, s.name, s.type, request);
      const dt = (performance.now() - t0).toFixed(0);
      status.className = "tag ok";
      status.textContent = `成功 · ${dt} ms`;
      resultBox.className = "code result-ok";
      resultBox.textContent = `${toJson(res)}\n\n// ${dt} ms`;
    } catch (err) {
      const dt = (performance.now() - t0).toFixed(0);
      status.className = "tag err";
      status.textContent = `失败 · ${dt} ms`;
      resultBox.className = "code result-err";
      resultBox.textContent = `${err?.message ?? String(err)}\n\n// ${dt} ms`;
    } finally {
      callBtn.disabled = false;
    }
  });
}

/** 把表单值组装成请求对象 */
function buildRequest(inputs) {
  const out = {};
  for (const { f, input } of inputs) {
    const v = input.value;

    if (f.baseType === "bool") {
      out[f.name] = v === "true";
      continue;
    }
    if (f.isArray) {
      if (v.trim() === "") { out[f.name] = []; continue; }
      if (f.isNested || !isPrimitive(f.baseType)) {
        out[f.name] = JSON.parse(v);
        continue;
      }
      out[f.name] = v.split(",").map((s) => coerceScalar(s.trim(), f.baseType));
      continue;
    }
    if (f.isNested || !isPrimitive(f.baseType)) {
      out[f.name] = v.trim() === "" ? {} : JSON.parse(v);
      continue;
    }
    out[f.name] = coerceScalar(v, f.baseType);
  }
  return out;
}

/** 按 ROS 基本类型把字符串转成正确的 JS 值 */
function coerceScalar(s, baseType) {
  if (baseType === "string" || baseType === "wstring") return String(s);
  if (baseType === "bool") return s === "true" || s === "1";
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`字段 "${s}" 不是合法数字`);
  // 64 位整型用 BigInt，避免 CDR 序列化精度/类型不匹配
  if (baseType === "int64" || baseType === "uint64") return BigInt(Math.trunc(n));
  if (baseType === "float32" || baseType === "float64") return n;
  return Math.trunc(n);
}
