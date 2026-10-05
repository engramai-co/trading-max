export function releasePresentation(result) {
  const desktop = result.desktop;
  if (!desktop) return {
    message: `仓库稳定版 v${result.version}。最近 30 个发布中尚无适用于这台 Mac 的正式桌面安装包；当前 App 可以继续使用。`,
    download: false, label: "下载 Mac 安装包 ↗", details: "",
  };
  const comparison = desktop.relation === "newer" ? "有新版本可下载。"
    : desktop.relation === "same" ? "本机已是这个版本，可以重新下载安装包。"
    : "本机版本较新，无需降级。";
  return {
    message: `桌面版 v${desktop.version}，${comparison} 仓库稳定版为 v${result.version}。`,
    download: desktop.relation !== "older",
    label: desktop.relation === "same" ? "重新下载安装包 ↗" : "下载 Mac 安装包 ↗",
    details: `Apple Silicon · macOS 13 或更新 · ${(desktop.size / 1048576).toFixed(1)} MB\nSHA-256：${desktop.sha256}`,
  };
}
