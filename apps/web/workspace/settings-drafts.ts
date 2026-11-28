import type { LLMRoutePolicy, UserProfile } from "@/lib/types";

export type PreferencesDraft = {
  baseRevision: number;
  name?: string;
  zone?: string;
  labels?: Record<string, string>;
};

export type PreferencesSubmission = {
  values: Partial<Pick<UserProfile, "displayName" | "accountLabels" | "locale" | "timezone">> & {
    expectedRevision: number;
  };
  timeZonePreference?: string;
};

export type ModelRoutingDraft = {
  baseRevision: number;
  defaultRoute?: string;
  overrides?: Record<string, string>;
};

export type ModelRoutingSubmission = {
  defaultRoute: string;
  overrides: Record<string, string>;
  expectedRevision: number;
};

export function sameStringRecord(a: Record<string, string>, b: Record<string, string>) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

export function isAcceptedPreferencesSave(
  profile: UserProfile,
  submitted: PreferencesSubmission,
) {
  const { expectedRevision, displayName, accountLabels, locale, timezone } = submitted.values;
  return profile.revision === expectedRevision + 1 &&
    (displayName === undefined || displayName === profile.displayName) &&
    (accountLabels === undefined || sameStringRecord(accountLabels, profile.accountLabels)) &&
    (locale === undefined || locale === profile.locale) &&
    (timezone === undefined || timezone === profile.timezone);
}

export function reconcilePreferencesDraft(
  current: PreferencesDraft,
  submitted: PreferencesSubmission,
  committed: UserProfile,
): PreferencesDraft | undefined {
  if (current.baseRevision !== submitted.values.expectedRevision) return current;

  const labels = Object.fromEntries(Object.entries(current.labels ?? {}).filter(
    ([code, label]) => label !== committed.accountLabels[code],
  ));
  const name = current.name?.trim() === committed.displayName ? undefined : current.name;
  const zone = current.zone === submitted.timeZonePreference ? undefined : current.zone;
  if (name === undefined && zone === undefined && !Object.keys(labels).length) return undefined;
  return { baseRevision: committed.revision, name, zone, labels };
}

export function reconcileModelRoutingDraft(
  current: ModelRoutingDraft | undefined,
  submitted: ModelRoutingSubmission,
  committed: LLMRoutePolicy,
): ModelRoutingDraft | undefined {
  if (!current || current.baseRevision !== submitted.expectedRevision) return current;
  // Older services can return another writer's policy if it won a race with the response.
  if (committed.revision !== submitted.expectedRevision + 1) return undefined;

  const overrides = { ...committed.overrides };
  if (current.overrides) {
    for (const lens of new Set([...Object.keys(current.overrides), ...Object.keys(submitted.overrides)])) {
      const route = current.overrides[lens];
      if (route === submitted.overrides[lens]) continue;
      if (route === undefined) delete overrides[lens];
      else overrides[lens] = route;
    }
  }
  const defaultRoute = current.defaultRoute === submitted.defaultRoute ? undefined : current.defaultRoute;
  const overridesChanged = !sameStringRecord(overrides, committed.overrides);
  if (!defaultRoute && !overridesChanged) return undefined;
  return { baseRevision: committed.revision, defaultRoute, overrides: overridesChanged ? overrides : undefined };
}
