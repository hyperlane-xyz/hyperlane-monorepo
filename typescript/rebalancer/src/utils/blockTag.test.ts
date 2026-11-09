import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { BigNumber, providers } from 'ethers';
import { pino } from 'pino';
import Sinon from 'sinon';

import {
  type ChainMetadata,
  EthJsonRpcBlockParameterTag,
  MultiProtocolProvider,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';
import { TronJsonRpcProvider } from '@hyperlane-xyz/tron-sdk/runtime';

import { getConfirmedBlockTag } from './blockTag.js';

chai.use(chaiAsPromised);

function block(number: number): providers.Block {
  return {
    number,
    hash: '',
    parentHash: '',
    timestamp: 1,
    nonce: '',
    difficulty: 1,
    gasLimit: BigNumber.from(1),
    gasUsed: BigNumber.from(1),
    miner: '',
    extraData: '',
    transactions: [],
    _difficulty: BigNumber.from(1),
  };
}

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
  let provider: Sinon.SinonStubbedInstance<TronJsonRpcProvider>;

  beforeEach(() => {
    mpp = Sinon.createStubInstance(MultiProtocolProvider);
    provider = Sinon.createStubInstance(TronJsonRpcProvider);
    provider.getFinalizedBlockNumber.resolves(100);
    mpp.getChainMetadata.returns({
      ...tronMetadata,
      protocol: ProtocolType.Ethereum,
    });
    mpp.getEthersV5Provider.returns(provider);
    provider.send.resolves('0x64');
  });

  afterEach(() => {
    Sinon.restore();
  });

  for (const reorgPeriod of [
    20,
    EthJsonRpcBlockParameterTag.Finalized,
    undefined,
  ]) {
    it(`uses explicit native finalized state for Tron with reorg period ${reorgPeriod}`, async () => {
      mpp.getChainMetadata.returns({
        ...tronMetadata,
        blocks: { reorgPeriod, confirmations: 1 },
      });
      expect(await getConfirmedBlockTag(mpp, 'tron')).to.equal(
        EthJsonRpcBlockParameterTag.Finalized,
      );
      expect(provider.send.called).to.equal(false);
      expect(provider.getFinalizedBlockNumber.called).to.equal(false);
    });
  }

  it('rejects a Tron configuration without its native finalized-state provider', async () => {
    mpp.getChainMetadata.returns(tronMetadata);
    mpp.getEthersV5Provider.returns(
      Sinon.createStubInstance(providers.JsonRpcProvider),
    );
    await expect(getConfirmedBlockTag(mpp, 'tron')).to.be.rejectedWith(
      'Missing Tron provider',
    );
  });

  it('clamps a confirmed block number to zero', async () => {
    provider.send.resolves('0x0a');
    expect(await getConfirmedBlockTag(mpp, 'tron')).to.equal(0);
  });

  it('uses the default numeric EVM reorg period', async () => {
    mpp.getChainMetadata.returns({
      ...tronMetadata,
      protocol: ProtocolType.Ethereum,
      blocks: undefined,
    });
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

  for (const protocol of [ProtocolType.Ethereum, ProtocolType.Tron]) {
    it(`resolves named finality once for ${protocol}`, async () => {
      mpp.getChainMetadata.returns({
        ...tronMetadata,
        protocol,
        blocks: {
          confirmations: 1,
          reorgPeriod: EthJsonRpcBlockParameterTag.Finalized,
        },
      });
      if (protocol === ProtocolType.Tron) {
        provider.getFinalizedBlockNumber.resolves(36);
        expect(await getConfirmedBlockTag(mpp, 'tron')).to.equal(
          EthJsonRpcBlockParameterTag.Finalized,
        );
        expect(provider.getFinalizedBlockNumber.called).to.equal(false);
        expect(provider.getBlock.called).to.equal(false);
      } else {
        const ethereumProvider = Sinon.createStubInstance(
          providers.JsonRpcProvider,
        );
        mpp.getEthersV5Provider.returns(ethereumProvider);
        ethereumProvider.getBlock.resolves(block(36));
        expect(await getConfirmedBlockTag(mpp, 'tron')).to.equal(36);
        expect(
          ethereumProvider.getBlock.calledOnceWith(
            EthJsonRpcBlockParameterTag.Finalized,
          ),
        ).to.equal(true);
      }
    });
  }

  it('propagates failed numeric EVM block reads', async () => {
    const failure = new Error('block unavailable');
    const warn = Sinon.stub(logger, 'warn');
    provider.send.rejects(failure);

    await expect(getConfirmedBlockTag(mpp, 'tron', logger)).to.be.rejectedWith(
      failure,
    );
    expect(warn.calledOnce).to.equal(true);
    expect(warn.firstCall.args[1]).to.equal(
      'Failed to resolve confirmed balance snapshot',
    );
  });

  it('propagates provider lookup failures', async () => {
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
    it(`rejects an invalid EVM block response (${typeof invalidResponse}): ${String(invalidResponse).slice(0, 32)}`, async () => {
      provider.send.resolves(invalidResponse);
      await expect(getConfirmedBlockTag(mpp, 'tron')).to.be.rejectedWith(
        'Invalid',
      );
    });
  }

  it('rejects an invalid numeric block from a non-JSON-RPC provider', async () => {
    mpp.getChainMetadata.returns({
      ...tronMetadata,
      protocol: ProtocolType.Ethereum,
    });
    const fallbackProvider = Sinon.createStubInstance(providers.BaseProvider);
    fallbackProvider.getBlockNumber.resolves(Number.NaN);
    mpp.getEthersV5Provider.returns(fallbackProvider);

    await expect(getConfirmedBlockTag(mpp, 'tron')).to.be.rejectedWith(
      'Invalid block number for tron: NaN',
    );
  });

  it('propagates an Ethereum snapshot lookup failure', async () => {
    mpp.getChainMetadata.returns({
      ...tronMetadata,
      protocol: ProtocolType.Ethereum,
      name: 'ethereum',
    });
    provider.send.rejects(new Error('block unavailable'));

    await expect(getConfirmedBlockTag(mpp, 'ethereum')).to.be.rejectedWith(
      'block unavailable',
    );
  });

  it('propagates metadata lookup failures', async () => {
    const failure = new Error('metadata unavailable');
    mpp.getChainMetadata.throws(failure);

    const warn = Sinon.stub(logger, 'warn');
    await expect(getConfirmedBlockTag(mpp, 'tron', logger)).to.be.rejectedWith(
      failure,
    );
    expect(warn.calledOnce).to.equal(true);
    expect(warn.firstCall.args[1]).to.equal(
      'Failed to resolve confirmed balance snapshot',
    );
    expect(mpp.getEthersV5Provider.notCalled).to.equal(true);
  });
});
