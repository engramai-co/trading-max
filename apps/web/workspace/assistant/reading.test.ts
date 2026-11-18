import { afterEach, expect, it, vi } from "vitest";
import { fetchReading } from "./reading";

afterEach(() => vi.unstubAllGlobals());
it.each([["assistant_role_unknown", "assistant_role_unknown"], ["untrusted", "assistant_unavailable"]])("handles failed role response %s", async (code, expected) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({detail:{code}}, {status:404})));
  await expect(fetchReading({role:"test",context:{}}, new AbortController().signal)).rejects.toThrow(expected);
});
