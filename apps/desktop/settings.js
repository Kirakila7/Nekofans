"use strict";
const bridge = window.fishSettings;
const byId = (id) => document.getElementById(id);
let saving = false;

function status(message, error = false) {
  byId("status").textContent = message;
  byId("status").classList.toggle("is-error", error);
}
function showSection(section) {
  if (saving) return;
  const api = section !== "persona";
  byId("api-form").hidden = !api;
  byId("persona-form").hidden = api;
  byId("api-tab").setAttribute("aria-pressed", String(api));
  byId("persona-tab").setAttribute("aria-pressed", String(!api));
  status("");
}
function endpointHint() {
  byId("endpoint-hint").textContent = byId("protocol").value === "anthropic"
    ? "基础地址后会添加 /v1/messages（已有 /v1 时只添加 /messages）。"
    : "基础地址后会添加 /chat/completions；请勿填写完整接口路径。";
}
function keyStatus(hasKey) { byId("key-status").textContent = hasKey ? "已加密保存" : "尚未保存"; }
function busy(value) {
  saving = value;
  document.querySelectorAll("input, textarea, select, button").forEach((el) => { el.disabled = value; });
  if (!value) byId("api-key").disabled = byId("clear-key").checked;
}

byId("api-tab").addEventListener("click", () => showSection("api"));
byId("persona-tab").addEventListener("click", () => showSection("persona"));
byId("protocol").addEventListener("change", endpointHint);
byId("clear-key").addEventListener("change", () => {
  byId("api-key").value = "";
  byId("api-key").disabled = byId("clear-key").checked;
});

byId("api-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!bridge || saving) return;
  const enteredKey = byId("api-key").value.trim();
  const key = byId("clear-key").checked ? { action: "clear" } : enteredKey ? { action: "replace", value: enteredKey } : { action: "keep" };
  const payload = {
    protocol: byId("protocol").value,
    baseUrl: byId("base-url").value.trim(),
    model: byId("model").value.trim(),
    requestTimeoutMs: Number(byId("timeout").value) * 1000,
    maxOutputTokens: Number(byId("max-tokens").value),
    key,
  };
  byId("api-key").value = "";
  busy(true);
  status("正在保存并应用…");
  try {
    const result = await bridge.saveApi(payload);
    if (result.ok) {
      keyStatus(result.hasKey);
      byId("clear-key").checked = false;
      status("已保存。回到大肥鱼身边，发送一条消息就可以开始聊天。");
    } else status(result.error || "保存失败，请重试。", true);
  } catch { status("设置窗口与桌宠的连接已断开，请重新打开设置。", true); }
  finally { busy(false); }
});

byId("persona-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!bridge || saving) return;
  const payload = { name: byId("name").value, persona: byId("persona").value, boundaries: byId("boundaries").value.split(/\r?\n/).filter((line) => line.trim()) };
  busy(true);
  status("正在保存角色设定…");
  try {
    const result = await bridge.savePersona(payload);
    status(result.ok ? "已保存，新设定会用于接下来的对话。" : result.error || "保存失败，请重试。", !result.ok);
  } catch { status("设置窗口与桌宠的连接已断开，请重新打开设置。", true); }
  finally { busy(false); }
});

async function initialize() {
  if (!bridge) { busy(true); status("设置组件未能启动，请重新打开设置。", true); return; }
  bridge.onSection(showSection);
  try {
    const state = await bridge.read();
    if (!state.ok) { busy(true); status(state.error || "设置读取失败。", true); return; }
    byId("protocol").value = state.mainChat.protocol;
    byId("base-url").value = state.mainChat.baseUrl;
    byId("model").value = state.mainChat.model;
    byId("timeout").value = state.mainChat.requestTimeoutMs / 1000;
    byId("max-tokens").value = state.mainChat.maxOutputTokens;
    keyStatus(state.hasKey);
    byId("name").value = state.persona.name;
    byId("persona").value = state.persona.persona;
    byId("boundaries").value = state.persona.boundaries.join("\n");
    endpointHint();
    showSection(state.section);
  } catch { busy(true); status("设置读取失败，请重新打开设置。", true); }
}
void initialize();
