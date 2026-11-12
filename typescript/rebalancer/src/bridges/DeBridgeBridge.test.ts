import { createHash } from 'node:crypto';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  MintLayout,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { expect } from 'chai';
import { ethers } from 'ethers';
import { pino } from 'pino';
import sinon from 'sinon';

import { ChainDisabledReason, ChainStatus } from '@hyperlane-xyz/sdk';
import {
  TronJsonRpcProvider,
  TronWallet,
} from '@hyperlane-xyz/tron-sdk/runtime';
import {
  ProtocolType,
  TransactionSubmissionError,
  assert,
} from '@hyperlane-xyz/utils';

import type {
  BridgeQuote,
  BridgeQuoteParams,
} from '../interfaces/IExternalBridge.js';
import { DeBridgeBridge, type DeBridgeBridgeConfig } from './DeBridgeBridge.js';
import { DLN_EVENTS, type DlnOrder, dlnOrderId } from './deBridgeSettlement.js';
import {
  DLN_EVM_SOURCE,
  DLN_TRON_SOURCE,
  DLN_SOLANA_SOURCE,
  DLN_SOURCE_INTERFACE,
  deBridgeAddressBytes,
} from './deBridgeValidation.js';
import {
  DEBRIDGE_SOLANA_CHAIN_ID,
  DEBRIDGE_TRON_CHAIN_ID,
  type DeBridgeCreateTxResponse,
  type DeBridgeQuoteResponse,
  formatAddressForDebridge,
  hyperlaneChainIdToDebridge,
} from './deBridgeUtils.js';

const logger = pino({ level: 'silent' });
const PRIVATE_KEY = ethers.utils.id('deBridge test signer');
const OTHER_PRIVATE_KEY = ethers.utils.id('different deBridge test signer');
const SIGNER_ADDRESS = new ethers.Wallet(PRIVATE_KEY).address;
const BSC_USDT = '0x55d398326f99059fF775485246999027B3197955';
const DLN_FORWARDER = '0x663DC15D3C1aC63ff12E45Ab68FeA3F0a883C251';
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const SOLANA_USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const OTHER_ORDER_ID = `0x${'b'.repeat(64)}`;
const DESTINATION_TX_HASH = `0x${'c'.repeat(64)}`;
const DLN_SOURCE = DLN_EVM_SOURCE;
const SOURCE_AMOUNT = 1_000_000_000_000_000_000_000n;
const DESTINATION_AMOUNT = 996_000_000n;
const FIX_FEE = 5_000_000_000_000_000n;

const SOURCE_TX_HASH = ethers.utils.id('deBridge source transaction');
function settlementOrder(): DlnOrder {
  return {
    makerOrderNonce: 1n,
    makerSrc: SIGNER_ADDRESS.toLowerCase(),
    giveChainId: 56n,
    giveTokenAddress: BSC_USDT.toLowerCase(),
    giveAmount: SOURCE_AMOUNT,
    takeChainId: BigInt(DEBRIDGE_TRON_CHAIN_ID),
    takeTokenAddress: deBridgeAddressBytes(TRON_USDT, 728126428),
    takeAmount: DESTINATION_AMOUNT,
    receiverDst: SIGNER_ADDRESS.toLowerCase(),
    givePatchAuthoritySrc: SIGNER_ADDRESS.toLowerCase(),
    orderAuthorityAddressDst: SIGNER_ADDRESS.toLowerCase(),
    allowedTakerDst: '0x',
    allowedCancelBeneficiarySrc: SIGNER_ADDRESS.toLowerCase(),
    externalCall: '0x',
  };
}
const ORDER_ID = dlnOrderId(settlementOrder());

const BRIDGE_CONFIG: DeBridgeBridgeConfig = {
  maxFeeBps: 50,
  chainMetadata: {
    bsc: {
      chainId: 56,
      name: 'bsc',
      domainId: 56,
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: 'https://bsc-rpc.example.com' }],
    },
    tron: {
      chainId: 728126428,
      name: 'tron',
      domainId: 728126428,
      protocol: ProtocolType.Tron,
      rpcUrls: [{ http: 'https://api.trongrid.io' }],
    },
    solana: {
      chainId: 1399811149,
      name: 'solanamainnet',
      domainId: 1399811149,
      protocol: ProtocolType.Sealevel,
      rpcUrls: [{ http: 'https://api.mainnet-beta.solana.com' }],
    },
  },
};

const BSC_TO_TRON_PARAMS: BridgeQuoteParams = {
  fromChain: 56,
  toChain: 728126428,
  fromToken: BSC_USDT,
  toToken: TRON_USDT,
  fromAmount: SOURCE_AMOUNT,
  fromAddress: SIGNER_ADDRESS,
  toAddress: formatAddressForDebridge(SIGNER_ADDRESS, DEBRIDGE_TRON_CHAIN_ID),
};

describe('DeBridgeBridge constructor', () => {
  it('ignores duplicate chain IDs for disabled metadata', () => {
    const disabledMetadata = {
      ...BRIDGE_CONFIG.chainMetadata!.bsc,
      chainId: 41455,
      availability: {
        status: ChainStatus.Disabled,
        reasons: [ChainDisabledReason.Deprecated],
      },
    };

    expect(
      () =>
        new DeBridgeBridge(
          {
            ...BRIDGE_CONFIG,
            chainMetadata: {
              ...BRIDGE_CONFIG.chainMetadata,
              disabledA: {
                ...disabledMetadata,
                name: 'disabledA',
                domainId: 41455,
              },
              disabledB: {
                ...disabledMetadata,
                name: 'disabledB',
                domainId: 1000041455,
              },
            },
          },
          logger,
        ),
    ).not.to.throw();
  });
});

function makeSolanaParams(signer: Keypair): BridgeQuoteParams {
  return {
    fromChain: 1399811149,
    toChain: 56,
    fromToken: SOLANA_USDT,
    toToken: BSC_USDT,
    fromAmount: 1_000_000_000n,
    fromAddress: signer.publicKey.toBase58(),
    toAddress: SIGNER_ADDRESS,
  };
}

function makeSolanaQuoteResponse(): DeBridgeQuoteResponse {
  return {
    estimation: {
      srcChainTokenIn: {
        chainId: DEBRIDGE_SOLANA_CHAIN_ID,
        address: SOLANA_USDT,
        name: 'Tether USD',
        symbol: 'USDT',
        decimals: 6,
        amount: '1000000000',
      },
      dstChainTokenOut: {
        chainId: 56,
        address: BSC_USDT,
        name: 'Tether USD',
        symbol: 'USDT',
        decimals: 18,
        amount: '996000000000000000000',
      },
    },
    fixFee: '0',
    protocolFee: '0',
  };
}

function makeSolanaOrderInstruction(payer: Keypair): TransactionInstruction {
  const vector = (value: Uint8Array) => {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(value.length);
    return Buffer.concat([length, value]);
  };
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(1_000_000_000n);
  const word = (value: bigint) =>
    Buffer.from(
      ethers.utils.arrayify(
        ethers.utils.hexZeroPad(ethers.utils.hexlify(value), 32),
      ),
    );
  const target = ethers.utils.arrayify(BSC_USDT);
  const receiver = ethers.utils.arrayify(SIGNER_ADDRESS);
  const accounts = Array.from(
    { length: 12 },
    () => Keypair.generate().publicKey,
  );
  accounts[0] = payer.publicKey;
  accounts[2] = new PublicKey(SOLANA_USDT);
  accounts[5] = getAssociatedTokenAddressSync(accounts[2], payer.publicKey);
  accounts[9] = SystemProgram.programId;
  accounts[10] = TOKEN_PROGRAM_ID;
  accounts[11] = ASSOCIATED_TOKEN_PROGRAM_ID;
  return new TransactionInstruction({
    programId: DLN_SOLANA_SOURCE,
    keys: accounts.map((pubkey, index) => ({
      pubkey,
      isSigner: index === 0,
      isWritable: [0, 3, 5, 6, 7, 8].includes(index),
    })),
    data: Buffer.concat([
      createHash('sha256')
        .update('global:create_order')
        .digest()
        .subarray(0, 8),
      amount,
      word(56n),
      vector(target),
      word(996_000_000_000_000_000_000n),
      vector(receiver),
      Buffer.from([0]),
      payer.publicKey.toBuffer(),
      Buffer.from([1]),
      payer.publicKey.toBuffer(),
      vector(receiver),
      Buffer.from([0, 0, 0]),
    ]),
  });
}

function makeSerializedSolanaTransaction(
  payer: Keypair,
  instructions = [makeSolanaOrderInstruction(payer)],
): string {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
    instructions,
  }).compileToV0Message();
  return `0x${Buffer.from(new VersionedTransaction(message).serialize()).toString('hex')}`;
}

function makeEvmOrderData(
  params = BSC_TO_TRON_PARAMS,
  amountOut = DESTINATION_AMOUNT,
  overrides: Record<string, unknown> = {},
): string {
  assert(
    params.toAddress && params.fromAmount,
    'Test order requires input and recipient',
  );
  return DLN_SOURCE_INTERFACE.encodeFunctionData('createSaltedOrder', [
    {
      giveTokenAddress: deBridgeAddressBytes(
        params.fromToken,
        params.fromChain,
      ),
      giveAmount: params.fromAmount,
      takeTokenAddress: deBridgeAddressBytes(params.toToken, params.toChain),
      takeAmount: amountOut,
      takeChainId: hyperlaneChainIdToDebridge(params.toChain),
      receiverDst: deBridgeAddressBytes(params.toAddress, params.toChain),
      givePatchAuthoritySrc: deBridgeAddressBytes(
        params.fromAddress,
        params.fromChain,
      ),
      orderAuthorityAddressDst: deBridgeAddressBytes(
        params.toAddress,
        params.toChain,
      ),
      allowedTakerDst: '0x',
      externalCall: '0x',
      allowedCancelBeneficiarySrc: deBridgeAddressBytes(
        params.fromAddress,
        params.fromChain,
      ),
      ...overrides,
    },
    123,
    '0x',
    0,
    '0x',
    '0x',
  ]);
}

function makeQuoteResponse(
  sourceAmount = SOURCE_AMOUNT,
  destinationAmount = DESTINATION_AMOUNT,
): DeBridgeQuoteResponse {
  return {
    estimation: {
      srcChainTokenIn: {
        chainId: 56,
        address: BSC_USDT.toLowerCase(),
        name: 'Tether USD',
        symbol: 'USDT',
        decimals: 18,
        amount: sourceAmount.toString(),
      },
      dstChainTokenOut: {
        chainId: DEBRIDGE_TRON_CHAIN_ID,
        address: TRON_USDT,
        name: 'Tether USD',
        symbol: 'USDT',
        decimals: 6,
        amount: destinationAmount.toString(),
      },
    },
    fixFee: FIX_FEE.toString(),
    protocolFee: '0',
  };
}

function makeCreateTxResponse(): DeBridgeCreateTxResponse {
  return {
    ...makeQuoteResponse(),
    orderId: ORDER_ID,
    fixFee: FIX_FEE.toString(),
    tx: {
      to: DLN_SOURCE,
      data: makeEvmOrderData(),
      value: FIX_FEE.toString(),
    },
  };
}

function makeBridgeQuote(
  params: BridgeQuoteParams,
  response: DeBridgeQuoteResponse,
): BridgeQuote {
  return {
    id: 'quote-id',
    tool: 'debridge',
    fromAmount: BigInt(response.estimation.srcChainTokenIn.amount),
    toAmount: BigInt(response.estimation.dstChainTokenOut.amount),
    toAmountMin: BigInt(response.estimation.dstChainTokenOut.amount),
    executionDuration: 60,
    gasCosts: 0n,
    feeCosts: 0n,
    route: response,
    requestParams: params,
  };
}

function makeTransferIdentity(
  params = BSC_TO_TRON_PARAMS,
  orderId = ORDER_ID,
  minimumAmount = DESTINATION_AMOUNT,
): string {
  assert(params.toAddress, 'Fixture requires a destination recipient');
  return JSON.stringify({
    version: 1,
    orderId: orderId.toLowerCase(),
    fromChain: params.fromChain,
    toChain: params.toChain,
    token: deBridgeAddressBytes(params.toToken, params.toChain),
    recipient: deBridgeAddressBytes(params.toAddress, params.toChain),
    minimumAmount: minimumAmount.toString(),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function getRejection(promise: Promise<unknown>): Promise<Error> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof Error, 'Expected promise to reject with an Error');
  return caught;
}

interface CapturedTransaction {
  to?: string;
  data: string;
  value: ethers.BigNumber;
}

function makeTransactionResponse(
  transaction: CapturedTransaction,
  hash: string,
): ethers.providers.TransactionResponse {
  const receipt: ethers.providers.TransactionReceipt = {
    to: transaction.to ?? ethers.constants.AddressZero,
    from: SIGNER_ADDRESS,
    contractAddress: ethers.constants.AddressZero,
    transactionIndex: 0,
    gasUsed: ethers.constants.Zero,
    logsBloom: `0x${'0'.repeat(512)}`,
    blockHash: `0x${'d'.repeat(64)}`,
    transactionHash: hash,
    logs: [],
    blockNumber: 1,
    confirmations: 1,
    cumulativeGasUsed: ethers.constants.Zero,
    effectiveGasPrice: ethers.constants.Zero,
    byzantium: true,
    type: 0,
    status: 1,
  };
  return {
    hash,
    confirmations: 0,
    from: SIGNER_ADDRESS,
    to: transaction.to,
    nonce: 0,
    gasLimit: ethers.constants.Zero,
    gasPrice: ethers.constants.Zero,
    data: transaction.data,
    value: transaction.value,
    chainId: 56,
    wait: async () => receipt,
  };
}

describe('deBridge utilities', function () {
  it('maps all production route chain IDs', () => {
    expect(hyperlaneChainIdToDebridge(1)).to.equal(1);
    expect(hyperlaneChainIdToDebridge(56)).to.equal(56);
    expect(hyperlaneChainIdToDebridge(42161)).to.equal(42161);
    expect(hyperlaneChainIdToDebridge(728126428)).to.equal(
      DEBRIDGE_TRON_CHAIN_ID,
    );
    expect(hyperlaneChainIdToDebridge(1399811149)).to.equal(
      DEBRIDGE_SOLANA_CHAIN_ID,
    );
  });

  it('converts and validates Tron addresses', async () => {
    const expected = 'TFdFSWMovbz9PSKm6skvV4RCxuXq3nepo5';
    expect(
      formatAddressForDebridge(
        '0x3e0A78A330F2b97059A4D507ca9d8292b65B6FB5',
        DEBRIDGE_TRON_CHAIN_ID,
      ),
    ).to.equal(expected);
    expect(
      formatAddressForDebridge(
        '0x413e0A78A330F2b97059A4D507ca9d8292b65B6FB5',
        DEBRIDGE_TRON_CHAIN_ID,
      ),
    ).to.equal(expected);
    expect(
      formatAddressForDebridge(
        '413e0A78A330F2b97059A4D507ca9d8292b65B6FB5',
        DEBRIDGE_TRON_CHAIN_ID,
      ),
    ).to.equal(expected);
    const error = await getRejection(
      Promise.resolve().then(() =>
        formatAddressForDebridge(
          'TFdFSWMovbz9PSKm6skvV4RCxuXq3nepo4',
          DEBRIDGE_TRON_CHAIN_ID,
        ),
      ),
    );
    expect(error.message).to.include('checksum');
  });

  it('rejects unsupported chains', async () => {
    for (const chainId of [9745, 99999]) {
      const error = await getRejection(
        Promise.resolve().then(() => hyperlaneChainIdToDebridge(chainId)),
      );
      expect(error.message).to.include('not supported');
    }
  });
});

describe('DeBridgeBridge.quote', function () {
  beforeEach(() => {
    sinon
      .stub(ethers.providers.StaticJsonRpcProvider.prototype, 'call')
      .callsFake((tx) => chainRead(tx));
    sinon
      .stub(TronJsonRpcProvider.prototype, 'call')
      .callsFake((tx) => chainRead(tx));
  });
  afterEach(() => sinon.restore());

  it('rejects quote decimals that disagree with chain data', async () => {
    const response = makeQuoteResponse();
    response.estimation.srcChainTokenIn.decimals++;
    sinon.stub(globalThis, 'fetch').resolves(jsonResponse(response));
    const error = await getRejection(
      new DeBridgeBridge(BRIDGE_CONFIG, logger).quote(BSC_TO_TRON_PARAMS),
    );
    expect(error.message).to.include('decimals do not match chain data');
  });

  it('bounds a stalled response body independently of abort propagation', async () => {
    const clock = sinon.useFakeTimers();
    let aborted = 0;
    const fetch = sinon.stub(globalThis, 'fetch').callsFake(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start() {
              init?.signal?.addEventListener('abort', () => {
                aborted++;
              });
            },
          }),
        ),
    );
    const result = getRejection(
      new DeBridgeBridge(BRIDGE_CONFIG, logger).quote(BSC_TO_TRON_PARAMS),
    );
    await clock.runAllAsync();
    expect((await result).message).to.include('HTTP request timed out');
    expect(fetch.callCount).to.equal(3);
    expect(aborted).to.equal(3);
  });

  it('does not retry a permanent HTTP status when its error body stalls', async () => {
    const clock = sinon.useFakeTimers();
    const fetch = sinon.stub(globalThis, 'fetch').resolves(
      new Response(new ReadableStream(), {
        status: 401,
        statusText: 'Unauthorized',
      }),
    );
    const result = getRejection(
      new DeBridgeBridge(BRIDGE_CONFIG, logger).quote(BSC_TO_TRON_PARAMS),
    );

    await clock.runAllAsync();

    expect((await result).message).to.include('HTTP 401: Unauthorized');
    expect(fetch.callCount).to.equal(1);
  });

  it('does not retry permanent HTTP errors', async () => {
    const fetch = sinon
      .stub(globalThis, 'fetch')
      .resolves(jsonResponse({ error: 'invalid request' }, 400));
    const error = await getRejection(
      new DeBridgeBridge(BRIDGE_CONFIG, logger).quote(BSC_TO_TRON_PARAMS),
    );
    expect(error.message).to.include('HTTP 400');
    expect(fetch.calledOnce).to.equal(true);
  });

  it('advertises native EVM assets and rejects native SOL before fetching', async () => {
    const fetch = sinon.stub(globalThis, 'fetch');
    const bridge = new DeBridgeBridge(BRIDGE_CONFIG, logger);
    expect(bridge.getNativeTokenAddress()).to.equal(
      ethers.constants.AddressZero,
    );
    const error = await getRejection(
      bridge.quote({
        ...makeSolanaParams(Keypair.generate()),
        fromToken: bridge.getNativeTokenAddress(),
      }),
    );
    expect(error.message).to.include('native SOL is not supported');
    expect(fetch.called).to.equal(false);
  });

  it('normalizes decimals for its fee guard and URL-encodes the request', async () => {
    let calledUrl = '';
    sinon.stub(globalThis, 'fetch').callsFake(async (input) => {
      calledUrl = String(input);
      return jsonResponse(makeQuoteResponse());
    });

    const quote = await new DeBridgeBridge(BRIDGE_CONFIG, logger).quote(
      BSC_TO_TRON_PARAMS,
    );

    expect(quote.fromAmount).to.equal(SOURCE_AMOUNT);
    expect(quote.toAmount).to.equal(DESTINATION_AMOUNT);
    const url = new URL(calledUrl);
    expect(url.pathname).to.equal('/v1.0/dln/order/quote');
    expect(url.searchParams.get('srcChainId')).to.equal('56');
    expect(url.searchParams.get('dstChainId')).to.equal('100000026');
    expect(url.searchParams.get('dstChainTokenOut')).to.equal(TRON_USDT);
  });

  it('accepts 50 bps and rejects 51 bps', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    fetchStub
      .onFirstCall()
      .resolves(jsonResponse(makeQuoteResponse(SOURCE_AMOUNT, 995_000_000n)));
    fetchStub
      .onSecondCall()
      .resolves(jsonResponse(makeQuoteResponse(SOURCE_AMOUNT, 994_900_000n)));

    await new DeBridgeBridge(BRIDGE_CONFIG, logger).quote(BSC_TO_TRON_PARAMS);

    const error = await getRejection(
      new DeBridgeBridge(BRIDGE_CONFIG, logger).quote(BSC_TO_TRON_PARAMS),
    );
    expect(error.message).to.include('51 bps');
  });

  it('rejects a quote far above maxFeeBps', async () => {
    sinon
      .stub(globalThis, 'fetch')
      .resolves(jsonResponse(makeQuoteResponse(SOURCE_AMOUNT, 900_000_000n)));

    const error = await getRejection(
      new DeBridgeBridge(BRIDGE_CONFIG, logger).quote(BSC_TO_TRON_PARAMS),
    );
    expect(error.message).to.include('fee too high');
  });

  it('rejects malformed and mismatched responses', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    fetchStub.onFirstCall().resolves(jsonResponse({ estimation: {} }));
    fetchStub.onSecondCall().resolves(
      jsonResponse({
        ...makeQuoteResponse(),
        estimation: {
          ...makeQuoteResponse().estimation,
          srcChainTokenIn: {
            ...makeQuoteResponse().estimation.srcChainTokenIn,
            chainId: 1,
          },
        },
      }),
    );

    const bridge = new DeBridgeBridge(BRIDGE_CONFIG, logger);
    const malformedError = await getRejection(bridge.quote(BSC_TO_TRON_PARAMS));
    expect(malformedError.message).to.include('estimation');
    const mismatchedError = await getRejection(
      bridge.quote(BSC_TO_TRON_PARAMS),
    );
    expect(mismatchedError.message).to.include('source chain');
  });

  it('surfaces structured API errors', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      jsonResponse({
        errorCode: 12,
        errorId: 'ERROR_LOW_GIVE_AMOUNT',
        errorMessage: 'Amount is too low',
      }),
    );

    const error = await getRejection(
      new DeBridgeBridge(BRIDGE_CONFIG, logger).quote(BSC_TO_TRON_PARAMS),
    );
    expect(error.message).to.include(
      'ERROR_LOW_GIVE_AMOUNT: Amount is too low',
    );
  });

  it('validates exact-input/exact-output invariants before fetching', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    const bridge = new DeBridgeBridge(BRIDGE_CONFIG, logger);

    const conflictingAmountError = await getRejection(
      bridge.quote({
        ...BSC_TO_TRON_PARAMS,
        toAmount: DESTINATION_AMOUNT,
      }),
    );
    expect(conflictingAmountError.message).to.include('Cannot specify both');
    const missingAmountError = await getRejection(
      bridge.quote({
        ...BSC_TO_TRON_PARAMS,
        fromAmount: undefined,
      }),
    );
    expect(missingAmountError.message).to.include('Must specify either');
    expect(fetchStub.called).to.equal(false);
  });
});

async function chainRead(
  request: Parameters<ethers.providers.Provider['call']>[0],
  allowance = 0n,
): Promise<string> {
  const data = ethers.utils.hexlify((await request.data) ?? '0x');
  const address = String(await request.to).toLowerCase();
  let result: ethers.BigNumberish = allowance;
  if (data === ethers.utils.id('decimals()').slice(0, 10))
    result = address === BSC_USDT.toLowerCase() ? 18 : 6;
  return ethers.utils.defaultAbiCoder.encode(['uint256'], [result]);
}

function stubMint(): sinon.SinonStub {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 1_000_000_000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return sinon.stub(Connection.prototype, 'getAccountInfo').resolves({
    executable: false,
    owner: TOKEN_PROGRAM_ID,
    lamports: 1_000_000,
    data,
  });
}

describe('DeBridgeBridge.execute', function () {
  let callStub: sinon.SinonStub;
  beforeEach(() => {
    sinon
      .stub(ethers.Wallet.prototype, 'populateTransaction')
      .callsFake(async (tx) => ({
        ...(await ethers.utils.resolveProperties(tx)),
        chainId: 56,
        nonce: 0,
        gasLimit: ethers.BigNumber.from(100_000),
        gasPrice: ethers.BigNumber.from(1),
        type: 0,
      }));
    sinon
      .stub(ethers.providers.StaticJsonRpcProvider.prototype, 'sendTransaction')
      .callsFake(async (signed) => {
        const bytes = await signed;
        const tx = ethers.utils.parseTransaction(bytes);
        // Keep each test's broadcast behavior while exercising local signing.
        const result = await new ethers.Wallet(PRIVATE_KEY).sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value,
        });
        return { ...result, hash: ethers.utils.keccak256(bytes) };
      });
    callStub = sinon
      .stub(ethers.providers.StaticJsonRpcProvider.prototype, 'call')
      .callsFake((tx) => chainRead(tx));
    sinon
      .stub(TronJsonRpcProvider.prototype, 'call')
      .callsFake((tx) => chainRead(tx));
    stubMint();
    sinon
      .stub(ethers.providers.StaticJsonRpcProvider.prototype, 'estimateGas')
      .resolves(ethers.BigNumber.from(250_000));
    sinon
      .stub(TronJsonRpcProvider.prototype, 'estimateGas')
      .resolves(ethers.BigNumber.from(250_000));
    sinon.stub(Connection.prototype, 'getFeeForMessage').resolves({
      context: { slot: 1 },
      value: 5_000,
    });
    sinon.stub(Connection.prototype, 'simulateTransaction').resolves({
      context: { slot: 1 },
      value: {
        err: null,
        logs: [],
        accounts: null,
        unitsConsumed: 1,
        returnData: null,
        innerInstructions: null,
      },
    });
  });
  afterEach(() => sinon.restore());

  it('prepares a validated unsigned order without a key, allowance read, approval or broadcast', async () => {
    const response = makeCreateTxResponse();
    sinon.stub(globalThis, 'fetch').resolves(jsonResponse(response));
    const send = sinon.stub(ethers.Wallet.prototype, 'sendTransaction');
    const result = await new DeBridgeBridge(BRIDGE_CONFIG, logger).prepare(
      makeBridgeQuote(BSC_TO_TRON_PARAMS, makeQuoteResponse()),
    );
    expect(result.response).to.deep.equal(response);
    expect(send.called).to.equal(false);
    for (const call of callStub.getCalls()) {
      expect(await call.args[0].data).not.to.equal(
        ethers.utils.id('allowance(address,address)').slice(0, 10),
      );
    }
  });

  it('preserves a fixed request budget across small adverse quote changes', async () => {
    const fetch = sinon.stub(globalThis, 'fetch');
    fetch.onFirstCall().resolves(jsonResponse(makeQuoteResponse()));
    const bridge = new DeBridgeBridge(BRIDGE_CONFIG, logger);
    const quote = await bridge.quote(BSC_TO_TRON_PARAMS);
    expect(quote.toAmountMin).to.equal(995_000_000n);
    const refreshed = makeCreateTxResponse();
    refreshed.estimation.dstChainTokenOut.amount = (
      DESTINATION_AMOUNT - 1n
    ).toString();
    fetch.onSecondCall().resolves(jsonResponse(refreshed));
    const prepared = await bridge.prepare(quote);
    expect(prepared.transferId).to.equal(
      makeTransferIdentity(BSC_TO_TRON_PARAMS, ORDER_ID, 995_000_000n),
    );
    refreshed.estimation.dstChainTokenOut.amount = '994999999';
    fetch.onThirdCall().resolves(jsonResponse(refreshed));
    expect((await getRejection(bridge.prepare(quote))).message).to.include(
      'below required',
    );
  });

  it('keeps the original exact-output target above the economic floor', async () => {
    sinon.stub(globalThis, 'fetch').resolves(jsonResponse(makeQuoteResponse()));
    const quote = await new DeBridgeBridge(BRIDGE_CONFIG, logger).quote({
      ...BSC_TO_TRON_PARAMS,
      fromAmount: undefined,
      toAmount: DESTINATION_AMOUNT,
    });
    expect(quote.toAmountMin).to.equal(DESTINATION_AMOUNT);
  });

  it('dates a successful retry from its own request start after a full timeout', async () => {
    const clock = sinon.useFakeTimers();
    const fetch = sinon.stub(globalThis, 'fetch');
    fetch.onFirstCall().returns(new Promise(() => {}));
    fetch.onSecondCall().resolves(jsonResponse(makeCreateTxResponse()));
    const pending = new DeBridgeBridge(BRIDGE_CONFIG, logger).prepare(
      makeBridgeQuote(BSC_TO_TRON_PARAMS, makeQuoteResponse()),
    );
    await clock.tickAsync(31_001);
    expect((await pending).preparedAt).to.equal(31_000);
    expect(fetch.callCount).to.equal(2);
  });

  it('rejects incidental native value above the configured cap', async () => {
    const response = makeCreateTxResponse();
    response.tx.value = '10000000000000001';
    sinon.stub(globalThis, 'fetch').resolves(jsonResponse(response));
    const send = sinon.stub(ethers.Wallet.prototype, 'sendTransaction');
    const error = await getRejection(
      new DeBridgeBridge(BRIDGE_CONFIG, logger).prepare(
        makeBridgeQuote(BSC_TO_TRON_PARAMS, makeQuoteResponse()),
      ),
    );
    expect(error.message).to.include('exceeds cap');
    expect(send.called).to.equal(false);
  });

  it('rejects consistent API decimal spoofing against on-chain token metadata', async () => {
    const response = makeCreateTxResponse();
    response.estimation.srcChainTokenIn.decimals++;
    response.estimation.dstChainTokenOut.decimals++;
    sinon.stub(globalThis, 'fetch').resolves(jsonResponse(response));
    const error = await getRejection(
      new DeBridgeBridge(BRIDGE_CONFIG, logger).prepare(
        makeBridgeQuote(BSC_TO_TRON_PARAMS, makeQuoteResponse()),
      ),
    );
    expect(error.message).to.include('decimals do not match chain data');
  });

  for (const scenario of [
    'refresh',
    'worse quote',
    'lost broadcast',
  ] as const) {
    it(`handles ${scenario} without submitting stale or duplicate source work`, async () => {
      let now = 0;
      sinon.stub(Date, 'now').callsFake(() => now);
      let allowance = 0n;
      callStub.callsFake((tx) => chainRead(tx, allowance));
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.onFirstCall().resolves(jsonResponse(makeCreateTxResponse()));
      const refreshed = makeCreateTxResponse();
      if (scenario === 'worse quote')
        refreshed.estimation.dstChainTokenOut.amount = (
          DESTINATION_AMOUNT - 1n
        ).toString();
      fetchStub.onSecondCall().resolves(jsonResponse(refreshed));
      sinon
        .stub(
          ethers.providers.StaticJsonRpcProvider.prototype,
          'waitForTransaction',
        )
        .callsFake(async (hash) =>
          makeTransactionResponse(
            { to: BSC_USDT, data: '0x', value: ethers.constants.Zero },
            hash,
          ).wait(),
        );
      let primary = 0;
      sinon
        .stub(ethers.Wallet.prototype, 'sendTransaction')
        .callsFake(async (request) => {
          const to = await request.to;
          const data = ethers.utils.hexlify((await request.data) ?? '0x');
          if (to?.toLowerCase() === BSC_USDT.toLowerCase()) {
            allowance = SOURCE_AMOUNT;
            if (scenario !== 'lost broadcast') now += 31_000;
          } else {
            primary++;
            if (scenario === 'lost broadcast')
              throw new Error('lost broadcast response');
          }
          return makeTransactionResponse(
            {
              to,
              data,
              value: ethers.BigNumber.from((await request.value) ?? 0),
            },
            ethers.utils.id(`sent ${to} ${primary}`),
          );
        });
      const promise = new DeBridgeBridge(BRIDGE_CONFIG, logger).execute(
        makeBridgeQuote(BSC_TO_TRON_PARAMS, makeQuoteResponse()),
        { [ProtocolType.Ethereum]: PRIVATE_KEY },
      );
      if (scenario === 'refresh') {
        await promise;
        expect(primary).to.equal(1);
        expect(fetchStub.callCount).to.equal(2);
      } else {
        const error = await getRejection(promise);
        expect(error.message).to.include(
          scenario === 'worse quote' ? 'below required' : 'lost broadcast',
        );
        expect(primary).to.equal(scenario === 'worse quote' ? 0 : 1);
        expect(fetchStub.callCount).to.equal(
          scenario === 'worse quote' ? 2 : 1,
        );
        if (scenario === 'lost broadcast') {
          expect(error).to.be.instanceOf(TransactionSubmissionError);
          assert(
            error instanceof TransactionSubmissionError,
            'Expected submission state',
          );
          expect(error.submissionState).to.equal('unknown');
        }
      }
    });
  }

  it('rejects a private key that does not match the configured signer', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    const bridge = new DeBridgeBridge(BRIDGE_CONFIG, logger);
    const quote = makeBridgeQuote(BSC_TO_TRON_PARAMS, makeQuoteResponse());

    const error = await getRejection(
      bridge.execute(quote, {
        [ProtocolType.Ethereum]: OTHER_PRIVATE_KEY,
      }),
    );
    expect(error.message).to.include('does not match inventory signer');
    expect(fetchStub.called).to.equal(false);
  });

  it('resets and sets an exact EVM allowance before direct API execution', async () => {
    sinon
      .stub(
        ethers.providers.StaticJsonRpcProvider.prototype,
        'waitForTransaction',
      )
      .callsFake(async (hash) =>
        makeTransactionResponse(
          { to: DLN_SOURCE, data: '0x', value: ethers.constants.Zero },
          hash,
        ).wait(),
      );
    const fetchStub = sinon
      .stub(globalThis, 'fetch')
      .resolves(jsonResponse(makeCreateTxResponse()));
    callStub.callsFake((tx) => chainRead(tx, SOURCE_AMOUNT + 1n));

    const captured: CapturedTransaction[] = [];
    sinon
      .stub(ethers.Wallet.prototype, 'sendTransaction')
      .callsFake(async (request) => {
        const transaction = {
          to: await request.to,
          data: ethers.utils.hexlify((await request.data) ?? '0x'),
          value: ethers.BigNumber.from((await request.value) ?? 0),
        };
        captured.push(transaction);
        return makeTransactionResponse(
          transaction,
          `0x${captured.length.toString(16).padStart(64, '0')}`,
        );
      });

    const bridge = new DeBridgeBridge(BRIDGE_CONFIG, logger);
    const result = await bridge.execute(
      makeBridgeQuote(BSC_TO_TRON_PARAMS, makeQuoteResponse()),
      { [ProtocolType.Ethereum]: PRIVATE_KEY },
    );

    const createUrl = new URL(String(fetchStub.firstCall.args[0]));
    expect(createUrl.searchParams.get('srcAllowedCancelBeneficiary')).to.equal(
      ethers.utils.computeAddress(PRIVATE_KEY),
    );
    expect(createUrl.searchParams.has('srcChainRefundAddress')).to.equal(false);
    expect(captured).to.have.length(3);
    const erc20 = new ethers.utils.Interface([
      'function approve(address,uint256) returns (bool)',
    ]);
    const reset = erc20.decodeFunctionData('approve', captured[0].data);
    const approval = erc20.decodeFunctionData('approve', captured[1].data);
    expect(reset[0]).to.equal(DLN_SOURCE);
    expect(reset[1].toString()).to.equal('0');
    expect(approval[0]).to.equal(DLN_SOURCE);
    expect(approval[1].toString()).to.equal(SOURCE_AMOUNT.toString());
    expect(captured[2]).to.deep.include({
      to: DLN_SOURCE,
      data: makeEvmOrderData(),
    });
    expect(captured[2].value.toString()).to.equal(FIX_FEE.toString());
    expect(result.txHash).to.match(/^0x[0-9a-f]{64}$/);
    expect(result).to.deep.include({
      fromChain: 56,
      toChain: 728126428,
      transferId: makeTransferIdentity(),
    });
  });

  it('accepts a provider-selected target without decoding its calldata', async () => {
    const response = makeCreateTxResponse();
    response.tx.to = DLN_FORWARDER;
    sinon.stub(globalThis, 'fetch').resolves(jsonResponse(response));
    callStub.callsFake((tx) => chainRead(tx));
    sinon
      .stub(
        ethers.providers.StaticJsonRpcProvider.prototype,
        'waitForTransaction',
      )
      .callsFake(async (hash) =>
        makeTransactionResponse(
          { to: DLN_FORWARDER, data: '0x', value: ethers.constants.Zero },
          hash,
        ).wait(),
      );
    const captured: CapturedTransaction[] = [];
    sinon
      .stub(ethers.Wallet.prototype, 'sendTransaction')
      .callsFake(async (request) => {
        const tx = {
          to: await request.to,
          data: ethers.utils.hexlify((await request.data) ?? '0x'),
          value: ethers.BigNumber.from((await request.value) ?? 0),
        };
        captured.push(tx);
        return makeTransactionResponse(
          tx,
          ethers.utils.id(`forwarder transaction ${captured.length}`),
        );
      });
    const result = await new DeBridgeBridge(BRIDGE_CONFIG, logger).execute(
      makeBridgeQuote(BSC_TO_TRON_PARAMS, makeQuoteResponse()),
      { [ProtocolType.Ethereum]: PRIVATE_KEY },
    );
    expect(captured).to.have.length(2);
    const erc20 = new ethers.utils.Interface([
      'function approve(address,uint256)',
    ]);
    const approval = erc20.decodeFunctionData('approve', captured[0].data);
    expect(captured[0].to?.toLowerCase()).to.equal(BSC_USDT.toLowerCase());
    expect(approval[0]).to.equal(DLN_FORWARDER);
    expect(approval[1].toString()).to.equal(SOURCE_AMOUNT.toString());
    expect(captured[1].to).to.equal(DLN_FORWARDER);
    expect(captured[1].data).to.equal(response.tx.data);
    expect(result.transferId).to.equal(makeTransferIdentity());
  });

  it('constructs an exact TRC20 approval for Tron execution', async () => {
    const params: BridgeQuoteParams = {
      fromChain: 728126428,
      toChain: 56,
      fromToken: TRON_USDT,
      toToken: BSC_USDT,
      fromAmount: 1_000_000_000n,
      fromAddress: SIGNER_ADDRESS,
      toAddress: SIGNER_ADDRESS,
    };
    const response: DeBridgeQuoteResponse = {
      estimation: {
        srcChainTokenIn: {
          chainId: DEBRIDGE_TRON_CHAIN_ID,
          address: TRON_USDT,
          name: 'Tether USD',
          symbol: 'USDT',
          decimals: 6,
          amount: '1000000000',
        },
        dstChainTokenOut: {
          chainId: 56,
          address: BSC_USDT,
          name: 'Tether USD',
          symbol: 'USDT',
          decimals: 18,
          amount: '996000000000000000000',
        },
      },
      fixFee: '4000000',
      protocolFee: '400000',
    };
    sinon.stub(globalThis, 'fetch').resolves(
      jsonResponse({
        ...response,
        orderId: ORDER_ID,
        tx: {
          to: DLN_TRON_SOURCE,
          data: makeEvmOrderData(params, 996_000_000_000_000_000_000n),
          value: '4000000',
        },
      }),
    );
    let approvalRequest: CapturedTransaction | undefined;
    sinon
      .stub(TronWallet.prototype, 'sendTransaction')
      .callsFake(async (request): Promise<never> => {
        approvalRequest = {
          to: await request.to,
          data: ethers.utils.hexlify((await request.data) ?? '0x'),
          value: ethers.BigNumber.from((await request.value) ?? 0),
        };
        throw new Error('stop after TRC20 approval capture');
      });

    const error = await getRejection(
      new DeBridgeBridge(BRIDGE_CONFIG, logger).execute(
        makeBridgeQuote(params, response),
        { [ProtocolType.Tron]: PRIVATE_KEY },
      ),
    );
    expect(error.message).to.include('stop after TRC20 approval capture');

    expect(approvalRequest).not.to.equal(undefined);
    assert(approvalRequest, 'Expected an approval transaction');
    expect(approvalRequest.to).to.equal(
      '0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C',
    );
    const erc20 = new ethers.utils.Interface([
      'function approve(address,uint256) returns (bool)',
    ]);
    const approval = erc20.decodeFunctionData('approve', approvalRequest.data);
    expect(approval[0]).to.equal(DLN_TRON_SOURCE);
    expect(approval[1].toString()).to.equal('1000000000');
  });

  it('records the Solana signature and order ID when the broadcast response is lost', async () => {
    const signer = Keypair.generate();
    sinon.stub(globalThis, 'fetch').resolves(
      jsonResponse({
        ...makeSolanaQuoteResponse(),
        orderId: ORDER_ID,
        fixFee: '0',
        tx: { data: makeSerializedSolanaTransaction(signer) },
      }),
    );
    sinon.stub(Connection.prototype, 'getLatestBlockhash').resolves({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 123,
    });
    const send = sinon
      .stub(Connection.prototype, 'sendTransaction')
      .rejects(new Error('lost broadcast response'));
    const onTransferId = sinon.spy();
    const onSubmissionAttempt = sinon.spy();
    const error = await getRejection(
      new DeBridgeBridge(BRIDGE_CONFIG, logger).execute(
        makeBridgeQuote(makeSolanaParams(signer), makeSolanaQuoteResponse()),
        { [ProtocolType.Sealevel]: bs58.encode(signer.secretKey) },
        { onTransferId, onSubmissionAttempt },
      ),
    );
    expect(error).to.be.instanceOf(TransactionSubmissionError);
    assert(
      error instanceof TransactionSubmissionError,
      'Expected submission error',
    );
    expect(error.submissionState).to.equal('unknown');
    expect(error.txHash).to.equal(onSubmissionAttempt.firstCall.args[0]);
    expect(error.txHash).to.have.length.greaterThan(60);
    expect(
      onTransferId.calledOnceWithExactly(
        makeTransferIdentity(
          makeSolanaParams(signer),
          ORDER_ID,
          BigInt(makeSolanaQuoteResponse().estimation.dstChainTokenOut.amount),
        ),
      ),
    ).to.equal(true);
    expect(onSubmissionAttempt.calledBefore(send)).to.equal(true);
  });

  it('rejects a Solana transaction signed by another payer', async () => {
    const signer = Keypair.generate();
    const other = Keypair.generate();
    const params = makeSolanaParams(signer);
    const response = makeSolanaQuoteResponse();
    sinon.stub(globalThis, 'fetch').resolves(
      jsonResponse({
        ...response,
        orderId: ORDER_ID,
        fixFee: '0',
        tx: { data: makeSerializedSolanaTransaction(other) },
      }),
    );

    const error = await getRejection(
      new DeBridgeBridge(BRIDGE_CONFIG, logger).execute(
        makeBridgeQuote(params, response),
        { [ProtocolType.Sealevel]: bs58.encode(signer.secretKey) },
      ),
    );
    expect(error.message).to.include('signer does not match');
  });

  it('preserves the signed Solana identity if the RPC returns another signature', async () => {
    const signer = Keypair.generate();
    const response = makeSolanaQuoteResponse();
    sinon.stub(globalThis, 'fetch').resolves(
      jsonResponse({
        ...response,
        orderId: ORDER_ID,
        fixFee: '0',
        tx: { data: makeSerializedSolanaTransaction(signer) },
      }),
    );
    sinon.stub(Connection.prototype, 'getLatestBlockhash').resolves({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 123,
    });
    const send = sinon
      .stub(Connection.prototype, 'sendTransaction')
      .resolves('wrong-signature');
    const onSubmitted = sinon.spy();
    const error = await getRejection(
      new DeBridgeBridge(BRIDGE_CONFIG, logger).execute(
        makeBridgeQuote(makeSolanaParams(signer), response),
        { [ProtocolType.Sealevel]: bs58.encode(signer.secretKey) },
        { onSubmitted },
      ),
    );
    assert(
      error instanceof TransactionSubmissionError,
      'Expected submission error',
    );
    const transaction = send.firstCall.args[0];
    assert(
      transaction instanceof VersionedTransaction,
      'Expected versioned transaction',
    );
    expect(error.submissionState).to.equal('unknown');
    expect(error.txHash).to.equal(bs58.encode(transaction.signatures[0]));
    expect(onSubmitted.called).to.equal(false);
  });

  it('returns the Solana broadcast identity without waiting for confirmation', async () => {
    const signer = Keypair.generate();
    const params = makeSolanaParams(signer);
    const response = makeSolanaQuoteResponse();
    sinon.stub(globalThis, 'fetch').resolves(
      jsonResponse({
        ...response,
        orderId: ORDER_ID,
        fixFee: '0',
        tx: { data: makeSerializedSolanaTransaction(signer) },
      }),
    );
    sinon.stub(Connection.prototype, 'getLatestBlockhash').resolves({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 123,
    });
    const sendStub = sinon
      .stub(Connection.prototype, 'sendTransaction')
      .callsFake(async (transaction) => {
        assert(
          transaction instanceof VersionedTransaction,
          'Expected versioned transaction',
        );
        return bs58.encode(transaction.signatures[0]);
      });
    const confirmStub = sinon
      .stub(Connection.prototype, 'confirmTransaction')
      .rejects(new Error('receipt provider timeout'));

    const result = await new DeBridgeBridge(BRIDGE_CONFIG, logger).execute(
      makeBridgeQuote(params, response),
      { [ProtocolType.Sealevel]: bs58.encode(signer.secretKey) },
    );

    expect(sendStub.calledOnce).to.equal(true);
    expect(confirmStub.called).to.equal(false);
    expect(result).to.deep.equal({
      txHash: await sendStub.firstCall.returnValue,
      fromChain: 1399811149,
      toChain: 56,
      transferId: makeTransferIdentity(
        params,
        ORDER_ID,
        BigInt(response.estimation.dstChainTokenOut.amount),
      ),
    });
  });
});

async function preparedStatusBridge(
  params = BSC_TO_TRON_PARAMS,
  orderId = ORDER_ID,
): Promise<{ bridge: DeBridgeBridge; transferId: string }> {
  const response = makeCreateTxResponse();
  response.orderId = orderId;
  response.estimation.dstChainTokenOut.chainId = hyperlaneChainIdToDebridge(
    params.toChain,
  );
  response.estimation.dstChainTokenOut.address = params.toToken;
  const fetch = sinon
    .stub(globalThis, 'fetch')
    .resolves(jsonResponse(response));
  const call = sinon
    .stub(ethers.providers.StaticJsonRpcProvider.prototype, 'call')
    .callsFake((tx) => chainRead(tx));
  const tronCall = sinon
    .stub(TronJsonRpcProvider.prototype, 'call')
    .callsFake((tx) => chainRead(tx));
  const mint = stubMint();
  const bridge = new DeBridgeBridge(
    {
      ...BRIDGE_CONFIG,
      chainMetadata: {
        ...BRIDGE_CONFIG.chainMetadata,
        tron: {
          name: 'tron',
          chainId: 728126428,
          domainId: 728126428,
          protocol: ProtocolType.Tron,
          rpcUrls: [{ http: 'https://tron-rpc.example.com' }],
          nativeToken: { name: 'TRX', symbol: 'TRX', decimals: 6 },
        },
      },
    },
    logger,
  );
  try {
    const prepared = await bridge.prepare(makeBridgeQuote(params, response));
    return { bridge, transferId: prepared.transferId };
  } finally {
    fetch.restore();
    call.restore();
    tronCall.restore();
    mint.restore();
  }
}

describe('DeBridgeBridge.getStatus', function () {
  let sourceReceipt: ethers.providers.TransactionReceipt;
  let destinationReceipt: ethers.providers.TransactionReceipt;
  let receiptStub: sinon.SinonStub;
  let bridge: DeBridgeBridge;
  let transferId: string;
  beforeEach(async () => {
    ({ bridge, transferId } = await preparedStatusBridge());
    const order = settlementOrder();
    sourceReceipt = await makeTransactionResponse(
      { to: DLN_SOURCE, data: '0x', value: ethers.constants.Zero },
      SOURCE_TX_HASH,
    ).wait();
    destinationReceipt = await makeTransactionResponse(
      { to: SIGNER_ADDRESS, data: '0x', value: ethers.constants.Zero },
      DESTINATION_TX_HASH,
    ).wait();
    const log = (
      address: string,
      encoded: { topics: string[]; data: string },
    ): ethers.providers.Log => ({
      address,
      ...encoded,
      blockNumber: 1,
      blockHash: sourceReceipt.blockHash,
      transactionHash: SOURCE_TX_HASH,
      transactionIndex: 0,
      logIndex: 0,
      removed: false,
    });
    sourceReceipt.logs = [
      log(
        DLN_SOURCE,
        DLN_EVENTS.encodeEventLog(DLN_EVENTS.getEvent('CreatedOrder'), [
          order,
          ORDER_ID,
          '0x',
          FIX_FEE,
          0,
          0,
          '0x',
        ]),
      ),
    ];
    destinationReceipt.logs = [
      log(
        deBridgeAddressBytes('TXCbCdoHjg28g36X5jnWTP88mRzx54RqXp', 728126428),
        DLN_EVENTS.encodeEventLog(DLN_EVENTS.getEvent('FulfilledOrder'), [
          order,
          ORDER_ID,
          SIGNER_ADDRESS,
          SIGNER_ADDRESS,
        ]),
      ),
      log(order.takeTokenAddress, {
        topics: [
          ethers.utils.id('Transfer(address,address,uint256)'),
          ethers.utils.hexZeroPad(DLN_SOURCE, 32),
          ethers.utils.hexZeroPad(SIGNER_ADDRESS, 32),
        ],
        data: ethers.utils.defaultAbiCoder.encode(
          ['uint256'],
          [DESTINATION_AMOUNT],
        ),
      }),
    ];
    receiptStub = sinon
      .stub(
        ethers.providers.StaticJsonRpcProvider.prototype,
        'getTransactionReceipt',
      )
      .callsFake(async (hash) =>
        (await hash) === SOURCE_TX_HASH ? sourceReceipt : destinationReceipt,
      );
    sinon
      .stub(TronJsonRpcProvider.prototype, 'getTransactionReceipt')
      .callsFake((hash) => receiptStub(hash));
    sinon
      .stub(TronJsonRpcProvider.prototype, 'getFinalizedBlockNumber')
      .resolves(1);
  });
  afterEach(() => sinon.restore());

  it('keeps fulfillment pending without the prepared destination expectation', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      jsonResponse({
        orderId: ORDER_ID,
        status: 'Fulfilled',
        fulfilledDstEventMetadata: {
          transactionHash: { stringValue: DESTINATION_TX_HASH },
        },
      }),
    );
    const untracked = new DeBridgeBridge(BRIDGE_CONFIG, logger);
    expect(
      (await untracked.getStatus(SOURCE_TX_HASH, 56, 728126428, ORDER_ID))
        .status,
    ).to.equal('pending');
  });

  it('verifies the serialized expectation on a fresh adapter and repeated status calls', async () => {
    sinon.stub(globalThis, 'fetch').callsFake(async () =>
      jsonResponse({
        orderId: ORDER_ID,
        status: 'Fulfilled',
        fulfilledDstEventMetadata: {
          transactionHash: { stringValue: DESTINATION_TX_HASH },
        },
      }),
    );
    const restarted = new DeBridgeBridge(BRIDGE_CONFIG, logger);
    for (let i = 0; i < 2; i++) {
      expect(
        (await restarted.getStatus(SOURCE_TX_HASH, 56, 728126428, transferId))
          .status,
      ).to.equal('complete');
    }
  });

  it('rejects malformed, unsupported-version and route-mismatched identities before API access', async () => {
    const fetch = sinon.stub(globalThis, 'fetch');
    for (const identity of [
      'invalid JSON',
      transferId.replace('"version":1', '"version":2'),
    ]) {
      expect(
        await getRejection(
          bridge.getStatus(SOURCE_TX_HASH, 56, 728126428, identity),
        ),
      ).to.be.instanceOf(Error);
    }
    expect(
      (
        await getRejection(
          bridge.getStatus(SOURCE_TX_HASH, 1, 728126428, transferId),
        )
      ).message,
    ).to.include('requested route');
    expect(fetch.called).to.equal(false);
  });

  for (const change of [
    'recipient',
    'token',
    'amount',
    'chain',
    'net source amount',
  ] as const) {
    it(`binds a self-consistent order to the destination intent: ${change}`, async () => {
      const order = settlementOrder();
      if (change === 'recipient') order.receiverDst = DLN_SOURCE.toLowerCase();
      if (change === 'token') order.takeTokenAddress = BSC_USDT.toLowerCase();
      if (change === 'amount') order.takeAmount--;
      if (change === 'chain') order.takeChainId = 1n;
      if (change === 'net source amount') order.giveAmount -= 1_000n;
      const id = dlnOrderId(order);
      ({ bridge, transferId } = await preparedStatusBridge(
        BSC_TO_TRON_PARAMS,
        id,
      ));
      Object.assign(
        sourceReceipt.logs[0],
        DLN_EVENTS.encodeEventLog(DLN_EVENTS.getEvent('CreatedOrder'), [
          order,
          id,
          '0x',
          FIX_FEE,
          SOURCE_AMOUNT - order.giveAmount,
          0,
          '0x',
        ]),
      );
      Object.assign(
        destinationReceipt.logs[0],
        DLN_EVENTS.encodeEventLog(DLN_EVENTS.getEvent('FulfilledOrder'), [
          order,
          id,
          SIGNER_ADDRESS,
          SIGNER_ADDRESS,
        ]),
      );
      destinationReceipt.logs[1].address = order.takeTokenAddress;
      destinationReceipt.logs[1].topics[2] = ethers.utils.hexZeroPad(
        order.receiverDst,
        32,
      );
      destinationReceipt.logs[1].data = ethers.utils.defaultAbiCoder.encode(
        ['uint256'],
        [order.takeAmount],
      );
      sinon.stub(globalThis, 'fetch').resolves(
        jsonResponse({
          orderId: id,
          status: 'Fulfilled',
          fulfilledDstEventMetadata: {
            transactionHash: { stringValue: DESTINATION_TX_HASH },
          },
        }),
      );
      const status = bridge.getStatus(
        SOURCE_TX_HASH,
        56,
        728126428,
        transferId,
      );
      if (change === 'net source amount') {
        expect((await status).status).to.equal('complete');
      } else {
        expect((await getRejection(status)).message).to.include(
          'DLN settlement',
        );
      }
    });
  }

  it('uses the prepared order ID and maps completion metadata', async () => {
    let calledUrl = '';
    sinon.stub(globalThis, 'fetch').callsFake(async (input) => {
      calledUrl = String(input);
      return jsonResponse({
        orderId: ORDER_ID,
        status: 'Fulfilled',
        fulfilledDstEventMetadata: {
          transactionHash: { stringValue: DESTINATION_TX_HASH },
          receivedAmount: { bigIntegerValue: DESTINATION_AMOUNT.toString() },
        },
      });
    });

    const result = await bridge.getStatus(
      SOURCE_TX_HASH,
      56,
      728126428,
      transferId,
    );

    expect(calledUrl).to.include(`/order/${ORDER_ID}/status`);
    expect(calledUrl).not.to.include(SOURCE_TX_HASH);
    expect(result).to.deep.equal({
      status: 'complete',
      receivingTxHash: DESTINATION_TX_HASH,
      receivedAmount: DESTINATION_AMOUNT,
    });
  });

  for (const corruption of [
    'source ID',
    'destination recipient',
    'destination token',
    'destination amount',
    'token transfer',
    'event emitter',
  ] as const) {
    it(`rejects ${corruption} mismatches despite an API fulfillment claim`, async () => {
      sinon.stub(globalThis, 'fetch').resolves(
        jsonResponse({
          orderId: ORDER_ID,
          status: 'Fulfilled',
          fulfilledDstEventMetadata: {
            transactionHash: { stringValue: DESTINATION_TX_HASH },
          },
        }),
      );
      if (corruption === 'source ID')
        sourceReceipt.logs[0].data = DLN_EVENTS.encodeEventLog(
          DLN_EVENTS.getEvent('CreatedOrder'),
          [settlementOrder(), OTHER_ORDER_ID, '0x', FIX_FEE, 0, 0, '0x'],
        ).data;
      else if (corruption === 'event emitter')
        destinationReceipt.logs[0].address = SIGNER_ADDRESS;
      else if (corruption === 'token transfer')
        destinationReceipt.logs[1].data = ethers.utils.defaultAbiCoder.encode(
          ['uint256'],
          [DESTINATION_AMOUNT - 1n],
        );
      else {
        const order = settlementOrder();
        if (corruption === 'destination recipient')
          order.receiverDst = DLN_SOURCE;
        if (corruption === 'destination token')
          order.takeTokenAddress = BSC_USDT;
        if (corruption === 'destination amount') order.takeAmount--;
        destinationReceipt.logs[0].data = DLN_EVENTS.encodeEventLog(
          DLN_EVENTS.getEvent('FulfilledOrder'),
          [order, ORDER_ID, SIGNER_ADDRESS, SIGNER_ADDRESS],
        ).data;
      }
      expect(
        await getRejection(
          bridge.getStatus(SOURCE_TX_HASH, 56, 728126428, transferId),
        ),
      ).to.be.instanceOf(Error);
    });
  }

  it('does not count a recipient self-transfer as destination credit', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      jsonResponse({
        orderId: ORDER_ID,
        status: 'Fulfilled',
        fulfilledDstEventMetadata: {
          transactionHash: { stringValue: DESTINATION_TX_HASH },
        },
      }),
    );
    destinationReceipt.logs[1].topics[1] = destinationReceipt.logs[1].topics[2];
    expect(
      (
        await getRejection(
          bridge.getStatus(SOURCE_TX_HASH, 56, 728126428, transferId),
        )
      ).message,
    ).to.include('less than the committed amount');
  });

  it('rejects native fulfillment after a take-amount reduction', async () => {
    const order = {
      ...settlementOrder(),
      takeTokenAddress: ethers.constants.AddressZero,
    };
    const id = dlnOrderId(order);
    Object.assign(
      sourceReceipt.logs[0],
      DLN_EVENTS.encodeEventLog(DLN_EVENTS.getEvent('CreatedOrder'), [
        order,
        id,
        '0x',
        FIX_FEE,
        0,
        0,
        '0x',
      ]),
    );
    Object.assign(
      destinationReceipt.logs[0],
      DLN_EVENTS.encodeEventLog(DLN_EVENTS.getEvent('FulfilledOrder'), [
        order,
        id,
        SIGNER_ADDRESS,
        SIGNER_ADDRESS,
      ]),
    );
    destinationReceipt.logs.length = 1;
    ({ bridge, transferId } = await preparedStatusBridge(
      { ...BSC_TO_TRON_PARAMS, toToken: ethers.constants.AddressZero },
      id,
    ));
    sinon.stub(globalThis, 'fetch').callsFake(async () =>
      jsonResponse({
        orderId: id,
        status: 'Fulfilled',
        fulfilledDstEventMetadata: {
          transactionHash: { stringValue: DESTINATION_TX_HASH },
        },
      }),
    );
    const call = sinon
      .stub(TronJsonRpcProvider.prototype, 'call')
      .resolves(ethers.utils.defaultAbiCoder.encode(['uint256'], [0]));
    expect(
      (await bridge.getStatus(SOURCE_TX_HASH, 56, 728126428, transferId))
        .status,
    ).to.equal('complete');
    expect(await call.firstCall.args[1]).to.equal(
      destinationReceipt.blockNumber,
    );
    call.resolves(ethers.utils.defaultAbiCoder.encode(['uint256'], [1]));
    expect(
      (
        await getRejection(
          bridge.getStatus(SOURCE_TX_HASH, 56, 728126428, transferId),
        )
      ).message,
    ).to.include('amount was reduced');
  });

  it('waits for source and destination finality and propagates receipt timeouts', async () => {
    sinon.stub(globalThis, 'fetch').callsFake(async () =>
      jsonResponse({
        orderId: ORDER_ID,
        status: 'Fulfilled',
        fulfilledDstEventMetadata: {
          transactionHash: { stringValue: DESTINATION_TX_HASH },
        },
      }),
    );
    for (const receipt of [sourceReceipt, destinationReceipt]) {
      receipt.confirmations = 0;
      expect(
        (await bridge.getStatus(SOURCE_TX_HASH, 56, 728126428, transferId))
          .status,
      ).to.equal('pending');
      receipt.confirmations = 1;
    }
    destinationReceipt.blockNumber = 2;
    expect(
      (await bridge.getStatus(SOURCE_TX_HASH, 56, 728126428, transferId))
        .status,
    ).to.equal('pending');
    receiptStub.rejects(new Error('receipt RPC timeout'));
    expect(
      (
        await getRejection(
          bridge.getStatus(SOURCE_TX_HASH, 56, 728126428, transferId),
        )
      ).message,
    ).to.include('receipt RPC timeout');
  });

  it('requires finalized Solana fulfillment and the committed recipient token credit', async () => {
    const recipient = Keypair.generate().publicKey;
    const mint = new PublicKey(SOLANA_USDT);
    const ata = getAssociatedTokenAddressSync(mint, recipient);
    const order: DlnOrder = {
      ...settlementOrder(),
      takeChainId: BigInt(DEBRIDGE_SOLANA_CHAIN_ID),
      takeTokenAddress: ethers.utils.hexlify(mint.toBytes()),
      receiverDst: ethers.utils.hexlify(recipient.toBytes()),
      orderAuthorityAddressDst: ethers.utils.hexlify(recipient.toBytes()),
    };
    const id = dlnOrderId(order);
    ({ bridge, transferId } = await preparedStatusBridge(
      {
        ...BSC_TO_TRON_PARAMS,
        toChain: 1399811149,
        toToken: SOLANA_USDT,
        toAddress: recipient.toBase58(),
      },
      id,
    ));
    Object.assign(
      sourceReceipt.logs[0],
      DLN_EVENTS.encodeEventLog(DLN_EVENTS.getEvent('CreatedOrder'), [
        order,
        id,
        '0x',
        FIX_FEE,
        0,
        0,
        '0x',
      ]),
    );
    const program = 'dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo';
    const event = Buffer.concat([
      createHash('sha256').update('event:Fulfilled').digest().subarray(0, 8),
      Buffer.from(ethers.utils.arrayify(id)),
      recipient.toBuffer(),
    ]);
    const message = new TransactionMessage({
      payerKey: recipient,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [
        new TransactionInstruction({
          programId: new PublicKey(program),
          data: Buffer.alloc(0),
          keys: [{ pubkey: ata, isSigner: false, isWritable: true }],
        }),
      ],
    }).compileToV0Message();
    const index = message.staticAccountKeys.findIndex((key) => key.equals(ata));
    let amount = DESTINATION_AMOUNT;
    const get = sinon
      .stub(Connection.prototype, 'getTransaction')
      .callsFake(async () => ({
        slot: 1,
        blockTime: 1,
        transaction: { signatures: ['destination-solana-signature'], message },
        meta: {
          err: null,
          fee: 5000,
          preBalances: [],
          postBalances: [],
          preTokenBalances: [],
          postTokenBalances: [
            {
              accountIndex: index,
              mint: mint.toBase58(),
              owner: recipient.toBase58(),
              uiTokenAmount: {
                amount: amount.toString(),
                decimals: 6,
                uiAmount: null,
              },
            },
          ],
          logMessages: [
            `Program ${program} invoke [1]`,
            `Program data: ${event.toString('base64')}`,
            `Program ${program} success`,
          ],
        },
      }));
    sinon.stub(globalThis, 'fetch').callsFake(async () =>
      jsonResponse({
        orderId: id,
        status: 'Fulfilled',
        fulfilledDstEventMetadata: {
          transactionHash: { stringValue: 'destination-solana-signature' },
        },
      }),
    );
    expect(
      (await bridge.getStatus(SOURCE_TX_HASH, 56, 1399811149, transferId))
        .status,
    ).to.equal('complete');
    expect(get.firstCall.args[1]).to.deep.equal({
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    amount--;
    expect(
      (
        await getRejection(
          bridge.getStatus(SOURCE_TX_HASH, 56, 1399811149, transferId),
        )
      ).message,
    ).to.include('less than the committed amount');
  });

  it('maps all cancellation states to failed', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    for (const status of [
      'OrderCancelled',
      'SentOrderCancel',
      'ClaimedOrderCancel',
    ]) {
      fetchStub.resolves(jsonResponse({ orderId: ORDER_ID, status }));
      const result = await bridge.getStatus('tx', 56, 728126428, transferId);
      expect(result).to.deep.equal({ status: 'failed', error: status });
      fetchStub.resetBehavior();
    }
  });

  it('keeps API fulfillment pending without a destination transaction', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    for (const status of ['Fulfilled', 'SentUnlock', 'ClaimedUnlock']) {
      fetchStub.resolves(jsonResponse({ orderId: ORDER_ID, status }));
      const result = await bridge.getStatus('tx', 56, 728126428, transferId);
      expect(result).to.deep.equal({
        status: 'pending',
        substatus: 'Missing destination transaction',
      });
      fetchStub.resetBehavior();
    }
  });

  it('maps Created to pending and None to not_found', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    fetchStub
      .onFirstCall()
      .resolves(jsonResponse({ orderId: ORDER_ID, status: 'Created' }));
    fetchStub
      .onSecondCall()
      .resolves(jsonResponse({ orderId: ORDER_ID, status: 'None' }));

    expect(
      await bridge.getStatus('tx', 56, 728126428, transferId),
    ).to.deep.equal({ status: 'pending', substatus: 'Created' });
    expect(
      await bridge.getStatus('tx', 56, 728126428, transferId),
    ).to.deep.equal({ status: 'not_found' });
  });

  it('rejects missing IDs, mismatched IDs, and unknown statuses', async () => {
    const missingIdError = await getRejection(
      bridge.getStatus('tx', 56, 728126428),
    );
    expect(missingIdError.message).to.include('order ID is required');

    const fetchStub = sinon.stub(globalThis, 'fetch');
    fetchStub
      .onFirstCall()
      .resolves(jsonResponse({ orderId: OTHER_ORDER_ID, status: 'Created' }));
    fetchStub
      .onSecondCall()
      .resolves(jsonResponse({ orderId: ORDER_ID, status: 'Unexpected' }));
    const mismatchedIdError = await getRejection(
      bridge.getStatus('tx', 56, 728126428, transferId),
    );
    expect(mismatchedIdError.message).to.include('unexpected order ID');
    const statusError = await getRejection(
      bridge.getStatus('tx', 56, 728126428, transferId),
    );
    expect(statusError.message).to.include('status');
  });
});
