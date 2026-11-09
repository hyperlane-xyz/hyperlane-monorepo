import { rejects } from 'node:assert/strict';

import {
  Address,
  ParentToChildMessageReader,
  ParentToChildMessageStatus,
  ParentTransactionReceipt,
  type ParentToChildMessageWaitForStatusResult,
} from '@arbitrum/sdk';
import { ERC20Bridge__factory } from '@arbitrum/sdk/dist/lib/abi/factories/ERC20Bridge__factory.js';
import { Inbox__factory } from '@arbitrum/sdk/dist/lib/abi/factories/Inbox__factory.js';
import { L1ERC20Gateway__factory } from '@arbitrum/sdk/dist/lib/abi/factories/L1ERC20Gateway__factory.js';
import { L1GatewayRouter__factory } from '@arbitrum/sdk/dist/lib/abi/factories/L1GatewayRouter__factory.js';
import { IArbToken__factory } from '@arbitrum/sdk/dist/lib/abi/factories/IArbToken__factory.js';
import { RollupAdminLogic__factory } from '@arbitrum/sdk/dist/lib/abi/factories/RollupAdminLogic__factory.js';
import { resetNetworksToDefault } from '@arbitrum/sdk/dist/lib/dataEntities/networks.js';
import { expect } from 'chai';
import { ethers } from 'ethers';
import { pino } from 'pino';
import sinon from 'sinon';

import { ERC20__factory } from '@hyperlane-xyz/core';
import type { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  TransactionSubmissionError,
  assert,
} from '@hyperlane-xyz/utils';

import type { BridgeQuoteParams } from '../interfaces/IExternalBridge.js';

import {
  ELYSIUM_NATIVE_BRIDGE,
  ElysiumNativeBridge,
} from './ElysiumNativeBridge.js';

const logger = pino({ level: 'silent' });
const TEST_KEY = ethers.utils.id('Elysium native bridge unit test signer');
const SENDER = new ethers.Wallet(TEST_KEY).address;
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const INBOX = '0xce59f8b65ad41c9dae4c07a0571a39824bd92cff';
const BRIDGE = '0x503d572157113faaad4dbed2647bb10b949216b6';
const SOURCE_HASH = ethers.utils.id('native bridge parent transaction');
const CHILD_HASH = ethers.utils.id('native bridge child transaction');
const AMOUNT = 1_000_000n;
const EXPECTED_NATIVE_VALUE = 60_000_000_004_000n;
const routerInterface = L1GatewayRouter__factory.createInterface();
const gatewayInterface = L1ERC20Gateway__factory.createInterface();
const tokenInterface = ERC20__factory.createInterface();
const rollupInterface = RollupAdminLogic__factory.createInterface();
const inboxInterface = Inbox__factory.createInterface();
const bridgeInterface = ERC20Bridge__factory.createInterface();
const childTokenInterface = IArbToken__factory.createInterface();
const ALIASED_PARENT_GATEWAY = new Address(
  ELYSIUM_NATIVE_BRIDGE.parentGateway,
).applyAlias().value;

const METADATA: ChainMap<ChainMetadata> = {
  hyperevm: {
    name: 'hyperevm',
    chainId: 999,
    domainId: 999,
    protocol: ProtocolType.Ethereum,
    rpcUrls: [{ http: 'https://parent.example.invalid' }],
    blocks: { confirmations: 1, reorgPeriod: 0 },
  },
  elysium: {
    name: 'elysium',
    chainId: 99901,
    domainId: 99901,
    protocol: ProtocolType.Ethereum,
    rpcUrls: [{ http: 'https://child.example.invalid' }],
    blocks: { confirmations: 1, reorgPeriod: 0 },
  },
};

function quoteParams(
  overrides: Partial<BridgeQuoteParams> = {},
): BridgeQuoteParams {
  return {
    fromChain: 999,
    toChain: 99901,
    fromToken: ELYSIUM_NATIVE_BRIDGE.parentToken,
    toToken: ELYSIUM_NATIVE_BRIDGE.childToken,
    fromAmount: AMOUNT,
    fromAddress: SENDER,
    toAddress: RECIPIENT,
    ...overrides,
  };
}

function eventLog(
  address: string,
  encoded: { data: string; topics: string[] },
  transactionHash: string,
): ethers.providers.Log {
  return {
    ...encoded,
    address,
    transactionHash,
    blockNumber: 10,
    blockHash: ethers.utils.id('block'),
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

function tokenTransfer(
  token: string,
  from: string,
  to: string,
  amount: bigint,
  hash = SOURCE_HASH,
) {
  return eventLog(
    token,
    tokenInterface.encodeEventLog(tokenInterface.getEvent('Transfer'), [
      from,
      to,
      amount,
    ]),
    hash,
  );
}

function receipt(
  hash: string,
  logs: ethers.providers.Log[] = [],
): ethers.providers.TransactionReceipt {
  return {
    to: ELYSIUM_NATIVE_BRIDGE.parentRouter,
    from: SENDER,
    contractAddress: ethers.constants.AddressZero,
    transactionIndex: 0,
    gasUsed: ethers.BigNumber.from(100_000),
    logsBloom: '0x',
    blockHash: ethers.utils.id('block'),
    transactionHash: hash,
    logs,
    blockNumber: 10,
    confirmations: 2,
    cumulativeGasUsed: ethers.BigNumber.from(100_000),
    effectiveGasPrice: ethers.BigNumber.from(100_000_000),
    byzantium: true,
    type: 2,
    status: 1,
  };
}

function parentReceipt(): ethers.providers.TransactionReceipt {
  return receipt(SOURCE_HASH, [
    eventLog(
      ELYSIUM_NATIVE_BRIDGE.parentGateway,
      gatewayInterface.encodeEventLog(
        gatewayInterface.getEvent('DepositInitiated'),
        [ELYSIUM_NATIVE_BRIDGE.parentToken, SENDER, RECIPIENT, 1, AMOUNT],
      ),
      SOURCE_HASH,
    ),
    tokenTransfer(
      ELYSIUM_NATIVE_BRIDGE.parentToken,
      SENDER,
      ELYSIUM_NATIVE_BRIDGE.parentGateway,
      AMOUNT,
    ),
  ]);
}

function childReceipt(
  amount = AMOUNT,
  recipient = RECIPIENT,
): ethers.providers.TransactionReceipt {
  return receipt(CHILD_HASH, [
    tokenTransfer(
      ELYSIUM_NATIVE_BRIDGE.childToken,
      ethers.constants.AddressZero,
      recipient,
      amount,
      CHILD_HASH,
    ),
  ]);
}

describe('ElysiumNativeBridge', () => {
  let bridge: ElysiumNativeBridge;
  let parent: ethers.providers.StaticJsonRpcProvider;
  let child: ethers.providers.StaticJsonRpcProvider;
  let mappedGateway: string;
  let mappedToken: string;
  let childParentToken: string;
  let childDecimals: number;
  let nativeToken: string;
  let sourceReceiptStub: sinon.SinonStub<
    Parameters<typeof parent.getTransactionReceipt>,
    ReturnType<typeof parent.getTransactionReceipt>
  >;
  let redemption: ParentToChildMessageWaitForStatusResult;
  let broadcasts: ethers.Transaction[];
  let beforeBroadcast: () => void;
  let sourceReceiptWait: () => Promise<void>;

  beforeEach(() => {
    resetNetworksToDefault();
    mappedGateway = ELYSIUM_NATIVE_BRIDGE.parentGateway;
    mappedToken = ELYSIUM_NATIVE_BRIDGE.childToken;
    childParentToken = ELYSIUM_NATIVE_BRIDGE.parentToken;
    childDecimals = 6;
    nativeToken = ethers.constants.AddressZero;
    redemption = {
      status: ParentToChildMessageStatus.REDEEMED,
      childTxReceipt: childReceipt(),
    };
    broadcasts = [];
    beforeBroadcast = () => {};
    sourceReceiptWait = async () => {};
    parent = new ethers.providers.StaticJsonRpcProvider(
      'https://parent.example.invalid',
      999,
    );
    child = new ethers.providers.StaticJsonRpcProvider(
      'https://child.example.invalid',
      99901,
    );
    sinon
      .stub(parent, 'getNetwork')
      .resolves({ chainId: 999, name: 'hyperevm' });
    sinon
      .stub(child, 'getNetwork')
      .resolves({ chainId: 99901, name: 'elysium' });
    for (const provider of [parent, child]) {
      sinon
        .stub(provider, 'getGasPrice')
        .resolves(ethers.BigNumber.from(100_000_000));
      sinon
        .stub(provider, 'estimateGas')
        .resolves(ethers.BigNumber.from(100_000));
      sinon.stub(provider, 'getBlock').resolves({
        number: 12,
        hash: ethers.utils.id('block'),
        parentHash: ethers.utils.id('parent block'),
        timestamp: 1_800_000_000,
        nonce: '0x0000000000000000',
        difficulty: 0,
        _difficulty: ethers.constants.Zero,
        gasLimit: ethers.BigNumber.from(30_000_000),
        gasUsed: ethers.constants.Zero,
        miner: SENDER,
        extraData: '0x',
        transactions: [],
        baseFeePerGas: ethers.BigNumber.from(100_000_000),
      });
    }
    sinon
      .stub(parent, 'getTransactionCount')
      .callsFake(async () => broadcasts.length);
    sourceReceiptStub = sinon
      .stub(parent, 'getTransactionReceipt')
      .resolves(parentReceipt());
    sinon.stub(parent, 'call').callsFake(async (transaction) => {
      const address = await transaction.to;
      const data = await transaction.data;
      assert(
        typeof address === 'string' && typeof data === 'string',
        'Missing test call',
      );
      const contracts = [
        {
          address: ELYSIUM_NATIVE_BRIDGE.parentRouter,
          iface: routerInterface,
          values: {
            getGateway: mappedGateway,
            calculateL2TokenAddress: mappedToken,
          },
        },
        {
          address: ELYSIUM_NATIVE_BRIDGE.parentGateway,
          iface: gatewayInterface,
          values: {
            counterpartGateway: ELYSIUM_NATIVE_BRIDGE.childGateway,
            inbox: INBOX,
            getOutboundCalldata: '0x1234',
          },
        },
        {
          address: ELYSIUM_NATIVE_BRIDGE.parentToken,
          iface: tokenInterface,
          values: { decimals: 6, allowance: 0 },
        },
        {
          address: ELYSIUM_NATIVE_BRIDGE.rollup,
          iface: rollupInterface,
          values: {
            bridge: BRIDGE,
            inbox: INBOX,
            sequencerInbox: RECIPIENT,
            outbox: RECIPIENT,
            confirmPeriodBlocks: 483840,
          },
        },
        {
          address: INBOX,
          iface: inboxInterface,
          values: { calculateRetryableSubmissionFee: 1000 },
        },
        { address: BRIDGE, iface: bridgeInterface, values: { nativeToken } },
      ];
      for (const contract of contracts) {
        if (address.toLowerCase() !== contract.address.toLowerCase()) continue;
        const fn = contract.iface.parseTransaction({ data }).name;
        const entry = Object.entries(contract.values).find(
          ([name]) => name === fn,
        );
        assert(entry, `Unexpected call ${fn}`);
        return contract.iface.encodeFunctionResult(fn, [entry[1]]);
      }
      throw new Error(`Unexpected parent call ${address}`);
    });
    sinon.stub(child, 'call').callsFake(async (transaction) => {
      const data = await transaction.data;
      assert(typeof data === 'string', 'Missing child calldata');
      if (data === tokenInterface.getSighash('decimals'))
        return tokenInterface.encodeFunctionResult('decimals', [childDecimals]);
      const fn = childTokenInterface.parseTransaction({ data }).name;
      if (fn === 'l1Address')
        return childTokenInterface.encodeFunctionResult(fn, [childParentToken]);
      throw new Error(`Unexpected child call ${fn}`);
    });
    sinon.stub(parent, 'sendTransaction').callsFake(async (signed) => {
      beforeBroadcast();
      const tx = ethers.utils.parseTransaction(await signed);
      const hash = ethers.utils.keccak256(await signed);
      assert(tx.from, 'Signed test transaction lacks sender');
      broadcasts.push(tx);
      return {
        ...tx,
        from: tx.from,
        hash,
        confirmations: 0,
        wait: async () => {
          if (tx.to?.toLowerCase() === ELYSIUM_NATIVE_BRIDGE.parentRouter)
            await sourceReceiptWait();
          return receipt(hash);
        },
      };
    });
    bridge = new ElysiumNativeBridge({ chainMetadata: METADATA }, logger);
    bridge['multiProvider'].setProvider(999, parent);
    bridge['multiProvider'].setProvider(99901, child);
    const message = new ParentToChildMessageReader(
      child,
      99901,
      ALIASED_PARENT_GATEWAY,
      ethers.constants.One,
      ethers.constants.One,
      {
        destAddress: ELYSIUM_NATIVE_BRIDGE.childGateway,
        l2CallValue: ethers.constants.Zero,
        l1Value: ethers.constants.One,
        maxSubmissionFee: ethers.constants.One,
        maxFeePerGas: ethers.constants.One,
        gasLimit: ethers.constants.One,
        excessFeeRefundAddress: SENDER,
        callValueRefundAddress: SENDER,
        data: '0x1234',
      },
    );
    sinon
      .stub(message, 'getSuccessfulRedeem')
      .callsFake(async () => redemption);
    sinon
      .stub(ParentTransactionReceipt.prototype, 'getParentToChildMessages')
      .resolves([message]);
  });

  afterEach(() => {
    sinon.restore();
    resetNetworksToDefault();
  });

  it('quotes exact input and exact output one-to-one without approval or balance', async () => {
    for (const params of [
      quoteParams(),
      quoteParams({ fromAmount: undefined, toAmount: AMOUNT }),
    ]) {
      const quote = await bridge.quote(params);
      expect([
        quote.fromAmount,
        quote.toAmount,
        quote.toAmountMin,
      ]).to.deep.equal([AMOUNT, AMOUNT, AMOUNT]);
      expect(quote.feeCosts).to.equal(0n);
      expect(quote.gasCosts).to.equal(EXPECTED_NATIVE_VALUE);
      expect(quote.route.nativeValue).to.equal(EXPECTED_NATIVE_VALUE);
      expect(quote.route.request.to?.toLowerCase()).to.equal(
        ELYSIUM_NATIVE_BRIDGE.parentRouter,
      );
      const data = quote.route.request.data;
      assert(typeof data === 'string', 'Missing quote calldata');
      const call = routerInterface.parseTransaction({ data });
      expect(call.name).to.equal('outboundTransferCustomRefund');
      expect(call.args._refundTo).to.equal(SENDER);
      expect(call.args._to).to.equal(RECIPIENT);
      expect(call.args._amount.toString()).to.equal(AMOUNT.toString());
    }
    expect(broadcasts).to.have.length(0);
  });

  it('rejects reverse direction, other tokens, invalid recipients and invalid amounts', async () => {
    for (const params of [
      quoteParams({ fromChain: 99901, toChain: 999 }),
      quoteParams({ fromToken: RECIPIENT }),
      quoteParams({ toToken: RECIPIENT }),
      quoteParams({ toAddress: ethers.constants.AddressZero }),
      quoteParams({ toAddress: 'invalid' }),
      quoteParams({ fromAmount: 0n }),
      quoteParams({ fromAmount: -1n }),
      quoteParams({ toAmount: AMOUNT }),
      quoteParams({ fromAmount: undefined }),
    ])
      await rejects(() => bridge.quote(params));
    expect(broadcasts).to.have.length(0);
  });

  it('rejects changed canonical token or gateway mappings', async () => {
    mappedGateway = RECIPIENT;
    await rejects(() => bridge.quote(quoteParams()), /mapping changed/);
    mappedGateway = ELYSIUM_NATIVE_BRIDGE.parentGateway;
    mappedToken = RECIPIENT;
    await rejects(() => bridge.quote(quoteParams()), /mapping changed/);
    mappedToken = ELYSIUM_NATIVE_BRIDGE.childToken;
    childParentToken = RECIPIENT;
    await rejects(() => bridge.quote(quoteParams()), /mapping changed/);
    childParentToken = ELYSIUM_NATIVE_BRIDGE.parentToken;
    childDecimals = 18;
    await rejects(() => bridge.quote(quoteParams()), /mapping changed/);
    expect(broadcasts).to.have.length(0);
  });

  it('rejects an ERC20 gas-token configuration', async () => {
    nativeToken = RECIPIENT;
    await rejects(() => bridge.quote(quoteParams()), /native HYPE/);
    expect(broadcasts).to.have.length(0);
  });

  it('rejects delivery above the HYPE cap before approving', async () => {
    bridge = new ElysiumNativeBridge(
      { chainMetadata: METADATA, maxNativeValueWei: 1n },
      logger,
    );
    bridge['multiProvider'].setProvider(999, parent);
    bridge['multiProvider'].setProvider(99901, child);
    await rejects(() => bridge.quote(quoteParams()), /HYPE budget/);
    expect(broadcasts).to.have.length(0);
  });

  it('approves the exact gateway amount and observes the signed source hash before sending', async () => {
    const quote = await bridge.quote(quoteParams());
    const sourceAttempts: string[] = [];
    const approvalHashes: string[] = [];
    beforeBroadcast = () => {
      if (broadcasts.length === 0) expect(approvalHashes).to.have.length(1);
      else expect(sourceAttempts).to.have.length(1);
    };
    const result = await bridge.execute(
      quote,
      { [ProtocolType.Ethereum]: TEST_KEY },
      {
        onApproval: async (approval) => {
          if (approval?.txHash) approvalHashes.push(approval.txHash);
        },
        onSubmissionAttempt: async (hash) => {
          assert(hash, 'Missing signed source hash');
          sourceAttempts.push(hash);
        },
      },
    );
    expect(broadcasts).to.have.length(2);
    const approval = tokenInterface.parseTransaction({
      data: broadcasts[0].data,
    });
    expect(approval.name).to.equal('approve');
    expect(approval.args.spender.toLowerCase()).to.equal(
      ELYSIUM_NATIVE_BRIDGE.parentGateway,
    );
    expect(approval.args.amount.toString()).to.equal(AMOUNT.toString());
    expect(broadcasts[1].to?.toLowerCase()).to.equal(
      ELYSIUM_NATIVE_BRIDGE.parentRouter,
    );
    expect(broadcasts[1].value.toBigInt()).to.equal(EXPECTED_NATIVE_VALUE);
    expect(result.txHash).to.equal(sourceAttempts[0]);
  });

  it('serializes approval and deposit until the prior source receipt arrives', async () => {
    const quote = await bridge.quote(quoteParams());
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    sourceReceiptWait = () => gate;
    let submitted: (() => void) | undefined;
    const submission = new Promise<void>((resolve) => {
      submitted = resolve;
    });
    const first = bridge.execute(
      quote,
      { [ProtocolType.Ethereum]: TEST_KEY },
      {
        onSubmitted: async () => {
          submitted?.();
        },
      },
    );
    await submission;
    const second = bridge.execute(quote, { [ProtocolType.Ethereum]: TEST_KEY });
    await Promise.resolve();
    expect(broadcasts).to.have.length(2);
    assert(release, 'Missing test gate');
    release();
    await Promise.all([first, second]);
    expect(broadcasts).to.have.length(4);
  });

  it('rejects a changed quote amount or wrong signer before approval', async () => {
    const quote = await bridge.quote(quoteParams());
    await rejects(
      () =>
        bridge.execute(
          { ...quote, toAmountMin: AMOUNT - 1n },
          { [ProtocolType.Ethereum]: TEST_KEY },
        ),
      /one-to-one/,
    );
    await rejects(
      () =>
        bridge.execute(quote, {
          [ProtocolType.Ethereum]: ethers.utils.id('different test signer'),
        }),
      /does not match/,
    );
    expect(broadcasts).to.have.length(0);
  });

  it('preserves source identity after an uncertain broadcast and never retries it', async () => {
    const quote = await bridge.quote(quoteParams());
    beforeBroadcast = () => {
      if (broadcasts.length === 1) throw new Error('RPC disconnected');
    };
    let attemptedHash: string | undefined;
    await rejects(
      () =>
        bridge.execute(
          quote,
          { [ProtocolType.Ethereum]: TEST_KEY },
          {
            onSubmissionAttempt: async (hash) => {
              attemptedHash = hash;
            },
          },
        ),
      (error: unknown) => {
        assert(
          error instanceof TransactionSubmissionError,
          'Expected submission error',
        );
        expect(error.submissionState).to.equal('unknown');
        expect(error.txHash).to.equal(attemptedHash);
        return true;
      },
    );
    expect(broadcasts).to.have.length(1);
    expect(attemptedHash).to.be.a('string');
  });

  it('recovers completion from only the source hash and verifies the USDC mint', async () => {
    expect(await bridge.getStatus(SOURCE_HASH, 999, 99901)).to.deep.equal({
      status: 'complete',
      receivingTxHash: CHILD_HASH,
      receivedAmount: AMOUNT,
    });
  });

  it('does not complete on an unmined, unconfirmed or unredeemed deposit', async () => {
    sourceReceiptStub.resolves();
    expect(await bridge.getStatus(SOURCE_HASH, 999, 99901)).to.deep.equal({
      status: 'pending',
      substatus: 'SOURCE_NOT_MINED',
    });
    sourceReceiptStub.resolves({ ...parentReceipt(), confirmations: 0 });
    expect(await bridge.getStatus(SOURCE_HASH, 999, 99901)).to.deep.equal({
      status: 'pending',
      substatus: 'SOURCE_NOT_FINAL',
    });
    sourceReceiptStub.resolves(parentReceipt());
    redemption = { status: ParentToChildMessageStatus.NOT_YET_CREATED };
    expect(await bridge.getStatus(SOURCE_HASH, 999, 99901)).to.deep.equal({
      status: 'pending',
      substatus: 'RETRYABLE_NOT_CREATED',
    });
    redemption = {
      status: ParentToChildMessageStatus.FUNDS_DEPOSITED_ON_CHILD,
    };
    expect(await bridge.getStatus(SOURCE_HASH, 999, 99901)).to.deep.equal({
      status: 'pending',
      substatus: 'MANUAL_REDEMPTION_REQUIRED',
    });
    redemption = {
      status: ParentToChildMessageStatus.REDEEMED,
      childTxReceipt: { ...childReceipt(), confirmations: 0 },
    };
    expect(await bridge.getStatus(SOURCE_HASH, 999, 99901)).to.deep.equal({
      status: 'pending',
      substatus: 'DESTINATION_NOT_FINAL',
    });
  });

  it('reports source reverts, retryable creation failures and expiry explicitly', async () => {
    sourceReceiptStub.resolves({
      ...parentReceipt(),
      status: 0,
      confirmations: 0,
    });
    expect(await bridge.getStatus(SOURCE_HASH, 999, 99901)).to.deep.equal({
      status: 'pending',
      substatus: 'SOURCE_NOT_FINAL',
    });
    sourceReceiptStub.resolves({ ...parentReceipt(), status: 0 });
    expect((await bridge.getStatus(SOURCE_HASH, 999, 99901)).status).to.equal(
      'failed',
    );
    sourceReceiptStub.resolves(parentReceipt());
    for (const status of [
      ParentToChildMessageStatus.CREATION_FAILED,
      ParentToChildMessageStatus.EXPIRED,
    ]) {
      assert(
        status !== ParentToChildMessageStatus.REDEEMED,
        'Expected failure status',
      );
      redemption = { status };
      const result = await bridge.getStatus(SOURCE_HASH, 999, 99901);
      expect(result.status).to.equal('failed');
      if (result.status === 'failed')
        expect(result.error).to.include(ParentToChildMessageStatus[status]);
    }
  });

  it('rejects missing source debit and destination credits to the wrong recipient or amount', async () => {
    sourceReceiptStub.resolves({
      ...parentReceipt(),
      logs: parentReceipt().logs.slice(0, 1),
    });
    await rejects(
      () => bridge.getStatus(SOURCE_HASH, 999, 99901),
      /source USDC debit/,
    );
    sourceReceiptStub.resolves(parentReceipt());
    for (const childTxReceipt of [
      childReceipt(AMOUNT - 1n),
      childReceipt(AMOUNT, SENDER),
    ]) {
      redemption = {
        status: ParentToChildMessageStatus.REDEEMED,
        childTxReceipt,
      };
      await rejects(
        () => bridge.getStatus(SOURCE_HASH, 999, 99901),
        /mint does not match/,
      );
    }
    expect(broadcasts).to.have.length(0);
  });
});

const parentForkUrl = process.env.ELYSIUM_NATIVE_PARENT_FORK_URL;
const describeFork = parentForkUrl ? describe : describe.skip;
describeFork('ElysiumNativeBridge parent Anvil fork', () => {
  it('escrows exact USDC and creates the canonical retryable on a local fork', async () => {
    assert(parentForkUrl, 'Missing local parent fork URL');
    assert(
      ['127.0.0.1', 'localhost', '[::1]'].includes(
        new URL(parentForkUrl).hostname,
      ),
      'Fork writes are restricted to localhost',
    );
    const parent = new ethers.providers.JsonRpcProvider(parentForkUrl);
    expect((await parent.getNetwork()).chainId).to.equal(999);
    await parent.send('anvil_nodeInfo', []);
    const snapshot = await parent.send('evm_snapshot', []);
    try {
      await parent.send('anvil_setBalance', [
        SENDER,
        ethers.utils.parseEther('1').toHexString(),
      ]);
      await parent.send('anvil_setBalance', [
        ELYSIUM_NATIVE_BRIDGE.parentGateway,
        ethers.utils.parseEther('1').toHexString(),
      ]);
      await parent.send('anvil_impersonateAccount', [
        ELYSIUM_NATIVE_BRIDGE.parentGateway,
      ]);
      const token = ERC20__factory.connect(
        ELYSIUM_NATIVE_BRIDGE.parentToken,
        parent,
      );
      const funding = await token
        .connect(parent.getSigner(ELYSIUM_NATIVE_BRIDGE.parentGateway))
        .transfer(SENDER, AMOUNT);
      await funding.wait();
      await parent.send('anvil_stopImpersonatingAccount', [
        ELYSIUM_NATIVE_BRIDGE.parentGateway,
      ]);
      const initialBalance = await token.balanceOf(SENDER);
      const initialEscrow = await token.balanceOf(
        ELYSIUM_NATIVE_BRIDGE.parentGateway,
      );
      const bridge = new ElysiumNativeBridge(
        {
          chainMetadata: {
            hyperevm: {
              ...METADATA.hyperevm,
              rpcUrls: [{ http: parentForkUrl }],
            },
            elysium: {
              ...METADATA.elysium,
              rpcUrls: [
                {
                  http:
                    process.env.ELYSIUM_RPC_URL ??
                    'https://rpc.elysium.kinetiq.xyz',
                },
              ],
            },
          },
        },
        logger,
      );
      const quote = await bridge.quote(quoteParams());
      const result = await bridge.execute(quote, {
        [ProtocolType.Ethereum]: TEST_KEY,
      });
      const receipt = await parent.getTransactionReceipt(result.txHash);
      expect(receipt.status).to.equal(1);
      expect(
        initialBalance.sub(await token.balanceOf(SENDER)).toBigInt(),
      ).to.equal(AMOUNT);
      expect(
        (await token.balanceOf(ELYSIUM_NATIVE_BRIDGE.parentGateway))
          .sub(initialEscrow)
          .toBigInt(),
      ).to.equal(AMOUNT);
      const canonicalReceipt = new ParentTransactionReceipt(receipt);
      const deposits = canonicalReceipt.getTokenDepositEvents();
      expect(deposits).to.have.length(1);
      expect(deposits[0]._amount.toBigInt()).to.equal(AMOUNT);
      expect(deposits[0]._to.toLowerCase()).to.equal(RECIPIENT);
      const messages = await canonicalReceipt.getParentToChildMessages(
        new ethers.providers.JsonRpcProvider(
          process.env.ELYSIUM_RPC_URL ?? 'https://rpc.elysium.kinetiq.xyz',
        ),
      );
      expect(messages).to.have.length(1);
      expect(messages[0].sender.toLowerCase()).to.equal(
        ALIASED_PARENT_GATEWAY.toLowerCase(),
      );
      expect(messages[0].messageData.destAddress.toLowerCase()).to.equal(
        ELYSIUM_NATIVE_BRIDGE.childGateway,
      );
      // The fork does not deliver its message to the real child chain, but the
      // adapter must still reconstruct and validate its actual source receipt.
      expect(await bridge.getStatus(result.txHash, 999, 99901)).to.deep.equal({
        status: 'pending',
        substatus: 'RETRYABLE_NOT_CREATED',
      });
    } finally {
      await parent.send('evm_revert', [snapshot]);
    }
  }).timeout(120_000);
});

const describeLive =
  process.env.ELYSIUM_NATIVE_READ_ONLY === 'true' ? describe : describe.skip;
describeLive('ElysiumNativeBridge live read-only estimation', () => {
  it('quotes canonical USDC without keys, balance, approval or a transaction', async () => {
    const bridge = new ElysiumNativeBridge(
      {
        chainMetadata: {
          hyperevm: {
            ...METADATA.hyperevm,
            rpcUrls: [
              {
                http:
                  process.env.HYPEREVM_RPC_URL ??
                  'https://rpc.hyperliquid.xyz/evm',
              },
            ],
          },
          elysium: {
            ...METADATA.elysium,
            rpcUrls: [
              {
                http:
                  process.env.ELYSIUM_RPC_URL ??
                  'https://rpc.elysium.kinetiq.xyz',
              },
            ],
          },
        },
      },
      logger,
    );
    const quote = await bridge.quote(quoteParams());
    expect(quote.toAmountMin).to.equal(AMOUNT);
    expect(
      quote.gasCosts > 0n && quote.gasCosts <= 10_000_000_000_000_000n,
    ).to.equal(true);
  }).timeout(60_000);
});
