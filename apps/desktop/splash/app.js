"use strict";
const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
// The native entry uses the system language before a workspace preference exists.
const english = /^en(?:-|$)/i.test(navigator.language);
const t = (zh, en) => english ? en : zh;
if (english) {
  document.documentElement.lang = "en";
  document.title = "Trading Max · Workspaces and connections";
  document.querySelectorAll("[data-en]").forEach((node) => { node.textContent = node.dataset.en; });
  for (const attribute of ["aria-label", "placeholder", "value"]) {
    document.querySelectorAll("[data-en-" + attribute + "]").forEach((node) => {
      node.setAttribute(attribute, node.getAttribute("data-en-" + attribute));
    });
  }
}
const picker = new URLSearchParams(location.search).has("picker");
let selectedWorkspace = null, localRecentsKey = "";
let initialized = false, busy = false, savedProfile = null, current = null, view = "welcome";
let lastReadyGeneration = null;
if (picker) {
  document.body.classList.add("picker");
  document.title = t("Trading Max · 工作区", "Trading Max · Workspaces");
}
// Headings only: the choices and form fields below explain themselves.
const labels = {
  welcome: picker ? t("工作区", "Workspaces") : t("打开投资工作台", "Open your investment workspace"),
  remote: t("连接已有服务", "Connect to an existing service"),
  create: t("创建本地工作区", "Create a local workspace"),
  open: t("打开已有工作区", "Open an existing workspace"),
};
function text(id, value) { if ($(id).textContent !== value) $(id).textContent = value; }
function showView(next, focus = true) {
  view = next;
  document.body.classList.toggle("welcome-view", view === "welcome");
  $("welcome").hidden = view !== "welcome";
  $("form").hidden = view !== "remote";
  $("local-form").hidden = !["create", "open"].includes(view);
  $("back").hidden = view === "welcome";
  text("heading", labels[view]);
  $("feedback").hidden = true;
  if (view === "create" || view === "open") {
    selectedWorkspace = null;
    $("workspace-name-field").hidden = view !== "create";
    $("workspace-name").required = view === "create";
    $("workspace-path").value = "";
    $("workspace-summary").hidden = true;
    text("workspace-location-label", view === "create" ? t("保存位置", "Save location") : t("工作区文件夹", "Workspace folder"));
    text("workspace-hint", view === "create" ? t("将在这里新建同名文件夹。已有文件夹不会被覆盖。", "A new folder takes the workspace name. Existing folders stay as they are.") : t("选择由桌面 App 创建的工作区。App 会先检查格式。", "Choose a folder created by the desktop app. The app checks it before opening."));
    text("local-submit", view === "create" ? t("创建并连接账户 →", "Create and connect an account →") : t("打开工作区 →", "Open workspace →"));
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
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(seconds / 3600);
  return t("资料最近发布：", "Last published: ") + (seconds < 60
    ? t("不到 1 分钟前", "less than 1 minute ago")
    : seconds < 3600 ? t(minutes + " 分钟前", minutes + " min ago") : t(hours + " 小时前", hours + " hr ago"));
}
function savedServiceActive(state) {
  try {
    return ["ready", "reconnecting", "offline"].includes(state?.stage) && state.mode === "remote" &&
      new URL(state.active_url).origin === new URL(savedProfile.url).origin;
  } catch { return false; }
}
let refreshing = false;
function renderStatus(state) {
  const working = ["connecting", "loading"].includes(state.stage);
  const error = ["error", "reconnecting", "offline"].includes(state.stage);
  const connected = state.stage === "ready";
  const warning = connected && state.probe && (!state.probe.healthy || state.probe.worker_healthy === false);
  const localError = error && state.mode && state.mode !== "remote";
  $("status").hidden = (state.stage === "idle" && !state.detail) || (picker && connected && !warning);
  $("status").className = "status " + (error || warning ? "error" : connected ? "good" : "working");
  text("message", state.message);
  text("detail", localError ? t("重新打开会继续使用这份工作区。已保存的资料和连接不会被清空。", "Reopen to keep using this workspace and its saved data and connections.") : state.detail || (warning ? t("主机可访问，后台更新状态需要检查。可在数据状态页查看。", "The service is reachable. See Data status to check background updates.") : ""));
  text("freshness", age(state.probe));
  $("diagnostics").hidden = !localError || !state.detail;
  text("diagnostic-detail", localError ? state.detail : "");
  $("progress").hidden = !working || picker;
  $("recovery").hidden = !error;
  text("retry", localError ? t("重新打开工作区", "Reopen workspace") : t("立即重试", "Retry now"));
  $("browser").hidden = !state.can_open_browser;
  $("content").hidden = working && !picker;
  $("pending-actions").hidden = !working || picker;
  $("retry-countdown").hidden = !state.retry_at_ms;
  const seconds = Math.max(0, Math.ceil((state.retry_at_ms - Date.now()) / 1000));
  text("retry-countdown", seconds ? t(`${seconds} 秒后自动重试。`, `Retrying in ${seconds}s.`) : t("正在重新检查连接…", "Checking the connection again…"));
  // A remote service collects on its own; only local and demo modes carry a caveat.
  $("runtime-context").hidden = !state.mode || picker || state.mode === "remote";
  text("collection-hint", state.mode === "local" ? t("本地记录仅在 App 运行时更新。退出 App 或 Mac 休眠会暂停采集；重新打开后继续，不会补造缺失记录。", "Local updates pause when the app quits or your Mac sleeps. They resume when you reopen the app, without filling the gap.") : t("当前是独立的模拟资料，不会连接真实账户。", "This demo uses synthetic data and does not connect to a broker."));
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
        button.textContent = active ? t("回到工作台", "Back to workspace") : t("打开", "Open");
        button.addEventListener("click", () => action(async () => {
          if (active) await invoke("open_workspace_page", { page: "current" });
          else await invoke("open_local_workspace", { workspace });
          await refresh();
        }));
        // Forgetting only shortens the list; the workspace folder stays intact.
        const forget = document.createElement("button"); forget.type = "button"; forget.className = "icon-button";
        forget.textContent = "×"; forget.disabled = active;
        forget.setAttribute("aria-label", t("从最近列表移除 ", "Remove from recents: ") + workspace.name);
        forget.addEventListener("click", () => action(async () => {
          await invoke("forget_workspace", { path: workspace.path });
          await refresh();
        }));
        labels.append(title); row.append(labels, button, forget); container.append(row);
      }
    }
    if (!initialized || view !== "remote") applyProfile(state.profile);
    text("resume", savedServiceActive(state) ? t("回到工作台", "Back to workspace") : t("打开 →", "Open →"));
    if (!initialized) {
      text("version", state.app_version ? "v" + state.app_version : "");
      initialized = true;
      showView(view, false);
    }
    renderStatus(state);
  } catch {
    $("status").hidden = false;
    $("status").className = "status error";
    text("message", t("无法读取 App 连接状态。", "Could not read the connection status."));
    text("detail", t("可以退出 App 后重新打开。", "Quit and reopen the app to try again."));
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
  feedback(t("正在检查连接…", "Checking the connection…"));
  const result = await invoke("test_connection", { profile: tested });
  if (JSON.stringify(profile()) !== JSON.stringify(tested)) { feedback(t("地址已修改，请重新测试。", "The address changed. Test again.")); return; }
  feedback(result.healthy && result.worker_healthy !== false ? t("连接成功，Trading Max 服务可访问。", "Connected to the Trading Max service.") : t("已连接，后台更新状态需要检查。", "Connected. Check background updates."), result.healthy && result.worker_healthy !== false ? "good" : "");
}));
$("save").addEventListener("click", () => action(async () => {
  if (!$("form").reportValidity()) return;
  const value = profile();
  await invoke("save_profile", { profile: value });
  applyProfile(value);
  feedback(t("连接已保存。", "Connection saved."), "good");
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
    text("workspace-description", t("工作区格式兼容。打开后会检查账户连接和首次同步状态。", "This workspace is compatible. Open it to check account connections and first sync."));
    $("workspace-summary").hidden = false;
  }
}));
$("local-form").addEventListener("submit", (event) => {
  event.preventDefault();
  action(async () => {
    const path = $("workspace-path").value;
    if (!path) { feedback(t("请先选择保存位置。", "Choose a save location first."), "error"); return; }
    if (view === "create") {
      selectedWorkspace = await invoke("prepare_workspace", { path, name: $("workspace-name").value });
      // If launch fails, retry opens the created directory rather than recreating it.
      view = "open";
      text("heading", labels.open);
      text("workspace-location-label", t("工作区文件夹", "Workspace folder"));
      text("workspace-hint", t("工作区已创建。可以直接打开，继续连接账户。", "Workspace created. Open it to connect your accounts."));
      $("workspace-path").value = selectedWorkspace.path;
      $("workspace-name-field").hidden = true;
      text("local-submit", t("打开工作区 →", "Open workspace →"));
    }
    if (!selectedWorkspace) selectedWorkspace = await invoke("prepare_workspace", { path, name: null });
    await invoke("open_local_workspace", { workspace: selectedWorkspace });
    await refresh();
  });
});

$("workspace-path").addEventListener("input", () => { selectedWorkspace = null; $("workspace-summary").hidden = true; });
