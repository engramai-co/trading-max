import type { useCopy } from "../foundation";
import { ASSISTANT_NAME } from "../assistant-settings";

export function errorLabel(code: string, t: ReturnType<typeof useCopy>) {
  if (code === "assistant_busy" || code === "provider_rate_limited") return t("服务繁忙，稍后重试。", "The service is busy. Try again shortly.");
  if (code === "assistant_consent_required" || code === "assistant_disabled") return t("请在设置中启用 {name} 并确认数据共享。", "Enable {name} and confirm data sharing in Settings.").replace("{name}", ASSISTANT_NAME);
  if (code === "provider_auth_failed" || code === "provider_not_configured") return t("请在设置中检查模型连接。", "Check the model connection in Settings.");
  if (code === "assistant_timeout") return t("解读超时。", "The reading timed out.");
  if (code === "assistant_limit_reached") return t("这次解读达到了使用上限。", "This reading reached its usage limit.");
  if (code === "assistant_context_too_long") return t("对话超出模型的上下文限制。", "The conversation exceeded the model’s context limit.");
  if (code === "provider_unavailable") return t("模型服务暂不可用。", "The model service is unavailable.");
  if (code === "provider_model_rejected") return t("模型服务拒绝了请求。", "The model service rejected the request.");
  if (code === "provider_content_filtered") return t("模型服务拦截了这条消息。", "The model service filtered the message.");
  if (code === "provider_invalid_output") return t("模型返回的内容不完整。", "The model returned an incomplete result.");
  return t("这次解读未能完成。", "This reading could not be completed.");
}
