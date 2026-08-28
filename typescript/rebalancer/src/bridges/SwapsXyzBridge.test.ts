import type { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';
import { AccountLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  AddressLookupTableAccount,
  type AccountInfo,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
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
const SOLANA_DOMAIN = 1399811149;
const SOLANA_KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(7));
const SOLANA_PRIVATE_KEY = JSON.stringify(Array.from(SOLANA_KEYPAIR.secretKey));
const SOLANA_TOKEN = Keypair.generate().publicKey;
const SOLANA_SOURCE_ACCOUNT = Keypair.generate().publicKey;
const SOLANA_OTHER_TOKEN = Keypair.generate().publicKey;
const SOLANA_OTHER_SOURCE_ACCOUNT = Keypair.generate().publicKey;
const SOLANA_LOOKUP_TABLE_KEY = Keypair.generate().publicKey;
const SOLANA_PROGRAM = Keypair.generate().publicKey;
const SOLANA_BLOCKHASH = new PublicKey(new Uint8Array(32).fill(1)).toBase58();

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
  name: 'solanamainnet',
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
    maxQuoteLossBps?: number;
    maxSolanaNativeSpendLamports?: number;
    evmProviderFactory?: (rpcUrl: string) => providers.Provider;
    solanaConnectionFactory?: (rpcUrl: string) => Connection;
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
      maxSolanaNativeSpendLamports: overrides.maxSolanaNativeSpendLamports,
      evmProviderFactory: overrides.evmProviderFactory,
      solanaConnectionFactory: overrides.solanaConnectionFactory,
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

function tokenAccountData(
  amount: bigint,
  overrides: {
    mint?: PublicKey;
    delegateOption?: 0 | 1;
    delegate?: PublicKey;
  } = {},
): Buffer {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint: overrides.mint ?? SOLANA_TOKEN,
      owner: SOLANA_KEYPAIR.publicKey,
      amount,
      delegateOption: overrides.delegateOption ?? 0,
      delegate: overrides.delegate ?? PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}

function accountInfo(
  owner: PublicKey,
  data: Buffer,
  lamports: number,
): AccountInfo<Buffer> {
  return { owner, data, lamports, executable: false, rentEpoch: 0 };
}

function simulatedAccount(owner: PublicKey, data: Buffer, lamports: number) {
  return {
    owner: owner.toBase58(),
    data: [data.toString('base64'), 'base64'],
    lamports,
    executable: false,
    rentEpoch: 0,
  };
}

function solanaLookupTableAccount(): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: SOLANA_LOOKUP_TABLE_KEY,
    state: {
      deactivationSlot: 18_446_744_073_709_551_615n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: [SOLANA_SOURCE_ACCOUNT],
    },
  });
}

function serializedSolanaTransaction(
  options: {
    lookupTable?: AddressLookupTableAccount;
    additionalWritable?: PublicKey;
  } = {},
): string {
  const instruction = new TransactionInstruction({
    programId: SOLANA_PROGRAM,
    keys: [
      {
        pubkey: SOLANA_SOURCE_ACCOUNT,
        isSigner: false,
        isWritable: true,
      },
      ...(options.additionalWritable
        ? [
            {
              pubkey: options.additionalWritable,
              isSigner: false,
              isWritable: true,
            },
          ]
        : []),
    ],
    data: Buffer.from([1]),
  });
  const message = new TransactionMessage({
    payerKey: SOLANA_KEYPAIR.publicKey,
    recentBlockhash: SOLANA_BLOCKHASH,
    instructions: [instruction],
  }).compileToV0Message(
    options.lookupTable === undefined ? [] : [options.lookupTable],
  );
  return Buffer.from(new VersionedTransaction(message).serialize()).toString(
    'base64',
  );
}

function serializedLegacySolanaTransaction(): string {
  const transaction = new Transaction({
    feePayer: SOLANA_KEYPAIR.publicKey,
    recentBlockhash: SOLANA_BLOCKHASH,
  }).add(
    new TransactionInstruction({
      programId: SOLANA_PROGRAM,
      keys: [
        {
          pubkey: SOLANA_SOURCE_ACCOUNT,
          isSigner: false,
          isWritable: true,
        },
      ],
      data: Buffer.from([1]),
    }),
  );
  return transaction
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');
}

function solanaActionResponse(
  overrides: Partial<SwapsXyzActionResponse> = {},
): SwapsXyzActionResponse {
  return actionResponse({
    tx: {
      base64Tx: serializedSolanaTransaction(),
      payer: SOLANA_KEYPAIR.publicKey.toBase58(),
      chainId: SOLANA_DOMAIN,
    },
    txId: 'solana-tx-1',
    vmId: 'solana',
    amountIn: {
      chainId: SOLANA_DOMAIN,
      address: SOLANA_TOKEN.toBase58(),
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
    bridgeIds: ['solana-rail'],
    requiresRegisterTransaction: true,
    ...overrides,
  });
}

function solanaQuote(
  response = solanaActionResponse(),
  overrides: Partial<BridgeQuoteParams> = {},
): BridgeQuote<SwapsXyzBridgeRoute> {
  const params: BridgeQuoteParams = {
    fromChain: SOLANA_DOMAIN,
    toChain: 1,
    fromToken: SOLANA_TOKEN.toBase58(),
    toToken: FROM_TOKEN,
    fromAmount: 1_000_000n,
    fromAddress: SOLANA_KEYPAIR.publicKey.toBase58(),
    toAddress: SENDER,
    ...overrides,
  };
  return {
    id: response.txId,
    tool: 'solana-rail',
    fromAmount: 1_000_000n,
    toAmount: 995_000n,
    toAmountMin: 990_025n,
    executionDuration: 60,
    gasCosts: 0n,
    feeCosts: 0n,
    route: { actionResponse: response },
    requestParams: params,
  };
}

function createSolanaExecuteHarness(
  options: {
    response?: SwapsXyzActionResponse;
    postSourceData?: Buffer;
    postSignerLamports?: number;
    postSignerOwner?: PublicKey;
    maxSolanaNativeSpendLamports?: number;
    lookupTable?: AddressLookupTableAccount;
    additionalSignerToken?: {
      address: PublicKey;
      mint: PublicKey;
      preAmount: bigint;
      postAmount: bigint;
    };
  } = {},
) {
  const response = options.response ?? solanaActionResponse();
  const client = createClient();
  const connection = new Connection('https://solana.example.invalid');
  const getActionStub = sinon.stub(client, 'getAction').resolves(response);
  const preAccounts = [
    accountInfo(SystemProgram.programId, Buffer.alloc(0), 1_000_000_000),
    accountInfo(TOKEN_PROGRAM_ID, tokenAccountData(1_000_000n), 2_039_280),
  ];
  const postAccounts = [
    simulatedAccount(
      options.postSignerOwner ?? SystemProgram.programId,
      Buffer.alloc(0),
      options.postSignerLamports ?? 999_995_000,
    ),
    simulatedAccount(
      TOKEN_PROGRAM_ID,
      options.postSourceData ?? tokenAccountData(0n),
      2_039_280,
    ),
  ];
  if (options.additionalSignerToken) {
    preAccounts.push(
      accountInfo(
        TOKEN_PROGRAM_ID,
        tokenAccountData(options.additionalSignerToken.preAmount, {
          mint: options.additionalSignerToken.mint,
        }),
        2_039_280,
      ),
    );
    postAccounts.push(
      simulatedAccount(
        TOKEN_PROGRAM_ID,
        tokenAccountData(options.additionalSignerToken.postAmount, {
          mint: options.additionalSignerToken.mint,
        }),
        2_039_280,
      ),
    );
  }
  const getMultipleAccountsInfoStub = sinon
    .stub(connection, 'getMultipleAccountsInfoAndContext')
    .resolves({ context: { slot: 1 }, value: preAccounts });
  if (options.lookupTable) {
    sinon.stub(connection, 'getAddressLookupTable').resolves({
      context: { slot: 1 },
      value: options.lookupTable,
    });
  }
  sinon.stub(connection, 'getLatestBlockhash').resolves({
    blockhash: SOLANA_BLOCKHASH,
    lastValidBlockHeight: 100,
  });
  const simulateTransactionStub = sinon
    .stub(connection, 'simulateTransaction')
    .resolves({
      context: { slot: 1 },
      value: {
        err: null,
        logs: [],
        accounts: postAccounts,
        unitsConsumed: 1,
      },
    });
  sinon.stub(connection, 'getFeeForMessage').resolves({
    context: { slot: 1 },
    value: 5_000,
  });
  const sendRawTransactionStub = sinon
    .stub(connection, 'sendRawTransaction')
    .resolves('solana-signature');
  const registerTxsStub = sinon
    .stub(client, 'registerTxs')
    .resolves([{ success: true, error: null }]);
  const bridge = createBridge(client, {
    chainMetadata: { ethereum: ETHEREUM_METADATA, solana: SOLANA_METADATA },
    solanaConnectionFactory: () => connection,
    maxSolanaNativeSpendLamports:
      options.maxSolanaNativeSpendLamports ?? 10_000_000,
    registerTxRetryDelayMs: 1,
  });
  return {
    bridge,
    connection,
    getActionStub,
    getMultipleAccountsInfoStub,
    simulateTransactionStub,
    sendRawTransactionStub,
    registerTxsStub,
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
    await new Promise((resolve) => setTimeout(resolve, 10));

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

describe('SwapsXyzBridge.execute Solana', () => {
  afterEach(() => sinon.restore());

  it('simulates, binds, broadcasts, and registers an exact-input transfer', async () => {
    const harness = createSolanaExecuteHarness();

    const result = await harness.bridge.execute(solanaQuote(), {
      [ProtocolType.Sealevel]: SOLANA_PRIVATE_KEY,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(result).to.deep.equal({
      txHash: 'solana-signature',
      fromChain: SOLANA_DOMAIN,
      toChain: 1,
      transferId: 'solana-tx-1',
    });
    expect(harness.simulateTransactionStub.callCount).to.equal(1);
    expect(harness.simulateTransactionStub.firstCall.args[1]).to.include({
      minContextSlot: 1,
      sigVerify: true,
    });
    expect(harness.sendRawTransactionStub.callCount).to.equal(1);
    expect(harness.registerTxsStub.firstCall.args[0]).to.deep.equal([
      { txId: 'solana-tx-1', txHash: 'solana-signature' },
    ]);
  });

  it('supports legacy Solana transactions through the same validation', async () => {
    const response = solanaActionResponse({
      tx: {
        base64Tx: serializedLegacySolanaTransaction(),
        payer: SOLANA_KEYPAIR.publicKey.toBase58(),
        chainId: SOLANA_DOMAIN,
      },
    });
    const harness = createSolanaExecuteHarness({ response });

    await harness.bridge.execute(solanaQuote(response), {
      [ProtocolType.Sealevel]: SOLANA_PRIVATE_KEY,
    });

    expect(harness.sendRawTransactionStub.callCount).to.equal(1);
  });

  it('resolves address lookup tables before validating effects', async () => {
    const lookupTable = solanaLookupTableAccount();
    const response = solanaActionResponse({
      tx: {
        base64Tx: serializedSolanaTransaction({ lookupTable }),
        payer: SOLANA_KEYPAIR.publicKey.toBase58(),
        chainId: SOLANA_DOMAIN,
      },
    });
    const harness = createSolanaExecuteHarness({ response, lookupTable });

    await harness.bridge.execute(solanaQuote(response), {
      [ProtocolType.Sealevel]: SOLANA_PRIVATE_KEY,
    });

    expect(harness.sendRawTransactionStub.callCount).to.equal(1);
  });

  it('rejects a source-token debit that does not match exact input', async () => {
    const harness = createSolanaExecuteHarness({
      postSourceData: tokenAccountData(1n),
    });

    const error = await captureError(
      harness.bridge.execute(solanaQuote(), {
        [ProtocolType.Sealevel]: SOLANA_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('does not match exact input');
    expect(harness.sendRawTransactionStub.callCount).to.equal(0);
  });

  it('accepts a positive source-token debit below an exact-output cap', async () => {
    const response = solanaActionResponse({
      amountInMax: {
        chainId: SOLANA_DOMAIN,
        address: SOLANA_TOKEN.toBase58(),
        amount: '1000000',
      },
    });
    const harness = createSolanaExecuteHarness({
      response,
      postSourceData: tokenAccountData(100n),
    });
    const quote = solanaQuote(response, {
      fromAmount: undefined,
      toAmount: 995_000n,
    });

    await harness.bridge.execute(quote, {
      [ProtocolType.Sealevel]: SOLANA_PRIVATE_KEY,
    });

    expect(harness.sendRawTransactionStub.callCount).to.equal(1);
  });

  it('rejects source-token authority changes', async () => {
    const harness = createSolanaExecuteHarness({
      postSourceData: tokenAccountData(0n, {
        delegateOption: 1,
        delegate: Keypair.generate().publicKey,
      }),
    });

    const error = await captureError(
      harness.bridge.execute(solanaQuote(), {
        [ProtocolType.Sealevel]: SOLANA_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('changes authority or state');
    expect(harness.sendRawTransactionStub.callCount).to.equal(0);
  });

  it('rejects debits from another signer-owned token', async () => {
    const response = solanaActionResponse({
      tx: {
        base64Tx: serializedSolanaTransaction({
          additionalWritable: SOLANA_OTHER_SOURCE_ACCOUNT,
        }),
        payer: SOLANA_KEYPAIR.publicKey.toBase58(),
        chainId: SOLANA_DOMAIN,
      },
    });
    const harness = createSolanaExecuteHarness({
      response,
      additionalSignerToken: {
        address: SOLANA_OTHER_SOURCE_ACCOUNT,
        mint: SOLANA_OTHER_TOKEN,
        preAmount: 100n,
        postAmount: 99n,
      },
    });

    const error = await captureError(
      harness.bridge.execute(solanaQuote(response), {
        [ProtocolType.Sealevel]: SOLANA_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('debits non-source token account');
    expect(harness.sendRawTransactionStub.callCount).to.equal(0);
  });

  it('rejects changing the signer account owner', async () => {
    const harness = createSolanaExecuteHarness({
      postSignerOwner: SOLANA_PROGRAM,
    });

    const error = await captureError(
      harness.bridge.execute(solanaQuote(), {
        [ProtocolType.Sealevel]: SOLANA_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('signer account ownership or data');
    expect(harness.sendRawTransactionStub.callCount).to.equal(0);
  });

  it('rejects native spend above transaction fee plus configured cap', async () => {
    const harness = createSolanaExecuteHarness({
      postSignerLamports: 999_989_999,
      maxSolanaNativeSpendLamports: 5_000,
    });

    const error = await captureError(
      harness.bridge.execute(solanaQuote(), {
        [ProtocolType.Sealevel]: SOLANA_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('native spend');
    expect(harness.sendRawTransactionStub.callCount).to.equal(0);
  });

  it('rejects simulation failures before broadcast', async () => {
    const harness = createSolanaExecuteHarness();
    harness.simulateTransactionStub.resolves({
      context: { slot: 1 },
      value: { err: { InstructionError: [0, 'Custom'] }, logs: [] },
    });

    const error = await captureError(
      harness.bridge.execute(solanaQuote(), {
        [ProtocolType.Sealevel]: SOLANA_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('simulation failed');
    expect(harness.sendRawTransactionStub.callCount).to.equal(0);
  });

  it('rejects a quote whose Solana signer does not match fromAddress', async () => {
    const harness = createSolanaExecuteHarness();
    const quote = solanaQuote(solanaActionResponse(), {
      fromAddress: Keypair.generate().publicKey.toBase58(),
    });

    const error = await captureError(
      harness.bridge.execute(quote, {
        [ProtocolType.Sealevel]: SOLANA_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('signer does not match');
    expect(harness.getActionStub.callCount).to.equal(0);
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
