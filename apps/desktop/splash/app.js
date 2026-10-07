"use strict";
const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const picker = new URLSearchParams(location.search).has("picker");
let selectedWorkspace = null, localRecentsKey = "";
let initialized = false, busy = false, savedProfile = null, current = null, view = "welcome";
let lastReadyGeneration = null;
if (picker) {
  document.body.classList.add("picker");
  document.title = "Trading Max · 工作区";
}
const labels = {
  welcome: picker ? ["工作区", ""] : ["打开你的投资工作台。", "从这台 Mac 开始，或连接已经在运行的服务。"],
  remote: ["连接你的服务。", "用熟悉的地址，打开已经在运行的投资工作台。"],
  create: ["创建本地工作区。", "让账户与投资记录保存在这台 Mac。"],
  open: ["继续你的本地记录。", "选择你已经保存的 Trading Max 工作区。"],
};
function text(id, value) { if ($(id).textContent !== value) $(id).textContent = value; }
function showView(next, focus = true) {
  view = next;
  document.body.classList.toggle("welcome-view", view === "welcome");
  $("welcome").hidden = view !== "welcome";
  $("form").hidden = view !== "remote";
  $("local-form").hidden = !["create", "open"].includes(view);
  $("back").hidden = view === "welcome";
  text("heading", labels[view][0]);
  text("subtitle", labels[view][1]);
  $("subtitle").hidden = !labels[view][1];
  $("feedback").hidden = true;
  if (view === "create" || view === "open") {
    selectedWorkspace = null;
    $("workspace-name-field").hidden = view !== "create";
    $("workspace-name").required = view === "create";
    $("workspace-path").value = "";
    $("workspace-summary").hidden = true;
    text("workspace-location-label", view === "create" ? "保存位置" : "工作区文件夹");
    text("workspace-hint", view === "create" ? "将在这里新建同名文件夹。已有文件夹不会被覆盖。" : "选择由桌面 App 创建的工作区。检查兼容后才会打开；旧版源码数据暂不迁移。");
    text("local-submit", view === "create" ? "创建并连接账户 →" : "打开工作区 →");
  }
  if (focus) $("heading").focus({ preventScroll: true });
  if (current) renderStatus(current);
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
  for (const id of ["test", "save", "connect", "retry", "resume", "demo", "pick-folder", "local-submit"]) $(id).disabled = value;
}
async function action(work) {
  if (busy) return;
  lock(true);
  $("feedback").hidden = true;
  try { await work(); } catch (error) { feedback(String(error), "error"); }
  finally { lock(false); }
}
function age(probe) {
  if (probe?.artifact_age_seconds == null) return "";
  const seconds = probe.artifact_age_seconds + Math.max(0, (Date.now() - probe.checked_at_ms) / 1000);
  return "资料最近发布：" + (seconds < 60 ? "不到 1 分钟前" : seconds < 3600 ? Math.floor(seconds / 60) + " 分钟前" : Math.floor(seconds / 3600) + " 小时前");
}
function savedServiceActive(state) {
  try {
    return state?.stage === "ready" && state.mode === "remote" &&
      new URL(state.active_url).origin === new URL(savedProfile.url).origin;
  } catch { return false; }
}
let refreshing = false;
function renderStatus(state) {
  const working = ["connecting", "loading"].includes(state.stage);
  const error = state.stage === "error";
  const connected = state.stage === "ready";
  const warning = connected && state.probe && (!state.probe.healthy || state.probe.worker_healthy === false);
  const localError = error && state.mode && state.mode !== "remote";
  $("status").hidden = (state.stage === "idle" && !state.detail) || (picker && connected && !warning);
  $("status").className = "status " + (error || warning ? "error" : connected ? "good" : "working");
  text("message", state.message);
  text("detail", localError ? "重新打开会继续使用这份工作区。已保存的资料和连接不会被清空。" : state.detail || (warning ? "主机可访问，后台更新状态需要检查。可在数据状态页查看。" : ""));
  text("freshness", age(state.probe));
  $("diagnostics").hidden = !localError || !state.detail;
  text("diagnostic-detail", localError ? state.detail : "");
  $("progress").hidden = !working || picker;
  $("recovery").hidden = !error;
  text("retry", localError ? "重新打开工作区" : "立即重试");
  $("browser").hidden = !state.can_open_browser;
  $("content").hidden = working && !picker;
  $("pending-actions").hidden = !working || picker;
  $("retry-countdown").hidden = !state.retry_at_ms;
  const seconds = Math.max(0, Math.ceil((state.retry_at_ms - Date.now()) / 1000));
  text("retry-countdown", seconds ? `${seconds} 秒后自动再试，也可以立即重试。` : "正在重新检查连接…");
  $("runtime-context").hidden = !state.mode || picker;
  text("collection-hint", state.mode === "remote" ? "记录由服务端的更新计划负责；退出这个 App 不会停止主机采集。" : state.mode === "local" ? "本地记录仅在 App 运行时更新。退出 App 或 Mac 休眠会暂停采集；重新打开后继续，不会补造缺失记录。" : "当前是独立的模拟资料，不会连接真实账户。");
  $("reveal-workspace").hidden = !state.workspace;
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const state = await invoke("desktop_status");
    current = state;
    if (state.stage === "ready") {
      if (picker && initialized && lastReadyGeneration !== state.generation) showView("welcome", false);
      lastReadyGeneration = state.generation;
    }
    const localKey = JSON.stringify([state.workspaces ?? [], state.stage, state.workspace?.path]);
    if (localKey !== localRecentsKey) {
      localRecentsKey = localKey;
      const container = $("local-recents");
      container.hidden = !state.workspaces?.length;
      container.replaceChildren();
      for (const workspace of state.workspaces ?? []) {
        const row = document.createElement("div"); row.className = "recent-body local-recent"; row.title = workspace.path;
        const labels = document.createElement("div"); labels.className = "recent-name";
        const title = document.createElement("strong"); title.textContent = workspace.name;
        const button = document.createElement("button"); button.type = "button"; button.className = "secondary"; const active = state.stage === "ready" && state.workspace?.path === workspace.path;
        button.textContent = active ? "回到工作台" : "打开";
        button.addEventListener("click", () => action(async () => {
          if (active) await invoke("open_workspace_page", { page: "current" });
          else await invoke("open_local_workspace", { workspace });
          await refresh();
        }));
        // Forgetting only shortens the list; the workspace folder stays intact.
        const forget = document.createElement("button"); forget.type = "button"; forget.className = "icon-button";
        forget.textContent = "×"; forget.disabled = active;
        forget.setAttribute("aria-label", "从最近列表移除 " + workspace.name);
        forget.addEventListener("click", () => action(async () => {
          await invoke("forget_workspace", { path: workspace.path });
          await refresh();
        }));
        labels.append(title); row.append(labels, button, forget); container.append(row);
      }
    }
    if (!initialized || view !== "remote") applyProfile(state.profile);
    text("resume", savedServiceActive(state) ? "回到工作台" : "打开 →");
    if (!initialized) {
      text("version", state.app_version ? "v" + state.app_version : "");
      initialized = true;
      showView(view, false);
    }
    renderStatus(state);
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
  if (savedServiceActive(current)) await invoke("open_workspace_page", { page: "current" });
  else await invoke("connect_profile", { profile: { ...savedProfile, mode: "remote" } });
  await refresh();
}));
function demo() { return action(async () => { await invoke("open_demo"); await refresh(); }); }
$("demo").addEventListener("click", demo);

$("retry").addEventListener("click", () => action(async () => { await invoke("retry_connection"); await refresh(); }));
$("browser").addEventListener("click", () => action(() => invoke("open_in_browser")));
$("change").addEventListener("click", () => invoke("open_workspaces"));
$("cancel").addEventListener("click", () => action(() => invoke("disconnect")));
$("stop-retry").addEventListener("click", () => action(async () => { await invoke("disconnect"); await refresh(); }));
$("reveal-workspace").addEventListener("click", () => action(() => invoke("show_workspace_folder")));
$("show-settings").addEventListener("click", () => action(() => invoke("open_settings")));
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

$("pick-folder").addEventListener("click", () => action(async () => {
  const path = await invoke("choose_workspace_folder");
  if (!path) return;
  selectedWorkspace = null;
  $("workspace-path").value = path;
  $("workspace-summary").hidden = true;
  if (view === "open") {
    selectedWorkspace = await invoke("prepare_workspace", { path, name: null });
    text("workspace-title", selectedWorkspace.name);
    text("workspace-description", "工作区格式兼容。打开后会检查账户连接和首次同步状态。");
    $("workspace-summary").hidden = false;
  }
}));
$("local-form").addEventListener("submit", (event) => {
  event.preventDefault();
  action(async () => {
    const path = $("workspace-path").value;
    if (!path) { feedback("请先选择保存位置。", "error"); return; }
    if (view === "create") {
      selectedWorkspace = await invoke("prepare_workspace", { path, name: $("workspace-name").value });
      // If launch fails, retry opens the created directory rather than recreating it.
      view = "open";
      text("heading", labels.open[0]);
      text("subtitle", labels.open[1]);
      text("workspace-location-label", "工作区文件夹");
      text("workspace-hint", "工作区已创建。可以直接打开，继续连接账户。");
      $("workspace-path").value = selectedWorkspace.path;
      $("workspace-name-field").hidden = true;
      text("local-submit", "打开工作区 →");
    }
    if (!selectedWorkspace) selectedWorkspace = await invoke("prepare_workspace", { path, name: null });
    await invoke("open_local_workspace", { workspace: selectedWorkspace });
    await refresh();
  });
});

$("workspace-path").addEventListener("input", () => { selectedWorkspace = null; $("workspace-summary").hidden = true; });
