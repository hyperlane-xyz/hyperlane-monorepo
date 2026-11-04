import { expect } from 'chai';
import { mock } from 'node:test';
import { createElement } from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';

import { useAsyncPolling } from './useAsyncPolling.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Promise not initialized');
  };
  let reject: (reason: Error) => void = () => {
    throw new Error('Promise not initialized');
  };
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

describe('async polling request ownership', () => {
  let renderer: ReactTestRenderer | undefined;
  let latest: ReturnType<typeof useAsyncPolling<number>> | undefined;
  function Probe(props: {
    request: () => Promise<number>;
    requestKey: string;
  }) {
    latest = useAsyncPolling(props.request, props.requestKey, 100);
    return null;
  }
  beforeEach(() => {
    mock.timers.enable({ apis: ['setInterval'] });
  });
  afterEach(async () => {
    await act(async () => {
      renderer?.unmount();
    });
    renderer = undefined;
    latest = undefined;
    mock.timers.reset();
  });

  for (const failOld of [false, true]) {
    it(`ignores a stale ${failOld ? 'error' : 'success'} after changing request identity`, async () => {
      const old = deferred<number>();
      const current = deferred<number>();
      await act(async () => {
        renderer = create(
          createElement(Probe, {
            request: () => old.promise,
            requestKey: 'old',
          }),
        );
      });
      await act(async () => {
        renderer?.update(
          createElement(Probe, {
            request: () => current.promise,
            requestKey: 'new',
          }),
        );
      });
      await act(async () => {
        current.resolve(2);
      });
      expect(latest?.data).to.equal(2);
      await act(async () => {
        if (failOld) old.reject(new Error('old request failed'));
        else old.resolve(1);
      });
      expect(latest?.data).to.equal(2);
      expect(latest?.error).to.equal(null);
      expect(latest?.isLoading).to.equal(false);
    });
  }

  it('does not overlap polls, recovers from failure, and stops admission after unmount', async () => {
    let calls = 0;
    const first = deferred<number>();
    const request = () => {
      calls++;
      return calls === 1 ? first.promise : Promise.resolve(7);
    };
    await act(async () => {
      renderer = create(createElement(Probe, { request, requestKey: 'same' }));
    });
    await act(async () => {
      mock.timers.tick(1000);
    });
    expect(calls).to.equal(1);
    await act(async () => {
      first.reject(new Error('retryable'));
    });
    expect(latest?.error).to.contain('retryable');
    await act(async () => {
      mock.timers.tick(100);
    });
    expect(calls).to.equal(2);
    expect(latest?.data).to.equal(7);
    expect(latest?.error).to.equal(null);
    await act(async () => {
      renderer?.unmount();
    });
    renderer = undefined;
    await act(async () => {
      mock.timers.tick(1000);
    });
    expect(calls).to.equal(2);
  });
  it('ignores a request that completes after unmount', async () => {
    const pending = deferred<number>();
    let renders = 0;
    function PendingProbe() {
      renders++;
      useAsyncPolling(() => pending.promise, 'pending', 100);
      return null;
    }
    await act(async () => {
      renderer = create(createElement(PendingProbe));
    });
    await act(async () => {
      renderer?.unmount();
    });
    renderer = undefined;
    const before = renders;
    await act(async () => {
      pending.resolve(9);
      mock.timers.tick(1000);
    });
    expect(renders).to.equal(before);
  });
});
