import { expect } from 'chai';
import sinon from 'sinon';

import { fetchWithDeadline } from './fetchWithDeadline.js';

const URL = 'https://bridge.example/quote';

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected request to reject');
}

describe('fetchWithDeadline', () => {
  afterEach(() => sinon.restore());

  it('bounds stalled headers even when fetch ignores abort', async () => {
    const clock = sinon.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    sinon.stub(globalThis, 'fetch').callsFake((_url, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => undefined);
    });
    const result = captureError(
      fetchWithDeadline(URL, {}, 100, (response) => response.json()),
    );

    await clock.tickAsync(100);

    expect((await result).message).to.include('timed out after 100ms');
    expect(signal?.aborted).to.equal(true);
  });

  for (const status of [200, 503]) {
    it(`shares one deadline between headers and a stalled HTTP ${status} body`, async () => {
      const clock = sinon.useFakeTimers();
      let signal: AbortSignal | null | undefined;
      sinon.stub(globalThis, 'fetch').callsFake((_url, init) => {
        signal = init?.signal;
        return new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(new Response(new ReadableStream(), { status })),
            60,
          );
        });
      });
      const result = captureError(
        fetchWithDeadline(URL, {}, 100, (response) => response.json()),
      );

      await clock.tickAsync(99);
      expect(signal?.aborted).to.equal(false);
      await clock.tickAsync(1);

      expect((await result).message).to.include('timed out after 100ms');
      expect(signal?.aborted).to.equal(true);
      expect(clock.now).to.equal(100);
    });
  }

  it('returns without awaiting cancellation of an unused response body', async () => {
    const body = new ReadableStream();
    const cancel = sinon
      .stub(body, 'cancel')
      .returns(new Promise<void>(() => undefined));
    const fetch = sinon
      .stub(globalThis, 'fetch')
      .resolves(new Response(body, { status: 404 }));

    const status = await fetchWithDeadline(
      URL,
      {},
      100,
      async (response) => response.status,
    );

    expect(status).to.equal(404);
    expect(cancel.called).to.equal(false);
    expect(fetch.firstCall.args[1]?.signal?.aborted).to.equal(true);
  });

  it('preserves body errors and clears the deadline on failure', async () => {
    const clock = sinon.useFakeTimers();
    const failure = new Error('invalid body');
    sinon.stub(globalThis, 'fetch').resolves(new Response('{}'));

    const error = await captureError(
      fetchWithDeadline(URL, {}, 100, async () => {
        throw failure;
      }),
    );

    expect(error).to.equal(failure);
    expect(clock.countTimers()).to.equal(0);
  });

  it('does not consume a response that arrives after the deadline', async () => {
    const clock = sinon.useFakeTimers();
    sinon.stub(globalThis, 'fetch').callsFake(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response('{}')), 200);
        }),
    );
    const consume = sinon.stub<[Response], Promise<unknown>>().resolves({});
    const result = captureError(fetchWithDeadline(URL, {}, 100, consume));

    await clock.tickAsync(100);
    expect((await result).message).to.include('timed out');
    await clock.tickAsync(100);
    expect(consume.called).to.equal(false);
  });
});
