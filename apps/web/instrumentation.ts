export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startHistoryPrewarm } = await import("./lib/history-prewarm");
  startHistoryPrewarm();
}
