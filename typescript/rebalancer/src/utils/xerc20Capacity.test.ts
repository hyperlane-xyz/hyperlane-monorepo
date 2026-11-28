import { expect } from 'chai';
import sinon from 'sinon';

import {
  EvmHypAevoXERC20Adapter,
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

  for (const standard of [
    TokenStandard.EvmHypVSXERC20,
    TokenStandard.EvmHypVSXERC20Lockbox,
  ]) {
    it(`preserves the Velo per-transfer ceiling of a ${standard} destination`, async () => {
      const source = token('source');
      const destination = token('destination', standard);
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
  }

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

  describe('Aevo tokens', () => {
    // An Aevo router states its limits as any other: what it may mint is what
    // is left of its cap, and what it may burn is what it has minted.
    function aevo(value: Token, limits: { mint: bigint; burn: bigint }) {
      const adapter = sinon.createStubInstance(EvmHypAevoXERC20Adapter);
      adapter.getMintLimit.resolves(limits.mint);
      adapter.getBurnLimit.resolves(limits.burn);
      sinon.stub(value, 'getHypAdapter').returns(adapter);
      return adapter;
    }

    interface Case {
      name: string;
      // The source burns up to 500 and the destination mints up to 1000, unless
      // it is the Aevo router.
      source?: { mint: bigint; burn: bigint };
      destination?: { mint: bigint; burn: bigint };
      expected: bigint;
    }

    const cases: Case[] = [
      {
        name: 'has no capacity from a router that has minted nothing',
        source: { mint: 100n, burn: 0n },
        expected: 0n,
      },
      {
        name: 'is bounded by what the router it is sent from has minted',
        source: { mint: 100n, burn: 40n },
        expected: 40n,
      },
      {
        name: 'has no capacity to a router that is not authorized',
        destination: { mint: 0n, burn: 0n },
        expected: 0n,
      },
      {
        name: 'is bounded by what is left of the cap of the router it is sent to',
        destination: { mint: 80n, burn: 0n },
        expected: 80n,
      },
      {
        name: 'is not bounded by a router without a cap',
        destination: { mint: 2n ** 256n - 1n, burn: 0n },
        expected: 500n,
      },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const source = token(
          'source',
          c.source
            ? TokenStandard.EvmHypAevoXERC20
            : TokenStandard.EvmHypXERC20Lockbox,
        );
        const destination = token(
          'destination',
          c.destination
            ? TokenStandard.EvmHypAevoXERC20
            : TokenStandard.EvmHypXERC20Lockbox,
        );
        if (c.source) aevo(source, c.source);
        else limited(source, 500n, 1n);
        if (c.destination) aevo(destination, c.destination);
        else limited(destination, 1n, 1000n);

        expect(
          await getXerc20TransferCapacity({
            source,
            destination,
            multiProvider: provider,
            requested: 1000n,
          }),
        ).to.equal(c.expected);
      });
    }
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
