import type { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  TransactionSubmissionError,
  assert,
} from '@hyperlane-xyz/utils';
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

function apiResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createBridge(
  client: SwapsXyzClient,
  overrides: {
    chainMetadata?: ChainMap<ChainMetadata>;
    defaultSlippage?: number;
    maxQuoteLossBps?: number;
    maxEvmNativeFeeWei?: bigint;
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
      maxEvmNativeFeeWei: overrides.maxEvmNativeFeeWei,
      evmProviderFactory:
        overrides.evmProviderFactory ??
        (() => {
          const provider = new providers.StaticJsonRpcProvider();
          sinon
            .stub(provider, 'call')
            .resolves(utils.defaultAbiCoder.encode(['uint8'], [6]));
          return provider;
        }),
      maxSolanaNativeSpendLamports: overrides.maxSolanaNativeSpendLamports,
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

function stubObservedEvmSend(
  wallet: Wallet,
  provider: providers.StaticJsonRpcProvider,
): void {
  sinon.stub(wallet, 'populateTransaction').callsFake(async (tx) => ({
    ...(await utils.resolveProperties(tx)),
    chainId: 1,
    nonce: 0,
    gasLimit: BigNumber.from(100_000),
    gasPrice: BigNumber.from(1),
    type: 0,
  }));
  sinon.stub(provider, 'sendTransaction').callsFake(async (signed) => {
    const tx = utils.parseTransaction(await signed);
    return wallet.sendTransaction({
      to: tx.to?.toLowerCase(),
      data: tx.data,
      value: tx.value,
    });
  });
}

function createExecuteHarness(
  response = actionResponse(),
  overrides: { maxQuoteLossBps?: number } = {},
): {
  bridge: SwapsXyzBridge;
  client: SwapsXyzClient;
  provider: providers.StaticJsonRpcProvider;
  getActionStub: sinon.SinonStub;
  estimateGasStub: sinon.SinonStub;
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
    maxQuoteLossBps: overrides.maxQuoteLossBps,
    registerTxRetryDelayMs: 1,
  });
  const getActionStub = sinon.stub(client, 'getAction').resolves(response);
  const estimateGasStub = sinon
    .stub(Wallet.prototype, 'estimateGas')
    .resolves(BigNumber.from(100_000));
  const sendTransactionStub = sinon
    .stub(Wallet.prototype, 'sendTransaction')
    .resolves(transactionResponse('0xbridge'));
  stubObservedEvmSend(Wallet.prototype, provider);
  const waitForTransactionStub = sinon
    .stub(provider, 'waitForTransaction')
    .resolves(transactionReceipt('0xbridge', 1));
  return {
    bridge,
    client,
    provider,
    getActionStub,
    estimateGasStub,
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
    const quote = await createBridge(client).quote(
      quoteParams({ fromAmount: undefined, toAmount: 990025n }),
    );

    expect(quote.id).to.equal('fresh-id');
    expect(quote.tool).to.equal('across+cctp');
    expect(quote.fromAmount).to.equal(1_005_000n);
    expect(quote.toAmount).to.equal(995_000n);
    expect(quote.toAmountMin).to.equal(985_074n);
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

  it('uses chain decimals even when the API supplies consistent spoofed decimals', async () => {
    const client = createClient();
    sinon.stub(client, 'getAction').resolves(
      actionResponse({
        amountIn: { amount: '1000000', decimals: 7 },
      }),
    );
    const error = await captureError(
      createBridge(client, { maxQuoteLossBps: 50 }).quote(quoteParams()),
    );
    expect(error.message).to.include('decimals do not match chain data');
  });

  it('enforces slippage separately from expected quote loss', async () => {
    const client = createClient();
    const getAction = sinon.stub(client, 'getAction').resolves(
      actionResponse({
        amountOutMin: { amount: '990024' },
      }),
    );
    const bridge = createBridge(client, { maxQuoteLossBps: 50 });
    expect(
      (await captureError(bridge.quote(quoteParams()))).message,
    ).to.include('requested slippage');
    getAction.resolves(actionResponse());
    expect((await bridge.quote(quoteParams())).toAmountMin).to.equal(990025n);
    getAction.resolves(actionResponse({ amountOutMin: { amount: '995001' } }));
    expect(
      (await captureError(bridge.quote(quoteParams()))).message,
    ).to.include('requested slippage');
  });

  it('rejects exact-input responses that change the requested spend', async () => {
    const client = createClient();
    sinon
      .stub(client, 'getAction')
      .resolves(actionResponse({ amountIn: { amount: '999999' } }));
    expect(
      (await captureError(createBridge(client).quote(quoteParams()))).message,
    ).to.include('exact input');
  });

  it('rejects exact-output quotes below the request despite an acceptable price ratio', async () => {
    const client = createClient();
    sinon.stub(client, 'getAction').resolves(
      actionResponse({
        amountIn: { amount: '100' },
        amountOut: { amount: '100' },
        amountOutMin: { amount: '100' },
      }),
    );
    const error = await captureError(
      createBridge(client, { maxQuoteLossBps: 50 }).quote(
        quoteParams({ fromAmount: undefined, toAmount: 1000n, slippage: 0 }),
      ),
    );
    expect(error.message).to.include(
      'expected output is below the requested amount',
    );
  });

  it('accepts exact-output slippage below the target but rejects a lower refreshed expectation', async () => {
    const client = createClient();
    const response = actionResponse({
      amountIn: { amount: '1000' },
      amountOut: { amount: '1000' },
      amountOutMin: { amount: '995' },
    });
    const getAction = sinon.stub(client, 'getAction').resolves(response);
    const bridge = createBridge(client, { maxQuoteLossBps: 50 });
    const quote = await bridge.quote(
      quoteParams({ fromAmount: undefined, toAmount: 1000n, slippage: 0.005 }),
    );
    expect(quote.toAmount).to.equal(1000n);
    expect(quote.toAmountMin).to.equal(995n);
    await bridge.prepare(quote);

    getAction.resolves({ ...response, amountOut: { amount: '999' } });
    const error = await captureError(bridge.prepare(quote));
    expect(error.message).to.include(
      'expected output is below the requested amount',
    );
  });

  it('accepts quote loss at the configured bps boundary', async () => {
    const client = createClient();
    sinon.stub(client, 'getAction').resolves(actionResponse());

    const quote = await createBridge(client, {
      maxQuoteLossBps: 50,
    }).quote(quoteParams());

    expect(quote.toAmountMin).to.equal(990_025n);
  });

  it('rejects quote loss above the configured bps boundary', async () => {
    const client = createClient();
    sinon.stub(client, 'getAction').resolves(actionResponse());

    const error = await captureError(
      createBridge(client, { maxQuoteLossBps: 49 }).quote(quoteParams()),
    );

    expect(error.message).to.include('quote loss 50 bps');
    expect(error.message).to.include('maximum 49 bps');
  });

  it('normalizes token decimals before enforcing quote loss', async () => {
    const client = createClient();
    sinon.stub(client, 'getAction').resolves(
      actionResponse({
        amountIn: { amount: '1000000', decimals: 6 },
        amountOut: { amount: '995000000000000000', decimals: 18 },
        amountOutMin: { amount: '990025000000000000', decimals: 18 },
      }),
    );

    const quote = await createBridge(client, {
      maxQuoteLossBps: 50,
      evmProviderFactory: (rpcUrl) => {
        const provider = new providers.StaticJsonRpcProvider();
        sinon
          .stub(provider, 'call')
          .resolves(
            utils.defaultAbiCoder.encode(
              ['uint8'],
              [rpcUrl.includes('ethereum') ? 6 : 18],
            ),
          );
        return provider;
      },
    }).quote(quoteParams());

    expect(quote.toAmountMin).to.equal(990_025_000_000_000_000n);
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

  it('retains the original exact-output minimum when fallback switches to exact input', async () => {
    const client = createClient();
    const getAction = sinon.stub(client, 'getAction');
    getAction.onFirstCall().rejects(unsupportedDirection());
    getAction.onSecondCall().resolves(
      actionResponse({
        amountIn: { amount: '1008' },
        amountOut: { amount: '1006' },
        amountOutMin: { amount: '1001' },
      }),
    );
    const provider = providerWithDecimals(6);
    const bridge = createBridge(client, {
      evmProviderFactory: () => provider,
      maxQuoteLossBps: 50,
    });
    const quote = await bridge.quote(
      quoteParams({ fromAmount: undefined, toAmount: 1000n }),
    );
    expect(quote.requestParams.fromAmount).to.equal(1008n);
    expect(quote.toAmountMin).to.equal(1000n);
    getAction.onThirdCall().resolves(
      actionResponse({
        amountIn: { amount: '1008' },
        amountOut: { amount: '1005' },
        amountOutMin: { amount: '999' },
      }),
    );
    expect((await captureError(bridge.prepare(quote))).message).to.include(
      'fresh minimum output',
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
  it('classifies preparation failures as not submitted', async () => {
    const harness = createExecuteHarness();
    harness.getActionStub.rejects(new Error('quote unavailable'));
    const error = await captureError(
      harness.bridge.execute(bridgeQuote(), {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      }),
    );
    assert(
      error instanceof TransactionSubmissionError,
      'Expected submission error',
    );
    expect(error.submissionState).to.equal('not_submitted');
    expect(error.txHash).to.equal(undefined);
    expect(harness.sendTransactionStub.called).to.equal(false);
  });

  for (const value of [undefined, '999999']) {
    it(`rejects missing or insufficient native principal: ${value}`, async () => {
      const harness = createExecuteHarness(
        actionResponse({
          amountIn: { amount: '1000000', address: ZERO_ADDRESS },
          tx: { to: SPENDER, data: '0xdeadbeef', value, chainId: 1 },
        }),
      );
      const error = await captureError(
        harness.bridge.prepare(
          bridgeQuote(quoteParams({ fromToken: ZERO_ADDRESS })),
        ),
      );
      expect(error.message).to.include('below the native token input');
      expect(harness.sendTransactionStub.called).to.equal(false);
    });
  }

  it('allows exact-output native funding below the reserved maximum', async () => {
    const harness = createExecuteHarness(
      actionResponse({
        amountIn: { amount: '900000', address: ZERO_ADDRESS },
        amountInMax: { amount: '1000000' },
        tx: { to: SPENDER, data: '0xdeadbeef', value: '900000', chainId: 1 },
      }),
    );
    await harness.bridge.prepare(
      bridgeQuote(
        quoteParams({
          fromToken: ZERO_ADDRESS,
          fromAmount: undefined,
          toAmount: 990025n,
        }),
      ),
    );
    expect(harness.sendTransactionStub.called).to.equal(false);
  });

  it('accepts repeated adverse drift within the same request loss and slippage budget', async () => {
    const harness = createExecuteHarness(undefined, { maxQuoteLossBps: 50 });
    sinon
      .stub(harness.provider, 'call')
      .resolves(utils.defaultAbiCoder.encode(['uint8'], [6]));
    for (let cycle = 0; cycle < 3; cycle++) {
      const expected = 996_000n - BigInt(cycle);
      harness.getActionStub.resolves(
        actionResponse({
          amountOut: { amount: expected.toString() },
          amountOutMin: { amount: ((expected * 9950n) / 10000n).toString() },
        }),
      );
      const quote = await harness.bridge.quote(quoteParams());
      expect(quote.toAmountMin).to.equal(990_025n);
      const freshExpected = expected - 1n;
      harness.getActionStub.resolves(
        actionResponse({
          amountOut: { amount: freshExpected.toString() },
          amountOutMin: {
            amount: ((freshExpected * 9950n) / 10000n).toString(),
          },
        }),
      );
      await harness.bridge.execute(quote, {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      });
    }
    expect(harness.sendTransactionStub.callCount).to.equal(3);
  });

  it('measures preparation age from the successful retry after earlier timeouts', async () => {
    const clock = sinon.useFakeTimers();
    const harness = createExecuteHarness();
    harness.getActionStub.restore();
    const fetch = sinon.stub(globalThis, 'fetch');
    fetch.onFirstCall().returns(new Promise(() => {}));
    fetch
      .onSecondCall()
      .resolves(new Response(JSON.stringify(actionResponse())));
    const pending = harness.bridge.prepare(bridgeQuote());
    await clock.tickAsync(11_001);
    expect((await pending).preparedAt).to.equal(11_000);
    expect(fetch.callCount).to.equal(2);
  });

  it('does not refresh preparation age when a successful response arrives late', async () => {
    const clock = sinon.useFakeTimers();
    const harness = createExecuteHarness();
    harness.getActionStub.callsFake(
      async (_request: unknown, onAttempt?: (startedAt: number) => void) => {
        onAttempt?.(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 30_001));
        return actionResponse();
      },
    );
    const pending = captureError(harness.bridge.prepare(bridgeQuote()));
    await clock.tickAsync(30_001);
    expect((await pending).message).to.include('expired during preparation');
    expect(harness.sendTransactionStub.called).to.equal(false);
  });

  it('prepares unsigned payloads without approvals or a private key', async () => {
    const harness = createExecuteHarness(
      actionResponse({ requiresTokenApproval: true }),
    );
    const call = sinon.stub(harness.provider, 'call');
    const prepared = await harness.bridge.prepare(bridgeQuote());
    expect(prepared.response.txId).to.equal('tx-1');
    expect(harness.sendTransactionStub.called).to.equal(false);
    expect(call.called).to.equal(false);
  });

  for (const worse of [false, true]) {
    it(`refreshes after a slow approval and ${worse ? 'rejects a worse quote' : 'submits only the refreshed payload'}`, async () => {
      const clock = sinon.useFakeTimers({ toFake: ['Date'] });
      const harness = createExecuteHarness();
      harness.getActionStub
        .onFirstCall()
        .resolves(actionResponse({ requiresTokenApproval: true }));
      harness.getActionStub.onSecondCall().resolves(
        actionResponse({
          txId: 'refreshed',
          ...(worse ? { amountOutMin: { amount: '1' } } : {}),
        }),
      );
      sinon
        .stub(harness.provider, 'call')
        .resolves(utils.defaultAbiCoder.encode(['uint256'], [0]));
      harness.sendTransactionStub.onFirstCall().callsFake(async () => {
        clock.tick(31_000);
        return transactionResponse('0xapproval');
      });
      const execution = harness.bridge.execute(bridgeQuote(), {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      });
      if (worse) {
        expect((await captureError(execution)).message).to.include(
          'below accepted minimum',
        );
        expect(harness.sendTransactionStub.callCount).to.equal(1);
      } else {
        expect((await execution).transferId).to.equal('refreshed');
        expect(harness.sendTransactionStub.callCount).to.equal(2);
      }
      expect(harness.getActionStub.callCount).to.equal(2);
    });
  }

  it('does not refresh or submit again after a lost broadcast response', async () => {
    const harness = createExecuteHarness();
    harness.sendTransactionStub.rejects(new Error('lost broadcast response'));
    expect(
      (
        await captureError(
          harness.bridge.execute(bridgeQuote(), {
            [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
          }),
        )
      ).message,
    ).to.include('lost broadcast response');
    expect(harness.getActionStub.callCount).to.equal(1);
    expect(harness.sendTransactionStub.callCount).to.equal(1);
  });

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
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(result.transferId).to.equal('tx-1');
    expect(result.txHash).to.equal('0xbridge');
    expect(harness.estimateGasStub.callCount).to.equal(1);
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

    await harness.bridge.execute(
      bridgeQuote(quoteParams({ fromAmount: undefined, toAmount: 990025n })),
      {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      },
    );

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

  it('rejects fresh EVM native fees above the configured cap', async () => {
    const harness = createExecuteHarness(
      actionResponse({
        tx: {
          to: SPENDER,
          data: '0xdeadbeef',
          value: '10000000000000001',
          chainId: 1,
        },
      }),
    );

    const error = await captureError(
      harness.bridge.execute(bridgeQuote(), {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include('native fee');
    expect(harness.sendTransactionStub.callCount).to.equal(0);
  });

  it('allows direct provider payloads targeting the source token', async () => {
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

    await harness.bridge.execute(bridgeQuote(), {
      [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
    });

    expect(harness.sendTransactionStub.callCount).to.equal(1);
  });

  it('allows a fresh provider target to differ from the accepted quote', async () => {
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

    await harness.bridge.execute(bridgeQuote(), {
      [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
    });

    expect(harness.sendTransactionStub.callCount).to.equal(1);
  });

  it('allows a fresh provider selector to differ from the accepted quote', async () => {
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

    await harness.bridge.execute(bridgeQuote(), {
      [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
    });

    expect(harness.sendTransactionStub.callCount).to.equal(1);
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

  it('allows bounded native fees on an ERC20 route', async () => {
    const response = actionResponse({
      tx: { to: SPENDER, data: '0xdeadbeef', value: '1', chainId: 1 },
    });
    const acceptedQuote = bridgeQuote();
    acceptedQuote.route = { actionResponse: response };
    const harness = createExecuteHarness(response);

    await harness.bridge.execute(acceptedQuote, {
      [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
    });

    expect(harness.sendTransactionStub.callCount).to.equal(1);
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

  it('rejects exact-out input growth beyond the reserved quote amount', async () => {
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
    expect(error.message).to.include('accepted input cap 1000000');
    expect(harness.sendTransactionStub.called).to.equal(false);
  });

  it('rejects exact-out input growth above the configured cap', async () => {
    const harness = createExecuteHarness(
      actionResponse({
        amountInMax: {
          chainId: 1,
          address: FROM_TOKEN,
          amount: '1005001',
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

  it('rejects refreshed quote loss above the configured maximum', async () => {
    const harness = createExecuteHarness(
      actionResponse({
        amountOut: { amount: '994999', decimals: 6 },
      }),
      { maxQuoteLossBps: 50 },
    );
    sinon
      .stub(harness.provider, 'call')
      .resolves(utils.defaultAbiCoder.encode(['uint8'], [6]));
    const exactOutQuote = bridgeQuote(
      quoteParams({ fromAmount: undefined, toAmount: 994_999n }),
    );

    const error = await captureError(
      harness.bridge.execute(exactOutQuote, {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      }),
    );

    expect(error.message).to.include(
      'quote loss 51 bps exceeds configured maximum 50 bps',
    );
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

  it('prepares and simulates a Solana payload without signing or broadcasting', async () => {
    const harness = createSolanaExecuteHarness();
    const sign = sinon.spy(VersionedTransaction.prototype, 'sign');

    await harness.bridge.prepare(solanaQuote());

    expect(harness.simulateTransactionStub.callCount).to.equal(1);
    expect(sign.called).to.equal(false);
    expect(harness.sendRawTransactionStub.called).to.equal(false);
  });

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
      sigVerify: false,
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

  for (const response of [
    statusResponse('success', { txId: 'different-transfer' }),
    statusResponse('success', { srcTxHash: '0xdifferent-source' }),
  ]) {
    it(`rejects status identity mismatch ${response.txId}/${response.srcTxHash}`, async () => {
      const client = createClient();
      sinon.stub(client, 'getStatus').resolves(response);
      expect(
        await createBridge(client).getStatus('0xsource', 1, 8453, 'tx-1'),
      ).to.deep.equal({ status: 'not_found' });
    });
  }

  it('requires a known transfer ID or source hash to complete', async () => {
    const client = createClient();
    sinon
      .stub(client, 'getStatus')
      .resolves(statusResponse('success', { srcTxHash: undefined }));
    const bridge = createBridge(client);
    expect((await bridge.getStatus('0xsource', 1, 8453)).status).to.equal(
      'pending',
    );
    expect(
      (await bridge.getStatus('0xsource', 1, 8453, 'tx-1')).status,
    ).to.equal('complete');
  });

  it('normalizes hexadecimal source identities', async () => {
    const client = createClient();
    sinon
      .stub(client, 'getStatus')
      .resolves(statusResponse('success', { srcTxHash: 'ABCDEF' }));
    expect(
      (await createBridge(client).getStatus('0xabcdef', 1, 8453)).status,
    ).to.equal('complete');
  });

  it('requires a destination transaction for completed statuses', async () => {
    const client = createClient();
    const getStatusStub = sinon.stub(client, 'getStatus');
    getStatusStub.onFirstCall().resolves(statusResponse('success'));
    getStatusStub.onSecondCall().resolves(
      statusResponse('completed', {
        srcTxHash: '0xsource2',
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
      status: 'pending',
      substatus: 'completed',
    });
    expect(getStatusStub.firstCall.args[0]).to.deep.equal({
      txHash: '0xsource',
      chainId: 1,
    });
  });

  it('keeps a completed status pending until route identity is available', async () => {
    const client = createClient();
    sinon
      .stub(client, 'getStatus')
      .resolves(statusResponse('success', { dstChainId: null }));

    const result = await createBridge(client).getStatus('0xsource', 1, 8453);

    expect(result).to.deep.equal({ status: 'pending', substatus: 'success' });
  });

  it('retries persisted transaction registration after explicit status not-found', async () => {
    const client = createClient();
    const getStatusStub = sinon.stub(client, 'getStatus');
    getStatusStub
      .onFirstCall()
      .rejects(new SwapsXyzRequestError('not registered', 404, 'Not Found'));
    getStatusStub
      .onSecondCall()
      .resolves(statusResponse('success', { txId: 'persisted-transfer-id' }));
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

  for (const status of [401, 403]) {
    it(`does not register after HTTP ${status}, even with a not-found error code`, async () => {
      const fetch = sinon
        .stub(globalThis, 'fetch')
        .callsFake(async () =>
          apiResponse({ error: { code: 'NOT_FOUND' } }, status),
        );

      const error = await captureError(
        createBridge(createClient()).getStatus('0xsource', 1, 8453, 'tx-1'),
      );

      expect(error).to.be.instanceOf(SwapsXyzRequestError);
      expect(fetch.callCount).to.equal(1);
      expect(fetch.firstCall.args[1]?.method).to.equal('GET');
    });
  }

  it('does not amplify a status outage into registration requests', async () => {
    const clock = sinon.useFakeTimers();
    const fetch = sinon
      .stub(globalThis, 'fetch')
      .callsFake(async () =>
        apiResponse({ error: { code: 'NOT_FOUND' } }, 503),
      );
    const result = captureError(
      createBridge(createClient()).getStatus('0xsource', 1, 8453, 'tx-1'),
    );

    await clock.runAllAsync();

    expect(await result).to.be.instanceOf(SwapsXyzRequestError);
    expect(fetch.callCount).to.equal(3);
    expect(fetch.getCalls().map((call) => call.args[1]?.method)).to.deep.equal([
      'GET',
      'GET',
      'GET',
    ]);
    expect(clock.now).to.equal(3_000);
  });

  it('does not register after a status network error or malformed response', async () => {
    const clock = sinon.useFakeTimers();
    const fetch = sinon.stub(globalThis, 'fetch').rejects(new Error('offline'));
    const bridge = createBridge(createClient());
    const outage = captureError(bridge.getStatus('0xsource', 1, 8453, 'tx-1'));
    await clock.runAllAsync();
    expect((await outage).message).to.equal('offline');
    expect(fetch.callCount).to.equal(3);

    fetch.resetHistory();
    fetch.resolves(apiResponse({}));
    const malformed = await captureError(
      bridge.getStatus('0xsource', 1, 8453, 'tx-1'),
    );
    expect(malformed.message).to.include('Invalid swaps.xyz response');
    expect(fetch.callCount).to.equal(1);
    expect(fetch.firstCall.args[1]?.method).to.equal('GET');
  });

  for (const seconds of [1, 120]) {
    it(`preserves the single registration budget and rate-limit cooldown: ${seconds}s`, async () => {
      const clock = sinon.useFakeTimers();
      const fetch = sinon.stub(globalThis, 'fetch');
      fetch.onFirstCall().resolves(apiResponse({}, 404));
      fetch.callsFake(
        async () =>
          new Response('{}', {
            status: 429,
            headers: { 'retry-after': String(seconds) },
          }),
      );
      const bridge = createBridge(createClient(), {
        registerTxRetryDelayMs: 10,
      });
      const result = bridge.getStatus('0xsource', 1, 8453, 'tx-1');
      await clock.runAllAsync();
      expect(await result).to.deep.equal({ status: 'not_found' });
      expect(
        fetch.getCalls().filter((call) => call.args[1]?.method === 'POST')
          .length,
      ).to.equal(seconds === 1 ? 3 : 1);
      if (seconds === 120) {
        const error = await captureError(
          bridge.getStatus('0xsource', 1, 8453, 'tx-1'),
        );
        expect(error.message).to.include('cooldown');
        expect(fetch.callCount).to.equal(2);
        expect(clock.now).to.equal(0);
      } else {
        expect(clock.now).to.equal(2_000);
      }
    });
  }

  it('caps registration HTTP failures at three POSTs using the configured delay', async () => {
    const clock = sinon.useFakeTimers();
    const fetch = sinon.stub(globalThis, 'fetch');
    fetch.onFirstCall().resolves(apiResponse({}, 404));
    fetch.callsFake(async () => apiResponse({}, 503));
    const result = createBridge(createClient(), {
      registerTxRetryDelayMs: 10,
    }).getStatus('0xsource', 1, 8453, 'tx-1');

    await clock.runAllAsync();

    expect(await result).to.deep.equal({ status: 'not_found' });
    expect(fetch.getCalls().map((call) => call.args[1]?.method)).to.deep.equal([
      'GET',
      'POST',
      'POST',
      'POST',
    ]);
    expect(clock.now).to.equal(30);
  });

  it('shares one registration budget across HTTP and unsuccessful API results', async () => {
    const clock = sinon.useFakeTimers();
    const fetch = sinon.stub(globalThis, 'fetch');
    fetch.onCall(0).resolves(apiResponse({}, 404));
    fetch
      .onCall(1)
      .resolves(
        apiResponse([{ success: false, error: 'indexer unavailable' }]),
      );
    fetch.onCall(2).resolves(apiResponse({}, 503));
    fetch.onCall(3).resolves(apiResponse([{ success: true }]));
    fetch.onCall(4).resolves(apiResponse(statusResponse('pending')));
    const result = createBridge(createClient(), {
      registerTxRetryDelayMs: 10,
    }).getStatus('0xsource', 1, 8453, 'tx-1');

    await clock.runAllAsync();

    expect((await result).status).to.equal('pending');
    expect(fetch.getCalls().map((call) => call.args[1]?.method)).to.deep.equal([
      'GET',
      'POST',
      'POST',
      'POST',
      'GET',
    ]);
    expect(clock.now).to.equal(30);
  });

  for (const registration of [
    { name: 'unauthorized', status: 401, body: {} },
    { name: 'forbidden', status: 403, body: {} },
    { name: 'malformed', status: 200, body: {} },
  ]) {
    it(`stops ${registration.name} registration failures after one POST`, async () => {
      const clock = sinon.useFakeTimers();
      const fetch = sinon.stub(globalThis, 'fetch');
      fetch.onFirstCall().resolves(apiResponse({}, 404));
      fetch
        .onSecondCall()
        .resolves(apiResponse(registration.body, registration.status));
      const result = await createBridge(createClient()).getStatus(
        '0xsource',
        1,
        8453,
        'tx-1',
      );

      expect(result).to.deep.equal({ status: 'not_found' });
      expect(
        fetch.getCalls().map((call) => call.args[1]?.method),
      ).to.deep.equal(['GET', 'POST']);
      expect(clock.now).to.equal(0);
    });
  }

  for (const missing of [
    {
      name: 'not yet created',
      status: 200,
      body: statusResponse('not yet created'),
    },
    { name: 'NOT_FOUND', status: 400, body: { error: { code: 'NOT_FOUND' } } },
    {
      name: 'TX_NOT_FOUND',
      status: 400,
      body: { error: { code: 'TX_NOT_FOUND' } },
    },
    {
      name: 'TRANSACTION_NOT_FOUND',
      status: 400,
      body: { error: { code: 'TRANSACTION_NOT_FOUND' } },
    },
  ]) {
    it(`recovers explicit ${missing.name} statuses with registration`, async () => {
      const fetch = sinon.stub(globalThis, 'fetch');
      fetch.onFirstCall().resolves(apiResponse(missing.body, missing.status));
      fetch.onSecondCall().resolves(apiResponse([{ success: true }]));
      fetch.onThirdCall().resolves(apiResponse(statusResponse('pending')));

      const result = await createBridge(createClient()).getStatus(
        '0xsource',
        1,
        8453,
        'tx-1',
      );

      expect(result.status).to.equal('pending');
      expect(
        fetch.getCalls().map((call) => call.args[1]?.method),
      ).to.deep.equal(['GET', 'POST', 'GET']);
    });
  }
});
