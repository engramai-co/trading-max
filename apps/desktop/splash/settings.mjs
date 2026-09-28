import { workspacePresentation, savedRemote } from "./presentation.mjs";

const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const pages = {
  general: ["通用", "这台 Mac 上的启动与使用偏好。"],
  workspace: ["当前工作区", "确认正在查看哪份资料，以及它由谁更新。"],
  updates: ["关于与更新", "本机 App 的版本与更新信息。"],
};
let refreshing = false, saving = false, checkedRelease = null;
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
    text("page-title", pages[page][0]); text("page-description", pages[page][1]);
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
    text("startup-hint", available && state.profile.auto_connect ? "启动 App 时打开上面的服务。本地工作区与演示不会替换这个选择。" : "启动 App 时显示工作区选择器，由你选择要打开的资料。");
    text("installed-version", "v" + state.app_version);
    const workspace = workspacePresentation(state);
    text("source-kind", workspace.kind); text("active-name", workspace.name);
    text("active-address", workspace.address); text("connection-state", workspace.status);
    $("connection-state").className = "connection-state " + (state.stage === "error" ? "error" : workspace.ready ? "connected" : "");
    text("connection-detail", workspace.detail); text("ownership-hint", workspace.ownership);
    text("workspace-settings-label", workspace.settingsLabel);
    for (const id of ["return-workspace", "workspace-settings", "workspace-health"]) $(id).disabled = !workspace.ready;
    $("data-folder").hidden = !workspace.canRevealFolder;
    $("data-folder").disabled = false;
  } catch {
    feedback("暂时无法读取 App 状态，请关闭设置后重新打开。", true);
    $("auto-connect").disabled = true;
    for (const id of ["return-workspace", "workspace-settings", "workspace-health", "data-folder"]) $(id).disabled = true;
  } finally { refreshing = false; }
}
for (const id of ["manage-workspaces", "choose-workspace", "switch-workspace"]) {
  $(id).addEventListener("click", () => action(() => invoke("open_workspaces")));
}
for (const [id, page] of [["return-workspace", "current"], ["workspace-settings", "settings"], ["workspace-health", "health"]]) {
  $(id).addEventListener("click", () => action(() => invoke("open_workspace_page", { page })));
}
$("data-folder").addEventListener("click", () => action(() => invoke("show_workspace_folder")));
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
  $("release-notes").hidden = true;
  $("update-result").hidden = false;
  text("update-result", "正在检查官方版本…");
  try {
    const result = await invoke("check_updates");
    checkedRelease = result.version;
    const comparison = result.relation === "newer" ? "版本号高于本机 App。" : result.relation === "same" ? "与本机 App 的基础版本号一致。" : "本机是较新的内部预览。";
    text("update-result", `官方稳定版 v${result.version}，${comparison} 这是仓库版本，不代表已有桌面安装包。`);
    $("release-notes").hidden = false;
  } catch (error) { checkedRelease = null; text("update-result", String(error)); }
  finally { $("check-updates").disabled = false; }
});
$("release-notes").addEventListener("click", () => action(() => invoke("open_release_notes", { version: checkedRelease })));
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 2000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
