import type { useCopy } from "../foundation";

export function errorLabel(code: string, t: ReturnType<typeof useCopy>) {
  if (code === "assistant_busy" || code === "provider_rate_limited") return t("服务繁忙，稍后重试。", "The service is busy. Try again shortly.");
  if (code === "assistant_consent_required" || code === "assistant_disabled") return t("请在设置中启用助手并确认数据共享。", "Enable the assistant and confirm data sharing in Settings.");
  if (code === "provider_auth_failed" || code === "provider_not_configured") return t("请在设置中检查模型连接。", "Check the model connection in Settings.");
  return t("这次解读未能完成。", "This reading could not be completed.");
}
