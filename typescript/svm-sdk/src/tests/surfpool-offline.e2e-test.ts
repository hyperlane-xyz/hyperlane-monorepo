import { expect } from 'chai';
import { after, describe, it } from 'mocha';

import { assert, pollAsync } from '@hyperlane-xyz/utils';

import {
  SurfpoolDatasourceMode,
  type SurfpoolNode,
} from '../fork/surfpool-node.js';
import { createRpc } from '../rpc.js';
import { runSurfpoolContainer } from '../testing/surfpool-container.js';

const OFFLINE_RPC_PORT = 8899;

describe('surfpool offline node e2e', function () {
  this.timeout(300_000);

  let node: SurfpoolNode | undefined;

  after(() => {
    node?.kill();
  });

  it('boots an offline surfpool node and serves a healthy Solana RPC', async () => {
    node = await runSurfpoolContainer({
      datasource: { mode: SurfpoolDatasourceMode.Offline },
      rpcPort: OFFLINE_RPC_PORT,
    });

    const rpc = createRpc(node.rpcUrl);

    const health = await rpc.getHealth().send();
    expect(health).to.equal('ok');

    const initialSlot = await rpc.getSlot().send();
    await pollAsync(
      async () => {
        const slot = await rpc.getSlot().send();
        assert(
          slot > initialSlot,
          `slot ${slot} has not advanced past ${initialSlot}`,
        );
      },
      500,
      60,
    );
  });
});
