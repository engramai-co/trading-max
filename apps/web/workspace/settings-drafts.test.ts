import { describe, expect, it } from "vitest";
import type { UserProfile } from "@/lib/types";
import { isAcceptedPreferencesSave, reconcileModelRoutingDraft, reconcilePreferencesDraft, sameStringRecord } from "./settings-drafts";

const profile: UserProfile = {
  profileId: "synthetic",
  displayName: "Synthetic",
  initials: "S",
  avatarColor: "blue",
  locale: "en",
  baseCurrency: "GBP",
  timezone: "Europe/London",
  accountLabels: { A: "Invest", B: "Stocks ISA" },
  revision: 2,
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("settings save reconciliation", () => {
  it("keeps only draft fields changed during the save, including individual labels", () => {
    const submitted = {
      values: { ...profile, expectedRevision: 1 },
      timeZonePreference: "browser",
    };
    const draft = {
      baseRevision: 1,
      name: "Synthetic ",
      zone: "browser",
      labels: { A: "Invest", B: "Core ISA" },
    };

    expect(reconcilePreferencesDraft(draft, submitted, profile)).toEqual({
      baseRevision: 2, labels: { B: "Core ISA" },
    });
    expect(reconcilePreferencesDraft({ ...draft, baseRevision: 3 }, submitted, profile))
      .toEqual({ ...draft, baseRevision: 3 });
  });

  it("accepts only the next profile revision with the submitted values", () => {
    const submitted = {
      values: { displayName: profile.displayName, expectedRevision: 1 },
    };
    expect(isAcceptedPreferencesSave(profile, submitted)).toBe(true);
    expect(isAcceptedPreferencesSave({ ...profile, revision: 3 }, submitted)).toBe(false);
    expect(isAcceptedPreferencesSave({ ...profile, displayName: "Another writer" }, submitted)).toBe(false);
  });

  it("carries only in-flight routing edits onto the committed policy", () => {
    const submitted = {
      defaultRoute: "openai/legacy",
      overrides: { taxonomy: "openai/gpt-5", portfolio: "openai/legacy" },
      expectedRevision: 4,
    };
    const committed = {
      defaultRoute: "openai/gpt-5",
      overrides: { taxonomy: "openai/gpt-5", portfolio: "openai/gpt-5" },
      revision: 5,
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const draft = {
      baseRevision: 4,
      defaultRoute: submitted.defaultRoute,
      overrides: { portfolio: "openai/legacy" },
    };

    expect(reconcileModelRoutingDraft(draft, submitted, committed)).toEqual({
      baseRevision: 5,
      overrides: { portfolio: "openai/gpt-5" },
    });
    expect(reconcileModelRoutingDraft(draft, submitted, { ...committed, revision: 6 })).toBeUndefined();
    expect(sameStringRecord({ a: "A", b: "B" }, { b: "B", a: "A" })).toBe(true);
  });
});
