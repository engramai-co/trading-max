import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTimeoutSignal } from "./abort";
import { isReadTimeout, readApi } from "./data";

const originalAny = Object.getOwnPropertyDescriptor(AbortSignal, "any");

function restoreAbortSignalAny() {
  if (originalAny) Object.defineProperty(AbortSignal, "any", originalAny);
  else Reflect.deleteProperty(AbortSignal, "any");
}

function pendingWithAbort(onSignal?: (signal: AbortSignal) => void) {
  return (signal: AbortSignal) =>
    new Promise<string>((_resolve, reject) => {
      onSignal?.(signal);
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
}

afterEach(() => {
  restoreAbortSignalAny();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("withTimeoutSignal without AbortSignal.any", () => {
  beforeEach(() => {
    Reflect.deleteProperty(AbortSignal, "any");
  });

  it("propagates caller abort reason, skips timeout, and cleans up", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const reason = new Error("caller-cancelled");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const removeListenerSpy = vi.spyOn(caller.signal, "removeEventListener");

    let received: AbortSignal | undefined;
    const promise = withTimeoutSignal(
      caller.signal,
      5_000,
      pendingWithAbort((signal) => {
        received = signal;
      }),
    );

    expect(received?.aborted).toBe(false);
    caller.abort(reason);

    await expect(promise).rejects.toBe(reason);
    expect(received?.aborted).toBe(true);
    expect(received?.reason).toBe(reason);
    expect(isReadTimeout(reason)).toBe(false);

    vi.advanceTimersByTime(10_000);
    expect(received?.reason).toBe(reason);
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(removeListenerSpy).toHaveBeenCalledTimes(1);
  });

  it("handles pre-aborted caller signals without scheduling timers or listeners", async () => {
    const caller = new AbortController();
    const reason = new Error("already-aborted");
    caller.abort(reason);
    const addListenerSpy = vi.spyOn(caller.signal, "addEventListener");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    let received: AbortSignal | undefined;
    await expect(
      withTimeoutSignal(caller.signal, 5_000, async (signal) => {
        received = signal;
        return "stale-result";
      }),
    ).rejects.toBe(reason);

    expect(received?.aborted).toBe(true);
    expect(received?.reason).toBe(reason);
    expect(addListenerSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("fires TimeoutError on timeout, keeps first abort reason, and removes listener", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const removeListenerSpy = vi.spyOn(caller.signal, "removeEventListener");

    let received: AbortSignal | undefined;
    const promise = withTimeoutSignal(
      caller.signal,
      4_000,
      pendingWithAbort((signal) => {
        received = signal;
      }),
    );

    vi.advanceTimersByTime(4_000);

    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("TimeoutError");
    expect(isReadTimeout(error)).toBe(true);
    expect(received?.aborted).toBe(true);
    expect(received?.reason).toBe(error);

    caller.abort("late-caller-abort");
    expect(received?.reason).toBe(error);
    expect(removeListenerSpy).toHaveBeenCalledTimes(1);
  });

  it("classifies timeout as TimeoutError even when fetch reports AbortError", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();

    const promise = withTimeoutSignal(caller.signal, 4_000, (signal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted.", "AbortError")),
          { once: true },
        );
      }),
    );

    vi.advanceTimersByTime(4_000);

    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("TimeoutError");
    expect(isReadTimeout(error)).toBe(true);
  });

  it("rejects stale results when the operation resolves after abort or timeout", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let resolveCallerAbort!: (value: string) => void;
    const cancelled = withTimeoutSignal(
      caller.signal,
      5_000,
      () => new Promise<string>((resolve) => { resolveCallerAbort = resolve; }),
    );
    caller.abort("navigated-away");
    resolveCallerAbort("stale");
    await expect(cancelled).rejects.toBe("navigated-away");

    const secondCaller = new AbortController();
    let resolveTimedOut!: (value: string) => void;
    const timedOut = withTimeoutSignal(
      secondCaller.signal,
      1_000,
      () => new Promise<string>((resolve) => { resolveTimedOut = resolve; }),
    );
    vi.advanceTimersByTime(1_000);
    resolveTimedOut("stale-after-timeout");
    const error = await timedOut.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("TimeoutError");
  });

  it("removes listener and clears timer on normal resolution and non-abort rejection", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const addListenerSpy = vi.spyOn(caller.signal, "addEventListener");
    const removeListenerSpy = vi.spyOn(caller.signal, "removeEventListener");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    await expect(
      withTimeoutSignal(caller.signal, 5_000, async () => "ok"),
    ).resolves.toBe("ok");

    expect(addListenerSpy).toHaveBeenCalledTimes(1);
    const registeredListener = addListenerSpy.mock.calls[0][1];
    expect(removeListenerSpy).toHaveBeenCalledWith("abort", registeredListener);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);

    const failure = new Error("server-500");
    await expect(
      withTimeoutSignal(caller.signal, 5_000, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(removeListenerSpy).toHaveBeenCalledTimes(2);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
  });

  it("lets readApi reach fetch and time out without AbortSignal.any", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          fetchSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted.", "AbortError")),
            { once: true },
          );
        });
      }),
    );

    const pending = readApi("/indices/catalog", caller.signal);
    expect(fetchSignal).toBeDefined();
    expect(fetchSignal?.aborted).toBe(false);

    vi.advanceTimersByTime(20_000);
    const error = await pending.catch((caught: unknown) => caught);
    expect(isReadTimeout(error)).toBe(true);
  });
});

describe("withTimeoutSignal with native AbortSignal.any", () => {
  it("uses AbortSignal.any when present and clears the deadline timer on completion", async () => {
    vi.useFakeTimers();
    const anySpy = vi.spyOn(AbortSignal, "any");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const caller = new AbortController();

    await expect(
      withTimeoutSignal(caller.signal, 5_000, async () => "native-ok"),
    ).resolves.toBe("native-ok");

    expect(anySpy).toHaveBeenCalledTimes(1);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });
});
