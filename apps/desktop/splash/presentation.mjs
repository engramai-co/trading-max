// Desktop presentation only. Service-owned data/job health is not inferred
// from a successful connection or a recently published snapshot.
export function workspacePresentation(state) {
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
    kind: remote ? "远程服务" : local ? "本地工作区" : demo ? "独立演示" : "尚未连接",
    name: state.active_name || state.source_name || (local ? state.workspace?.name : null) ||
      (remote ? "已选择的服务" : demo ? "演示资料" : "尚未打开工作区"),
    address,
    ready,
    available: ready || retained,
    status: state.stage === "reconnecting" ? "连接中断 · 正在重连" : ready ? "已连接" : ["error", "offline"].includes(state.stage) ? "连接中断" :
      ["connecting", "loading"].includes(state.stage) ? "正在打开" : "未连接",
    detail: retained ? (state.stage === "reconnecting" ? "当前页面已保留，数据可能未更新。连接恢复后继续使用。" : state.detail || "请检查连接后手动重试。当前页面已保留，数据可能未更新。") : ready ? (state.probe && (!state.probe.healthy || state.probe.worker_healthy === false)
      ? "连接可用，但后台更新状态需要检查。请打开「同步与活动」查看详情。"
      : "连接可用。采集任务与资料完整性请查看「同步与活动」。") :
      state.stage === "error" ? "可以切换工作区，或从「连接」菜单重试。已保存的资料不会被清空。" :
      "选择工作区后，可在这里查看它的数据与连接设置。",
    settingsLabel: remote ? "服务端设置" : "工作区设置",
    ownership: remote ? "数据与密钥保存在服务端。退出这个 App，不影响远程主机继续采集。" :
      local ? "资料保存在这个文件夹，密钥存入本机钥匙串。退出 App 或 Mac 休眠后，本地采集暂停。" :
      demo ? "这里使用独立的模拟资料，不会连接真实账户。" : "App 设置不需要连接服务，也不会启动采集。",
    canRevealFolder: local && Boolean(state.workspace?.path),
  };
}

export function savedRemote(profile) {
  return profile?.mode === "remote" && Boolean(profile.url);
}
