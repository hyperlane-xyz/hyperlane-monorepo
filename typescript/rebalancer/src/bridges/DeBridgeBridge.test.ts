import {
  Connection,
  Keypair,
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
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import type {
  BridgeQuote,
  BridgeQuoteParams,
} from '../interfaces/IExternalBridge.js';
import { DeBridgeBridge, type DeBridgeBridgeConfig } from './DeBridgeBridge.js';
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
const ORDER_ID = `0x${'a'.repeat(64)}`;
const OTHER_ORDER_ID = `0x${'b'.repeat(64)}`;
const DESTINATION_TX_HASH = `0x${'c'.repeat(64)}`;
const DLN_SOURCE = '0xE6f924E3C42350684aF70F798c3cA2533A4c5Bd0';
const SOURCE_AMOUNT = 1_000_000_000_000_000_000_000n;
const DESTINATION_AMOUNT = 996_000_000n;
const FIX_FEE = 5_000_000_000_000_000n;

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

function makeSerializedSolanaTransaction(payer: Keypair): string {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [],
  }).compileToV0Message();
  return `0x${Buffer.from(new VersionedTransaction(message).serialize()).toString('hex')}`;
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
      data: '0xb9303701',
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
    expect(hyperlaneChainIdToDebridge(9745)).to.equal(100000028);
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
    const error = await getRejection(
      Promise.resolve().then(() => hyperlaneChainIdToDebridge(99999)),
    );
    expect(error.message).to.include('not supported');
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

describe('DeBridgeBridge.execute', function () {
  afterEach(() => sinon.restore());

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
      .stub(globalThis, 'fetch')
      .resolves(jsonResponse(makeCreateTxResponse()));
    sinon
      .stub(ethers.providers.StaticJsonRpcProvider.prototype, 'call')
      .resolves(
        ethers.utils.defaultAbiCoder.encode(['uint256'], [SOURCE_AMOUNT + 1n]),
      );

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
      data: '0xb9303701',
    });
    expect(captured[2].value.toString()).to.equal(FIX_FEE.toString());
    expect(result).to.deep.equal({
      txHash: `0x${'3'.padStart(64, '0')}`,
      fromChain: 56,
      toChain: 728126428,
      transferId: ORDER_ID,
    });
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
    expect(targetError.message).to.include('cannot be the source token');
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
        tx: { to: DLN_SOURCE, data: '0xb9303701', value: '4000000' },
      }),
    );
    sinon
      .stub(TronJsonRpcProvider.prototype, 'call')
      .resolves(ethers.utils.defaultAbiCoder.encode(['uint256'], [0]));
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
    expect(approval[0]).to.equal(DLN_SOURCE);
    expect(approval[1].toString()).to.equal('1000000000');
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

  it('signs, confirms, and returns the order ID for Solana', async () => {
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
    sinon.stub(Connection.prototype, 'confirmTransaction').resolves({
      context: { slot: 1 },
      value: { err: null },
    });

    const result = await new DeBridgeBridge(BRIDGE_CONFIG, logger).execute(
      makeBridgeQuote(params, response),
      { [ProtocolType.Sealevel]: bs58.encode(signer.secretKey) },
    );

    expect(sendStub.calledOnce).to.equal(true);
    expect(result).to.deep.equal({
      txHash: 'solana-signature',
      fromChain: 1399811149,
      toChain: 56,
      transferId: ORDER_ID,
    });
  });
});

describe('DeBridgeBridge.getStatus', function () {
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
      'origin-transaction-hash',
      56,
      728126428,
      ORDER_ID,
    );

    expect(calledUrl).to.include(`/order/${ORDER_ID}/status`);
    expect(calledUrl).not.to.include('origin-transaction-hash');
    expect(result).to.deep.equal({
      status: 'complete',
      receivingTxHash: DESTINATION_TX_HASH,
      receivedAmount: DESTINATION_AMOUNT,
    });
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

  it('maps all fulfillment states to complete', async () => {
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
        status: 'complete',
        receivingTxHash: '',
        receivedAmount: 0n,
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
