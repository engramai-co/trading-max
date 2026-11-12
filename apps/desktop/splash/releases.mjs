import { translate } from "./language.mjs";

export function releasePresentation(result, language) {
  const t = (zh, en) => translate(language, zh, en);
  const desktop = result.desktop;
  const downloadLabel = t("下载 Mac 安装包 ↗", "Download the Mac installer ↗");
  if (!desktop) return {
    message: t(
      `仓库稳定版 v${result.version}。最近 30 个发布中尚无适用于这台 Mac 的正式桌面安装包；当前 App 可以继续使用。`,
      `Repository release v${result.version}. The last 30 releases have no official desktop installer for this Mac. You can keep using the current app.`),
    download: false, inApp: false, label: downloadLabel, details: "",
  };
  const comparison = desktop.relation === "newer" ? t("有新版本可下载。", "A new version is available.")
    : desktop.relation === "same" ? t("本机已是这个版本，可以重新下载安装包。", "This version is installed. You can download the installer again.")
    : t("本机版本较新，无需降级。", "A newer version is installed.");
  return {
    message: t(`桌面版 v${desktop.version}，${comparison} 仓库稳定版为 v${result.version}。`,
      `Desktop v${desktop.version}. ${comparison} Repository release v${result.version}.`),
    download: desktop.relation !== "older",
    inApp: desktop.relation === "newer" && desktop.in_app === true,
    label: desktop.relation === "same" ? t("重新下载安装包 ↗", "Download the installer again ↗") : downloadLabel,
    details: t("Apple Silicon · macOS 13 或更新", "Apple Silicon · macOS 13 or later") +
      ` · ${(desktop.size / 1048576).toFixed(1)} MB\n` + t("SHA-256：", "SHA-256: ") + desktop.sha256,
  };
}
