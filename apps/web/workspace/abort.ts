function abortReason(signal: AbortSignal) {
  return "reason" in signal && signal.reason !== undefined
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function errorName(error: unknown) {
  return error instanceof Error || (typeof DOMException !== "undefined" && error instanceof DOMException)
    ? error.name
    : undefined;
}

/** Combine a caller signal with a timeout without requiring `AbortSignal.any`. */
export async function withTimeoutSignal<T>(
  caller: AbortSignal | undefined,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadlineReason = new DOMException("The operation timed out.", "TimeoutError");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listener: (() => void) | undefined;

  const cleanup = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (listener && caller) {
      caller.removeEventListener("abort", listener);
      listener = undefined;
    }
  };

  let signal: AbortSignal;
  if (caller?.aborted) {
    const reason = abortReason(caller);
    if ("reason" in caller && caller.reason !== undefined) {
      signal = caller;
    } else {
      controller.abort(reason);
      signal = controller.signal;
    }
  } else if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    timer = setTimeout(() => controller.abort(deadlineReason), timeoutMs);
    signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
  } else {
    listener = () => {
      cleanup();
      if (!controller.signal.aborted && caller) controller.abort(abortReason(caller));
    };
    caller?.addEventListener("abort", listener, { once: true });
    timer = setTimeout(() => {
      cleanup();
      if (!controller.signal.aborted) controller.abort(deadlineReason);
    }, timeoutMs);
    signal = controller.signal;
  }

  try {
    const value = await run(signal);
    if (signal.aborted) throw abortReason(signal);
    return value;
  } catch (error) {
    if (signal.aborted && errorName(error) === "AbortError") {
      throw abortReason(signal);
    }
    throw error;
  } finally {
    cleanup();
  }
}
