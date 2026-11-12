export type Publication = { runId: string | null };

const interval = 60_000;
const wakeInterval = 10_000;
const deadline = 10_000;
const maxBackoff = 300_000;

export function publicationFromHealth(value: unknown): Publication {
  const health = value as { service?: unknown; status?: unknown; latestRunId?: unknown } | null;
  if (health?.service === "trading-max-web" && health.status === "local-fallback") return { runId: null };
  if (health?.service !== "trading_max-api" || !["ok", "degraded"].includes(String(health.status)) ||
      !(health.latestRunId === null || typeof health.latestRunId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(health.latestRunId))) {
    throw new Error("Invalid publication status");
  }
  return { runId: health.latestRunId };
}

/** One scheduler per document. Failed probes don't release a stale in-flight result. */
export function watchPublications(
  read: (signal: AbortSignal) => Promise<Publication>,
  onResult: (value: Publication) => void,
  /** Receives the number of consecutive failed checks. */
  onFailure: (failures: number) => void,
  visible: () => boolean,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastCheck = -Infinity;
  let retryAt = -Infinity;
  let failures = 0;
  let active: AbortController | undefined;
  let resumeSoon = false;
  const clear = () => clearTimeout(timer);
  const schedule = (at: number) => {
    clear();
    if (!stopped && visible()) timer = setTimeout(() => void check(), Math.max(0, at - Date.now()));
  };

  async function check() {
    if (stopped || active || !visible()) return;
    const earliest = Math.max(lastCheck + wakeInterval, retryAt);
    if (earliest > Date.now()) {
      schedule(earliest);
      return;
    }
    lastCheck = Date.now();
    const controller = new AbortController();
    active = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deadline);
    try {
      // A timeout also settles the watcher if a transport fails to honor abort.
      const aborted = new Promise<never>((_, reject) =>
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }),
      );
      const value = await Promise.race([aborted, read(controller.signal)]);
      if (stopped || controller.signal.aborted || !visible()) return;
      failures = 0;
      retryAt = -Infinity;
      onResult(value);
    } catch {
      if (!stopped && visible() && (timedOut || !controller.signal.aborted)) {
        failures = Math.min(failures + 1, 4);
        retryAt = Date.now() + Math.min(maxBackoff, interval * 2 ** (failures - 1));
        onFailure(failures);
      }
    } finally {
      clearTimeout(timeout);
      active = undefined;
      schedule(Math.max(lastCheck + (resumeSoon ? wakeInterval : interval), retryAt));
      resumeSoon = false;
    }
  }

  function wake() {
    clear();
    if (!visible()) {
      active?.abort();
      return;
    }
    if (active?.signal.aborted) resumeSoon = true;
    else void check();
  }

  return {
    wake,
    retry() {
      retryAt = -Infinity;
      wake();
    },
    dispose() {
      stopped = true;
      clear();
      active?.abort();
    },
  };
}
