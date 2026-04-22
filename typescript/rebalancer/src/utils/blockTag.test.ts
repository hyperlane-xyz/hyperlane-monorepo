import { expect } from 'chai';
import { providers } from 'ethers';
import Sinon from 'sinon';

import { MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { getConfirmedBlockTag } from './blockTag.js';

describe('getConfirmedBlockTag', () => {
  let mpp: Sinon.SinonStubbedInstance<MultiProtocolProvider>;

  beforeEach(() => {
    mpp = Sinon.createStubInstance(MultiProtocolProvider);
  });

  afterEach(() => {
    Sinon.restore();
  });

  it('returns a confirmed block number for Tron chain (EVM-like)', async () => {
    mpp.getChainMetadata.returns({
      protocol: ProtocolType.Tron,
      name: 'tron',
      chainId: 728126428,
      blocks: { reorgPeriod: 20 },
    } as any);

    const mockProvider = {
      send: Sinon.stub().resolves('0x64'), // 100 in hex
      getBlockNumber: Sinon.stub().resolves(100),
    };
    // Make instanceof check pass
    Object.setPrototypeOf(mockProvider, providers.JsonRpcProvider.prototype);
    mpp.getEthersV5Provider.returns(mockProvider as any);

    const result = await getConfirmedBlockTag(mpp, 'tron');
    // 100 - 20 = 80
    expect(result).to.equal(80);
  });

  it('returns undefined for Sealevel chain (non-EVM-like)', async () => {
    mpp.getChainMetadata.returns({
      protocol: ProtocolType.Sealevel,
      name: 'solana',
      chainId: 1399811149,
    } as any);

    const result = await getConfirmedBlockTag(mpp, 'solana');
    expect(result).to.be.undefined;
  });

  it('returns undefined for Tron chain with string reorgPeriod (named block tags not supported)', async () => {
    const logger = { warn: Sinon.stub() };
    mpp.getChainMetadata.returns({
      protocol: ProtocolType.Tron,
      name: 'tron',
      chainId: 728126428,
      blocks: { reorgPeriod: 'finalized' },
    } as any);

    const result = await getConfirmedBlockTag(mpp, 'tron', logger as any);
    expect(result).to.be.undefined;
    expect(logger.warn.calledOnce).to.be.true;
    const warnCall = logger.warn.getCall(0);
    expect(warnCall.args[1]).to.include(
      'Tron does not support named block tags',
    );
  });
});
