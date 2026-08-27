import { expect } from 'chai';
import { TronWeb } from 'tronweb';

import { assert, ensure0x, strip0x } from '@hyperlane-xyz/utils';

import {
  TronNodeInfo,
  TronTestChainMetadata,
  runTronNode,
  stopTronNode,
} from '../testing/node.js';

import { TronJsonRpcProvider } from './TronJsonRpcProvider.js';

const TEST_CHAIN: TronTestChainMetadata = {
  name: 'tron-test-account',
  chainId: 3360022319,
  domainId: 3360022319,
  port: 19091,
};

// Never funded by TRE, so the node has no account record for it.
const UNACTIVATED_ADDRESS = '0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba';

describe('TronJsonRpcProvider Integration Tests', function () {
  this.timeout(120_000);

  let node: TronNodeInfo;
  let provider: TronJsonRpcProvider;
  let fundedAddress: string;

  before(async () => {
    node = await runTronNode(TEST_CHAIN);

    const host = `http://127.0.0.1:${TEST_CHAIN.port}`;
    provider = new TronJsonRpcProvider(`${host}/jsonrpc`, TEST_CHAIN.chainId);

    const tronWeb = new TronWeb({ fullHost: host });
    const base58 = tronWeb.address.fromPrivateKey(node.privateKeys[0]);
    assert(base58, 'TRE did not expose a funded account');
    // TronWeb hex is 41-prefixed; the provider is fed the 0x form production uses.
    fundedAddress = ensure0x(strip0x(tronWeb.address.toHex(base58)).slice(2));
  });

  after(async () => {
    await stopTronNode(node);
  });

  describe('isAccountActive', () => {
    it('returns true for an activated (funded) account', async () => {
      expect(await provider.isAccountActive(fundedAddress)).to.be.true;
    });

    it('returns false for an address that was never activated', async () => {
      expect(await provider.isAccountActive(UNACTIVATED_ADDRESS)).to.be.false;
    });

    it('still reports a zero nonce for the activated account', async () => {
      expect(await provider.getTransactionCount(fundedAddress)).to.equal(0);
    });
  });
});
