import { expect } from 'chai';
import sinon from 'sinon';

import {
  EvmHypXERC20LockboxAdapter,
  MultiProtocolProvider,
  Token,
  TokenStandard,
} from '@hyperlane-xyz/sdk';

import { getXerc20TransferCapacity } from './xerc20Capacity.js';

describe('xERC20 execution capacity', () => {
  const provider = new MultiProtocolProvider({});
  const token = (
    chainName: string,
    standard = TokenStandard.EvmHypXERC20Lockbox,
  ) =>
    new Token({
      chainName,
      standard,
      addressOrDenom: '0x1111111111111111111111111111111111111111',
      name: 'Token',
      symbol: 'TOKEN',
      decimals: 6,
    });
  afterEach(() => sinon.restore());

  function limited(
    value: Token,
    burn: bigint,
    mint: bigint,
    mintMax = mint * 2n,
  ) {
    const adapter = sinon.createStubInstance(EvmHypXERC20LockboxAdapter);
    adapter.getBurnLimit.resolves(burn);
    adapter.getMintLimit.resolves(mint);
    adapter.getMintMaxLimit.resolves(mintMax);
    sinon.stub(value, 'getHypAdapter').returns(adapter);
    return adapter;
  }

  it('uses sender burn and receiver mint capacity, including reservations and token fees', async () => {
    const source = token('source');
    const destination = token('destination');
    limited(source, 100n, 1n);
    limited(destination, 1n, 80n);
    expect(
      await getXerc20TransferCapacity({
        source,
        destination,
        multiProvider: provider,
        requested: 1000n,
        burnFees: 10n,
        reservedBurn: 20n,
        reservedMint: 15n,
      }),
    ).to.equal(65n);
    expect(
      await getXerc20TransferCapacity({
        source: destination,
        destination: source,
        multiProvider: provider,
        requested: 1000n,
      }),
    ).to.equal(1n);
  });

  it('returns zero when existing work exhausts capacity', async () => {
    const source = token('source');
    const destination = token('destination');
    limited(source, 20n, 100n);
    limited(destination, 100n, 100n);
    expect(
      await getXerc20TransferCapacity({
        source,
        destination,
        multiProvider: provider,
        requested: 1000n,
        reservedBurn: 21n,
      }),
    ).to.equal(0n);
  });

  it('requires source mint capacity for locally paid token fees', async () => {
    const source = token('source');
    const destination = token('destination');
    limited(source, 1000n, 0n);
    limited(destination, 1000n, 1000n);
    expect(
      await getXerc20TransferCapacity({
        source,
        destination,
        multiProvider: provider,
        requested: 100n,
        burnFees: 1n,
        sourceMintFees: 1n,
      }),
    ).to.equal(0n);
  });

  it('preserves the Velo per-transfer ceiling', async () => {
    const source = token('source');
    const destination = token(
      'destination',
      TokenStandard.EvmHypVSXERC20Lockbox,
    );
    limited(source, 1000n, 1000n);
    limited(destination, 1000n, 1000n, 100n);
    expect(
      await getXerc20TransferCapacity({
        source,
        destination,
        multiProvider: provider,
        requested: 1000n,
      }),
    ).to.equal(50n);
    expect(
      await getXerc20TransferCapacity({
        source,
        destination,
        multiProvider: provider,
        requested: 1000n,
        reservedMint: 100n,
      }),
    ).to.equal(50n);
  });

  it('does not infer protocol scaling from display decimals', async () => {
    const source = new Token({
      chainName: 'source',
      standard: TokenStandard.EvmHypXERC20Lockbox,
      addressOrDenom: '0x1111111111111111111111111111111111111111',
      name: 'Token',
      symbol: 'TOKEN',
      decimals: 18,
    });
    const destination = token('destination');
    limited(source, 10n ** 18n, 10n ** 18n);
    limited(destination, 1_000_000n, 1_000_000n);
    expect(
      await getXerc20TransferCapacity({
        source,
        destination,
        multiProvider: provider,
        requested: 10n ** 18n,
      }),
    ).to.equal(1_000_000n);
  });

  it('rounds destination capacity down in source units', async () => {
    const source = token('source');
    const destination = token('destination');
    source.scale = { numerator: 2, denominator: 1 };
    limited(source, 100n, 100n);
    limited(destination, 100n, 3n);
    expect(
      await getXerc20TransferCapacity({
        source,
        destination,
        multiProvider: provider,
        requested: 100n,
      }),
    ).to.equal(1n);
  });

  it('does not query limits or balances for ordinary collateral', async () => {
    const source = token('source', TokenStandard.EvmHypCollateral);
    const destination = token('destination', TokenStandard.EvmHypCollateral);
    const sourceAdapter = sinon
      .stub(source, 'getHypAdapter')
      .throws('Unexpected adapter read');
    const destinationAdapter = sinon
      .stub(destination, 'getHypAdapter')
      .throws('Unexpected adapter read');
    expect(
      await getXerc20TransferCapacity({
        source,
        destination,
        multiProvider: provider,
        requested: 1000n,
      }),
    ).to.equal(1000n);
    expect(sourceAdapter.called || destinationAdapter.called).to.equal(false);
  });
});
