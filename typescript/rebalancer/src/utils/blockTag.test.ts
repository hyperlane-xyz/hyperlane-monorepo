import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { providers } from 'ethers';
import { pino } from 'pino';
import Sinon from 'sinon';

import {
  type ChainMetadata,
  EthJsonRpcBlockParameterTag,
  MultiProtocolProvider,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { getConfirmedBlockTag } from './blockTag.js';

chai.use(chaiAsPromised);

const tronMetadata: ChainMetadata = {
  protocol: ProtocolType.Tron,
  name: 'tron',
  chainId: 728126428,
  domainId: 728126428,
  rpcUrls: [{ http: 'http://unused' }],
  blocks: { reorgPeriod: 20, confirmations: 1 },
};

const logger = pino({ level: 'silent' });

describe('getConfirmedBlockTag', () => {
  let mpp: Sinon.SinonStubbedInstance<MultiProtocolProvider>;
  let provider: Sinon.SinonStubbedInstance<providers.JsonRpcProvider>;

  beforeEach(() => {
    mpp = Sinon.createStubInstance(MultiProtocolProvider);
    provider = Sinon.createStubInstance(providers.JsonRpcProvider);
    mpp.getChainMetadata.returns(tronMetadata);
    mpp.getEthersV5Provider.returns(provider);
    provider.send.resolves('0x64');
  });

  afterEach(() => {
    Sinon.restore();
  });

  it('returns a confirmed block number for a numeric Tron reorg period', async () => {
    expect(await getConfirmedBlockTag(mpp, 'tron')).to.equal(80);
  });

  it('clamps a confirmed block number to zero', async () => {
    provider.send.resolves('0x0a');
    expect(await getConfirmedBlockTag(mpp, 'tron')).to.equal(0);
  });

  it('uses the default numeric reorg period for Tron', async () => {
    mpp.getChainMetadata.returns({ ...tronMetadata, blocks: undefined });
    expect(await getConfirmedBlockTag(mpp, 'tron')).to.equal(68);
  });

  it('returns undefined for a non-EVM-like chain without querying blocks', async () => {
    mpp.getChainMetadata.returns({
      ...tronMetadata,
      protocol: ProtocolType.Sealevel,
      name: 'solana',
    });

    expect(await getConfirmedBlockTag(mpp, 'solana')).to.equal(undefined);
    expect(mpp.getEthersV5Provider.notCalled).to.equal(true);
  });

  it('preserves the optional Tron tag for unsupported named reorg periods', async () => {
    const warn = Sinon.stub(logger, 'warn');
    mpp.getChainMetadata.returns({
      ...tronMetadata,
      blocks: {
        reorgPeriod: EthJsonRpcBlockParameterTag.Finalized,
        confirmations: 1,
      },
    });

    expect(await getConfirmedBlockTag(mpp, 'tron', logger)).to.equal(undefined);
    expect(mpp.getEthersV5Provider.notCalled).to.equal(true);
    expect(warn.calledOnce).to.equal(true);
    expect(warn.firstCall.args[1]).to.include(
      'Tron does not support named block tags',
    );
  });

  it('propagates failed numeric Tron block reads', async () => {
    const failure = new Error('block unavailable');
    const warn = Sinon.stub(logger, 'warn');
    provider.send.rejects(failure);

    await expect(getConfirmedBlockTag(mpp, 'tron', logger)).to.be.rejectedWith(
      failure,
    );
    expect(warn.calledOnce).to.equal(true);
    expect(warn.firstCall.args[1]).to.equal('Failed to get confirmed block');
  });

  it('propagates provider lookup failures in numeric Tron mode', async () => {
    const failure = new Error('provider unavailable');
    mpp.getEthersV5Provider.throws(failure);

    await expect(getConfirmedBlockTag(mpp, 'tron')).to.be.rejectedWith(failure);
  });

  for (const invalidResponse of [
    undefined,
    null,
    100,
    '100',
    '0x',
    '0xgg',
    '0x10000000000000000',
    `0x${'f'.repeat(300)}`,
  ]) {
    it(`rejects an invalid Tron block response (${typeof invalidResponse}): ${String(invalidResponse).slice(0, 32)}`, async () => {
      provider.send.resolves(invalidResponse);
      await expect(getConfirmedBlockTag(mpp, 'tron')).to.be.rejectedWith(
        'Invalid',
      );
    });
  }

  it('rejects an invalid numeric block from a non-JSON-RPC provider', async () => {
    const fallbackProvider = Sinon.createStubInstance(providers.BaseProvider);
    fallbackProvider.getBlockNumber.resolves(Number.NaN);
    mpp.getEthersV5Provider.returns(fallbackProvider);

    await expect(getConfirmedBlockTag(mpp, 'tron')).to.be.rejectedWith(
      'Invalid block number for tron: NaN',
    );
  });

  it('preserves undefined on an Ethereum lookup failure', async () => {
    mpp.getChainMetadata.returns({
      ...tronMetadata,
      protocol: ProtocolType.Ethereum,
      name: 'ethereum',
    });
    provider.send.rejects(new Error('block unavailable'));

    expect(await getConfirmedBlockTag(mpp, 'ethereum')).to.equal(undefined);
  });

  it('preserves Ethereum named block tags', async () => {
    mpp.getChainMetadata.returns({
      ...tronMetadata,
      protocol: ProtocolType.Ethereum,
      name: 'ethereum',
      blocks: {
        reorgPeriod: EthJsonRpcBlockParameterTag.Finalized,
        confirmations: 1,
      },
    });

    expect(await getConfirmedBlockTag(mpp, 'ethereum')).to.equal(
      EthJsonRpcBlockParameterTag.Finalized,
    );
    expect(mpp.getEthersV5Provider.notCalled).to.equal(true);
  });

  it('preserves undefined on metadata lookup failures', async () => {
    const failure = new Error('metadata unavailable');
    mpp.getChainMetadata.throws(failure);

    const warn = Sinon.stub(logger, 'warn');
    expect(await getConfirmedBlockTag(mpp, 'tron', logger)).to.equal(undefined);
    expect(warn.calledOnce).to.equal(true);
    expect(warn.firstCall.args[1]).to.equal('Failed to get confirmed block');
    expect(mpp.getEthersV5Provider.notCalled).to.equal(true);
  });
});
