// One request per child; no listener, background service, agent loop or disk state.
let size = 0;
const chunks = [];
try {
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new Error("request too large");
    chunks.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const { complete } = await import("./complete.mjs");
  process.stdout.write(JSON.stringify(await complete(request)));
} catch {
  process.stdout.write(JSON.stringify({ error: "provider_runtime_unavailable" }));
  process.exitCode = 1;
}
