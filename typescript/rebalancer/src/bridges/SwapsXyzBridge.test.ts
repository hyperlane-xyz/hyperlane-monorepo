import type { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { expect } from 'chai';
import { BigNumber, Wallet, providers, utils } from 'ethers';
import { pino } from 'pino';
import sinon from 'sinon';

import type {
  BridgeQuote,
  BridgeQuoteParams,
} from '../interfaces/IExternalBridge.js';
import {
  DEFAULT_RECEIPT_TIMEOUT_MS,
  ReceiptWaitTimeoutError,
} from '../utils/receiptTimeout.js';

import {
  SwapsXyzClient,
  SwapsXyzRequestError,
  type SwapsXyzActionResponse,
  type SwapsXyzStatus,
  type SwapsXyzStatusResponse,
} from './SwapsXyzClient.js';
import { SwapsXyzBridge, type SwapsXyzBridgeRoute } from './SwapsXyzBridge.js';

const logger = pino({ level: 'silent' });
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const FROM_TOKEN = '0x1111111111111111111111111111111111111111';
const TO_TOKEN = '0x2222222222222222222222222222222222222222';
const SPENDER = '0xfffffffffffffffffffffffffffffffffffffff1';
const SENDER = '0x3333333333333333333333333333333333333333';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const SOLANA_DOMAIN = 1399811149;
const SOLANA_TOKEN = 'So11111111111111111111111111111111111111112';
const SOLANA_KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(7));
const SOLANA_PRIVATE_KEY = JSON.stringify(Array.from(SOLANA_KEYPAIR.secretKey));
const DUMMY_SOLANA_BLOCKHASH = new PublicKey(
  new Uint8Array(32).fill(1),
).toBase58();

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

const SOLANA_METADATA: ChainMetadata = {
  chainId: SOLANA_DOMAIN,
  protocol: ProtocolType.Sealevel,
  name: 'solana',
  displayName: 'Solana',
  domainId: SOLANA_DOMAIN,
  rpcUrls: [{ http: 'https://solana.example.invalid' }],
  nativeToken: { name: 'Solana', symbol: 'SOL', decimals: 9 },
};

const CHAIN_METADATA: ChainMap<ChainMetadata> = {
  ethereum: ETHEREUM_METADATA,
  base: BASE_METADATA,
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
    evmProviderFactory?: (rpcUrl: string) => providers.Provider;
    solanaConnectionFactory?: (rpcUrl: string) => Connection;
    solanaConfirmPollMs?: number;
    solanaConfirmTimeoutMs?: number;
    registerTxRetryDelayMs?: number;
  } = {},
): SwapsXyzBridge {
  return new SwapsXyzBridge(
    {
      apiKey: 'test-key',
      chainMetadata: overrides.chainMetadata ?? CHAIN_METADATA,
      defaultSlippage: overrides.defaultSlippage,
      evmProviderFactory: overrides.evmProviderFactory,
      solanaConnectionFactory: overrides.solanaConnectionFactory,
      solanaConfirmPollMs: overrides.solanaConfirmPollMs,
      solanaConfirmTimeoutMs: overrides.solanaConfirmTimeoutMs,
      registerTxRetryDelayMs: overrides.registerTxRetryDelayMs,
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

function versionedSolanaTx(): string {
  const message = new TransactionMessage({
    payerKey: SOLANA_KEYPAIR.publicKey,
    recentBlockhash: DUMMY_SOLANA_BLOCKHASH,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: SOLANA_KEYPAIR.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    ],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString(
    'base64',
  );
}

function legacySolanaTx(): string {
  const transaction = new Transaction({
    feePayer: SOLANA_KEYPAIR.publicKey,
    recentBlockhash: DUMMY_SOLANA_BLOCKHASH,
  }).add(
    SystemProgram.transfer({
      fromPubkey: SOLANA_KEYPAIR.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  );
  return transaction
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');
}

function solanaActionResponse(
  base64Tx: string,
  overrides: Partial<SwapsXyzActionResponse> = {},
): SwapsXyzActionResponse {
  return actionResponse({
    tx: {
      base64Tx,
      payer: SOLANA_KEYPAIR.publicKey.toBase58(),
      recentBlockhash: DUMMY_SOLANA_BLOCKHASH,
    },
    txId: 'solana-tx-1',
    vmId: 'solana',
    amountIn: {
      chainId: SOLANA_DOMAIN,
      address: SOLANA_TOKEN,
      amount: '1000000',
      decimals: 6,
    },
    amountOut: {
      chainId: 1,
      address: FROM_TOKEN,
      amount: '995000',
      decimals: 6,
    },
    amountOutMin: {
      chainId: 1,
      address: FROM_TOKEN,
      amount: '990025',
      decimals: 6,
    },
    requiresRegisterTransaction: true,
    ...overrides,
  });
}

function solanaBridgeQuote(): BridgeQuote<SwapsXyzBridgeRoute> {
  return bridgeQuote(
    quoteParams({
      fromChain: SOLANA_DOMAIN,
      toChain: 1,
      fromToken: SOLANA_TOKEN,
      toToken: FROM_TOKEN,
      fromAddress: SOLANA_KEYPAIR.publicKey.toBase58(),
      toAddress: SENDER,
    }),
  );
}

function createSolanaExecuteHarness(
  response = solanaActionResponse(versionedSolanaTx()),
): {
  bridge: SwapsXyzBridge;
  client: SwapsXyzClient;
  connection: Connection;
  getActionStub: sinon.SinonStub;
  registerTxsStub: sinon.SinonStub;
  sendRawTransactionStub: sinon.SinonStub;
  getSignatureStatusesStub: sinon.SinonStub;
} {
  const client = createClient();
  const connection = new Connection('https://solana.example.invalid');
  const getActionStub = sinon.stub(client, 'getAction').resolves(response);
  const registerTxsStub = sinon
    .stub(client, 'registerTxs')
    .resolves([{ success: true, error: null }]);
  const sendRawTransactionStub = sinon
    .stub(connection, 'sendRawTransaction')
    .resolves('solana-signature');
  const getSignatureStatusesStub = sinon
    .stub(connection, 'getSignatureStatuses')
    .resolves({
      context: { slot: 1 },
      value: [
        {
          slot: 1,
          confirmations: 1,
          err: null,
          confirmationStatus: 'confirmed',
        },
      ],
    });
  const bridge = createBridge(client, {
    chainMetadata: { ethereum: ETHEREUM_METADATA, solana: SOLANA_METADATA },
    solanaConnectionFactory: () => connection,
    solanaConfirmPollMs: 1,
    solanaConfirmTimeoutMs: 5,
    registerTxRetryDelayMs: 1,
  });
  return {
    bridge,
    client,
    connection,
    getActionStub,
    registerTxsStub,
    sendRawTransactionStub,
    getSignatureStatusesStub,
  };
}

describe('SwapsXyzBridge.quote', () => {
  afterEach(() => sinon.restore());

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

  it('uses Solana token supply decimals for a Solana-source fallback', async () => {
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
    const connection = new Connection('https://solana.example.invalid');
    const getTokenSupplyStub = sinon
      .stub(connection, 'getTokenSupply')
      .resolves({
        context: { slot: 1 },
        value: {
          amount: '1000000',
          decimals: 6,
          uiAmount: 1,
          uiAmountString: '1',
        },
      });
    const bridge = createBridge(client, {
      chainMetadata: { ethereum: ETHEREUM_METADATA, solana: SOLANA_METADATA },
      solanaConnectionFactory: () => connection,
    });

    await bridge.quote(
      quoteParams({
        fromChain: SOLANA_DOMAIN,
        toChain: 1,
        fromToken: SOLANA_TOKEN,
        toToken: ZERO_ADDRESS,
        fromAmount: undefined,
        toAmount: 1_000_000_000_000_000_000n,
        fromAddress: SOLANA_KEYPAIR.publicKey.toBase58(),
      }),
    );

    expect(getActionStub.secondCall.args[0].amount).to.equal('1008000');
    expect(getTokenSupplyStub.callCount).to.equal(1);
    expect(getTokenSupplyStub.firstCall.args[0].toBase58()).to.equal(
      SOLANA_TOKEN,
    );
  });

  it('evicts a rejected token-decimals lookup from the cache', async () => {
    const client = createClient();
    const getActionStub = sinon.stub(client, 'getAction');
    getActionStub.onFirstCall().rejects(unsupportedDirection());
    getActionStub.onSecondCall().rejects(unsupportedDirection());
    getActionStub.onThirdCall().resolves(
      actionResponse({
        amountIn: { amount: '1008000' },
        amountOut: { amount: '1000000000000000000' },
        amountOutMin: { amount: '1000000000000000000' },
      }),
    );
    const connection = new Connection('https://solana.example.invalid');
    const getTokenSupplyStub = sinon.stub(connection, 'getTokenSupply');
    getTokenSupplyStub.onFirstCall().rejects(new Error('transient RPC error'));
    getTokenSupplyStub.onSecondCall().resolves({
      context: { slot: 1 },
      value: {
        amount: '1000000',
        decimals: 6,
        uiAmount: 1,
        uiAmountString: '1',
      },
    });
    const bridge = createBridge(client, {
      chainMetadata: { ethereum: ETHEREUM_METADATA, solana: SOLANA_METADATA },
      solanaConnectionFactory: () => connection,
    });
    const params = quoteParams({
      fromChain: SOLANA_DOMAIN,
      toChain: 1,
      fromToken: SOLANA_TOKEN,
      toToken: ZERO_ADDRESS,
      fromAmount: undefined,
      toAmount: 1_000_000_000_000_000_000n,
      fromAddress: SOLANA_KEYPAIR.publicKey.toBase58(),
    });

    const firstError = await captureError(bridge.quote(params));
    const quote = await bridge.quote(params);

    expect(firstError.message).to.equal('transient RPC error');
    expect(quote.fromAmount).to.equal(1_008_000n);
    expect(getTokenSupplyStub.callCount).to.equal(2);
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

  it('throws before re-quoting when the Sealevel private key is missing', async () => {
    const client = createClient();
    const getActionStub = sinon.stub(client, 'getAction');
    const bridge = createBridge(client, {
      chainMetadata: { solana: SOLANA_METADATA },
    });
    const quote = bridgeQuote(
      quoteParams({
        fromChain: SOLANA_DOMAIN,
        fromToken: 'So11111111111111111111111111111111111111112',
      }),
    );

    const error = await captureError(
      bridge.execute(quote, {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('Sealevel private key');
    expect(getActionStub.callCount).to.equal(0);
  });

  it('signs, sends, confirms, and returns a versioned Solana transaction', async () => {
    const harness = createSolanaExecuteHarness();

    const result = await harness.bridge.execute(solanaBridgeQuote(), {
      [ProtocolType.Sealevel]: SOLANA_PRIVATE_KEY,
    });

    expect(result).to.deep.equal({
      txHash: 'solana-signature',
      fromChain: SOLANA_DOMAIN,
      toChain: 1,
      transferId: 'solana-tx-1',
    });
    expect(harness.getActionStub.callCount).to.equal(1);
    expect(harness.sendRawTransactionStub.callCount).to.equal(1);
    const sentBytes: unknown = harness.sendRawTransactionStub.firstCall.args[0];
    if (!(sentBytes instanceof Uint8Array)) {
      throw new Error('Expected serialized Solana transaction bytes');
    }
    const signed = VersionedTransaction.deserialize(sentBytes);
    expect(signed.signatures[0].some((byte) => byte !== 0)).to.equal(true);
    expect(harness.sendRawTransactionStub.firstCall.args[1]).to.deep.equal({
      skipPreflight: false,
      maxRetries: 5,
    });
  });

  it('signs and sends a legacy Solana transaction', async () => {
    const harness = createSolanaExecuteHarness(
      solanaActionResponse(legacySolanaTx()),
    );

    await harness.bridge.execute(solanaBridgeQuote(), {
      [ProtocolType.Sealevel]: SOLANA_PRIVATE_KEY,
    });

    const sentBytes: unknown = harness.sendRawTransactionStub.firstCall.args[0];
    if (!(sentBytes instanceof Uint8Array)) {
      throw new Error('Expected serialized Solana transaction bytes');
    }
    const signed = Transaction.from(sentBytes);
    const payerSignature = signed.signatures.find((entry) =>
      entry.publicKey.equals(SOLANA_KEYPAIR.publicKey),
    );
    expect(payerSignature?.signature).not.to.equal(null);
    expect(payerSignature?.signature).not.to.equal(undefined);
  });

  it('rejects a Solana payer mismatch before broadcasting', async () => {
    const mismatchedPayer = Keypair.generate().publicKey.toBase58();
    const harness = createSolanaExecuteHarness(
      solanaActionResponse(versionedSolanaTx(), {
        tx: {
          base64Tx: versionedSolanaTx(),
          payer: mismatchedPayer,
        },
      }),
    );

    const error = await captureError(
      harness.bridge.execute(solanaBridgeQuote(), {
        [ProtocolType.Sealevel]: SOLANA_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include(mismatchedPayer);
    expect(error.message).to.include(SOLANA_KEYPAIR.publicKey.toBase58());
    expect(harness.sendRawTransactionStub.callCount).to.equal(0);
  });

  it('throws when Solana confirmation reports a signature error', async () => {
    const harness = createSolanaExecuteHarness();
    harness.getSignatureStatusesStub.resolves({
      context: { slot: 1 },
      value: [
        {
          slot: 1,
          confirmations: 1,
          err: { InstructionError: [0, 'Custom'] },
          confirmationStatus: 'confirmed',
        },
      ],
    });

    const error = await captureError(
      harness.bridge.execute(solanaBridgeQuote(), {
        [ProtocolType.Sealevel]: SOLANA_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('solana-signature');
    expect(error.message).to.include('InstructionError');
    expect(harness.sendRawTransactionStub.callCount).to.equal(1);
  });

  it('times out when Solana confirmation misses its deadline', async () => {
    const harness = createSolanaExecuteHarness();
    harness.getSignatureStatusesStub.resolves({
      context: { slot: 1 },
      value: [null],
    });

    const error = await captureError(
      harness.bridge.execute(solanaBridgeQuote(), {
        [ProtocolType.Sealevel]: SOLANA_PRIVATE_KEY,
      }),
    );

    expect(error).to.be.instanceOf(ReceiptWaitTimeoutError);
    expect(error.message).to.include('solana-signature');
    expect(error.message).to.include('solana sendRawTransaction confirm');
  });

  it('registers confirmed Solana-source and EVM-source-to-Solana transfers', async () => {
    const solanaHarness = createSolanaExecuteHarness();
    await solanaHarness.bridge.execute(solanaBridgeQuote(), {
      [ProtocolType.Sealevel]: SOLANA_PRIVATE_KEY,
    });

    expect(solanaHarness.registerTxsStub.firstCall.args[0]).to.deep.equal([
      { txId: 'solana-tx-1', txHash: 'solana-signature' },
    ]);

    sinon.restore();
    const evmResponse = actionResponse({
      txId: 'evm-to-solana-tx',
      amountOut: {
        chainId: SOLANA_DOMAIN,
        address: SOLANA_TOKEN,
        amount: '995000',
      },
      requiresRegisterTransaction: true,
    });
    const evmHarness = createExecuteHarness(evmResponse);
    const registerTxsStub = sinon
      .stub(evmHarness.client, 'registerTxs')
      .resolves([{ success: true, error: null }]);
    const quote = bridgeQuote(
      quoteParams({ toChain: SOLANA_DOMAIN, toToken: SOLANA_TOKEN }),
    );

    await evmHarness.bridge.execute(quote, {
      [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
    });

    expect(registerTxsStub.firstCall.args[0]).to.deep.equal([
      { txId: 'evm-to-solana-tx', txHash: '0xbridge' },
    ]);
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

    expect(providerCallStub.callCount).to.equal(2);
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

  it('converts provider receipt timeout to ReceiptWaitTimeoutError', async () => {
    const harness = createExecuteHarness();
    const timeoutError = Object.assign(new Error('timeout exceeded'), {
      code: 'TIMEOUT',
    });
    harness.waitForTransactionStub.rejects(timeoutError);

    const error = await captureError(
      harness.bridge.execute(bridgeQuote(), {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error).to.be.instanceOf(ReceiptWaitTimeoutError);
    if (!(error instanceof ReceiptWaitTimeoutError)) {
      throw new Error('Expected ReceiptWaitTimeoutError');
    }
    expect(error.txHash).to.equal('0xbridge');
    expect(error.role).to.equal('primary');
    sinon.assert.calledWith(
      harness.waitForTransactionStub,
      '0xbridge',
      1,
      DEFAULT_RECEIPT_TIMEOUT_MS,
    );
  });

  it('throws when the source transaction receipt is reverted', async () => {
    const harness = createExecuteHarness();
    harness.waitForTransactionStub.resolves(transactionReceipt('0xbridge', 0));

    const error = await captureError(
      harness.bridge.execute(bridgeQuote(), {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('transaction reverted');
    expect(error.message).to.include('0xbridge');
  });

  const mismatchCases: Array<{
    name: string;
    response: SwapsXyzActionResponse;
    message: string;
  }> = [
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

  it('passes the Solana domain as chainId for Solana-source status', async () => {
    const client = createClient();
    const getStatusStub = sinon
      .stub(client, 'getStatus')
      .resolves(statusResponse('pending'));

    await createBridge(client).getStatus('solana-signature', SOLANA_DOMAIN, 1);

    expect(getStatusStub.firstCall.args[0]).to.deep.equal({
      txHash: 'solana-signature',
      chainId: SOLANA_DOMAIN,
    });
  });

  it('returns not_found when the response srcChainId does not match the requested chain', async () => {
    const client = createClient();
    sinon
      .stub(client, 'getStatus')
      .resolves(statusResponse('success', { srcChainId: SOLANA_DOMAIN }));

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
    'expired',
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

  it('returns not_found when the client throws', async () => {
    const client = createClient();
    sinon.stub(client, 'getStatus').rejects(new Error('network unavailable'));

    const result = await createBridge(client).getStatus('0xsource', 1, 8453);

    expect(result).to.deep.equal({ status: 'not_found' });
  });
});
