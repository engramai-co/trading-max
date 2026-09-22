"use strict";
const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const settings = new URLSearchParams(location.search).has("settings");
let initialized = false, busy = false, savedProfile = null, current = null, view = "welcome";
if (settings) document.body.classList.add("settings");
const labels = {
  welcome: ["打开你的投资工作台。", "从这台 Mac 开始，或连接已经在运行的服务。"],
  remote: ["连接你的服务。", "用熟悉的地址，打开已经在运行的投资工作台。"],
  create: ["创建本地工作区。", "让账户与投资记录保存在这台 Mac。"],
  open: ["继续你的本地记录。", "选择你已经保存的 Trading Max 工作区。"],
};
function text(id, value) { if ($(id).textContent !== value) $(id).textContent = value; }
function showView(next, focus = true) {
  view = next;
  $("welcome").hidden = view !== "welcome";
  $("form").hidden = view !== "remote";
  $("local-preview").hidden = !["create", "open"].includes(view);
  $("back").hidden = view === "welcome";
  text("heading", labels[view][0]);
  text("subtitle", labels[view][1]);
  $("feedback").hidden = true;
  if (view === "create" || view === "open") {
    text("local-title", view === "create" ? "一个属于你的本地资料库" : "账户与历史记录，接着使用");
    text("local-description", view === "create" ? "即将支持在 App 里创建工作区，并连接你的真实账户。" : "即将支持打开已有工作区，并检查它与当前 App 是否兼容。");
    const steps = view === "create" ? ["选择保存位置，为工作区命名。", "连接 Trading 212 只读账户。", "完成首次同步，核对金额后开始使用。"] : ["选择已有资料目录。", "检查格式、版本与运行状态。", "确认兼容后继续使用已有记录。"];
    $("local-steps").replaceChildren(...steps.map((label) => { const li = document.createElement("li"); li.textContent = label; return li; }));
  }
  if (focus) $("heading").focus({ preventScroll: true });
}
function profile() { return { schema: 1, mode: "remote", name: $("name").value, url: $("url").value, auto_connect: $("auto").checked }; }
function applyProfile(value) {
  savedProfile = value;
  $("name").value = value.name;
  $("url").value = value.url;
  $("auto").checked = value.auto_connect;
  $("recent").hidden = !value.url;
  text("recent-name", value.name);
  let host = "";
  try { host = new URL(value.url).hostname; } catch { /* An unsaved profile has no address. */ }
  text("recent-host", host);
}
function feedback(message, tone = "") {
  text("feedback", message);
  $("feedback").className = tone;
  $("feedback").hidden = false;
}
function lock(value) {
  busy = value;
  for (const id of ["test", "save", "connect", "retry", "resume", "demo", "local-demo"]) $(id).disabled = value;
}
async function action(work) {
  if (busy) return;
  lock(true);
  try { await work(); } catch (error) { feedback(String(error), "error"); }
  finally { lock(false); }
}
function age(probe) {
  if (probe?.artifact_age_seconds == null) return "";
  const seconds = probe.artifact_age_seconds + Math.max(0, (Date.now() - probe.checked_at_ms) / 1000);
  return "资料最近发布：" + (seconds < 60 ? "不到 1 分钟前" : seconds < 3600 ? Math.floor(seconds / 60) + " 分钟前" : Math.floor(seconds / 3600) + " 小时前");
}
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const state = await invoke("desktop_status");
    current = state;
    if (!initialized) {
      applyProfile(state.profile);
      text("version", state.app_version ? "v" + state.app_version : "");
      initialized = true;
      showView(view, false);
    }
    const working = ["connecting", "loading"].includes(state.stage);
    const error = state.stage === "error";
    const connected = state.stage === "ready";
    const warning = connected && state.probe && (!state.probe.healthy || state.probe.worker_healthy === false);
    $("status").hidden = state.stage === "idle" && !state.detail;
    $("status").className = "status " + (error || warning ? "error" : connected ? "good" : "working");
    text("message", state.message);
    text("detail", state.detail || (warning ? "主机可访问，后台更新状态需要检查。可在数据状态页查看。" : ""));
    text("freshness", age(state.probe));
    $("progress").hidden = !working || settings;
    $("recovery").hidden = !error;
    $("browser").hidden = !state.profile.url;
    $("content").hidden = working && !settings;
    $("pending-actions").hidden = !working || settings;
  } catch {
    $("status").hidden = false;
    $("status").className = "status error";
    text("message", "无法读取 App 连接状态。");
    text("detail", "可以退出 App 后重新打开。");
  } finally { refreshing = false; }
}
function remoteForm() { showView("remote"); }
$("choose-remote").addEventListener("click", remoteForm);
$("edit-remote").addEventListener("click", remoteForm);
$("local-remote").addEventListener("click", remoteForm);
$("create-workspace").addEventListener("click", () => showView("create"));
$("open-workspace").addEventListener("click", () => showView("open"));
$("back").addEventListener("click", () => showView("welcome"));
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && view !== "welcome" && !busy) showView("welcome"); });
$("test").addEventListener("click", () => action(async () => {
  if (!$("form").reportValidity()) return;
  const tested = profile();
  feedback("正在检查连接…");
  const result = await invoke("test_connection", { profile: tested });
  if (JSON.stringify(profile()) !== JSON.stringify(tested)) { feedback("地址已修改，请重新测试。"); return; }
  feedback(result.healthy && result.worker_healthy !== false ? "连接成功，Trading Max 服务可访问。" : "已连接，后台更新状态需要检查。", result.healthy && result.worker_healthy !== false ? "good" : "");
}));
$("save").addEventListener("click", () => action(async () => {
  if (!$("form").reportValidity()) return;
  const value = profile();
  await invoke("save_profile", { profile: value });
  applyProfile(value);
  feedback("连接已保存。", "good");
}));
$("form").addEventListener("submit", (event) => {
  event.preventDefault();
  action(async () => { await invoke("connect_profile", { profile: profile() }); $("feedback").hidden = true; await refresh(); });
});
$("resume").addEventListener("click", () => action(async () => {
  if (!savedProfile?.url) return;
  await invoke("connect_profile", { profile: { ...savedProfile, mode: "remote" } });
  await refresh();
}));
function demo() { return action(async () => { await invoke("open_demo"); await refresh(); }); }
$("demo").addEventListener("click", demo);
$("local-demo").addEventListener("click", demo);
$("retry").addEventListener("click", () => action(async () => { await invoke("retry_connection"); await refresh(); }));
$("browser").addEventListener("click", () => action(() => invoke("open_in_browser")));
$("change").addEventListener("click", () => invoke("open_settings"));
$("cancel").addEventListener("click", () => action(() => invoke("disconnect")));
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
