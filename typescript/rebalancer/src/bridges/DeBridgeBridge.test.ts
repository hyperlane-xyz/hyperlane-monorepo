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
import {
  DLN_FORWARDER,
  DLN_FORWARDER_INTERFACE,
  DLN_FORWARDER_IMPLEMENTATION,
  ZERO_EX_BSC_SETTLER,
  ZERO_EX_DEPLOYER,
} from './deBridgeForwarderValidation.js';
import { DLN_EVENTS, type DlnOrder, dlnOrderId } from './deBridgeSettlement.js';
import { changeCall, withSignerSurplus } from './fixtures/deBridgeForwarder.js';
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
  maxFeePercent: 2.5,
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

function makeForwarderResponse(): DeBridgeCreateTxResponse {
  const response = makeCreateTxResponse();
  response.tx.to = DLN_FORWARDER;
  response.tx.data = changeCall(
    DLN_FORWARDER_INTERFACE,
    withSignerSurplus(SIGNER_ADDRESS),
    (args) => {
      const next = [...args];
      next[9] = makeEvmOrderData(BSC_TO_TRON_PARAMS, DESTINATION_AMOUNT, {
        giveTokenAddress: args.srcTokenOut,
        giveAmount: args.srcAmountOut,
      });
      return next;
    },
  );
  return response;
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
  afterEach(() => sinon.restore());

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

  it('rejects a quote above maxFeePercent', async () => {
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
  else if (data === ethers.utils.id('globalFixedNativeFee()').slice(0, 10))
    result = address === DLN_TRON_SOURCE.toLowerCase() ? 4_000_000 : FIX_FEE;
  else if (address === ZERO_EX_DEPLOYER.toLowerCase())
    result = ZERO_EX_BSC_SETTLER;
  return ethers.utils.defaultAbiCoder.encode(['uint256'], [result]);
}

function stubMint(): void {
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
  sinon.stub(Connection.prototype, 'getAccountInfo').resolves({
    executable: false,
    owner: TOKEN_PROGRAM_ID,
    lamports: 1_000_000,
    data,
  });
}

describe('DeBridgeBridge.execute', function () {
  let callStub: sinon.SinonStub;
  beforeEach(() => {
    callStub = sinon
      .stub(ethers.providers.StaticJsonRpcProvider.prototype, 'call')
      .callsFake((tx) => chainRead(tx));
    sinon
      .stub(TronJsonRpcProvider.prototype, 'call')
      .callsFake((tx) => chainRead(tx));
    stubMint();
    sinon
      .stub(ethers.providers.StaticJsonRpcProvider.prototype, 'getStorageAt')
      .resolves(ethers.utils.hexZeroPad(DLN_FORWARDER_IMPLEMENTATION, 32));
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

  it('rejects API fee and transaction value tampering against the source contract', async () => {
    const response = makeCreateTxResponse();
    response.fixFee = (FIX_FEE * 2n).toString();
    response.tx.value = response.fixFee;
    sinon.stub(globalThis, 'fetch').resolves(jsonResponse(response));
    const send = sinon.stub(ethers.Wallet.prototype, 'sendTransaction');
    const error = await getRejection(
      new DeBridgeBridge(BRIDGE_CONFIG, logger).prepare(
        makeBridgeQuote(BSC_TO_TRON_PARAMS, makeQuoteResponse()),
      ),
    );
    expect(error.message).to.include(
      'fixed fee does not match source contract',
    );
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
    expect(result).to.deep.equal({
      txHash: `0x${'3'.padStart(64, '0')}`,
      fromChain: 56,
      toChain: 728126428,
      transferId: ORDER_ID,
    });
  });

  it('approves only the source amount to the validated forwarder and submits the nested order', async () => {
    const response = makeForwarderResponse();
    sinon.stub(globalThis, 'fetch').resolves(jsonResponse(response));
    sinon
      .stub(ethers.providers.StaticJsonRpcProvider.prototype, 'getBlock')
      .resolves({ timestamp: 0 } as ethers.providers.Block);
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
    expect(result.transferId).to.equal(ORDER_ID);
  });

  it('rejects malicious wrappers before allowance reads, approvals or source submission', async () => {
    const response = makeForwarderResponse();
    const original = response.tx.data;
    const fetchStub = sinon.stub(globalThis, 'fetch');
    const call = callStub;
    const send = sinon.stub(ethers.Wallet.prototype, 'sendTransaction');
    for (const index of [0, 1, 3, 8]) {
      response.tx.data = changeCall(
        DLN_FORWARDER_INTERFACE,
        original,
        (args) => {
          const next = [...args];
          next[index] = index === 1 ? SOURCE_AMOUNT + 1n : SIGNER_ADDRESS;
          return next;
        },
      );
      fetchStub.resolves(jsonResponse(response));
      await getRejection(
        new DeBridgeBridge(BRIDGE_CONFIG, logger).execute(
          makeBridgeQuote(BSC_TO_TRON_PARAMS, makeQuoteResponse()),
          { [ProtocolType.Ethereum]: PRIVATE_KEY },
        ),
      );
    }
    expect(call.called).to.equal(false);
    expect(send.called).to.equal(false);
  });

  it('rejects an expired wrapper before allowance or approval even when its registry is valid', async () => {
    sinon
      .stub(globalThis, 'fetch')
      .resolves(jsonResponse(makeForwarderResponse()));
    const call = callStub.resolves(
      ethers.utils.defaultAbiCoder.encode(['address'], [ZERO_EX_BSC_SETTLER]),
    );
    sinon
      .stub(ethers.providers.StaticJsonRpcProvider.prototype, 'getBlock')
      .resolves({ timestamp: 2_000_000_000 } as ethers.providers.Block);
    const send = sinon.stub(ethers.Wallet.prototype, 'sendTransaction');
    const error = await getRejection(
      new DeBridgeBridge(BRIDGE_CONFIG, logger).execute(
        makeBridgeQuote(BSC_TO_TRON_PARAMS, makeQuoteResponse()),
        { [ProtocolType.Ethereum]: PRIVATE_KEY },
      ),
    );
    expect(error.message).to.include('deadline has expired');
    expect(call.callCount).to.equal(1);
    expect(await call.firstCall.args[0].to).to.equal(ZERO_EX_DEPLOYER);
    expect(send.called).to.equal(false);
  });

  it('rejects value changes and direct calls to the source token', async () => {
    const changedValue = makeCreateTxResponse();
    changedValue.tx.value = (FIX_FEE + 1n).toString();
    const directTokenCall = makeCreateTxResponse();
    directTokenCall.tx.to = BSC_USDT;
    const fetchStub = sinon.stub(globalThis, 'fetch');
    fetchStub.onFirstCall().resolves(jsonResponse(changedValue));
    fetchStub.onSecondCall().resolves(jsonResponse(directTokenCall));
    const bridge = new DeBridgeBridge(BRIDGE_CONFIG, logger);
    const quote = makeBridgeQuote(BSC_TO_TRON_PARAMS, makeQuoteResponse());

    const valueError = await getRejection(
      bridge.execute(quote, { [ProtocolType.Ethereum]: PRIVATE_KEY }),
    );
    expect(valueError.message).to.include('does not match expected');
    const targetError = await getRejection(
      bridge.execute(quote, { [ProtocolType.Ethereum]: PRIVATE_KEY }),
    );
    expect(targetError.message).to.include('not the documented DLN source');
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

  for (const [field, value] of Object.entries({
    giveTokenAddress: '0x1111111111111111111111111111111111111111',
    giveAmount: SOURCE_AMOUNT + 1n,
    takeTokenAddress: '0x1111111111111111111111111111111111111111',
    takeAmount: 1n,
    takeChainId: 1,
    receiverDst: '0x1111111111111111111111111111111111111111',
    givePatchAuthoritySrc: '0x1111111111111111111111111111111111111111',
    orderAuthorityAddressDst: '0x1111111111111111111111111111111111111111',
    allowedCancelBeneficiarySrc: '0x1111111111111111111111111111111111111111',
    externalCall: '0xdeadbeef',
  })) {
    it(`rejects an altered DLN order ${field} before signing`, async () => {
      const response = makeCreateTxResponse();
      response.tx.data = makeEvmOrderData(
        BSC_TO_TRON_PARAMS,
        DESTINATION_AMOUNT,
        { [field]: value },
      );
      sinon.stub(globalThis, 'fetch').resolves(jsonResponse(response));
      const send = sinon.stub(ethers.Wallet.prototype, 'sendTransaction');
      await getRejection(
        new DeBridgeBridge(BRIDGE_CONFIG, logger).execute(
          makeBridgeQuote(BSC_TO_TRON_PARAMS, makeQuoteResponse()),
          { [ProtocolType.Ethereum]: PRIVATE_KEY },
        ),
      );
      expect(send.called).to.equal(false);
    });
  }

  it('rejects an unrelated-token drain even when quote metadata is valid', async () => {
    const response = makeCreateTxResponse();
    response.tx.to = '0x1111111111111111111111111111111111111111';
    response.tx.data = new ethers.utils.Interface([
      'function transfer(address,uint256)',
    ]).encodeFunctionData('transfer', [SIGNER_ADDRESS, SOURCE_AMOUNT]);
    sinon.stub(globalThis, 'fetch').resolves(jsonResponse(response));
    const send = sinon.stub(ethers.Wallet.prototype, 'sendTransaction');
    const error = await getRejection(
      new DeBridgeBridge(BRIDGE_CONFIG, logger).execute(
        makeBridgeQuote(BSC_TO_TRON_PARAMS, makeQuoteResponse()),
        { [ProtocolType.Ethereum]: PRIVATE_KEY },
      ),
    );
    expect(error.message).to.include('not the documented DLN source');
    expect(send.called).to.equal(false);
  });

  it('rejects a Solana transfer appended to an otherwise valid DLN order', async () => {
    const signer = Keypair.generate();
    const data = makeSerializedSolanaTransaction(signer, [
      makeSolanaOrderInstruction(signer),
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 100_000,
      }),
    ]);
    sinon.stub(globalThis, 'fetch').resolves(
      jsonResponse({
        ...makeSolanaQuoteResponse(),
        orderId: ORDER_ID,
        fixFee: '0',
        tx: { data },
      }),
    );
    const send = sinon.stub(Connection.prototype, 'sendTransaction');
    const error = await getRejection(
      new DeBridgeBridge(BRIDGE_CONFIG, logger).execute(
        makeBridgeQuote(makeSolanaParams(signer), makeSolanaQuoteResponse()),
        { [ProtocolType.Sealevel]: bs58.encode(signer.secretKey) },
      ),
    );
    expect(error.message).to.include('unsupported program');
    expect(send.called).to.equal(false);
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
    expect(onTransferId.calledOnceWithExactly(ORDER_ID)).to.equal(true);
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
      .resolves('solana-signature');
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
      txHash: 'solana-signature',
      fromChain: 1399811149,
      toChain: 56,
      transferId: ORDER_ID,
    });
  });
});

describe('DeBridgeBridge.getStatus', function () {
  let sourceReceipt: ethers.providers.TransactionReceipt;
  let destinationReceipt: ethers.providers.TransactionReceipt;
  let receiptStub: sinon.SinonStub;
  beforeEach(async () => {
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

  it('uses the persisted order ID and maps completion metadata', async () => {
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

    const result = await new DeBridgeBridge(BRIDGE_CONFIG, logger).getStatus(
      SOURCE_TX_HASH,
      56,
      728126428,
      ORDER_ID,
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
          new DeBridgeBridge(BRIDGE_CONFIG, logger).getStatus(
            SOURCE_TX_HASH,
            56,
            728126428,
            ORDER_ID,
          ),
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
          new DeBridgeBridge(BRIDGE_CONFIG, logger).getStatus(
            SOURCE_TX_HASH,
            56,
            728126428,
            ORDER_ID,
          ),
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
    const bridge = new DeBridgeBridge(BRIDGE_CONFIG, logger);
    expect(
      (await bridge.getStatus(SOURCE_TX_HASH, 56, 728126428, id)).status,
    ).to.equal('complete');
    expect(await call.firstCall.args[1]).to.equal(
      destinationReceipt.blockNumber,
    );
    call.resolves(ethers.utils.defaultAbiCoder.encode(['uint256'], [1]));
    expect(
      (await getRejection(bridge.getStatus(SOURCE_TX_HASH, 56, 728126428, id)))
        .message,
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
    const bridge = new DeBridgeBridge(BRIDGE_CONFIG, logger);
    for (const receipt of [sourceReceipt, destinationReceipt]) {
      receipt.confirmations = 0;
      expect(
        (await bridge.getStatus(SOURCE_TX_HASH, 56, 728126428, ORDER_ID))
          .status,
      ).to.equal('pending');
      receipt.confirmations = 1;
    }
    destinationReceipt.blockNumber = 2;
    expect(
      (await bridge.getStatus(SOURCE_TX_HASH, 56, 728126428, ORDER_ID)).status,
    ).to.equal('pending');
    receiptStub.rejects(new Error('receipt RPC timeout'));
    expect(
      (
        await getRejection(
          bridge.getStatus(SOURCE_TX_HASH, 56, 728126428, ORDER_ID),
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
    const bridge = new DeBridgeBridge(BRIDGE_CONFIG, logger);
    expect(
      (await bridge.getStatus(SOURCE_TX_HASH, 56, 1399811149, id)).status,
    ).to.equal('complete');
    expect(get.firstCall.args[1]).to.deep.equal({
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    amount--;
    expect(
      (await getRejection(bridge.getStatus(SOURCE_TX_HASH, 56, 1399811149, id)))
        .message,
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
      const result = await new DeBridgeBridge(BRIDGE_CONFIG, logger).getStatus(
        'tx',
        56,
        728126428,
        ORDER_ID,
      );
      expect(result).to.deep.equal({ status: 'failed', error: status });
      fetchStub.resetBehavior();
    }
  });

  it('keeps API fulfillment pending without a destination transaction', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    for (const status of ['Fulfilled', 'SentUnlock', 'ClaimedUnlock']) {
      fetchStub.resolves(jsonResponse({ orderId: ORDER_ID, status }));
      const result = await new DeBridgeBridge(BRIDGE_CONFIG, logger).getStatus(
        'tx',
        56,
        728126428,
        ORDER_ID,
      );
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
    const bridge = new DeBridgeBridge(BRIDGE_CONFIG, logger);

    expect(await bridge.getStatus('tx', 56, 728126428, ORDER_ID)).to.deep.equal(
      { status: 'pending', substatus: 'Created' },
    );
    expect(await bridge.getStatus('tx', 56, 728126428, ORDER_ID)).to.deep.equal(
      { status: 'not_found' },
    );
  });

  it('rejects missing IDs, mismatched IDs, and unknown statuses', async () => {
    const bridge = new DeBridgeBridge(BRIDGE_CONFIG, logger);
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
      bridge.getStatus('tx', 56, 728126428, ORDER_ID),
    );
    expect(mismatchedIdError.message).to.include('unexpected order ID');
    const statusError = await getRejection(
      bridge.getStatus('tx', 56, 728126428, ORDER_ID),
    );
    expect(statusError.message).to.include('status');
  });
});
