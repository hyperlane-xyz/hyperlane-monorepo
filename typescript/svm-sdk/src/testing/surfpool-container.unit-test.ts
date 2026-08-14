import { expect } from 'chai';
import { describe, it } from 'mocha';
import sinon from 'sinon';

import { stopContainerOnReadinessFailure } from './surfpool-container.js';

describe('stopContainerOnReadinessFailure', () => {
  it('stops the started container and rethrows when readiness fails', async () => {
    const stop = sinon.stub().resolves();
    const readinessError = new Error('rpc never became ready');
    const waitForReady = (): Promise<void> => Promise.reject(readinessError);

    let rejected: unknown;
    try {
      await stopContainerOnReadinessFailure(
        { stop },
        'http://127.0.0.1:8899',
        waitForReady,
      );
    } catch (error: unknown) {
      rejected = error;
    }

    expect(stop.calledOnce).to.equal(true);
    expect(rejected).to.equal(readinessError);
  });

  it('does not stop the container when readiness succeeds', async () => {
    const stop = sinon.stub().resolves();
    const waitForReady = (): Promise<void> => Promise.resolve();

    await stopContainerOnReadinessFailure(
      { stop },
      'http://127.0.0.1:8899',
      waitForReady,
    );

    expect(stop.called).to.equal(false);
  });
});
