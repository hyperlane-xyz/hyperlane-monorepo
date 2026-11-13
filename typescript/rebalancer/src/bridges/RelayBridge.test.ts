import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { BigNumber, Wallet, constants, providers, utils } from 'ethers';
import { pino } from 'pino';
import sinon from 'sinon';

import {
  MultiProvider,
  type ChainMap,
  type ChainMetadata,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, TransactionSubmissionError } from '@hyperlane-xyz/utils';

import type { BridgeQuoteParams } from '../interfaces/IExternalBridge.js';

import { RelayBridge } from './RelayBridge.js';
import {
  RelayClient,
  RelayStatus,
  RelayStepId,
  RelayTradeType,
  type RelayQuoteResponse,
} from './RelayClient.js';

chai.use(chaiAsPromised);

const logger = pino({ level: 'silent' });
const wallet = Wallet.createRandom();
const TOKEN = '0x1111111111111111111111111111111111111111';
const DESTINATION_TOKEN = '0x2222222222222222222222222222222222222222';
const DEPOSITORY = '0x3333333333333333333333333333333333333333';
const REQUEST_ID = `0x${'ab'.repeat(32)}`;
const SOURCE_HASH = `0x${'cd'.repeat(32)}`;
const DESTINATION_HASH = `0x${'ef'.repeat(32)}`;
const ABI = new utils.Interface([
  'function decimals() view returns (uint8)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const metadata: ChainMap<ChainMetadata> = {
  base: {
    name: 'base',
    chainId: 8453,
    domainId: 8453,
    protocol: ProtocolType.Ethereum,
    rpcUrls: [{ http: 'https://base.invalid' }],
    blocks: { confirmations: 1, reorgPeriod: 1 },
  },
  elysium: {
    name: 'elysium',
    chainId: 99901,
    domainId: 99901,
    protocol: ProtocolType.Ethereum,
    rpcUrls: [{ http: 'https://elysium.invalid' }],
    blocks: { confirmations: 1, reorgPeriod: 1 },
  },
};
const params: BridgeQuoteParams = {
  fromChain: 8453,
  toChain: 99901,
  fromToken: TOKEN,
  toToken: DESTINATION_TOKEN,
  fromAmount: 10_000_000n,
  fromAddress: wallet.address,
};

function response(
  input = '10000000',
  output = '9970000',
  minimum = '9960000',
): RelayQuoteResponse {
  return {
    requestId: REQUEST_ID,
    steps: [
      {
        id: RelayStepId.Approve,
        kind: 'transaction',
        requestId: REQUEST_ID,
        items: [
          {
            data: {
              from: wallet.address,
              to: TOKEN,
              data: ABI.encodeFunctionData('approve', [DEPOSITORY, input]),
              value: '0',
              chainId: 8453,
            },
          },
        ],
      },
      {
        id: RelayStepId.Deposit,
        kind: 'transaction',
        requestId: REQUEST_ID,
        depositAddress: '',
        items: [
          {
            data: {
              from: wallet.address,
              to: DEPOSITORY,
              data: '0xdeadbeef',
              value: '0',
              chainId: 8453,
            },
          },
        ],
      },
    ],
    details: {
      sender: wallet.address,
      recipient: wallet.address,
      currencyIn: {
        currency: { chainId: 8453, address: TOKEN, decimals: 6 },
        amount: input,
        minimumAmount: input,
      },
      currencyOut: {
        currency: { chainId: 99901, address: DESTINATION_TOKEN, decimals: 6 },
        amount: output,
        minimumAmount: minimum,
      },
      timeEstimate: 1,
    },
  };
}

function receipt(
  hash: string,
  token?: string,
  from = DEPOSITORY,
  to = wallet.address,
  amount = 0n,
): providers.TransactionReceipt {
  const encoded = ABI.encodeEventLog(ABI.getEvent('Transfer'), [
    from,
    to,
    amount,
  ]);
  return {
    to: DEPOSITORY,
    from: wallet.address,
    contractAddress: constants.AddressZero,
    transactionIndex: 0,
    gasUsed: BigNumber.from(1),
    logsBloom: '0x',
    blockHash: SOURCE_HASH,
    transactionHash: hash,
    blockNumber: 10,
    confirmations: 3,
    cumulativeGasUsed: BigNumber.from(1),
    effectiveGasPrice: BigNumber.from(1),
    byzantium: true,
    type: 0,
    status: 1,
    logs: token
      ? [
          {
            ...encoded,
            address: token,
            blockNumber: 10,
            blockHash: SOURCE_HASH,
            transactionHash: hash,
            transactionIndex: 0,
            logIndex: 0,
            removed: false,
          },
        ]
      : [],
  };
}

function transaction(hash: string): providers.TransactionResponse {
  return {
    hash,
    from: wallet.address,
    to: DEPOSITORY,
    confirmations: 3,
    nonce: 0,
    gasLimit: BigNumber.from(100000),
    gasPrice: BigNumber.from(1),
    data: '0xdeadbeef',
    value: constants.Zero,
    chainId: 8453,
    wait: async () => receipt(hash),
  };
}

describe('RelayBridge', () => {
  let client: RelayClient;
  let bridge: RelayBridge;
  let apiQuote: sinon.SinonStub<
    Parameters<RelayClient['quote']>,
    ReturnType<RelayClient['quote']>
  >;
  let apiStatus: sinon.SinonStub<
    Parameters<RelayClient['getStatus']>,
    ReturnType<RelayClient['getStatus']>
  >;
  let sourceProvider: providers.StaticJsonRpcProvider;
  let destinationProvider: providers.StaticJsonRpcProvider;
  let sourceDecimals: number;
  let destinationDecimals: number;
  let allowance: bigint;
  let broadcasts: providers.TransactionResponse[];
  let send: sinon.SinonStub<
    Parameters<providers.Provider['sendTransaction']>,
    ReturnType<providers.Provider['sendTransaction']>
  >;
  let sourceReceipt: sinon.SinonStub<
    Parameters<providers.StaticJsonRpcProvider['getTransactionReceipt']>,
    ReturnType<providers.StaticJsonRpcProvider['getTransactionReceipt']>
  >;
  let destinationReceipt: sinon.SinonStub<
    Parameters<providers.StaticJsonRpcProvider['getTransactionReceipt']>,
    ReturnType<providers.StaticJsonRpcProvider['getTransactionReceipt']>
  >;

  beforeEach(() => {
    client = new RelayClient();
    apiQuote = sinon.stub(client, 'quote').resolves(response());
    apiStatus = sinon.stub(client, 'getStatus').resolves({
      status: RelayStatus.Success,
      originChainId: 8453,
      destinationChainId: 99901,
      inTxHashes: [SOURCE_HASH],
      txHashes: [DESTINATION_HASH],
    });
    const multiProvider = new MultiProvider(metadata);
    sourceProvider = new providers.StaticJsonRpcProvider(
      'https://base.invalid',
      8453,
    );
    destinationProvider = new providers.StaticJsonRpcProvider(
      'https://elysium.invalid',
      99901,
    );
    multiProvider.setProvider(8453, sourceProvider);
    multiProvider.setProvider(99901, destinationProvider);
    bridge = new RelayBridge({}, logger, client, multiProvider);
    sourceDecimals = destinationDecimals = 6;
    allowance = 0n;
    broadcasts = [];
    sinon.stub(sourceProvider, 'call').callsFake(async (request) => {
      const data = String(await request.data);
      if (data.startsWith(ABI.getSighash('decimals')))
        return ABI.encodeFunctionResult('decimals', [sourceDecimals]);
      if (data.startsWith(ABI.getSighash('allowance')))
        return ABI.encodeFunctionResult('allowance', [allowance]);
      throw new Error('Unexpected contract read');
    });
    sinon
      .stub(destinationProvider, 'call')
      .callsFake(async () =>
        ABI.encodeFunctionResult('decimals', [destinationDecimals]),
      );
    sourceReceipt = sinon
      .stub(sourceProvider, 'getTransactionReceipt')
      .resolves(
        receipt(SOURCE_HASH, TOKEN, wallet.address, DEPOSITORY, 10_000_000n),
      );
    destinationReceipt = sinon
      .stub(destinationProvider, 'getTransactionReceipt')
      .resolves(
        receipt(
          DESTINATION_HASH,
          DESTINATION_TOKEN,
          DEPOSITORY,
          wallet.address,
          9_970_000n,
        ),
      );
    sinon
      .stub(sourceProvider, 'getTransaction')
      .resolves(transaction(SOURCE_HASH));
    sinon
      .stub(Wallet.prototype, 'estimateGas')
      .resolves(BigNumber.from(100000));
    sinon
      .stub(Wallet.prototype, 'populateTransaction')
      .callsFake(async (request) => ({
        to: String(await request.to),
        data: String(await request.data),
        value: BigNumber.from((await request.value) ?? 0),
        chainId: Number((await request.chainId) ?? 8453),
        nonce: 0,
        gasLimit: BigNumber.from(100000),
        gasPrice: BigNumber.from(1),
      }));
    send = sinon
      .stub(sourceProvider, 'sendTransaction')
      .callsFake(async (signed) => {
        const raw = await signed;
        const decoded = utils.parseTransaction(raw);
        if (decoded.to?.toLowerCase() === TOKEN) {
          const amount: unknown = ABI.decodeFunctionData(
            'approve',
            decoded.data,
          )[1];
          expect(BigNumber.isBigNumber(amount)).to.equal(true);
          if (BigNumber.isBigNumber(amount)) allowance = amount.toBigInt();
        }
        const sent = {
          ...transaction(utils.keccak256(raw)),
          data: decoded.data,
          to: decoded.to,
        };
        broadcasts.push(sent);
        return sent;
      });
  });

  afterEach(() => sinon.restore());

  it('quotes exact input using normalized addresses and configured slippage', async () => {
    const quote = await bridge.quote(params);
    expect(quote.toAmountMin).to.equal(9_960_000n);
    expect(apiQuote.firstCall.args[0]).to.include({
      user: wallet.address.toLowerCase(),
      originCurrency: TOKEN,
      tradeType: RelayTradeType.ExactInput,
      slippageTolerance: '10',
    });
  });

  it('accepts whole basis points despite floating-point representation', async () => {
    await bridge.quote({ ...params, slippage: 0.0003 });
    expect(apiQuote.firstCall.args[0].slippageTolerance).to.equal('3');
  });

  it('quotes exact output and rejects a minimum below the desired amount', async () => {
    apiQuote.resolves(response('10000000', '9970000', '9970000'));
    await bridge.quote({
      ...params,
      fromAmount: undefined,
      toAmount: 9_970_000n,
    });
    expect(apiQuote.firstCall.args[0].tradeType).to.equal(
      RelayTradeType.ExactOutput,
    );
    apiQuote.resolves(response());
    await expect(
      bridge.quote({ ...params, fromAmount: undefined, toAmount: 9_970_000n }),
    ).to.be.rejectedWith('minimum below target');
  });

  it('includes slippage in the total one-percent loss limit', async () => {
    apiQuote.resolves(response('10000000', '9950000', '9899999'));
    await expect(bridge.quote(params)).to.be.rejectedWith('total loss budget');
    apiQuote.resolves(response('10000000', '9950000', '9900000'));
    expect((await bridge.quote(params)).toAmountMin).to.equal(9_900_000n);
  });

  it('normalizes the loss limit across source and destination decimals', async () => {
    sourceDecimals = 18;
    const quote = response('10000000000000000000');
    quote.details.currencyIn.currency.decimals = 18;
    apiQuote.resolves(quote);
    expect(
      (await bridge.quote({ ...params, fromAmount: 10n ** 19n })).toAmountMin,
    ).to.equal(9_960_000n);
    destinationDecimals = 18;
    await expect(
      bridge.quote({ ...params, fromAmount: 10n ** 19n }),
    ).to.be.rejectedWith('decimals mismatch');
  });

  for (const [name, change] of [
    [
      'wrong recipient',
      (quote: RelayQuoteResponse) => {
        quote.details.recipient = DEPOSITORY;
      },
    ],
    [
      'wrong token',
      (quote: RelayQuoteResponse) => {
        quote.details.currencyOut.currency.address = TOKEN;
      },
    ],
    [
      'wrong chain',
      (quote: RelayQuoteResponse) => {
        quote.details.currencyOut.currency.chainId = 1;
      },
    ],
    [
      'native value',
      (quote: RelayQuoteResponse) => {
        quote.steps[1].items[0].data.value = '1';
      },
    ],
    [
      'deposit address',
      (quote: RelayQuoteResponse) => {
        quote.steps[1].depositAddress = DEPOSITORY;
      },
    ],
    [
      'two deposits',
      (quote: RelayQuoteResponse) => {
        quote.steps.push(quote.steps[1]);
      },
    ],
    [
      'unbounded approval',
      (quote: RelayQuoteResponse) => {
        quote.steps[0].items[0].data.data = ABI.encodeFunctionData('approve', [
          DEPOSITORY,
          constants.MaxUint256,
        ]);
      },
    ],
  ] as const) {
    it(`rejects ${name} before any approval`, async () => {
      const quote = response();
      change(quote);
      apiQuote.resolves(quote);
      await expect(bridge.quote(params)).to.be.rejected;
      expect(broadcasts).to.have.length(0);
    });
  }

  it('rejects native tokens and ambiguous input/output amounts', async () => {
    await expect(
      bridge.quote({ ...params, fromToken: constants.AddressZero }),
    ).to.be.rejectedWith('ERC20');
    await expect(bridge.quote({ ...params, toAmount: 1n })).to.be.rejectedWith(
      'exactly one',
    );
    expect(apiQuote.called).to.equal(false);
  });

  it('refuses refreshed minimum drift before approval', async () => {
    const quote = await bridge.quote(params);
    apiQuote.resolves(response('10000000', '9970000', '9959999'));
    await expect(
      bridge.execute(quote, { [ProtocolType.Ethereum]: wallet.privateKey }),
    ).to.be.rejectedWith('below accepted minimum');
    expect(broadcasts).to.have.length(0);
  });

  it('refuses increased exact-output input', async () => {
    apiQuote.resolves(response('10000000', '9970000', '9970000'));
    const quote = await bridge.quote({
      ...params,
      fromAmount: undefined,
      toAmount: 9_970_000n,
    });
    apiQuote.resolves(response('10000001', '9970000', '9970000'));
    await expect(bridge.prepare(quote)).to.be.rejectedWith(
      'input exceeds accepted',
    );
  });

  it('uses an exact approval and records request identity before the source attempt', async () => {
    const quote = await bridge.quote(params);
    const observations: string[] = [];
    const result = await bridge.execute(
      quote,
      { [ProtocolType.Ethereum]: wallet.privateKey },
      {
        onTransferId: (identity) => {
          expect(JSON.parse(identity).minimumAmount).to.equal('9960000');
          observations.push('identity');
        },
        onSubmissionAttempt: () => {
          observations.push('attempt');
        },
        onSubmitted: () => {
          observations.push('submitted');
        },
        onApproval: (approval) => {
          if (approval) expect(approval.token).to.equal(TOKEN);
        },
      },
    );
    expect(observations).to.deep.equal(['identity', 'attempt', 'submitted']);
    expect(broadcasts).to.have.length(2);
    expect(allowance).to.equal(10_000_000n);
    expect(result.transferId).to.be.a('string');
  });

  it('does not deposit if the post-approval quote changes recipient or output floor', async () => {
    const quote = await bridge.quote(params);
    apiQuote.onCall(2).resolves(response('10000000', '9970000', '9959999'));
    await expect(
      bridge.execute(quote, { [ProtocolType.Ethereum]: wallet.privateKey }),
    ).to.be.rejectedWith('below accepted minimum');
    expect(broadcasts).to.have.length(1);
    expect(broadcasts[0].to?.toLowerCase()).to.equal(TOKEN);
  });

  it('does not broadcast when recording the provider identity fails', async () => {
    allowance = 10_000_000n;
    const quote = await bridge.quote(params);
    await expect(
      bridge.execute(
        quote,
        { [ProtocolType.Ethereum]: wallet.privateKey },
        {
          onTransferId: () => {
            throw new Error('record failed');
          },
        },
      ),
    ).to.be.rejectedWith('record failed');
    expect(broadcasts).to.have.length(0);
  });

  it('retains signed source identity on ambiguous transport failure', async () => {
    allowance = 10_000_000n;
    const quote = await bridge.quote(params);
    send.rejects(new Error('transport'));
    let attemptedHash: string | undefined;
    try {
      await bridge.execute(
        quote,
        { [ProtocolType.Ethereum]: wallet.privateKey },
        {
          onSubmissionAttempt: (hash) => {
            attemptedHash = hash;
          },
        },
      );
      expect.fail('Expected a submission error');
    } catch (error) {
      expect(error).to.be.instanceOf(TransactionSubmissionError);
      if (!(error instanceof TransactionSubmissionError)) throw error;
      expect(error.submissionState).to.equal('unknown');
      expect(error.txHash).to.equal(attemptedHash);
      expect(attemptedHash).to.match(/^0x[0-9a-f]{64}$/);
    }
    expect(send.calledOnce).to.equal(true);
  });

  function identity() {
    return JSON.stringify({
      version: 1,
      requestId: REQUEST_ID,
      fromChain: 8453,
      toChain: 99901,
      fromToken: TOKEN,
      toToken: DESTINATION_TOKEN,
      fromAddress: wallet.address,
      toAddress: wallet.address,
      inputAmount: '10000000',
      minimumAmount: '9960000',
    });
  }

  it('settles only from finalized source debit and actual destination credit', async () => {
    expect(
      await bridge.getStatus(SOURCE_HASH, 8453, 99901, identity()),
    ).to.deep.equal({
      status: 'complete',
      receivingTxHash: DESTINATION_HASH,
      receivedAmount: 9_970_000n,
    });
  });

  it('keeps missing identity pending for manual reconciliation', async () => {
    expect((await bridge.getStatus(SOURCE_HASH, 8453, 99901)).status).to.equal(
      'pending',
    );
    expect(apiStatus.called).to.equal(false);
  });

  it('resolves status domains that differ from EVM chain IDs', async () => {
    const multiProvider = new MultiProvider({
      base: { ...metadata.base, domainId: 84530 },
      elysium: { ...metadata.elysium, domainId: 999010 },
    });
    multiProvider.setProvider('base', sourceProvider);
    multiProvider.setProvider('elysium', destinationProvider);
    bridge = new RelayBridge({}, logger, client, multiProvider);
    expect(
      await bridge.getStatus(SOURCE_HASH, 84530, 999010, identity()),
    ).to.deep.equal({
      status: 'complete',
      receivingTxHash: DESTINATION_HASH,
      receivedAmount: 9_970_000n,
    });
  });

  it('does not treat an API success with another source transaction as settlement', async () => {
    apiStatus.resolves({
      status: RelayStatus.Success,
      originChainId: 8453,
      destinationChainId: 99901,
      inTxHashes: [DESTINATION_HASH],
      txHashes: [DESTINATION_HASH],
    });
    await expect(
      bridge.getStatus(SOURCE_HASH, 8453, 99901, identity()),
    ).to.be.rejectedWith('source transaction');
  });

  it('keeps failure and manual-refund-required outcomes pending', async () => {
    apiStatus.resolves({ status: RelayStatus.Failure, failReason: 'SLIPPAGE' });
    expect(
      (await bridge.getStatus(SOURCE_HASH, 8453, 99901, identity())).status,
    ).to.equal('pending');
    apiStatus.resolves({
      status: RelayStatus.Failure,
      refundFailReason: 'AMOUNT_TOO_LOW_TO_REFUND',
    });
    expect(
      await bridge.getStatus(SOURCE_HASH, 8453, 99901, identity()),
    ).to.deep.equal({
      status: 'pending',
      substatus: 'Relay manual refund required: AMOUNT_TOO_LOW_TO_REFUND',
    });
  });

  it('rejects destination receipts without sufficient net token credit', async () => {
    destinationReceipt.resolves(
      receipt(
        DESTINATION_HASH,
        DESTINATION_TOKEN,
        DEPOSITORY,
        wallet.address,
        9_959_999n,
      ),
    );
    await expect(
      bridge.getStatus(SOURCE_HASH, 8453, 99901, identity()),
    ).to.be.rejectedWith('accepted minimum');
  });

  it('waits for destination finality', async () => {
    destinationReceipt.resolves({
      ...receipt(
        DESTINATION_HASH,
        DESTINATION_TOKEN,
        DEPOSITORY,
        wallet.address,
        9_970_000n,
      ),
      confirmations: 0,
    });
    expect(
      (await bridge.getStatus(SOURCE_HASH, 8453, 99901, identity())).status,
    ).to.equal('pending');
  });

  it('requires a verified origin-token refund before reporting failed', async () => {
    apiStatus.resolves({
      status: RelayStatus.Refund,
      originChainId: 8453,
      destinationChainId: 99901,
      inTxHashes: [SOURCE_HASH],
      txHashes: [DESTINATION_HASH],
    });
    sourceReceipt
      .withArgs(DESTINATION_HASH)
      .resolves(receipt(DESTINATION_HASH));
    await expect(
      bridge.getStatus(SOURCE_HASH, 8453, 99901, identity()),
    ).to.be.rejectedWith('no verified source token credit');
    sourceReceipt
      .withArgs(DESTINATION_HASH)
      .resolves(
        receipt(
          DESTINATION_HASH,
          TOKEN,
          DEPOSITORY,
          wallet.address,
          9_990_000n,
        ),
      );
    expect(
      await bridge.getStatus(SOURCE_HASH, 8453, 99901, identity()),
    ).to.deep.equal({
      status: 'failed',
      error: 'Relay refunded 9990000 source token units',
    });
  });
});
