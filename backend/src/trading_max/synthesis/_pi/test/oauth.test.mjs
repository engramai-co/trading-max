import assert from "node:assert/strict";
import { test } from "node:test";
import { oauth } from "../oauth.mjs";

const token = (suffix = "fixture") => `e30.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" },
})).toString("base64url")}.${suffix}`;
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

test("Only device login is available from the helper", async () => {
  const result = await oauth({ operation: "resolve" }, undefined, {
    fetch: async () => assert.fail("inference and refresh belong to Python"),
  });
  assert.deepEqual(result, { error: "provider_not_configured" });
});
