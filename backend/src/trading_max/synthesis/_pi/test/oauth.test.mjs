import assert from "node:assert/strict";
import { test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { oauth } from "../oauth.mjs";
import { complete } from "../complete.mjs";

const token = (suffix = "fixture") => `e30.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" },
})).toString("base64url")}.${suffix}`;
const credential = { type: "oauth", access: token(), refresh: "synthetic-refresh", expires: 1, accountId: "synthetic-account" };
const response = (json, status = 200) => new Response(JSON.stringify(json), { status });

test("Pi performs device-code login, pending polling and token exchange", async () => {
  const events = [], calls = [];
  let polls = 0;
  const result = await oauth({ operation: "login" }, (event) => events.push(event), {
    fetch: async (url, init) => {
      calls.push(new URL(url).pathname);
      assert.equal(init.redirect, "error");
      if (String(url).endsWith("/usercode")) return response({ device_auth_id: "fixture", user_code: "TEST-1234", interval: 0 });
      if (String(url).endsWith("/deviceauth/token")) return ++polls === 1 ? response({}, 403)
        : response({ authorization_code: "fixture-code", code_verifier: "fixture-verifier" });
      assert.equal(new URLSearchParams(init.body).get("grant_type"), "authorization_code");
      return response({ access_token: token(), refresh_token: "synthetic-refresh", expires_in: 3600 });
    },
  });
  assert.equal(result.credential.accountId, "synthetic-account");
  assert.equal(result.credential.refresh, "synthetic-refresh");
  assert.equal(events.length, 1);
  assert.equal(events[0].verificationUri, "https://auth.openai.com/codex/device");
  assert.equal(events[0].userCode, "TEST-1234");
  assert.equal(JSON.stringify(events).includes("synthetic-refresh"), false);
  assert.equal(calls.filter((path) => path.endsWith("/deviceauth/token")).length, 2);
});

test("Pi refreshes expired OAuth and returns the rotated credential for native persistence", async () => {
  let calls = 0;
  const result = await oauth({ operation: "resolve", credential }, undefined, { fetch: async (_url, init) => {
    calls++;
    const body = new URLSearchParams(init.body);
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "synthetic-refresh");
    return response({ access_token: token("rotated"), refresh_token: "rotated-refresh", expires_in: 3600 });
  } });
  assert.equal(calls, 1);
  assert.equal(result.auth.apiKey, token("rotated"));
  assert.equal(result.credential.refresh, "rotated-refresh");
  let unexpectedFetch = false;
  const fresh = await oauth({ operation: "resolve", credential: result.credential }, undefined, { fetch: async () => {
    unexpectedFetch = true; throw new Error("unnecessary refresh");
  } });
  assert.equal(unexpectedFetch, false);
  assert.equal(fresh.auth.apiKey, token("rotated"));
});

test("OAuth errors expose no upstream tokens or payloads and cancellation is bounded", async () => {
  const failed = await oauth({ operation: "login" }, undefined, { fetch: async () => response({ secret: "never-return-this" }, 500) });
  assert.deepEqual(failed, { error: "provider_auth_failed" });
  const controller = new AbortController();
  controller.abort();
  const aborted = await oauth({ operation: "login" }, undefined, { signal: controller.signal, fetch: async () => {
    throw new Error("private-diagnostics");
  } });
  assert.deepEqual(aborted, { error: "oauth_expired" });
});

test("ChatGPT Luna requests use Pi's Codex transport and account header, not the Platform API", async () => {
  let body;
  const result = await complete({
    provider: "openai-codex", model: "gpt-5.6-luna", apiKey: token(),
    baseUrl: "https://chatgpt.com/backend-api", maxRetries: 0, timeoutMs: 2000,
    context: { systemPrompt: "Return JSON.", messages: [{ role: "user", content: "fixture", timestamp: 1 }] },
  }, { fetch: async (url, init) => {
    assert.equal(new URL(url).origin, "https://chatgpt.com");
    assert.equal(new Headers(init.headers).get("chatgpt-account-id"), "synthetic-account");
    body = JSON.parse(new Headers(init.headers).get("content-encoding") === "zstd"
      ? zstdDecompressSync(init.body).toString() : init.body);
    const events = [
      { type: "response.created", response: { id: "fixture", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m1", role: "assistant", content: [] } },
      { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: '{"ok":true}' },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 2 } } },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.store, false);
  assert.equal(result.error, undefined);
  assert.equal(result.text, '{"ok":true}');
});
