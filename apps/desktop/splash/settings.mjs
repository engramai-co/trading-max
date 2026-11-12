import { workspacePresentation, savedRemote } from "./presentation.mjs";
import { releasePresentation } from "./releases.mjs";
import { pageLanguage } from "./language.mjs";

const { core: { invoke }, webviewWindow: { getCurrentWebviewWindow } } = window.__TAURI__;
const $ = (id) => document.getElementById(id);
const language = pageLanguage(document);
const { t } = language;
const nav = [...document.querySelectorAll("[data-page]")];
let activePage = nav[0];
let refreshing = false, saving = false, savingLanguage = false, languageRevision = 0;
let current, feedbackCopy, release, updateError, downloadUnavailable = false;
function text(id, value) { if ($(id).textContent !== value) $(id).textContent = value; }
function feedback(message, error = false) {
  feedbackCopy = typeof message === "function" ? message : () => message;
  text("feedback", feedbackCopy());
  $("feedback").className = error ? "error" : "good";
  $("feedback").hidden = false;
}
async function action(work) {
  try { await work(); } catch (error) { feedback(String(error), true); }
}
for (const button of nav) {
  button.addEventListener("click", () => {
    activePage = button;
    for (const item of nav) {
      $(item.dataset.page).hidden = item !== button;
      if (item === button) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
    text("page-title", activePage.textContent.trim());
    $("feedback").hidden = true;
    document.querySelector(".preferences-main").scrollTop = 0;
  });
}
function renderRelease() {
  if ($("update-result").hidden) return;
  if (!release) {
    text("update-result", updateError ?? t("正在检查官方版本…", "Checking for updates…"));
    return;
  }
  const view = releasePresentation(release, language.value);
  text("update-result", view.message);
  $("download-desktop").hidden = !view.download || downloadUnavailable;
  $("install-update").hidden = !view.inApp;
  text("download-desktop", view.label);
  $("package-details").hidden = !view.details;
  text("package-checksum", view.details);
  $("release-notes").hidden = false;
}
function applyLanguage(choice) {
  const changed = language.apply(choice);
  $("app-language").value = language.value;
  if (!changed) return;
  document.title = t("Trading Max · 设置", "Trading Max · Settings");
  text("page-title", activePage.textContent.trim());
  if (!$("feedback").hidden && feedbackCopy) text("feedback", feedbackCopy());
  renderRelease();
  if (current) renderStatus(current);
}
getCurrentWebviewWindow().listen("app-language-changed", ({ payload }) => {
  languageRevision++;
  applyLanguage(payload);
}).catch(() => { /* The status poll also carries the saved language. */ });
function renderStatus(state) {
  const available = savedRemote(state.profile);
  if (!saving) {
    $("auto-connect").checked = available && state.profile.auto_connect;
    $("auto-connect").disabled = !available;
  }
  text("startup-name", available ? state.profile.name : t("尚未保存服务连接", "No saved service"));
  text("startup-address", available ? state.profile.url : t("可以先创建本地工作区，或保存一个服务地址。", "Create a local workspace or save a service address."));
  text("installed-version", "v" + state.app_version);
  const workspace = workspacePresentation(state, language.value);
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
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const revision = languageRevision;
    current = await invoke("desktop_status");
    if (!savingLanguage && revision === languageRevision) applyLanguage(current.app_language);
    $("app-language").disabled = savingLanguage;
    renderStatus(current);
  } catch {
    feedback(() => t("暂时无法读取 App 状态，请关闭设置后重新打开。", "Could not read the app status. Close Settings and open it again."), true);
    for (const id of ["app-language", "auto-connect", "return-workspace", "workspace-settings", "workspace-health", "data-folder", "recovery-folder"]) $(id).disabled = true;
  } finally { refreshing = false; }
}
$("app-language").addEventListener("change", async () => {
  if (savingLanguage) return;
  savingLanguage = true;
  $("app-language").disabled = true;
  try {
    const choice = await invoke("set_app_language", { language: $("app-language").value });
    languageRevision++;
    applyLanguage(choice);
  } catch (error) {
    $("app-language").value = language.value;
    feedback(String(error), true);
  } finally {
    savingLanguage = false;
    $("app-language").disabled = false;
  }
});
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
    feedback(() => t("启动偏好已保存，下次打开 App 时生效。", "Startup preference saved. It takes effect the next time you open the app."));
  } catch (error) { feedback(String(error), true); }
  finally { saving = false; await refresh(); }
});
$("check-updates").addEventListener("click", async () => {
  $("check-updates").disabled = true;
  release = null; updateError = null; downloadUnavailable = false;
  $("release-notes").hidden = true;
  $("download-desktop").hidden = true;
  $("install-update").hidden = true;
  $("package-details").hidden = true;
  $("update-result").hidden = false;
  renderRelease();
  try {
    release = await invoke("check_updates");
  } catch (error) { updateError = String(error); }
  renderRelease();
  $("check-updates").disabled = false;
});
$("download-desktop").addEventListener("click", async () => {
  if (!release?.desktop) return;
  $("download-desktop").disabled = true; $("check-updates").disabled = true;
  try {
    await invoke("open_desktop_download", { version: release.desktop.version });
    feedback(() => t("已在浏览器打开官方安装包下载。下载完成后，请退出 App，再在 Finder 中替换应用。资料与连接保留。", "The official installer opened in your browser. When the download finishes, quit the app and replace it in Finder. Data and connections are kept."));
  } catch (error) {
    downloadUnavailable = true; $("download-desktop").hidden = true;
    feedback(String(error), true);
  } finally { $("download-desktop").disabled = false; $("check-updates").disabled = false; }
});
$("install-update").addEventListener("click", async () => {
  if (!release?.desktop?.in_app) return;
  $("install-update").disabled = true;
  $("check-updates").disabled = true;
  try {
    await invoke("install_desktop_update", { version: release.desktop.version });
    // The native update window reports progress and errors itself.
    $("feedback").hidden = true;
  } catch (error) { feedback(String(error), true); }
  finally { $("install-update").disabled = false; $("check-updates").disabled = false; }
});
$("release-notes").addEventListener("click", () => action(() => invoke("open_release_notes", { version: release?.version })));
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 2000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
