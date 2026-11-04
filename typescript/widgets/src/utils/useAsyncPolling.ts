import { useEffect, useRef, useState } from 'react';

interface PollingState<T> {
  key: unknown;
  data: T | undefined;
  error: string | null;
  isLoading: boolean;
}

/** One request owner per input key; old completions cannot publish after cleanup. */
export function useAsyncPolling<T>(
  request: () => Promise<T>,
  key: unknown,
  interval: number | null,
  shouldPoll?: (data: T | undefined) => boolean,
) {
  const requestRef = useRef(request);
  const shouldPollRef = useRef(shouldPoll);
  const [state, setState] = useState<PollingState<T>>({
    key,
    data: undefined,
    error: null,
    isLoading: true,
  });
  useEffect(() => {
    requestRef.current = request;
  }, [request]);
  useEffect(() => {
    shouldPollRef.current = shouldPoll;
  }, [shouldPoll]);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let data: T | undefined;
    let error: string | null = null;
    const poll = async () => {
      if (!active || inFlight || shouldPollRef.current?.(data) === false)
        return;
      inFlight = true;
      setState({ key, data, error, isLoading: true });
      try {
        const result = await requestRef.current();
        if (!active) return;
        data = result;
        error = null;
      } catch (failure: unknown) {
        if (!active) return;
        error = String(failure);
      } finally {
        inFlight = false;
        if (active) setState({ key, data, error, isLoading: false });
      }
    };
    void poll();
    const timer =
      interval === null
        ? undefined
        : setInterval(() => {
            void poll();
          }, interval);
    return () => {
      active = false;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [key, interval]);

  // Hide old data during the render that changes inputs, before effects run.
  return Object.is(state.key, key)
    ? state
    : { key, data: undefined, error: null, isLoading: true };
}
