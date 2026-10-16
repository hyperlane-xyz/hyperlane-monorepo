import { expect } from 'chai';
import { ethers } from 'ethers';
import { pino } from 'pino';

import {
  TokenStandard,
  TokenType,
  type WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import type { BridgeQuoteParams } from '../interfaces/IExternalBridge.js';
import {
  LayerZeroBridge,
  type TokenBridgeOftContract,
} from './LayerZeroBridge.js';

const ETH_ADAPTER = '0x1111111111111111111111111111111111111111';
const ARB_ADAPTER = '0x2222222222222222222222222222222222222222';
const LEGACY_ETH_ADAPTER = '0x3333333333333333333333333333333333333333';
const LEGACY_ARB_ADAPTER = '0x4444444444444444444444444444444444444444';
const TRON_ADAPTER = '0x5555555555555555555555555555555555555555';
const ETH_USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const ARB_USDT = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const TRON_USDT = '0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C';
const SIGNER = '0x6666666666666666666666666666666666666666';

function token(
  chainName: string,
  adapter: string,
  collateral: string,
  connections: string[],
  standard = TokenStandard.EvmHypCollateral,
): WarpCoreConfig['tokens'][number] {
  return {
    chainName,
    addressOrDenom: adapter,
    collateralAddressOrDenom: collateral,
    connections: connections.map((connection) => ({ token: connection })),
    decimals: 6,
    name: 'Tether USD',
    standard,
    symbol: 'USDT',
    tokenType: TokenType.collateralOft,
  };
}

const CURRENT_ROUTE: WarpCoreConfig = {
  tokens: [
    token('ethereum', ETH_ADAPTER, ETH_USDT, [
      `ethereum|arbitrum|${ARB_ADAPTER}`,
    ]),
    token('arbitrum', ARB_ADAPTER, ARB_USDT, [
      `ethereum|ethereum|${ETH_ADAPTER}`,
    ]),
  ],
};
const LEGACY_ROUTE: WarpCoreConfig = {
  tokens: [
    token('ethereum', LEGACY_ETH_ADAPTER, ETH_USDT, [
      `ethereum|arbitrum|${LEGACY_ARB_ADAPTER}`,
      `tron|tron|${TRON_ADAPTER}`,
    ]),
    token('arbitrum', LEGACY_ARB_ADAPTER, ARB_USDT, [
      `ethereum|ethereum|${LEGACY_ETH_ADAPTER}`,
      `tron|tron|${TRON_ADAPTER}`,
    ]),
    token(
      'tron',
      TRON_ADAPTER,
      TRON_USDT,
      [
        `ethereum|ethereum|${LEGACY_ETH_ADAPTER}`,
        `ethereum|arbitrum|${LEGACY_ARB_ADAPTER}`,
      ],
      TokenStandard.TronHypCollateral,
    ),
  ],
};

const TOKENS: Record<string, string> = {
  [ETH_ADAPTER.toLowerCase()]: ETH_USDT,
  [ARB_ADAPTER.toLowerCase()]: ARB_USDT,
  [LEGACY_ETH_ADAPTER.toLowerCase()]: ETH_USDT,
  [LEGACY_ARB_ADAPTER.toLowerCase()]: ARB_USDT,
  [TRON_ADAPTER.toLowerCase()]: TRON_USDT,
};

function makeContract(address: string): TokenBridgeOftContract {
  const sourceToken = TOKENS[address.toLowerCase()];
  assert(sourceToken, `Unknown test adapter ${address}`);
  return {
    token: async () => sourceToken,
    quoteTransferRemote: async (_destination, _recipient, amount) => [
      {
        token: ethers.constants.AddressZero,
        amount: ethers.BigNumber.from(100),
      },
      {
        token: sourceToken,
        amount: ethers.BigNumber.from(amount + 5_000n),
      },
    ],
    hyperlaneDomainToLzEid: async (domain) => domain + 30_000,
    populateTransaction: {
      transferRemote: async (destination, recipient, amount, overrides) => ({
        to: address,
        data: ethers.utils.defaultAbiCoder.encode(
          ['uint32', 'bytes32', 'uint256'],
          [destination, recipient, amount],
        ),
        value: ethers.BigNumber.from(overrides.value.toString()),
      }),
    },
  };
}

function makeBridge(maxFeeBps = 50): LayerZeroBridge {
  return new LayerZeroBridge(
    {
      chainMetadata: {
        ethereum: {
          chainId: 1,
          domainId: 1,
          name: 'ethereum',
          protocol: ProtocolType.Ethereum,
          rpcUrls: [{ http: 'https://ethereum.example.com' }],
        },
        arbitrum: {
          chainId: 42161,
          domainId: 42161,
          name: 'arbitrum',
          protocol: ProtocolType.Ethereum,
          rpcUrls: [{ http: 'https://arbitrum.example.com' }],
        },
        tron: {
          chainId: 728126428,
          domainId: 728126428,
          name: 'tron',
          protocol: ProtocolType.Tron,
          rpcUrls: [{ http: 'https://tron.example.com' }],
        },
      },
      warpRoutes: [
        { id: 'USDT/oft', config: CURRENT_ROUTE },
        { id: 'USDT/oft-legacy', config: LEGACY_ROUTE },
      ],
      maxFeeBps,
      contractFactory: (address) => makeContract(address),
    },
    pino({ level: 'silent' }),
  );
}

function params(overrides: Partial<BridgeQuoteParams> = {}): BridgeQuoteParams {
  return {
    fromChain: 1,
    toChain: 42161,
    fromToken: ETH_USDT,
    toToken: ARB_USDT,
    toAmount: 995_000n,
    fromAddress: SIGNER,
    toAddress: SIGNER,
    ...overrides,
  };
}

async function getRejection(promise: Promise<unknown>): Promise<Error> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof Error, 'Expected promise to reject');
  return caught;
}

describe('LayerZeroBridge', () => {
  it('prefers USDT/oft for Ethereum and Arbitrum', async () => {
    const quote = await makeBridge().quote(params());
    expect(quote.fromAmount).to.equal(1_000_000n);
    expect(quote.toAmount).to.equal(995_000n);
    expect(quote.feeCosts).to.equal(5_000n);
    expect(quote.route.warpRouteId).to.equal('USDT/oft');
    expect(quote.route.sourceAdapter).to.equal(ETH_ADAPTER);
  });

  it('uses USDT/oft-legacy for Tron paths', async () => {
    const quote = await makeBridge().quote(
      params({
        toChain: 728126428,
        toToken: TRON_USDT,
      }),
    );
    expect(quote.route.warpRouteId).to.equal('USDT/oft-legacy');
    expect(quote.route.destinationAdapter).to.equal(TRON_ADAPTER);
  });

  it('derives an exact-input quote without exceeding source inventory', async () => {
    const quote = await makeBridge().quote(
      params({ fromAmount: 1_000_000n, toAmount: undefined }),
    );
    expect(quote.fromAmount).to.equal(1_000_000n);
    expect(quote.toAmount).to.equal(995_000n);
  });

  it('accepts 50 bps and rejects 51 bps', async () => {
    await makeBridge().quote(params());
    const error = await getRejection(
      makeBridge().quote(params({ toAmount: 994_900n })),
    );
    expect(error.message).to.include('51 bps');
  });

  it('rejects a signer mismatch before preparing or approving', async () => {
    const bridge = makeBridge();
    const quote = await bridge.quote(params());
    const error = await getRejection(
      bridge.execute(quote, {
        [ProtocolType.Ethereum]: ethers.Wallet.createRandom().privateKey,
      }),
    );
    expect(error.message).to.include('does not match inventory signer');
  });
});
