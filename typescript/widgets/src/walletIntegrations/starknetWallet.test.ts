import assert from 'node:assert/strict';

import { connectStarknetWallet } from './starknetWallet.js';

describe('connectStarknetWallet', () => {
  it('connects the selected connector exactly once', async () => {
    const connector = { id: 'argentX' };
    const connectCalls: unknown[] = [];
    const modalCalls: unknown[] = [];

    await connectStarknetWallet(
      [connector],
      async (args) => {
        connectCalls.push(args);
      },
      async (options) => {
        modalCalls.push(options);
        return { connector };
      },
    );

    assert.deepEqual(modalCalls, [
      { connectors: [connector], resultType: 'connector' },
    ]);
    assert.deepEqual(connectCalls, [{ connector }]);
  });
});
