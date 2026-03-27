import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';

import { StarknetWarpArtifactManager } from '../warp/warp-artifact-manager.js';

import { StarknetProtocolProvider } from './protocol.js';

const METADATA = {
  name: 'starknetsepolia',
  protocol: ProtocolType.Starknet,
  chainId: 'SN_SEPOLIA',
  domainId: 1234,
  rpcUrls: [{ http: 'http://localhost:9545' }],
};

describe('StarknetProtocolProvider', () => {
  it('returns a Starknet warp artifact manager', () => {
    const provider = new StarknetProtocolProvider();

    const manager = provider.createWarpArtifactManager(METADATA);

    expect(manager).to.be.instanceOf(StarknetWarpArtifactManager);
    expect(manager.supportsHookUpdates()).to.equal(true);
  });

  it('does not implement a protocol-level submitter', async () => {
    const provider = new StarknetProtocolProvider();

    let error: unknown;
    try {
      await provider.createSubmitter(METADATA, {
        type: 'jsonRpc',
        chain: 'starknetsepolia',
        privateKey: '0xkey',
        accountAddress: '0x123',
      });
    } catch (caughtError) {
      error = caughtError;
    }

    expect(String(error)).to.match(/Not implemented/);
  });
});
