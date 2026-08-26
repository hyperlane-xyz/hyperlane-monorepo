import type { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';
import { ProtocolType, bytesToAddressTron } from '@hyperlane-xyz/utils';
import { expect } from 'chai';
import {
  BigNumber,
  Contract,
  Wallet,
  providers,
  utils,
  type BigNumberish,
  type Signer,
} from 'ethers';
import { pino } from 'pino';
import sinon from 'sinon';

import type {
  BridgeQuote,
  BridgeQuoteParams,
} from '../interfaces/IExternalBridge.js';

import {
  SwapsXyzClient,
  SwapsXyzRequestError,
  type SwapsXyzActionResponse,
  type SwapsXyzStatus,
  type SwapsXyzStatusResponse,
} from './SwapsXyzClient.js';
import { SwapsXyzBridge, type SwapsXyzBridgeRoute } from './SwapsXyzBridge.js';
import type { Erc20ContractFactory } from './erc20Approve.js';

const logger = pino({ level: 'silent' });
const TEST_WALLET = Wallet.createRandom();
const TEST_PRIVATE_KEY = TEST_WALLET.privateKey;
const FROM_TOKEN = '0x1111111111111111111111111111111111111111';
const TO_TOKEN = '0x2222222222222222222222222222222222222222';
const SPENDER = '0xfffffffffffffffffffffffffffffffffffffff1';
const SENDER = TEST_WALLET.address;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const TRON_CHAIN_ID = 728126428;
const TRON_TOKEN_HEX = '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c';
const TRON_TOKEN_BASE58 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRON_SENDER_BASE58 = bytesToAddressTron(
  Buffer.from(SENDER.slice(2), 'hex'),
);
const TRON_SPENDER_BASE58 = bytesToAddressTron(
  Buffer.from(SPENDER.slice(2), 'hex'),
);
const TRON_TX_HASH = `0x${'ab'.repeat(32)}`;

const ETHEREUM_METADATA: ChainMetadata = {
  chainId: 1,
  protocol: ProtocolType.Ethereum,
  name: 'ethereum',
  displayName: 'Ethereum',
  domainId: 1,
  rpcUrls: [{ http: 'https://ethereum.example.invalid' }],
  nativeToken: { name: 'Ether', symbol: 'ETH', decimals: 18 },
};

const BASE_METADATA: ChainMetadata = {
  chainId: 8453,
  protocol: ProtocolType.Ethereum,
  name: 'base',
  displayName: 'Base',
  domainId: 8453,
  rpcUrls: [{ http: 'https://base.example.invalid' }],
  nativeToken: { name: 'Ether', symbol: 'ETH', decimals: 18 },
};

const TRON_METADATA: ChainMetadata = {
  chainId: TRON_CHAIN_ID,
  protocol: ProtocolType.Tron,
  name: 'tron',
  displayName: 'Tron',
  domainId: TRON_CHAIN_ID,
  rpcUrls: [{ http: 'https://tron.example.invalid/jsonrpc' }],
  nativeToken: { name: 'Tron', symbol: 'TRX', decimals: 6 },
};

const CHAIN_METADATA: ChainMap<ChainMetadata> = {
  ethereum: ETHEREUM_METADATA,
  base: BASE_METADATA,
  tron: TRON_METADATA,
};

function actionResponse(
  overrides: Partial<SwapsXyzActionResponse> = {},
): SwapsXyzActionResponse {
  return {
    tx: {
      to: SPENDER,
      data: '0xdeadbeef',
      value: '0',
      chainId: 1,
    },
    txId: 'tx-1',
    vmId: 'evm',
    amountIn: {
      chainId: 1,
      address: FROM_TOKEN,
      amount: '1000000',
      decimals: 6,
    },
    amountOut: {
      chainId: 8453,
      address: TO_TOKEN,
      amount: '995000',
      decimals: 6,
    },
    amountOutMin: {
      chainId: 8453,
      address: TO_TOKEN,
      amount: '990025',
      decimals: 6,
    },
    bridgeIds: ['across'],
    requiresTokenApproval: false,
    estimatedTxTime: 60,
    protocolFee: { amount: '100' },
    applicationFee: { amount: '50' },
    bridgeFee: { amount: '200' },
    ...overrides,
  };
}

function quoteParams(
  overrides: Partial<BridgeQuoteParams> = {},
): BridgeQuoteParams {
  return {
    fromChain: 1,
    toChain: 8453,
    fromToken: FROM_TOKEN,
    toToken: TO_TOKEN,
    fromAmount: 1_000_000n,
    fromAddress: SENDER,
    ...overrides,
  };
}

function bridgeQuote(
  params: BridgeQuoteParams = quoteParams(),
): BridgeQuote<SwapsXyzBridgeRoute> {
  const response = actionResponse();
  return {
    id: response.txId,
    tool: 'across',
    fromAmount: 1_000_000n,
    toAmount: 995_000n,
    toAmountMin: 990_025n,
    executionDuration: 60,
    gasCosts: 0n,
    feeCosts: 350n,
    route: { actionResponse: response },
    requestParams: params,
  };
}

function statusResponse(
  status: SwapsXyzStatus,
  overrides: Partial<SwapsXyzStatusResponse> = {},
): SwapsXyzStatusResponse {
  return {
    status,
    txId: 'tx-1',
    srcChainId: 1,
    dstChainId: 8453,
    srcTxHash: '0xsource',
    dstTxHash: '0xdestination',
    actionResponse: actionResponse(),
    ...overrides,
  };
}

function createClient(): SwapsXyzClient {
  return new SwapsXyzClient({ apiKey: 'test-key' }, logger);
}

function createBridge(
  client: SwapsXyzClient,
  overrides: {
    chainMetadata?: ChainMap<ChainMetadata>;
    defaultSlippage?: number;
    maxQuoteLossBps?: number;
    evmProviderFactory?: (rpcUrl: string) => providers.Provider;
    tronWalletFactory?: (privateKey: string, rpcUrl: string) => Wallet;
    registerTxRetryDelayMs?: number;
    erc20ContractFactory?: Erc20ContractFactory;
  } = {},
): SwapsXyzBridge {
  return new SwapsXyzBridge(
    {
      apiKey: 'test-key',
      chainMetadata: overrides.chainMetadata ?? CHAIN_METADATA,
      defaultSlippage: overrides.defaultSlippage,
      maxQuoteLossBps: overrides.maxQuoteLossBps,
      evmProviderFactory: overrides.evmProviderFactory,
      tronWalletFactory: overrides.tronWalletFactory,
      registerTxRetryDelayMs: overrides.registerTxRetryDelayMs,
      erc20ContractFactory: overrides.erc20ContractFactory,
    },
    logger,
    client,
  );
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof Error)) {
    throw new Error(`Expected an Error, received ${String(caught)}`);
  }
  return caught;
}

function transactionReceipt(
  hash: string,
  status: number,
): providers.TransactionReceipt {
  return {
    to: SPENDER,
    from: SENDER,
    contractAddress: '',
    transactionIndex: 0,
    gasUsed: BigNumber.from(1),
    logsBloom: '0x',
    blockHash: '0xblock',
    transactionHash: hash,
    logs: [],
    blockNumber: 1,
    confirmations: 1,
    cumulativeGasUsed: BigNumber.from(1),
    effectiveGasPrice: BigNumber.from(1),
    byzantium: true,
    type: 2,
    status,
  };
}

function transactionResponse(
  hash: string,
  status = 1,
): providers.TransactionResponse {
  return {
    hash,
    confirmations: 0,
    from: SENDER,
    nonce: 0,
    gasLimit: BigNumber.from(1),
    gasPrice: BigNumber.from(1),
    data: '0x',
    value: BigNumber.from(0),
    chainId: 1,
    wait: async () => transactionReceipt(hash, status),
  };
}

function createExecuteHarness(response = actionResponse()): {
  bridge: SwapsXyzBridge;
  client: SwapsXyzClient;
  provider: providers.StaticJsonRpcProvider;
  getActionStub: sinon.SinonStub;
  sendTransactionStub: sinon.SinonStub;
  waitForTransactionStub: sinon.SinonStub;
} {
  const client = createClient();
  const provider = new providers.StaticJsonRpcProvider(
    'https://ethereum.example.invalid',
    { chainId: 1, name: 'ethereum' },
  );
  const bridge = createBridge(client, {
    evmProviderFactory: () => provider,
    registerTxRetryDelayMs: 1,
  });
  const getActionStub = sinon.stub(client, 'getAction').resolves(response);
  const sendTransactionStub = sinon
    .stub(Wallet.prototype, 'sendTransaction')
    .resolves(transactionResponse('0xbridge'));
  const waitForTransactionStub = sinon
    .stub(provider, 'waitForTransaction')
    .resolves(transactionReceipt('0xbridge', 1));
  return {
    bridge,
    client,
    provider,
    getActionStub,
    sendTransactionStub,
    waitForTransactionStub,
  };
}

function tronActionResponse(
  overrides: Partial<SwapsXyzActionResponse> = {},
): SwapsXyzActionResponse {
  return actionResponse({
    tx: {
      to: TRON_SPENDER_BASE58,
      toExtra: '0xdeadbeef',
      value: '0',
      chainId: TRON_CHAIN_ID,
      chainKey: 'trx',
    },
    txId: 'tron-transfer-id',
    vmId: 'alt-vm',
    amountIn: {
      chainId: TRON_CHAIN_ID,
      address: TRON_TOKEN_BASE58,
      amount: '1000000',
      decimals: 6,
    },
    amountOut: {
      chainId: 1,
      address: TO_TOKEN,
      amount: '995000',
      decimals: 6,
    },
    amountOutMin: {
      chainId: 1,
      address: TO_TOKEN,
      amount: '990025',
      decimals: 6,
    },
    requiresRegisterTransaction: true,
    ...overrides,
  });
}

function tronBridgeQuote(
  response = tronActionResponse(),
): BridgeQuote<SwapsXyzBridgeRoute> {
  return {
    ...bridgeQuote(
      quoteParams({
        fromChain: TRON_CHAIN_ID,
        toChain: 1,
        fromToken: TRON_TOKEN_HEX,
        toToken: TO_TOKEN,
        fromAddress: TRON_SENDER_BASE58,
        toAddress: SENDER,
      }),
    ),
    id: response.txId,
    tool: response.bridgeIds?.join('+') || 'swapsxyz',
    route: { actionResponse: response },
  };
}

function createTronExecuteHarness(response = tronActionResponse()): {
  bridge: SwapsXyzBridge;
  client: SwapsXyzClient;
  getActionStub: sinon.SinonStub;
  registerTxsStub: sinon.SinonStub;
  sendTransactionStub: sinon.SinonStub;
  waitStub: sinon.SinonStub;
  wallet: Wallet;
} {
  const client = createClient();
  const getActionStub = sinon.stub(client, 'getAction').resolves(response);
  const registerTxsStub = sinon
    .stub(client, 'registerTxs')
    .resolves([{ success: true, error: null }]);
  const wallet = new Wallet(TEST_PRIVATE_KEY);
  const txResponse = transactionResponse(TRON_TX_HASH);
  const waitStub = sinon.stub(txResponse, 'wait');
  const sendTransactionStub = sinon
    .stub(wallet, 'sendTransaction')
    .resolves(txResponse);
  const bridge = createBridge(client, {
    tronWalletFactory: () => wallet,
    registerTxRetryDelayMs: 1,
  });
  return {
    bridge,
    client,
    getActionStub,
    registerTxsStub,
    sendTransactionStub,
    waitStub,
    wallet,
  };
}

describe('SwapsXyzBridge.quote', () => {
  afterEach(() => sinon.restore());

  it('normalizes Tron senders, recipients, and tokens to checksummed base58', async () => {
    const client = createClient();
    const getActionStub = sinon
      .stub(client, 'getAction')
      .resolves(tronActionResponse());
    const bridge = createBridge(client);

    await bridge.quote(
      quoteParams({
        fromChain: TRON_CHAIN_ID,
        toChain: 1,
        fromToken: TRON_TOKEN_HEX,
        toToken: TO_TOKEN,
        fromAddress: SENDER,
        toAddress: SENDER,
      }),
    );
    await bridge.quote(
      quoteParams({
        fromChain: 1,
        toChain: TRON_CHAIN_ID,
        fromToken: FROM_TOKEN,
        toToken: TRON_TOKEN_HEX,
        fromAddress: SENDER,
        toAddress: SENDER,
      }),
    );

    expect(getActionStub.firstCall.args[0]).to.include({
      sender: TRON_SENDER_BASE58,
      srcToken: TRON_TOKEN_BASE58,
      recipient: SENDER,
    });
    expect(getActionStub.secondCall.args[0]).to.include({
      sender: SENDER,
      dstToken: TRON_TOKEN_BASE58,
      recipient: TRON_SENDER_BASE58,
    });
  });

  it('rejects invalid Tron base58 checksums before quoting', async () => {
    const client = createClient();
    const getActionStub = sinon.stub(client, 'getAction');
    const invalidToken = `${TRON_TOKEN_BASE58.slice(0, -1)}1`;

    const error = await captureError(
      createBridge(client).quote(
        quoteParams({
          fromChain: TRON_CHAIN_ID,
          fromToken: invalidToken,
          fromAddress: SENDER,
        }),
      ),
    );

    expect(error.message).to.include('invalid Tron address');
    expect(getActionStub.callCount).to.equal(0);
  });

  it('maps fees, tool, id, costs, duration, and amountInMax', async () => {
    const client = createClient();
    sinon.stub(client, 'getAction').resolves(
      actionResponse({
        txId: 'fresh-id',
        bridgeIds: ['across', 'cctp'],
        amountInMax: { amount: '1005000' },
      }),
    );
    const quote = await createBridge(client).quote(quoteParams());

    expect(quote.id).to.equal('fresh-id');
    expect(quote.tool).to.equal('across+cctp');
    expect(quote.fromAmount).to.equal(1_005_000n);
    expect(quote.toAmount).to.equal(995_000n);
    expect(quote.toAmountMin).to.equal(990_025n);
    expect(quote.executionDuration).to.equal(60);
    expect(quote.gasCosts).to.equal(0n);
    expect(quote.feeCosts).to.equal(350n);
  });

  it('defaults tool, duration, and absent fees', async () => {
    const client = createClient();
    sinon.stub(client, 'getAction').resolves(
      actionResponse({
        bridgeIds: undefined,
        estimatedTxTime: undefined,
        protocolFee: undefined,
        applicationFee: undefined,
        bridgeFee: undefined,
      }),
    );

    const quote = await createBridge(client).quote(quoteParams());

    expect(quote.tool).to.equal('swapsxyz');
    expect(quote.executionDuration).to.equal(0);
    expect(quote.feeCosts).to.equal(0n);
  });

  it('defaults recipient to fromAddress and honors toAddress', async () => {
    const client = createClient();
    const getActionStub = sinon
      .stub(client, 'getAction')
      .resolves(actionResponse());
    const bridge = createBridge(client);

    await bridge.quote(quoteParams());
    await bridge.quote(quoteParams({ toAddress: '0xRecipient' }));

    expect(getActionStub.firstCall.args[0].recipient).to.equal(SENDER);
    expect(getActionStub.secondCall.args[0].recipient).to.equal('0xRecipient');
  });

  it('converts explicit and configured slippage fractions to bps', async () => {
    const client = createClient();
    const getActionStub = sinon
      .stub(client, 'getAction')
      .resolves(actionResponse());
    const bridge = createBridge(client, { defaultSlippage: 0.0123 });

    await bridge.quote(quoteParams({ slippage: 0.005 }));
    await bridge.quote(quoteParams());

    expect(getActionStub.firstCall.args[0].slippage).to.equal(50);
    expect(getActionStub.secondCall.args[0].slippage).to.equal(123);
  });

  it('rejects both, neither, and nonpositive amounts', async () => {
    const client = createClient();
    const bridge = createBridge(client);
    const cases: Array<{ params: BridgeQuoteParams; message: string }> = [
      {
        params: quoteParams({ fromAmount: 1n, toAmount: 1n }),
        message: 'Cannot specify both',
      },
      {
        params: quoteParams({ fromAmount: undefined, toAmount: undefined }),
        message: 'Must specify either',
      },
      {
        params: quoteParams({ fromAmount: 0n }),
        message: 'fromAmount must be positive',
      },
      {
        params: quoteParams({ fromAmount: undefined, toAmount: -1n }),
        message: 'toAmount must be positive',
      },
    ];

    for (const testCase of cases) {
      const error = await captureError(bridge.quote(testCase.params));
      expect(error.message).to.include(testCase.message);
    }
  });

  it('returns the zero native-token address', () => {
    expect(createBridge(createClient()).getNativeTokenAddress()).to.equal(
      ZERO_ADDRESS,
    );
  });

  it('accepts quote loss at the configured bps boundary', async () => {
    const client = createClient();
    sinon.stub(client, 'getAction').resolves(actionResponse());

    const quote = await createBridge(client, {
      maxQuoteLossBps: 100,
    }).quote(quoteParams());

    expect(quote.toAmountMin).to.equal(990_025n);
  });

  it('rejects quote loss above the configured bps boundary', async () => {
    const client = createClient();
    sinon.stub(client, 'getAction').resolves(actionResponse());

    const error = await captureError(
      createBridge(client, { maxQuoteLossBps: 99 }).quote(quoteParams()),
    );

    expect(error.message).to.include('quote loss 100 bps');
    expect(error.message).to.include('maximum 99 bps');
  });

  it('normalizes token decimals before enforcing quote loss', async () => {
    const client = createClient();
    sinon.stub(client, 'getAction').resolves(
      actionResponse({
        amountIn: { amount: '1000000', decimals: 6 },
        amountOut: { amount: '995000000000000000', decimals: 18 },
        amountOutMin: { amount: '990000000000000000', decimals: 18 },
      }),
    );

    const quote = await createBridge(client, {
      maxQuoteLossBps: 100,
    }).quote(quoteParams());

    expect(quote.toAmountMin).to.equal(990_000_000_000_000_000n);
  });
});

describe('SwapsXyzBridge reverse quote fallback', () => {
  afterEach(() => sinon.restore());

  function unsupportedDirection(): SwapsXyzRequestError {
    return new SwapsXyzRequestError(
      'exact-out unavailable',
      400,
      'Bad Request',
      'UNSUPPORTED_SWAP_DIRECTION',
    );
  }

  function providerWithDecimals(
    decimals: number,
  ): providers.StaticJsonRpcProvider {
    const provider = new providers.StaticJsonRpcProvider();
    sinon
      .stub(provider, 'call')
      .resolves(utils.defaultAbiCoder.encode(['uint8'], [decimals]));
    return provider;
  }

  it('uses a decimal-scaled 6-to-18 seed with headroom', async () => {
    const client = createClient();
    const getActionStub = sinon.stub(client, 'getAction');
    getActionStub.onFirstCall().rejects(unsupportedDirection());
    getActionStub.onSecondCall().resolves(
      actionResponse({
        amountIn: { amount: '1008000' },
        amountOut: { amount: '1000000000000000000' },
        amountOutMin: { amount: '1000000000000000000' },
      }),
    );
    const sourceProvider = providerWithDecimals(6);
    const destinationProvider = providerWithDecimals(18);
    const bridge = createBridge(client, {
      evmProviderFactory: (rpcUrl) =>
        rpcUrl.includes('ethereum') ? sourceProvider : destinationProvider,
    });

    await bridge.quote(
      quoteParams({
        fromAmount: undefined,
        toAmount: 1_000_000_000_000_000_000n,
      }),
    );

    expect(getActionStub.secondCall.args[0].amount).to.equal('1008000');
    expect(getActionStub.secondCall.args[0].swapDirection).to.equal(
      'exact-amount-in',
    );
  });

  it('uses a decimal-scaled 18-to-6 seed with headroom', async () => {
    const client = createClient();
    const getActionStub = sinon.stub(client, 'getAction');
    getActionStub.onFirstCall().rejects(unsupportedDirection());
    getActionStub.onSecondCall().resolves(
      actionResponse({
        amountIn: { amount: '1008000000000000000' },
        amountOut: { amount: '1000000' },
        amountOutMin: { amount: '1000000' },
      }),
    );
    const sourceProvider = providerWithDecimals(18);
    const destinationProvider = providerWithDecimals(6);
    const bridge = createBridge(client, {
      evmProviderFactory: (rpcUrl) =>
        rpcUrl.includes('ethereum') ? sourceProvider : destinationProvider,
    });

    await bridge.quote(
      quoteParams({ fromAmount: undefined, toAmount: 1_000_000n }),
    );

    expect(getActionStub.secondCall.args[0].amount).to.equal(
      '1008000000000000000',
    );
  });

  it('iteratively scales up and rewrites requestParams to exact-in', async () => {
    const client = createClient();
    const getActionStub = sinon.stub(client, 'getAction');
    getActionStub.onFirstCall().rejects(unsupportedDirection());
    getActionStub.onSecondCall().resolves(
      actionResponse({
        amountIn: { amount: '1008' },
        amountOutMin: { amount: '900' },
      }),
    );
    getActionStub.onThirdCall().resolves(
      actionResponse({
        amountIn: { amount: '1121' },
        amountOut: { amount: '1005' },
        amountOutMin: { amount: '1000' },
      }),
    );
    const provider = providerWithDecimals(6);
    const bridge = createBridge(client, {
      evmProviderFactory: () => provider,
    });

    const quote = await bridge.quote(
      quoteParams({ fromAmount: undefined, toAmount: 1_000n }),
    );

    expect(getActionStub.thirdCall.args[0].amount).to.equal('1121');
    expect(quote.requestParams.fromAmount).to.equal(1_121n);
    expect(quote.requestParams.toAmount).to.equal(undefined);
  });

  it('throws after four unsuccessful forward attempts', async () => {
    const client = createClient();
    const getActionStub = sinon.stub(client, 'getAction');
    getActionStub.onFirstCall().rejects(unsupportedDirection());
    for (let index = 1; index <= 4; index++) {
      getActionStub.onCall(index).resolves(
        actionResponse({
          amountIn: { amount: String(index * 1_000) },
          amountOutMin: { amount: '500' },
        }),
      );
    }
    const provider = providerWithDecimals(6);
    const bridge = createBridge(client, {
      evmProviderFactory: () => provider,
    });

    const error = await captureError(
      bridge.quote(quoteParams({ fromAmount: undefined, toAmount: 1_000n })),
    );

    expect(getActionStub.callCount).to.equal(5);
    expect(error.message).to.include('exhausted after 4 attempts');
    expect(error.message).to.include('last amountOutMin 500');
  });

  it('propagates other terminal errors without falling back', async () => {
    const client = createClient();
    const routeError = new SwapsXyzRequestError(
      'no route',
      400,
      'Bad Request',
      'NO_AVAILABLE_ROUTE',
    );
    const getActionStub = sinon.stub(client, 'getAction').rejects(routeError);

    const error = await captureError(
      createBridge(client).quote(
        quoteParams({ fromAmount: undefined, toAmount: 1_000n }),
      ),
    );

    expect(error).to.equal(routeError);
    expect(getActionStub.callCount).to.equal(1);
  });

  it('keeps native exact-out requestParams untouched when API succeeds', async () => {
    const client = createClient();
    sinon.stub(client, 'getAction').resolves(actionResponse());
    const params = quoteParams({
      fromToken: ZERO_ADDRESS,
      toToken: ZERO_ADDRESS,
      fromAmount: undefined,
      toAmount: 1_000n,
    });

    const quote = await createBridge(client).quote(params);

    expect(quote.requestParams).to.equal(params);
    expect(quote.requestParams.fromAmount).to.equal(undefined);
    expect(quote.requestParams.toAmount).to.equal(1_000n);
  });
});

describe('SwapsXyzBridge.execute', () => {
  afterEach(() => sinon.restore());

  it('throws before re-quoting when source metadata is missing', async () => {
    const client = createClient();
    const getActionStub = sinon.stub(client, 'getAction');
    const bridge = createBridge(client, { chainMetadata: {} });

    const error = await captureError(
      bridge.execute(bridgeQuote(), {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('no chain metadata');
    expect(getActionStub.callCount).to.equal(0);
  });

  it('throws before re-quoting when source RPC metadata is missing', async () => {
    const client = createClient();
    const getActionStub = sinon.stub(client, 'getAction');
    const noRpcMetadata: ChainMetadata = {
      ...ETHEREUM_METADATA,
      rpcUrls: [],
    };
    const bridge = createBridge(client, {
      chainMetadata: { ethereum: noRpcMetadata },
    });

    const error = await captureError(
      bridge.execute(bridgeQuote(), {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('no RPC URL');
    expect(getActionStub.callCount).to.equal(0);
  });

  it('throws when the EVM private key is missing', async () => {
    const client = createClient();
    const getActionStub = sinon.stub(client, 'getAction');

    const error = await captureError(
      createBridge(client).execute(bridgeQuote(), {}),
    );

    expect(error.message).to.include('Ethereum (EVM) private key');
    expect(getActionStub.callCount).to.equal(0);
  });

  it('throws before re-quoting when the Tron private key is missing', async () => {
    const client = createClient();
    const getActionStub = sinon.stub(client, 'getAction');

    const error = await captureError(
      createBridge(client).execute(tronBridgeQuote(), {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('Tron private key');
    expect(getActionStub.callCount).to.equal(0);
  });

  it('throws before re-quoting when the Tron signer does not match fromAddress', async () => {
    const client = createClient();
    const getActionStub = sinon.stub(client, 'getAction');
    const quote = tronBridgeQuote();
    quote.requestParams.fromAddress =
      '0x4444444444444444444444444444444444444444';

    const error = await captureError(
      createBridge(client, {
        tronWalletFactory: () => new Wallet(TEST_PRIVATE_KEY),
      }).execute(quote, { [ProtocolType.Tron]: TEST_PRIVATE_KEY }),
    );

    expect(error.message).to.include('Tron signer does not match');
    expect(getActionStub.callCount).to.equal(0);
  });

  it('broadcasts Tron alt-vm calldata and returns before confirmation', async () => {
    const harness = createTronExecuteHarness();

    const result = await harness.bridge.execute(tronBridgeQuote(), {
      [ProtocolType.Tron]: TEST_PRIVATE_KEY,
    });

    expect(harness.getActionStub.firstCall.args[0]).to.include({
      sender: TRON_SENDER_BASE58,
      srcToken: TRON_TOKEN_BASE58,
    });
    expect(harness.sendTransactionStub.firstCall.args[0]).to.deep.include({
      to: SPENDER,
      data: '0xdeadbeef',
    });
    expect(
      BigNumber.from(
        harness.sendTransactionStub.firstCall.args[0].value,
      ).toString(),
    ).to.equal('0');
    expect(harness.registerTxsStub.firstCall.args[0]).to.deep.equal([
      { txId: 'tron-transfer-id', txHash: TRON_TX_HASH },
    ]);
    expect(harness.waitStub.callCount).to.equal(0);
    expect(result).to.deep.equal({
      txHash: TRON_TX_HASH,
      fromChain: TRON_CHAIN_ID,
      toChain: 1,
      transferId: 'tron-transfer-id',
    });
  });

  it('broadcasts the direct TRC20 deposit shape returned by swaps.xyz', async () => {
    const accepted = tronActionResponse({
      tx: {
        to: TRON_SPENDER_BASE58,
        toExtra: null,
        value: '1000000',
        chainId: TRON_CHAIN_ID,
        chainKey: 'trx',
      },
      bridgeIds: ['alt-vm-1'],
    });
    const freshRecipient = '0x4444444444444444444444444444444444444444';
    const response = tronActionResponse({
      tx: {
        to: bytesToAddressTron(Buffer.from(freshRecipient.slice(2), 'hex')),
        toExtra: null,
        value: '1000000',
        chainId: TRON_CHAIN_ID,
        chainKey: 'trx',
      },
      bridgeIds: ['alt-vm-1'],
    });
    const harness = createTronExecuteHarness(response);

    const result = await harness.bridge.execute(tronBridgeQuote(accepted), {
      [ProtocolType.Tron]: TEST_PRIVATE_KEY,
    });

    const sent = harness.sendTransactionStub.firstCall.args[0];
    expect(sent.to).to.equal(TRON_TOKEN_HEX);
    expect(BigNumber.from(sent.value).isZero()).to.equal(true);
    const transfer = new utils.Interface([
      'function transfer(address recipient, uint256 amount) returns (bool)',
    ]).decodeFunctionData('transfer', sent.data);
    expect(transfer.recipient.toLowerCase()).to.equal(
      freshRecipient.toLowerCase(),
    );
    expect(transfer.amount.toString()).to.equal('1000000');
    expect(harness.waitStub.callCount).to.equal(0);
    expect(result.transferId).to.equal('tron-transfer-id');
  });

  it('rejects a refreshed direct Tron deposit on another bridge rail', async () => {
    const accepted = tronActionResponse({
      tx: {
        to: TRON_SPENDER_BASE58,
        toExtra: null,
        value: '1000000',
        chainId: TRON_CHAIN_ID,
        chainKey: 'trx',
      },
      bridgeIds: ['alt-vm-1'],
    });
    const fresh = tronActionResponse({
      tx: {
        to: bytesToAddressTron(Buffer.from('44'.repeat(20), 'hex')),
        toExtra: null,
        value: '1000000',
        chainId: TRON_CHAIN_ID,
        chainKey: 'trx',
      },
      bridgeIds: ['other-rail'],
    });
    const harness = createTronExecuteHarness(fresh);

    const error = await captureError(
      harness.bridge.execute(tronBridgeQuote(accepted), {
        [ProtocolType.Tron]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('fresh bridge');
    expect(harness.sendTransactionStub.callCount).to.equal(0);
  });

  it('rejects an unregistrable Tron action before broadcasting', async () => {
    const harness = createTronExecuteHarness(
      tronActionResponse({ requiresRegisterTransaction: false }),
    );

    const error = await captureError(
      harness.bridge.execute(tronBridgeQuote(), {
        [ProtocolType.Tron]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('must require transaction registration');
    expect(harness.sendTransactionStub.callCount).to.equal(0);
  });

  it('rejects fresh Tron native value above the accepted quote', async () => {
    const harness = createTronExecuteHarness(
      tronActionResponse({
        tx: {
          to: TRON_SPENDER_BASE58,
          toExtra: '0xdeadbeef',
          value: '1',
          chainId: TRON_CHAIN_ID,
          chainKey: 'trx',
        },
      }),
    );

    const error = await captureError(
      harness.bridge.execute(tronBridgeQuote(), {
        [ProtocolType.Tron]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('fresh native value');
    expect(harness.sendTransactionStub.callCount).to.equal(0);
  });

  it('rejects a direct Tron source-token transfer', async () => {
    const harness = createTronExecuteHarness(
      tronActionResponse({
        tx: {
          to: TRON_TOKEN_BASE58,
          toExtra: `0xa9059cbb${'00'.repeat(64)}`,
          value: '0',
          chainId: TRON_CHAIN_ID,
          chainKey: 'trx',
        },
      }),
    );

    const error = await captureError(
      harness.bridge.execute(tronBridgeQuote(), {
        [ProtocolType.Tron]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('direct source-token selector');
    expect(harness.sendTransactionStub.callCount).to.equal(0);
  });

  it('rejects a refreshed Tron target mismatch', async () => {
    const otherTarget = bytesToAddressTron(Buffer.from('44'.repeat(20), 'hex'));
    const harness = createTronExecuteHarness(
      tronActionResponse({
        tx: {
          to: otherTarget,
          toExtra: '0xdeadbeef',
          value: '0',
          chainId: TRON_CHAIN_ID,
          chainKey: 'trx',
        },
      }),
    );

    const error = await captureError(
      harness.bridge.execute(tronBridgeQuote(), {
        [ProtocolType.Tron]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('fresh target');
    expect(harness.sendTransactionStub.callCount).to.equal(0);
  });

  it('rejects a refreshed Tron calldata selector mismatch', async () => {
    const harness = createTronExecuteHarness(
      tronActionResponse({
        tx: {
          to: TRON_SPENDER_BASE58,
          toExtra: '0xfeedface',
          value: '0',
          chainId: TRON_CHAIN_ID,
          chainKey: 'trx',
        },
      }),
    );

    const error = await captureError(
      harness.bridge.execute(tronBridgeQuote(), {
        [ProtocolType.Tron]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('calldata selector');
    expect(harness.sendTransactionStub.callCount).to.equal(0);
  });

  it('resets and approves the exact Tron token input', async () => {
    const harness = createTronExecuteHarness(
      tronActionResponse({ requiresTokenApproval: true }),
    );
    const allowanceStub = sinon
      .stub<[string, string], Promise<BigNumber>>()
      .resolves(BigNumber.from('2000000'));
    const revokeTx = transactionResponse(`0x${'cd'.repeat(32)}`);
    const approveTx = transactionResponse(`0x${'ef'.repeat(32)}`);
    const approveStub = sinon.stub<
      [string, BigNumberish],
      Promise<providers.TransactionResponse>
    >();
    approveStub.onFirstCall().resolves(revokeTx);
    approveStub.onSecondCall().resolves(approveTx);

    class TronApprovalContract extends Contract {
      constructor() {
        super(TRON_TOKEN_HEX, [], harness.wallet);
      }

      allowance(owner: string, spender: string): Promise<BigNumber> {
        return allowanceStub(owner, spender);
      }

      approve(
        spender: string,
        amount: BigNumberish,
      ): Promise<providers.TransactionResponse> {
        return approveStub(spender, amount);
      }
    }

    const contract = new TronApprovalContract();
    const contractFactory = sinon
      .stub<[string, string[], Signer], Contract>()
      .returns(contract);
    const bridge = createBridge(harness.client, {
      tronWalletFactory: () => harness.wallet,
      erc20ContractFactory: contractFactory,
      registerTxRetryDelayMs: 1,
    });

    await bridge.execute(tronBridgeQuote(), {
      [ProtocolType.Tron]: TEST_PRIVATE_KEY,
    });

    expect(contractFactory.firstCall.args[0]).to.equal(TRON_TOKEN_HEX);
    expect(allowanceStub.firstCall.args).to.deep.equal([SENDER, SPENDER]);
    expect(approveStub.callCount).to.equal(2);
    expect(approveStub.firstCall.args[0]).to.equal(SPENDER);
    expect(BigNumber.from(approveStub.firstCall.args[1]).isZero()).to.be.true;
    expect(approveStub.secondCall.args[0]).to.equal(SPENDER);
    expect(BigNumber.from(approveStub.secondCall.args[1]).toString()).to.equal(
      '1000000',
    );
  });

  it('throws before re-quoting when the signer does not match fromAddress', async () => {
    const client = createClient();
    const getActionStub = sinon.stub(client, 'getAction');

    const error = await captureError(
      createBridge(client).execute(
        bridgeQuote(
          quoteParams({
            fromAddress: '0x3333333333333333333333333333333333333333',
          }),
        ),
        { [ProtocolType.Ethereum]: TEST_PRIVATE_KEY },
      ),
    );

    expect(error.message).to.include('signer does not match');
    expect(getActionStub.callCount).to.equal(0);
  });

  it('does not register an EVM transfer when the flag is absent', async () => {
    const harness = createExecuteHarness();
    const registerTxsStub = sinon.stub(harness.client, 'registerTxs');

    await harness.bridge.execute(bridgeQuote(), {
      [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
    });

    expect(registerTxsStub.callCount).to.equal(0);
  });

  it('returns the transfer after persistent registration failures', async () => {
    const harness = createExecuteHarness(
      actionResponse({ requiresRegisterTransaction: true }),
    );
    const registerTxsStub = sinon
      .stub(harness.client, 'registerTxs')
      .resolves([{ success: false, error: 'indexer unavailable' }]);
    const loggerErrorStub = sinon.stub(logger, 'error');

    const result = await harness.bridge.execute(bridgeQuote(), {
      [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(result.transferId).to.equal('tx-1');
    expect(result.txHash).to.equal('0xbridge');
    expect(registerTxsStub.callCount).to.equal(3);
    expect(loggerErrorStub.callCount).to.equal(1);
    expect(loggerErrorStub.firstCall.args[0]).to.include({
      txId: 'tx-1',
      txHash: '0xbridge',
    });
  });

  it('re-quotes with forward params and returns the fresh transfer ID', async () => {
    const fresh = actionResponse({ txId: 'fresh-transfer-id' });
    const harness = createExecuteHarness(fresh);

    const result = await harness.bridge.execute(bridgeQuote(), {
      [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
    });

    expect(harness.getActionStub.callCount).to.equal(1);
    expect(harness.getActionStub.firstCall.args[0].amount).to.equal('1000000');
    expect(harness.getActionStub.firstCall.args[0].swapDirection).to.equal(
      'exact-amount-in',
    );
    expect(result).to.deep.equal({
      txHash: '0xbridge',
      fromChain: 1,
      toChain: 8453,
      transferId: 'fresh-transfer-id',
    });
  });

  it('approves only when required, using fresh spender and amountInMax', async () => {
    const fresh = actionResponse({
      requiresTokenApproval: true,
      amountIn: { amount: '100' },
      amountInMax: { amount: '150' },
    });
    const harness = createExecuteHarness(fresh);
    const providerCallStub = sinon
      .stub(harness.provider, 'call')
      .callsFake(async (transaction) => {
        const transactionData = await transaction.data;
        if (transactionData === undefined) {
          throw new Error('Expected contract call data');
        }
        const data = utils.hexlify(transactionData);
        if (data.startsWith('0xdd62ed3e')) {
          return utils.defaultAbiCoder.encode(['uint256'], ['100']);
        }
        return utils.defaultAbiCoder.encode(['uint8'], [6]);
      });
    harness.sendTransactionStub
      .onFirstCall()
      .resolves(transactionResponse('0xrevoke'));
    harness.sendTransactionStub
      .onSecondCall()
      .resolves(transactionResponse('0xapproval'));
    harness.sendTransactionStub
      .onThirdCall()
      .resolves(transactionResponse('0xbridge'));

    await harness.bridge.execute(bridgeQuote(), {
      [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
    });

    expect(providerCallStub.callCount).to.equal(1);
    expect(harness.sendTransactionStub.callCount).to.equal(3);
    const approvalRequest = harness.sendTransactionStub.secondCall.args[0];
    const approvalTo = await approvalRequest.to;
    const approvalData = await approvalRequest.data;
    if (approvalTo === undefined || approvalData === undefined) {
      throw new Error('Expected approval transaction target and data');
    }
    expect(approvalTo.toLowerCase()).to.equal(FROM_TOKEN);
    expect(utils.hexlify(approvalData).toLowerCase()).to.include(
      SPENDER.slice(2),
    );
    expect(utils.hexlify(approvalData).toLowerCase()).to.include(
      utils.hexZeroPad(utils.hexlify(150), 32).slice(2),
    );
  });

  it('does not call the token contract when approval is not required', async () => {
    const harness = createExecuteHarness(
      actionResponse({ requiresTokenApproval: false }),
    );
    const providerCallStub = sinon.stub(harness.provider, 'call');

    await harness.bridge.execute(bridgeQuote(), {
      [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
    });

    expect(providerCallStub.callCount).to.equal(0);
    expect(harness.sendTransactionStub.callCount).to.equal(1);
  });

  it('returns the EVM broadcast identity before confirmation', async () => {
    const harness = createExecuteHarness();

    const result = await harness.bridge.execute(bridgeQuote(), {
      [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
    });

    expect(result.txHash).to.equal('0xbridge');
    expect(result.transferId).to.equal('tx-1');
    expect(harness.waitForTransactionStub.callCount).to.equal(0);
  });

  it('rejects fresh EVM native value above the accepted quote', async () => {
    const harness = createExecuteHarness(
      actionResponse({
        tx: {
          to: SPENDER,
          data: '0xdeadbeef',
          value: '1',
          chainId: 1,
        },
      }),
    );

    const error = await captureError(
      harness.bridge.execute(bridgeQuote(), {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('fresh native value');
    expect(harness.sendTransactionStub.callCount).to.equal(0);
  });

  it('rejects a direct EVM source-token approval', async () => {
    const harness = createExecuteHarness(
      actionResponse({
        tx: {
          to: FROM_TOKEN,
          data: `0x095ea7b3${'00'.repeat(64)}`,
          value: '0',
          chainId: 1,
        },
      }),
    );

    const error = await captureError(
      harness.bridge.execute(bridgeQuote(), {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('direct source-token selector');
    expect(harness.sendTransactionStub.callCount).to.equal(0);
  });

  it('rejects a fresh transaction target mismatch', async () => {
    const harness = createExecuteHarness(
      actionResponse({
        tx: {
          to: '0x4444444444444444444444444444444444444444',
          data: '0xdeadbeef',
          value: '0',
          chainId: 1,
        },
      }),
    );

    const error = await captureError(
      harness.bridge.execute(bridgeQuote(), {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('fresh target');
    expect(harness.sendTransactionStub.callCount).to.equal(0);
  });

  it('rejects a fresh transaction calldata selector mismatch', async () => {
    const harness = createExecuteHarness(
      actionResponse({
        tx: {
          to: SPENDER,
          data: '0xfeedface',
          value: '0',
          chainId: 1,
        },
      }),
    );

    const error = await captureError(
      harness.bridge.execute(bridgeQuote(), {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('calldata selector');
    expect(harness.sendTransactionStub.callCount).to.equal(0);
  });

  it('allows refreshed calldata when target and selector are unchanged', async () => {
    const harness = createExecuteHarness(
      actionResponse({
        tx: {
          to: SPENDER,
          data: `0xdeadbeef${'00'.repeat(32)}`,
          value: '0',
          chainId: 1,
        },
      }),
    );

    await harness.bridge.execute(bridgeQuote(), {
      [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
    });

    expect(harness.sendTransactionStub.callCount).to.equal(1);
  });

  it('rejects native value on an ERC20 route', async () => {
    const response = actionResponse({
      tx: { to: SPENDER, data: '0xdeadbeef', value: '1', chainId: 1 },
    });
    const acceptedQuote = bridgeQuote();
    acceptedQuote.route = { actionResponse: response };
    const harness = createExecuteHarness(response);

    const error = await captureError(
      harness.bridge.execute(acceptedQuote, {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('ERC20 routes must not send native value');
    expect(harness.sendTransactionStub.callCount).to.equal(0);
  });

  const mismatchCases: Array<{
    name: string;
    response: SwapsXyzActionResponse;
    message: string;
  }> = [
    {
      name: 'transaction source chain',
      response: actionResponse({
        tx: {
          to: SPENDER,
          data: '0xdeadbeef',
          value: '0',
          chainId: 10,
        },
      }),
      message: 'tx chainId',
    },
    {
      name: 'source chain',
      response: actionResponse({
        amountIn: { chainId: 10, address: FROM_TOKEN, amount: '1000000' },
      }),
      message: 'amountIn chainId',
    },
    {
      name: 'destination chain',
      response: actionResponse({
        amountOut: { chainId: 10, address: TO_TOKEN, amount: '995000' },
      }),
      message: 'amountOut chainId',
    },
    {
      name: 'source token',
      response: actionResponse({
        amountIn: {
          chainId: 1,
          address: '0x4444444444444444444444444444444444444444',
          amount: '1000000',
        },
      }),
      message: 'amountIn token',
    },
    {
      name: 'destination token',
      response: actionResponse({
        amountOut: {
          chainId: 8453,
          address: '0x4444444444444444444444444444444444444444',
          amount: '995000',
        },
      }),
      message: 'amountOut token',
    },
  ];

  for (const testCase of mismatchCases) {
    it(`rejects a fresh ${testCase.name} mismatch`, async () => {
      const harness = createExecuteHarness(testCase.response);

      const error = await captureError(
        harness.bridge.execute(bridgeQuote(), {
          [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
        }),
      );

      expect(error.message).to.include(testCase.message);
      expect(harness.sendTransactionStub.callCount).to.equal(0);
    });
  }

  it('rejects exact-in output degradation from a fresh quote', async () => {
    const harness = createExecuteHarness(
      actionResponse({
        amountOutMin: {
          chainId: 8453,
          address: TO_TOKEN,
          amount: '990024',
        },
      }),
    );

    const error = await captureError(
      harness.bridge.execute(bridgeQuote(), {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('fresh minimum output');
    expect(harness.sendTransactionStub.callCount).to.equal(0);
  });

  it('rejects exact-out input growth from a fresh quote', async () => {
    const harness = createExecuteHarness(
      actionResponse({
        amountInMax: {
          chainId: 1,
          address: FROM_TOKEN,
          amount: '1000001',
        },
      }),
    );
    const exactOutQuote = bridgeQuote(
      quoteParams({ fromAmount: undefined, toAmount: 995_000n }),
    );

    const error = await captureError(
      harness.bridge.execute(exactOutQuote, {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('fresh input');
    expect(error.message).to.include('accepted input cap');
    expect(harness.sendTransactionStub.callCount).to.equal(0);
  });

  it('rejects exact-out output degradation from a fresh quote', async () => {
    const harness = createExecuteHarness(
      actionResponse({
        amountOutMin: {
          chainId: 8453,
          address: TO_TOKEN,
          amount: '990024',
        },
      }),
    );
    const exactOutQuote = bridgeQuote(
      quoteParams({ fromAmount: undefined, toAmount: 995_000n }),
    );

    const error = await captureError(
      harness.bridge.execute(exactOutQuote, {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('fresh minimum output');
    expect(harness.sendTransactionStub.callCount).to.equal(0);
  });
});

describe('SwapsXyzBridge.getStatus', () => {
  afterEach(() => sinon.restore());

  it('maps success and completed with required defaults', async () => {
    const client = createClient();
    const getStatusStub = sinon.stub(client, 'getStatus');
    getStatusStub.onFirstCall().resolves(statusResponse('success'));
    getStatusStub.onSecondCall().resolves(
      statusResponse('completed', {
        dstTxHash: undefined,
        actionResponse: undefined,
      }),
    );
    const bridge = createBridge(client);

    const success = await bridge.getStatus('0xsource', 1, 8453);
    const completed = await bridge.getStatus('0xsource2', 1, 8453);

    expect(success).to.deep.equal({
      status: 'complete',
      receivingTxHash: '0xdestination',
      receivedAmount: 995_000n,
    });
    expect(completed).to.deep.equal({
      status: 'complete',
      receivingTxHash: '',
      receivedAmount: 0n,
    });
    expect(getStatusStub.firstCall.args[0]).to.deep.equal({
      txHash: '0xsource',
      chainId: 1,
    });
  });

  it('retries persisted transaction registration after status lookup fails', async () => {
    const client = createClient();
    const getStatusStub = sinon.stub(client, 'getStatus');
    getStatusStub.onFirstCall().rejects(new Error('not registered'));
    getStatusStub.onSecondCall().resolves(statusResponse('success'));
    const registerTxsStub = sinon
      .stub(client, 'registerTxs')
      .resolves([{ success: true, error: null }]);
    const bridge = createBridge(client, { registerTxRetryDelayMs: 1 });

    const result = await bridge.getStatus(
      '0xsource',
      1,
      8453,
      'persisted-transfer-id',
    );

    expect(getStatusStub.firstCall.args[0]).to.deep.equal({
      txHash: '0xsource',
      txId: 'persisted-transfer-id',
      chainId: 1,
    });
    expect(registerTxsStub.firstCall.args[0]).to.deep.equal([
      { txId: 'persisted-transfer-id', txHash: '0xsource' },
    ]);
    expect(getStatusStub.secondCall.args[0]).to.deep.equal({
      txHash: '0xsource',
      txId: 'persisted-transfer-id',
      chainId: 1,
    });
    expect(result.status).to.equal('complete');
  });

  it('returns not_found when the response srcChainId does not match the requested chain', async () => {
    const client = createClient();
    sinon
      .stub(client, 'getStatus')
      .resolves(statusResponse('success', { srcChainId: 10 }));

    const result = await createBridge(client).getStatus('0xsource', 1, 8453);

    expect(result).to.deep.equal({ status: 'not_found' });
  });

  it('returns not_found when the response dstChainId does not match the requested chain', async () => {
    const client = createClient();
    sinon
      .stub(client, 'getStatus')
      .resolves(statusResponse('success', { dstChainId: 10 }));

    const result = await createBridge(client).getStatus('0xsource', 1, 8453);

    expect(result).to.deep.equal({ status: 'not_found' });
  });

  it('maps status strings case-insensitively', async () => {
    const client = createClient();
    Object.defineProperty(client, 'getStatus', {
      configurable: true,
      value: async () => ({
        ...statusResponse('success'),
        status: 'SUCCESS',
      }),
    });

    const result = await createBridge(client).getStatus('0xsource', 1, 8453);

    expect(result.status).to.equal('complete');
  });

  const terminalCases: Array<{
    raw: SwapsXyzStatus;
    error: string;
  }> = [
    { raw: 'failed', error: 'swaps.xyz reported transfer failed' },
    { raw: 'refunded', error: 'refunded' },
    {
      raw: 'requires refund',
      error: 'requires refund (claim via swaps.xyz)',
    },
    { raw: 'expired', error: 'swaps.xyz transfer expired' },
  ];

  for (const testCase of terminalCases) {
    it(`maps ${testCase.raw} to failed`, async () => {
      const client = createClient();
      sinon.stub(client, 'getStatus').resolves(statusResponse(testCase.raw));

      const result = await createBridge(client).getStatus('0xsource', 1, 8453);

      expect(result).to.deep.equal({
        status: 'failed',
        error: testCase.error,
      });
    });
  }

  const pendingCases: SwapsXyzStatus[] = [
    'pending',
    'submitted',
    'not yet created',
  ];

  for (const rawStatus of pendingCases) {
    it(`maps ${rawStatus} to pending with raw substatus`, async () => {
      const client = createClient();
      sinon.stub(client, 'getStatus').resolves(statusResponse(rawStatus));

      const result = await createBridge(client).getStatus('0xsource', 1, 8453);

      expect(result).to.deep.equal({
        status: 'pending',
        substatus: rawStatus,
      });
    });
  }

  it('propagates status API outages', async () => {
    const client = createClient();
    sinon.stub(client, 'getStatus').rejects(new Error('network unavailable'));

    const error = await captureError(
      createBridge(client).getStatus('0xsource', 1, 8453),
    );

    expect(error.message).to.equal('network unavailable');
  });

  it('returns not_found for an explicit API not-found response', async () => {
    const client = createClient();
    sinon
      .stub(client, 'getStatus')
      .rejects(new SwapsXyzRequestError('missing', 404, 'Not Found'));

    const result = await createBridge(client).getStatus('0xsource', 1, 8453);

    expect(result).to.deep.equal({ status: 'not_found' });
  });
});
