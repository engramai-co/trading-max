// One request per child; OAuth device login may emit progress before its result.
// No listener, agent loop or disk state.
let size = 0;
const chunks = [];
try {
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 4 * 1024) throw new Error("request too large");
    chunks.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (request.provider !== "openai-codex" || request.operation !== "login") {
    throw new Error("device login only");
  }
  const { oauth } = await import("./oauth.mjs");
  const abort = new AbortController();
  process.once("SIGTERM", () => abort.abort());
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(900_000)]);
  const result = await oauth(request, (event) => {
    process.stdout.write(JSON.stringify(event) + "\n");
  }, { signal });
  process.stdout.write(JSON.stringify(result) + "\n");
} catch {
  process.stdout.write(JSON.stringify({ error: "provider_runtime_unavailable" }));
  process.exitCode = 1;
}
