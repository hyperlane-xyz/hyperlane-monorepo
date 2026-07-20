import { expect } from 'chai';

import {
  DeletableGateway,
  deleteViolationSeriesOrThrow,
} from '../scripts/check/clear-utils.js';

// A stub gateway that either resolves with a canned response or rejects,
// standing in for prom-client's Pushgateway so every branch of
// deleteViolationSeriesOrThrow can be exercised without a live gateway.
function stubGateway(result: { resp?: unknown } | Error): DeletableGateway {
  return {
    delete: async () => {
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
}

const JOB = 'check-warp-deploy-mainnet3';
const GROUPINGS = { alert_key: 'abc' };

async function captureError(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

describe('deleteViolationSeriesOrThrow', () => {
  it('throws when the gateway is not configured (missing PROMETHEUS_PUSH_GATEWAY)', async () => {
    const err = await captureError(
      deleteViolationSeriesOrThrow(JOB, GROUPINGS, null),
    );
    expect(err).to.be.instanceOf(Error);
    if (err instanceof Error) {
      expect(err.message).to.match(/PushGateway not configured/);
    }
  });

  it('propagates a network rejection from the gateway', async () => {
    const err = await captureError(
      deleteViolationSeriesOrThrow(
        JOB,
        GROUPINGS,
        stubGateway(new Error('ECONNREFUSED')),
      ),
    );
    expect(err).to.be.instanceOf(Error);
    if (err instanceof Error) {
      expect(err.message).to.match(/ECONNREFUSED/);
    }
  });

  it('throws on a non-2xx status', async () => {
    const err = await captureError(
      deleteViolationSeriesOrThrow(
        JOB,
        GROUPINGS,
        stubGateway({ resp: { statusCode: 500 } }),
      ),
    );
    expect(err).to.be.instanceOf(Error);
    if (err instanceof Error) {
      expect(err.message).to.match(/did not succeed \(status=500\)/);
    }
  });

  it('throws when the response carries no status code', async () => {
    const err = await captureError(
      deleteViolationSeriesOrThrow(JOB, GROUPINGS, stubGateway({})),
    );
    expect(err).to.be.instanceOf(Error);
    if (err instanceof Error) {
      expect(err.message).to.match(/did not succeed \(status=undefined\)/);
    }
  });

  it('resolves on a 2xx status', async () => {
    const err = await captureError(
      deleteViolationSeriesOrThrow(
        JOB,
        GROUPINGS,
        stubGateway({ resp: { statusCode: 202 } }),
      ),
    );
    expect(err).to.equal(undefined);
  });

  it('accepts the 2xx boundaries and rejects just outside them', async () => {
    for (const status of [200, 299]) {
      const err = await captureError(
        deleteViolationSeriesOrThrow(
          JOB,
          GROUPINGS,
          stubGateway({ resp: { statusCode: status } }),
        ),
      );
      expect(err, `status ${status} should succeed`).to.equal(undefined);
    }
    for (const status of [199, 300]) {
      const err = await captureError(
        deleteViolationSeriesOrThrow(
          JOB,
          GROUPINGS,
          stubGateway({ resp: { statusCode: status } }),
        ),
      );
      expect(err, `status ${status} should fail`).to.be.instanceOf(Error);
    }
  });
});
