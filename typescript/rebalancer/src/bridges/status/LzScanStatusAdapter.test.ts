import { expect } from 'chai';
import { providers } from 'ethers';
import { pino } from 'pino';
import Sinon from 'sinon';

import { MultiProtocolCore, MultiProtocolProvider } from '@hyperlane-xyz/sdk';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { OftSettlementVerifier } from '../OftSettlementVerifier.js';
import { LzScanStatusAdapter } from './LzScanStatusAdapter.js';

describe('LzScanStatusAdapter', () => {
  afterEach(() => Sinon.restore());

  it('passes the sampled numeric boundary and destination provider to the shared verifier', async () => {
    const provider = Sinon.createStubInstance(providers.JsonRpcProvider);
    const multiProvider = Sinon.createStubInstance(MultiProtocolProvider);
    multiProvider.getChainName.returns('tron');
    multiProvider.getEthersV5Provider.returns(provider);
    const core = Sinon.createStubInstance(MultiProtocolCore);
    Object.defineProperty(core, 'multiProvider', { value: multiProvider });
    core.metadata.returns({
      name: 'tron',
      protocol: ProtocolType.Tron,
      chainId: 728126428,
      domainId: 728126428,
      rpcUrls: [{ http: 'https://rpc.invalid' }],
      blocks: { confirmations: 1, reorgPeriod: 64 },
    });
    const ref = { provider: 'lz_scan', kind: 'lz_scan', data: {} };
    const poll = Sinon.stub(
      OftSettlementVerifier.prototype,
      'pollStatus',
    ).resolves({ status: 'pending' });
    const adapter = new LzScanStatusAdapter({
      logger: pino({ level: 'silent' }),
    });
    await adapter.pollStatus(ref, {
      core,
      destination: 728126428,
      blockTag: 36,
    });
    expect(
      poll.calledOnceWith(ref, {
        provider,
        blocks: { confirmations: 1, reorgPeriod: 64 },
        blockTag: 36,
      }),
    ).to.equal(true);
  });
});
