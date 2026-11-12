import { translate } from "./language.mjs";

// Desktop presentation only. Service-owned data/job health is not inferred
// from a successful connection or a recently published snapshot.
export function workspacePresentation(state, language = state.app_language) {
  const t = (zh, en) => translate(language, zh, en);
  const remote = state.mode === "remote";
  const local = state.mode === "local";
  const demo = state.mode === "demo";
  const ready = state.stage === "ready";
  const retained = Boolean(state.active_url) && ["reconnecting", "offline"].includes(state.stage);
  let address = "";
  if (remote && (state.source_address || state.active_url)) {
    try { address = new URL(state.source_address || state.active_url).host; } catch { /* Unavailable address. */ }
  } else if (local) address = state.workspace?.path ?? "";
  return {
    kind: remote ? t("远程服务", "Remote service") : local ? t("本地工作区", "Local workspace")
      : demo ? t("独立演示", "Standalone demo") : t("尚未连接", "No connection"),
    name: demo && language === "en" ? "Demo data" :
      state.active_name || state.source_name || (local ? state.workspace?.name : null) ||
      (remote ? t("已选择的服务", "Selected service") : demo ? "演示资料" : t("尚未打开工作区", "No workspace open")),
    address,
    ready,
    available: ready || retained,
    status: state.stage === "reconnecting" ? t("连接中断 · 正在重连", "Disconnected · Reconnecting") :
      ready ? t("已连接", "Connected") : ["error", "offline"].includes(state.stage) ? t("连接中断", "Disconnected") :
      ["connecting", "loading"].includes(state.stage) ? t("正在打开", "Opening") : t("未连接", "Not connected"),
    detail: retained ? (state.stage === "reconnecting"
      ? t("当前页面已保留，数据可能未更新。连接恢复后继续使用。", "The current page is still open. Data may be out of date while the connection recovers.")
      : state.detail || t("请检查连接后手动重试。当前页面已保留，数据可能未更新。", "Check your connection and retry. The current page is still open, but data may be out of date."))
      : ready ? (state.probe && (!state.probe.healthy || state.probe.worker_healthy === false)
        ? t("连接可用，但后台更新状态需要检查。请打开「同步与活动」查看详情。", "Connected. Check Sync & activity for problems with background updates.")
        : t("连接可用。采集任务与资料完整性请查看「同步与活动」。", "Connected. Check Sync & activity for collection jobs and data coverage."))
      : state.stage === "error"
        ? t("可以切换工作区，或从「连接」菜单重试。已保存的资料不会被清空。", "Switch workspaces or retry from the Connection menu. Saved data is kept.")
        : t("选择工作区后，可在这里查看它的数据与连接设置。", "Open a workspace to see its data and connection settings here."),
    settingsLabel: remote ? t("服务端设置", "Service settings") : t("工作区设置", "Workspace settings"),
    ownership: remote ? t("数据与密钥保存在服务端。退出这个 App，不影响远程主机继续采集。", "The service stores data and keys and keeps collecting when you quit the app.")
      : local ? t("资料保存在这个文件夹，密钥存入本机钥匙串。退出 App 或 Mac 休眠后，本地采集暂停。", "This folder stores the data. The Mac’s Keychain stores credentials. Local collection pauses when the app quits or the Mac sleeps.")
      : demo ? t("这里使用独立的模拟资料，不会连接真实账户。", "The demo uses synthetic data and does not connect to real accounts.")
      : t("App 设置不需要连接服务，也不会启动采集。", "App settings work offline and do not start collection."),
    canRevealFolder: local && Boolean(state.workspace?.path),
  };
}

export function savedRemote(profile) {
  return profile?.mode === "remote" && Boolean(profile.url);
}

export function recentWorkspacePresentation(workspace, state, language) {
  const active = workspace.available && state.stage === "ready" && state.workspace?.path === workspace.path;
  return {
    action: !workspace.available ? null : active ? "return" : "open",
    label: !workspace.available ? translate(language, "不可用", "Unavailable")
      : active ? translate(language, "回到工作台", "Back to workspace")
      : translate(language, "打开", "Open"),
    canForget: !active,
  };
}
