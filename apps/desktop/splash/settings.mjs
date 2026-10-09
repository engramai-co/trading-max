import { workspacePresentation, savedRemote } from "./presentation.mjs";
import { releasePresentation } from "./releases.mjs";

const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const pages = {
  general: ["通用", "这台 Mac 上的启动与使用偏好。"],
  workspace: ["当前工作区", "确认正在查看哪份资料，以及它由谁更新。"],
  updates: ["关于与更新", "本机 App 的版本与更新信息。"],
  support: ["帮助与恢复", "安装、升级，以及你的资料保存在哪里。"],
};
let refreshing = false, saving = false, checkedRelease = null, checkedDesktop = null;
function text(id, value) { if ($(id).textContent !== value) $(id).textContent = value; }
function feedback(message, error = false) {
  text("feedback", message);
  $("feedback").className = error ? "error" : "good";
  $("feedback").hidden = false;
}
async function action(work) {
  try { await work(); } catch (error) { feedback(String(error), true); }
}
for (const button of document.querySelectorAll("[data-page]")) {
  button.addEventListener("click", () => {
    const page = button.dataset.page;
    for (const id of Object.keys(pages)) $(id).hidden = id !== page;
    for (const item of document.querySelectorAll("[data-page]")) {
      if (item === button) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
    text("page-title", pages[page][0]);
    $("feedback").hidden = true;
    document.querySelector(".preferences-main").scrollTop = 0;
  });
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const state = await invoke("desktop_status");
    const available = savedRemote(state.profile);
    if (!saving) {
      $("auto-connect").checked = available && state.profile.auto_connect;
      $("auto-connect").disabled = !available;
    }
    text("startup-name", available ? state.profile.name : "尚未保存服务连接");
    text("startup-address", available ? state.profile.url : "可以先创建本地工作区，或保存一个服务地址。");
    text("installed-version", "v" + state.app_version);
    const workspace = workspacePresentation(state);
    text("source-kind", workspace.kind); text("active-name", workspace.name);
    text("active-address", workspace.address); text("connection-state", workspace.status);
    $("connection-state").className = "connection-state " + (["error", "reconnecting", "offline"].includes(state.stage) ? "error" : workspace.ready ? "connected" : "");
    text("connection-detail", workspace.detail);
    // Only local collection has a caveat the user can act on.
    text("ownership-hint", state.mode === "local" ? workspace.ownership : "");
    $("ownership-hint").hidden = state.mode !== "local";
    text("workspace-settings-label", workspace.settingsLabel);
    for (const id of ["return-workspace", "workspace-settings", "workspace-health"]) $(id).disabled = !workspace.available;
    $("data-folder").hidden = !workspace.canRevealFolder;
    $("data-folder").disabled = false;
    $("recovery-folder").disabled = !workspace.canRevealFolder;
  } catch {
    feedback("暂时无法读取 App 状态，请关闭设置后重新打开。", true);
    $("auto-connect").disabled = true;
    for (const id of ["return-workspace", "workspace-settings", "workspace-health", "data-folder", "recovery-folder"]) $(id).disabled = true;
  } finally { refreshing = false; }
}
for (const id of ["manage-workspaces", "choose-workspace", "switch-workspace"]) {
  $(id).addEventListener("click", () => action(() => invoke("open_workspaces")));
}
for (const [id, page] of [["return-workspace", "current"], ["workspace-settings", "settings"], ["workspace-health", "health"]]) {
  $(id).addEventListener("click", () => action(() => invoke("open_workspace_page", { page })));
}
$("data-folder").addEventListener("click", () => action(() => invoke("show_workspace_folder")));
$("recovery-folder").addEventListener("click", () => action(() => invoke("show_recovery_folder")));
$("support-issues").addEventListener("click", () => action(() => invoke("open_issue_tracker")));
$("update-help").addEventListener("click", () => document.querySelector('[data-page="support"]').click());
$("auto-connect").addEventListener("change", async () => {
  if (saving) return;
  saving = true; $("auto-connect").disabled = true;
  try {
    await invoke("set_auto_connect", { enabled: $("auto-connect").checked });
    feedback("启动偏好已保存，下次打开 App 时生效。");
  } catch (error) { feedback(String(error), true); }
  finally { saving = false; await refresh(); }
});
$("check-updates").addEventListener("click", async () => {
  $("check-updates").disabled = true;
  checkedRelease = null; checkedDesktop = null;
  $("release-notes").hidden = true;
  $("download-desktop").hidden = true;
  $("install-update").hidden = true;
  $("package-details").hidden = true;
  $("update-result").hidden = false;
  text("update-result", "正在检查官方版本…");
  try {
    const result = await invoke("check_updates");
    checkedRelease = result.version;
    checkedDesktop = result.desktop;
    const view = releasePresentation(result);
    text("update-result", view.message);
    $("download-desktop").hidden = !view.download;
    $("install-update").hidden = !view.inApp;
    text("download-desktop", view.label);
    $("package-details").hidden = !view.details;
    text("package-checksum", view.details);
    $("release-notes").hidden = false;
  } catch (error) { checkedRelease = null; text("update-result", String(error)); }
  finally { $("check-updates").disabled = false; }
});
$("download-desktop").addEventListener("click", async () => {
  if (!checkedDesktop) return;
  $("download-desktop").disabled = true; $("check-updates").disabled = true;
  try {
    await invoke("open_desktop_download", { version: checkedDesktop.version });
    feedback("已在浏览器打开官方安装包下载。下载完成后，请退出 App，再在 Finder 中替换应用。资料与连接保留。");
  } catch (error) {
    checkedDesktop = null; $("download-desktop").hidden = true;
    feedback(String(error), true);
  } finally { $("download-desktop").disabled = false; $("check-updates").disabled = false; }
});
$("install-update").addEventListener("click", async () => {
  if (!checkedDesktop?.in_app) return;
  $("install-update").disabled = true;
  $("check-updates").disabled = true;
  try {
    await invoke("install_desktop_update", { version: checkedDesktop.version });
    feedback("更新窗口已打开。下载和验证完成后，可以安装并重启；你的资料与连接会保留。");
  } catch (error) { feedback(String(error), true); }
  finally { $("install-update").disabled = false; $("check-updates").disabled = false; }
});
$("release-notes").addEventListener("click", () => action(() => invoke("open_release_notes", { version: checkedRelease })));
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 2000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
