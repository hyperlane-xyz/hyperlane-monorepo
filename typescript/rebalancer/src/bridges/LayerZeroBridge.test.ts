import { expect } from 'chai';
import { ethers } from 'ethers';
import { pino } from 'pino';
import Sinon from 'sinon';

import {
  TokenStandard,
  TokenType,
  type WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  TransactionSubmissionError,
  assert,
  bytesToAddressTron,
} from '@hyperlane-xyz/utils';

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
    oft: async () => address,
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
        celestia: {
          chainId: 'celestia',
          domainId: 69420,
          name: 'celestia',
          protocol: ProtocolType.Cosmos,
          rpcUrls: [{ http: 'https://celestia.example.com' }],
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
  afterEach(() => Sinon.restore());
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
    assert(
      error instanceof TransactionSubmissionError,
      'Expected classified preparation error',
    );
    expect(error.submissionState).to.equal('not_submitted');
  });
});

const ORIGIN_HASH = `0x${'aa'.repeat(32)}`;
const DESTINATION_HASH = `0x${'bb'.repeat(32)}`;
const GUID = `0x${'cc'.repeat(32)}`;
const SENT = new ethers.utils.Interface([
  'event OFTSent(bytes32 indexed guid,uint32 dstEid,address indexed fromAddress,uint256 amountSentLD,uint256 amountReceivedLD)',
]);
const RECEIVED = new ethers.utils.Interface([
  'event OFTReceived(bytes32 indexed guid,uint32 srcEid,address indexed toAddress,uint256 amountReceivedLD)',
]);

function receiptWithEvent(
  eventInterface: ethers.utils.Interface,
  eventName: string,
  args: unknown[],
  address: string,
  transactionHash: string,
): ethers.providers.TransactionReceipt {
  const log = eventInterface.encodeEventLog(
    eventInterface.getEvent(eventName),
    args,
  );
  return {
    transactionHash,
    to: address,
    from: SIGNER,
    contractAddress: '',
    transactionIndex: 0,
    gasUsed: ethers.BigNumber.from(1),
    logsBloom: '',
    blockHash: ORIGIN_HASH,
    blockNumber: 100,
    confirmations: 100,
    cumulativeGasUsed: ethers.BigNumber.from(1),
    effectiveGasPrice: ethers.BigNumber.from(1),
    byzantium: true,
    type: 2,
    status: 1,
    logs: [
      {
        ...log,
        address,
        blockNumber: 100,
        blockHash: ORIGIN_HASH,
        transactionHash,
        transactionIndex: 0,
        logIndex: 0,
        removed: false,
      },
    ],
  };
}

async function captureTransferIdentity(
  bridge: LayerZeroBridge,
  request: BridgeQuoteParams,
  privateKey: string,
): Promise<string> {
  let identity: string | undefined;
  const quote = await bridge.quote(request);
  const error = await getRejection(
    bridge.execute(
      quote,
      {
        [request.fromChain === 728126428
          ? ProtocolType.Tron
          : ProtocolType.Ethereum]: privateKey,
      },
      {
        onTransferId: (value) => {
          identity = value;
          throw new Error('Stopped before approval');
        },
      },
    ),
  );
  expect(error.message).to.equal('Stopped before approval');
  assert(
    error instanceof TransactionSubmissionError,
    'Preparation must classify the failure',
  );
  expect(error.submissionState).to.equal('not_submitted');
  assert(identity, 'Expected transfer identity before submission');
  return identity;
}

function scanMessage() {
  return {
    guid: GUID,
    pathway: {
      srcEid: 30001,
      dstEid: 72161,
      sender: { address: ETH_ADAPTER },
      receiver: { address: ARB_ADAPTER },
    },
    source: { tx: { txHash: ORIGIN_HASH } },
    status: 'DELIVERED',
    destination: { status: 'SUCCEEDED', tx: { txHash: DESTINATION_HASH } },
  };
}

describe('LayerZeroBridge settlement', () => {
  afterEach(() => Sinon.restore());

  it('records exact identity before submission and returns the on-chain received amount', async () => {
    const wallet = ethers.Wallet.createRandom();
    const bridge = makeBridge();
    const identity = await captureTransferIdentity(
      bridge,
      params({ fromAddress: wallet.address }),
      wallet.privateKey,
    );
    const source = receiptWithEvent(
      SENT,
      'OFTSent',
      [GUID, 72161, ETH_ADAPTER, 1_000_000, 996_000],
      ETH_ADAPTER,
      ORIGIN_HASH,
    );
    const destination = receiptWithEvent(
      RECEIVED,
      'OFTReceived',
      [GUID, 30001, SIGNER, 996_000],
      ARB_ADAPTER,
      DESTINATION_HASH,
    );
    Sinon.stub(
      ethers.providers.StaticJsonRpcProvider.prototype,
      'getTransactionReceipt',
    ).callsFake(async (hash) =>
      (await hash) === ORIGIN_HASH ? source : destination,
    );
    Sinon.stub(
      ethers.providers.StaticJsonRpcProvider.prototype,
      'getBlockNumber',
    ).resolves(1000);
    const fetch = Sinon.stub(globalThis, 'fetch').resolves(
      new Response(JSON.stringify({ data: [scanMessage()] })),
    );
    expect(
      await bridge.getStatus(ORIGIN_HASH, 1, 42161, identity),
    ).to.deep.equal({
      status: 'complete',
      receivingTxHash: DESTINATION_HASH,
      receivedAmount: 996_000n,
    });
    expect(String(fetch.firstCall.args[0])).to.include(`/guid/${GUID}`);
  });

  it('does not complete an API-delivered movement to the wrong recipient', async () => {
    const wallet = ethers.Wallet.createRandom();
    const bridge = makeBridge();
    const identity = await captureTransferIdentity(
      bridge,
      params({ fromAddress: wallet.address }),
      wallet.privateKey,
    );
    const source = receiptWithEvent(
      SENT,
      'OFTSent',
      [GUID, 72161, ETH_ADAPTER, 1_000_000, 995_000],
      ETH_ADAPTER,
      ORIGIN_HASH,
    );
    const wrongDestination = receiptWithEvent(
      RECEIVED,
      'OFTReceived',
      [GUID, 30001, ARB_ADAPTER, 995_000],
      ARB_ADAPTER,
      DESTINATION_HASH,
    );
    Sinon.stub(
      ethers.providers.StaticJsonRpcProvider.prototype,
      'getTransactionReceipt',
    ).callsFake(async (hash) =>
      (await hash) === ORIGIN_HASH ? source : wrongDestination,
    );
    Sinon.stub(
      ethers.providers.StaticJsonRpcProvider.prototype,
      'getBlockNumber',
    ).resolves(1000);
    Sinon.stub(globalThis, 'fetch').resolves(
      new Response(JSON.stringify({ data: [scanMessage()] })),
    );
    expect(
      (await bridge.getStatus(ORIGIN_HASH, 1, 42161, identity)).status,
    ).to.equal('pending');
  });

  it('holds terminal API failures and missing transfer identity pending', async () => {
    const wallet = ethers.Wallet.createRandom();
    const bridge = makeBridge();
    const identity = await captureTransferIdentity(
      bridge,
      params({ fromAddress: wallet.address }),
      wallet.privateKey,
    );
    const source = receiptWithEvent(
      SENT,
      'OFTSent',
      [GUID, 72161, ETH_ADAPTER, 1_000_000, 995_000],
      ETH_ADAPTER,
      ORIGIN_HASH,
    );
    Sinon.stub(
      ethers.providers.StaticJsonRpcProvider.prototype,
      'getTransactionReceipt',
    ).resolves(source);
    Sinon.stub(
      ethers.providers.StaticJsonRpcProvider.prototype,
      'getBlockNumber',
    ).resolves(1000);
    Sinon.stub(globalThis, 'fetch').resolves(
      new Response(
        JSON.stringify({
          data: [{ ...scanMessage(), status: 'APPLICATION_BURNED' }],
        }),
      ),
    );
    expect(
      (await bridge.getStatus(ORIGIN_HASH, 1, 42161, identity)).status,
    ).to.equal('pending');
    expect((await bridge.getStatus(ORIGIN_HASH, 1, 42161)).status).to.equal(
      'pending',
    );
  });

  it('normalizes Tron base58 tokens and signer before preparation', async () => {
    const wallet = ethers.Wallet.createRandom();
    const base58 = (address: string) =>
      bytesToAddressTron(Buffer.from(address.slice(2), 'hex'));
    const identity = await captureTransferIdentity(
      makeBridge(),
      params({
        fromChain: 728126428,
        toChain: 1,
        fromToken: base58(TRON_USDT),
        toToken: ETH_USDT,
        fromAddress: base58(wallet.address),
        toAddress: SIGNER,
      }),
      wallet.privateKey,
    );
    expect(JSON.parse(identity).destinationRecipient.toLowerCase()).to.equal(
      SIGNER.toLowerCase(),
    );
  });
});
