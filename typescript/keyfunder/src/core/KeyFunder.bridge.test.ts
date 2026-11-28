import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { BigNumber, ethers } from 'ethers';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pino } from 'pino';
import sinon from 'sinon';

import { ERC20__factory } from '@hyperlane-xyz/core';
import { MultiProvider, type SendTransactionOptions } from '@hyperlane-xyz/sdk';
import { TransactionSubmissionError } from '@hyperlane-xyz/utils';

import {
  ChainConfigSchema,
  HyperlaneHookBridgeDeliverySchema,
  KeyFunderConfigSchema,
  type KeyFunderConfig,
} from '../config/types.js';
import { KeyFunderMetrics } from '../metrics/Metrics.js';

import {
  BRIDGE_INTERFACES,
  formatStandardHookMetadata,
} from './BridgeFunder.js';
import { FileBridgeStateStore } from './BridgeStateStore.js';
import { KeyFunder } from './KeyFunder.js';

chai.use(chaiAsPromised);

const RELAYER_ADDR = '0x1111111111111111111111111111111111111111';
const FUNDER_ADDR = '0x2222222222222222222222222222222222222222';
const PORTAL_ADDR = '0x3333333333333333333333333333333333333333';
const L1_BRIDGE_ADDR = '0x4444444444444444444444444444444444444444';
const INBOX_ADDR = '0x5555555555555555555555555555555555555555';
const MAILBOX_ADDR = '0x6666666666666666666666666666666666666666';
const HOOK_ADDR = '0x7777777777777777777777777777777777777777';
const GAS_TOKEN_ADDR = '0x8888888888888888888888888888888888888888';
const FORWARDER_ADDR = '0x9999999999999999999999999999999999999999';
const MOCK_CONTRACT_CODE = '0x6001600055';

async function extractTxCallData(
  tx: ethers.utils.Deferrable<ethers.providers.TransactionRequest>,
): Promise<string> {
  const raw = await tx.data;
  if (typeof raw === 'string') {
    return raw;
  }
  return raw != null ? ethers.utils.hexlify(raw) : '0x';
}

async function buildPopulatedTx(
  tx: ethers.utils.Deferrable<ethers.providers.TransactionRequest>,
  defaultGasLimit: BigNumber,
  defaultMaxFeePerGas: BigNumber,
): Promise<ethers.providers.TransactionRequest> {
  const [to, data, value, gasLimit, maxFeePerGas] = await Promise.all([
    tx.to,
    tx.data,
    tx.value,
    tx.gasLimit,
    tx.maxFeePerGas,
  ]);
  return {
    to,
    from: FUNDER_ADDR,
    data,
    value: value != null ? BigNumber.from(value) : undefined,
    gasLimit: gasLimit != null ? BigNumber.from(gasLimit) : defaultGasLimit,
    maxFeePerGas:
      maxFeePerGas != null ? BigNumber.from(maxFeePerGas) : defaultMaxFeePerGas,
  };
}

function createMockSetup(params?: {
  destFunderBalance?: BigNumber;
  destRoleBalance?: BigNumber;
  originFunderBalance?: BigNumber;
  originGasLimit?: BigNumber;
  originMaxFeePerGas?: BigNumber;
  originCode?: string;
  destCode?: string;
}) {
  const destProvider = sinon.createStubInstance(
    ethers.providers.JsonRpcProvider,
  );
  destProvider.getBalance.resolves(
    params?.destRoleBalance ?? BigNumber.from(0),
  );
  destProvider.getCode.resolves(params?.destCode ?? MOCK_CONTRACT_CODE);

  const originProvider = sinon.createStubInstance(
    ethers.providers.JsonRpcProvider,
  );
  originProvider.getCode.resolves(params?.originCode ?? MOCK_CONTRACT_CODE);
  originProvider.getGasPrice.resolves(
    params?.originMaxFeePerGas ?? BigNumber.from(1_000_000_000),
  );

  const destSigner = sinon.createStubInstance(ethers.Wallet);
  destSigner.getAddress.resolves(FUNDER_ADDR);
  destSigner.getBalance.resolves(
    params?.destFunderBalance ?? BigNumber.from(0),
  );

  const originGasLimit = params?.originGasLimit ?? BigNumber.from(100_000);
  const originMaxFeePerGas =
    params?.originMaxFeePerGas ?? BigNumber.from(1_000_000_000);

  const originSigner = sinon.createStubInstance(ethers.Wallet);
  originSigner.getAddress.resolves(FUNDER_ADDR);
  originSigner.getBalance.resolves(
    params?.originFunderBalance ?? ethers.utils.parseEther('10'),
  );
  originSigner.getTransactionCount.resolves(7);
  originSigner.populateTransaction.callsFake(async (tx) =>
    buildPopulatedTx(tx, originGasLimit, originMaxFeePerGas),
  );

  const multiProvider = sinon.createStubInstance(MultiProvider);
  multiProvider.getProvider.callsFake((chain) =>
    chain === 'ethereum' ? originProvider : destProvider,
  );
  multiProvider.getSigner.callsFake((chain) =>
    chain === 'ethereum' ? originSigner : destSigner,
  );
  multiProvider.getSignerAddress.resolves(FUNDER_ADDR);
  multiProvider.getChainMetadata.returns({
    nativeToken: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  });
  multiProvider.prepareTx.callsFake(async (_chain, transaction) => transaction);
  multiProvider.estimateGas.resolves(originGasLimit);

  const sendTransaction = sinon.stub<
    Parameters<MultiProvider['sendTransaction']>,
    ReturnType<MultiProvider['sendTransaction']>
  >();
  sendTransaction.callsFake(
    async (_chain, _tx, options?: SendTransactionOptions) => {
      const hash = `0x${'ab'.repeat(32)}`;
      await options?.onSubmissionAttempt?.(hash);
      await options?.onSubmitted?.(hash);
      return {
        status: 1,
        transactionHash: hash,
      } as unknown as ethers.ContractReceipt;
    },
  );
  multiProvider.sendTransaction = sendTransaction;
  multiProvider.tryGetExplorerTxUrl.returns(null);

  return {
    multiProvider,
    sendTransaction,
    originProvider,
    destProvider,
    originSigner,
    destSigner,
  };
}

describe('KeyFunder OP Stack and Arbitrum Orbit bridges', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('Schema validation', () => {
    it('rejects OP Stack canonical mode without bridgeContract', () => {
      const parsed = ChainConfigSchema.safeParse({
        bridge: {
          stack: 'opStack',
          originChain: 'ethereum',
          mode: 'optimismPortal',
        },
      });
      expect(parsed.success).to.equal(false);
    });

    it('rejects Arbitrum Orbit erc20Inbox without originGasToken', () => {
      const parsed = ChainConfigSchema.safeParse({
        bridge: {
          stack: 'arbitrumOrbit',
          originChain: 'ethereum',
          mode: 'erc20Inbox',
          inboxAddress: INBOX_ADDR,
        },
      });
      expect(parsed.success).to.equal(false);
    });

    it('rejects self-referencing originChain in KeyFunderConfigSchema', () => {
      const parsed = KeyFunderConfigSchema.safeParse({
        version: '1',
        roles: { relayer: { address: RELAYER_ADDR } },
        chains: {
          optimism: {
            balances: { relayer: '1' },
            bridge: {
              stack: 'opStack',
              originChain: 'optimism',
              mode: 'optimismPortal',
              bridgeContract: PORTAL_ADDR,
            },
          },
        },
      });
      expect(parsed.success).to.equal(false);
    });

    it('rejects destinationDomain above uint32 maximum and accepts 0xffffffff', () => {
      const invalid = HyperlaneHookBridgeDeliverySchema.safeParse({
        mailboxAddress: MAILBOX_ADDR,
        hookAddress: HOOK_ADDR,
        recipientAddress: FORWARDER_ADDR,
        destinationDomain: 0x1_0000_0000,
      });
      expect(invalid.success).to.equal(false);

      const valid = HyperlaneHookBridgeDeliverySchema.safeParse({
        mailboxAddress: MAILBOX_ADDR,
        hookAddress: HOOK_ADDR,
        recipientAddress: FORWARDER_ADDR,
        destinationDomain: 0xffffffff,
      });
      expect(valid.success).to.equal(true);
    });

    it('returns field-level Zod issues instead of throwing when token decimals are 0, 1, or exceeded', () => {
      const zeroDecDefault = ChainConfigSchema.safeParse({
        bridge: {
          stack: 'arbitrumOrbit',
          originChain: 'ethereum',
          mode: 'erc20Inbox',
          inboxAddress: INBOX_ADDR,
          originGasToken: { address: GAS_TOKEN_ADDR, decimals: 0 },
        },
      });
      expect(zeroDecDefault.success).to.equal(false);
      expect(
        zeroDecDefault.error?.issues.map((i) => i.path.join('.')),
      ).to.include('bridge.minBridgeThreshold');

      const oneDecDefault = ChainConfigSchema.safeParse({
        bridge: {
          stack: 'arbitrumOrbit',
          originChain: 'ethereum',
          mode: 'erc20Inbox',
          inboxAddress: INBOX_ADDR,
          originGasToken: { address: GAS_TOKEN_ADDR, decimals: 1 },
        },
      });
      expect(oneDecDefault.success).to.equal(false);
      expect(
        oneDecDefault.error?.issues.map((i) => i.path.join('.')),
      ).to.include('bridge.minBridgeThreshold');

      const sixDecExcess = ChainConfigSchema.safeParse({
        bridge: {
          stack: 'arbitrumOrbit',
          originChain: 'ethereum',
          mode: 'erc20Inbox',
          inboxAddress: INBOX_ADDR,
          originGasToken: { address: GAS_TOKEN_ADDR, decimals: 6 },
          minBridgeThreshold: '0.0000001',
          maxBridgeAmount: '5',
        },
      });
      expect(sixDecExcess.success).to.equal(false);
      expect(
        sixDecExcess.error?.issues.map((i) => i.path.join('.')),
      ).to.include('bridge.minBridgeThreshold');

      const zeroDecValid = ChainConfigSchema.safeParse({
        bridge: {
          stack: 'arbitrumOrbit',
          originChain: 'ethereum',
          mode: 'erc20Inbox',
          inboxAddress: INBOX_ADDR,
          originGasToken: { address: GAS_TOKEN_ADDR, decimals: 0 },
          minBridgeThreshold: '1',
          maxBridgeAmount: '5',
        },
      });
      expect(zeroDecValid.success).to.equal(true);
    });
  });

  it('bridges ETH to an OP Stack rollup via OptimismPortal.depositTransaction', async () => {
    const { multiProvider, sendTransaction } = createMockSetup();
    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        mode: {
          balances: { relayer: '0.5' },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'optimismPortal',
            bridgeContract: PORTAL_ADDR,
            l2GasLimit: 200_000,
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });
    await keyFunder.fundChain('mode');

    sinon.assert.calledOnce(sendTransaction);
    expect(sendTransaction.firstCall.args[0]).to.equal('ethereum');
    const tx = await Promise.resolve(sendTransaction.firstCall.args[1]);
    expect(tx.to).to.equal(PORTAL_ADDR);
    expect(tx.value?.toString()).to.equal(
      ethers.utils.parseEther('0.5').toString(),
    );
    const decoded = BRIDGE_INTERFACES.optimismPortal.decodeFunctionData(
      'depositTransaction',
      tx.data ?? '0x',
    );
    expect(decoded._to.toLowerCase()).to.equal(RELAYER_ADDR);
    expect(decoded._isCreation).to.equal(false);
    expect(decoded._gasLimit.toNumber()).to.equal(200_000);
  });

  it('bridges ETH to an OP Stack rollup via L1StandardBridge.depositETHTo', async () => {
    const { multiProvider, sendTransaction } = createMockSetup();
    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        zora: {
          balances: { relayer: '0.4' },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'l1StandardBridge',
            bridgeContract: L1_BRIDGE_ADDR,
            l2GasLimit: 210_000,
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });
    await keyFunder.fundChain('zora');

    sinon.assert.calledOnce(sendTransaction);
    const tx = await Promise.resolve(sendTransaction.firstCall.args[1]);
    expect(tx.to).to.equal(L1_BRIDGE_ADDR);
    const decoded = BRIDGE_INTERFACES.l1StandardBridge.decodeFunctionData(
      'depositETHTo',
      tx.data ?? '0x',
    );
    expect(decoded._to.toLowerCase()).to.equal(RELAYER_ADDR);
    expect(decoded._minGasLimit).to.equal(210_000);
  });

  it('rejects OP Stack canonical deposit when bridgeContract has no deployed code on origin', async () => {
    const { multiProvider, sendTransaction } = createMockSetup({
      originCode: '0x',
    });
    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        mode: {
          balances: { relayer: '0.5' },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'optimismPortal',
            bridgeContract: PORTAL_ADDR,
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });

    await expect(keyFunder.fundChain('mode')).to.be.rejectedWith(
      `Configured OP Stack bridge contract ${PORTAL_ADDR} has no deployed contract code on ethereum`,
    );
    sinon.assert.notCalled(sendTransaction);
  });

  it('quotes 5-arg Mailbox.quoteDispatch and dispatches to a verified payable IMessageRecipient forwarder', async () => {
    const { multiProvider, sendTransaction, originProvider } =
      createMockSetup();
    const amount = ethers.utils.parseEther('0.25');
    const protocolFee = ethers.utils.parseEther('0.001');
    const totalQuotedFee = amount.add(protocolFee);

    let capturedQuoteCallData = '';
    originProvider.call.callsFake(async (txReq) => {
      capturedQuoteCallData = await extractTxCallData(txReq);
      return BRIDGE_INTERFACES.hyperlaneMailbox.encodeFunctionResult(
        'quoteDispatch',
        [totalQuotedFee],
      );
    });

    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        base: {
          balances: { relayer: '0.25' },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'hyperlaneHook',
            hookDelivery: {
              mailboxAddress: MAILBOX_ADDR,
              hookAddress: HOOK_ADDR,
              recipientAddress: FORWARDER_ADDR,
              destinationDomain: 8453,
              gasLimit: 300_000,
            },
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });
    await keyFunder.fundChain('base');

    const expectedRecipientBytes32 = ethers.utils.hexZeroPad(
      FORWARDER_ADDR,
      32,
    );
    const expectedMessageBody = ethers.utils.hexZeroPad(RELAYER_ADDR, 32);
    const expectedMetadata = formatStandardHookMetadata({
      msgValue: amount,
      gasLimit: 300_000,
      refundAddress: FUNDER_ADDR,
    });

    const decodedQuote = BRIDGE_INTERFACES.hyperlaneMailbox.decodeFunctionData(
      'quoteDispatch',
      capturedQuoteCallData,
    );
    expect(decodedQuote.destinationDomain).to.equal(8453);
    expect(decodedQuote.recipientAddress).to.equal(expectedRecipientBytes32);
    expect(decodedQuote.messageBody).to.equal(expectedMessageBody);
    expect(decodedQuote.customHookMetadata).to.equal(expectedMetadata);
    expect(decodedQuote.customHook.toLowerCase()).to.equal(HOOK_ADDR);

    sinon.assert.calledOnce(sendTransaction);
    const tx = await Promise.resolve(sendTransaction.firstCall.args[1]);
    expect(tx.to).to.equal(MAILBOX_ADDR);
    expect(tx.value?.toString()).to.equal(totalQuotedFee.toString());
    const decodedDispatch =
      BRIDGE_INTERFACES.hyperlaneMailbox.decodeFunctionData(
        'dispatch',
        tx.data ?? '0x',
      );
    expect(decodedDispatch.destinationDomain).to.equal(8453);
    expect(decodedDispatch.recipientAddress).to.equal(expectedRecipientBytes32);
    expect(decodedDispatch.messageBody).to.equal(expectedMessageBody);
    expect(decodedDispatch.customHook.toLowerCase()).to.equal(HOOK_ADDR);
    expect(decodedDispatch.customHookMetadata).to.equal(expectedMetadata);
  });

  it('propagates Mailbox.quoteDispatch RPC failures instead of submitting with fallback value', async () => {
    const { multiProvider, sendTransaction, originProvider } =
      createMockSetup();
    originProvider.call.rejects(new Error('Mailbox quoteDispatch reverted'));

    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        base: {
          balances: { relayer: '0.25' },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'hyperlaneHook',
            hookDelivery: {
              mailboxAddress: MAILBOX_ADDR,
              hookAddress: HOOK_ADDR,
              recipientAddress: FORWARDER_ADDR,
              destinationDomain: 8453,
            },
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });

    await expect(keyFunder.fundChain('base')).to.be.rejectedWith(
      'Mailbox quoteDispatch reverted',
    );
    sinon.assert.notCalled(sendTransaction);
  });

  it('rejects hyperlaneHook dispatch when destination recipientAddress is an EOA without code', async () => {
    const { multiProvider, sendTransaction } = createMockSetup({
      destCode: '0x',
    });
    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        base: {
          balances: { relayer: '0.25' },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'hyperlaneHook',
            hookDelivery: {
              mailboxAddress: MAILBOX_ADDR,
              hookAddress: HOOK_ADDR,
              recipientAddress: RELAYER_ADDR,
              destinationDomain: 8453,
            },
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });

    await expect(keyFunder.fundChain('base')).to.be.rejectedWith(
      `Configured Hyperlane hook recipient contract ${RELAYER_ADDR} has no deployed contract code on base`,
    );
    sinon.assert.notCalled(sendTransaction);
  });

  it('bridges ETH to an Arbitrum Orbit chain via createRetryableTicket', async () => {
    const { multiProvider, sendTransaction } = createMockSetup();
    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        xai: {
          balances: { relayer: '1' },
          bridge: {
            stack: 'arbitrumOrbit',
            originChain: 'ethereum',
            mode: 'retryableTicket',
            inboxAddress: INBOX_ADDR,
            l2GasLimit: 300_000,
            maxSubmissionCostWei: '100000000000000',
            maxFeePerGasWei: '1000000000',
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });
    await keyFunder.fundChain('xai');

    sinon.assert.calledOnce(sendTransaction);
    const tx = await Promise.resolve(sendTransaction.firstCall.args[1]);
    expect(tx.to).to.equal(INBOX_ADDR);
    const expectedValue = ethers.utils
      .parseEther('1')
      .add('100000000000000')
      .add(BigNumber.from(300_000).mul('1000000000'));
    expect(tx.value?.toString()).to.equal(expectedValue.toString());
    const decoded = BRIDGE_INTERFACES.arbitrumInbox.decodeFunctionData(
      'createRetryableTicket',
      tx.data ?? '0x',
    );
    expect(decoded.to.toLowerCase()).to.equal(RELAYER_ADDR);
  });

  it('converts 18-decimal deficit to 6-decimal origin units and uses ERC20Inbox.createRetryableTicket for distinct recipient', async () => {
    const tokenInterface = ERC20__factory.createInterface();
    const destProvider = sinon.createStubInstance(
      ethers.providers.JsonRpcProvider,
    );
    destProvider.getBalance.resolves(BigNumber.from(0));
    destProvider.getCode.resolves(MOCK_CONTRACT_CODE);

    const originProvider = new ethers.providers.JsonRpcProvider();
    sinon.stub(originProvider, 'getCode').resolves(MOCK_CONTRACT_CODE);
    sinon
      .stub(originProvider, 'getGasPrice')
      .resolves(BigNumber.from(1_000_000_000));
    sinon.stub(originProvider, 'call').callsFake(async (tx) => {
      const data = await extractTxCallData(tx);
      const { name } = tokenInterface.parseTransaction({ data });
      if (name === 'balanceOf') {
        return tokenInterface.encodeFunctionResult('balanceOf', [
          ethers.utils.parseUnits('50', 6),
        ]);
      }
      if (name === 'allowance') {
        return tokenInterface.encodeFunctionResult('allowance', [
          BigNumber.from(0),
        ]);
      }
      throw new Error(`Unexpected origin call: ${name}`);
    });

    const destSigner = sinon.createStubInstance(ethers.Wallet);
    destSigner.getAddress.resolves(FUNDER_ADDR);
    destSigner.getBalance.resolves(BigNumber.from(0));

    const originSigner = sinon.createStubInstance(ethers.Wallet);
    originSigner.getAddress.resolves(FUNDER_ADDR);
    originSigner.getBalance.resolves(ethers.utils.parseEther('5'));
    originSigner.getTransactionCount.resolves(3);
    originSigner.populateTransaction.callsFake(async (tx) =>
      buildPopulatedTx(
        tx,
        BigNumber.from(120_000),
        BigNumber.from(1_000_000_000),
      ),
    );

    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getProvider.callsFake((chain) =>
      chain === 'ethereum' ? originProvider : destProvider,
    );
    multiProvider.getSigner.callsFake((chain) =>
      chain === 'ethereum' ? originSigner : destSigner,
    );
    multiProvider.getSignerAddress.resolves(FUNDER_ADDR);
    multiProvider.getChainMetadata.returns({
      nativeToken: { name: 'OrbitGas', symbol: 'OGAS', decimals: 18 },
    });
    multiProvider.prepareTx.callsFake(async (_chain, tx) => tx);
    const sendTransaction = sinon.stub<
      Parameters<MultiProvider['sendTransaction']>,
      ReturnType<MultiProvider['sendTransaction']>
    >();
    sendTransaction.resolves({
      status: 1,
      transactionHash: `0x${'cd'.repeat(32)}`,
    } as unknown as ethers.ContractReceipt);
    multiProvider.sendTransaction = sendTransaction;

    const metrics = sinon.createStubInstance(KeyFunderMetrics);

    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        orbitcustom: {
          balances: { relayer: '2' },
          bridge: {
            stack: 'arbitrumOrbit',
            originChain: 'ethereum',
            mode: 'erc20Inbox',
            inboxAddress: INBOX_ADDR,
            originGasToken: { address: GAS_TOKEN_ADDR, decimals: 6 },
            l2GasLimit: 300_000,
            maxSubmissionCostWei: '100000000000000',
            maxFeePerGasWei: '1000000000',
            maxBridgeAmount: '5',
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
      metrics,
    });
    await keyFunder.fundChain('orbitcustom');

    sinon.assert.calledTwice(sendTransaction);
    const approveTx = await Promise.resolve(sendTransaction.firstCall.args[1]);
    expect(approveTx.to).to.equal(GAS_TOKEN_ADDR);

    // 2 tokens (2e18 on L2) + 0.0001 submission + 300k * 1 gwei (0.0003) = 2.0004 tokens => 2_000_400 in 6 decimals (not 5_000_000!)
    const expectedTokenTotalFee = BigNumber.from(2_000_400);
    const decodedApprove = tokenInterface.decodeFunctionData(
      'approve',
      approveTx.data ?? '0x',
    );
    expect(decodedApprove[0].toLowerCase()).to.equal(INBOX_ADDR);
    expect(decodedApprove[1].toString()).to.equal(
      expectedTokenTotalFee.toString(),
    );

    const depositTx = await Promise.resolve(sendTransaction.secondCall.args[1]);
    expect(depositTx.to).to.equal(INBOX_ADDR);
    const decodedRetryable =
      BRIDGE_INTERFACES.arbitrumErc20Inbox.decodeFunctionData(
        'createRetryableTicket',
        depositTx.data ?? '0x',
      );
    expect(decodedRetryable.to.toLowerCase()).to.equal(RELAYER_ADDR);
    expect(decodedRetryable.l2CallValue.toString()).to.equal(
      ethers.utils.parseEther('2').toString(),
    );
    expect(decodedRetryable.tokenTotalFeeAmount.toString()).to.equal(
      expectedTokenTotalFee.toString(),
    );

    expect(
      metrics.recordFundingAmount.calledOnceWithExactly(
        'orbitcustom',
        RELAYER_ADDR,
        'relayer',
        2,
      ),
    ).to.equal(true);
  });

  it('resets insufficient nonzero ERC20 allowance to zero before approving new amount and uses depositERC20 for self-recipient', async () => {
    const tokenInterface = ERC20__factory.createInterface();
    const destProvider = sinon.createStubInstance(
      ethers.providers.JsonRpcProvider,
    );
    destProvider.getBalance.resolves(BigNumber.from(0));
    destProvider.getCode.resolves(MOCK_CONTRACT_CODE);

    const originProvider = new ethers.providers.JsonRpcProvider();
    sinon.stub(originProvider, 'getCode').resolves(MOCK_CONTRACT_CODE);
    sinon
      .stub(originProvider, 'getGasPrice')
      .resolves(BigNumber.from(1_000_000_000));
    sinon.stub(originProvider, 'call').callsFake(async (tx) => {
      const data = await extractTxCallData(tx);
      const { name } = tokenInterface.parseTransaction({ data });
      if (name === 'balanceOf') {
        return tokenInterface.encodeFunctionResult('balanceOf', [
          ethers.utils.parseEther('50'),
        ]);
      }
      if (name === 'allowance') {
        // Nonzero residual allowance from an earlier failed deposit
        return tokenInterface.encodeFunctionResult('allowance', [
          ethers.utils.parseEther('0.5'),
        ]);
      }
      throw new Error(`Unexpected origin call: ${name}`);
    });

    const destSigner = sinon.createStubInstance(ethers.Wallet);
    destSigner.getAddress.resolves(FUNDER_ADDR);
    destSigner.getBalance.resolves(BigNumber.from(0));

    const originSigner = sinon.createStubInstance(ethers.Wallet);
    originSigner.getAddress.resolves(FUNDER_ADDR);
    originSigner.getBalance.resolves(ethers.utils.parseEther('5'));
    originSigner.getTransactionCount.resolves(4);
    originSigner.populateTransaction.callsFake(async (tx) =>
      buildPopulatedTx(
        tx,
        BigNumber.from(60_000),
        BigNumber.from(1_000_000_000),
      ),
    );

    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getProvider.callsFake((chain) =>
      chain === 'ethereum' ? originProvider : destProvider,
    );
    multiProvider.getSigner.callsFake((chain) =>
      chain === 'ethereum' ? originSigner : destSigner,
    );
    multiProvider.getSignerAddress.resolves(FUNDER_ADDR);
    multiProvider.getChainMetadata.returns({
      nativeToken: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    });
    multiProvider.prepareTx.callsFake(async (_chain, tx) => tx);

    let txSeq = 0;
    const sendTransaction = sinon.stub<
      Parameters<MultiProvider['sendTransaction']>,
      ReturnType<MultiProvider['sendTransaction']>
    >();
    sendTransaction.callsFake(async () => {
      txSeq += 1;
      return {
        status: 1,
        transactionHash: `0x${String(txSeq).padStart(64, '0')}`,
      } as unknown as ethers.ContractReceipt;
    });
    multiProvider.sendTransaction = sendTransaction;

    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { selfRole: { address: FUNDER_ADDR } },
      chains: {
        orbitself: {
          balances: { selfRole: '2' },
          bridge: {
            stack: 'arbitrumOrbit',
            originChain: 'ethereum',
            mode: 'erc20Inbox',
            inboxAddress: INBOX_ADDR,
            originGasToken: { address: GAS_TOKEN_ADDR, decimals: 18 },
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });
    await keyFunder.fundChain('orbitself');

    sinon.assert.calledThrice(sendTransaction);

    const resetTx = await Promise.resolve(sendTransaction.firstCall.args[1]);
    const decodedReset = tokenInterface.decodeFunctionData(
      'approve',
      resetTx.data ?? '0x',
    );
    expect(decodedReset[0].toLowerCase()).to.equal(INBOX_ADDR);
    expect(decodedReset[1].toString()).to.equal('0');

    const approveTx = await Promise.resolve(sendTransaction.secondCall.args[1]);
    const decodedApprove = tokenInterface.decodeFunctionData(
      'approve',
      approveTx.data ?? '0x',
    );
    expect(decodedApprove[0].toLowerCase()).to.equal(INBOX_ADDR);
    expect(decodedApprove[1].toString()).to.equal(
      ethers.utils.parseEther('2').toString(),
    );

    const depositTx = await Promise.resolve(sendTransaction.thirdCall.args[1]);
    const decodedDeposit =
      BRIDGE_INTERFACES.arbitrumErc20Inbox.decodeFunctionData(
        'depositERC20',
        depositTx.data ?? '0x',
      );
    expect(decodedDeposit._amount.toString()).to.equal(
      ethers.utils.parseEther('2').toString(),
    );
  });

  it('includes prepared origin gas fees in originReserveBuffer enforcement', async () => {
    // 1 ETH deposit + 0.05 ETH reserve + 0.0002 ETH gas fee (200_000 * 1 gwei) = 1.0502 ETH required.
    // Origin balance of 1.0501 ETH would pass without gas fees, but must fail once gas fees are included.
    const { multiProvider, sendTransaction } = createMockSetup({
      originFunderBalance: ethers.utils.parseEther('1.0501'),
      originGasLimit: BigNumber.from(200_000),
      originMaxFeePerGas: BigNumber.from(1_000_000_000),
    });
    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        mode: {
          balances: { relayer: '2' },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'optimismPortal',
            bridgeContract: PORTAL_ADDR,
            maxBridgeAmount: '1',
            originReserveBuffer: '0.05',
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });

    await expect(keyFunder.fundChain('mode')).to.be.rejectedWith(
      'Insufficient origin balance on ethereum',
    );
    sinon.assert.notCalled(sendTransaction);
  });

  it('serializes concurrent destination bridges sharing an origin signer so they cannot jointly spend below reserve', async () => {
    // Origin holds 1.5 ETH, reserve is 0.5 ETH, each rollup wants 0.7 ETH.
    // Without per-origin-signer serialization, both would read 1.5 ETH >= 1.2 ETH and spend down to ~0.1 ETH.
    let liveOriginBalance = ethers.utils.parseEther('1.5');
    const gasLimit = BigNumber.from(100_000);
    const feePerGas = BigNumber.from(1_000_000_000); // 0.0001 ETH gas

    const { multiProvider, originSigner, sendTransaction } = createMockSetup({
      originGasLimit: gasLimit,
      originMaxFeePerGas: feePerGas,
    });
    originSigner.getBalance.callsFake(async () => liveOriginBalance);
    sendTransaction.callsFake(async (_chain, pendingTx) => {
      const tx = await pendingTx;
      await new Promise((resolve) => setTimeout(resolve, 15));
      const spent = BigNumber.from(tx.value ?? 0).add(gasLimit.mul(feePerGas));
      liveOriginBalance = liveOriginBalance.sub(spent);
      return {
        status: 1,
        transactionHash: `0x${'ef'.repeat(32)}`,
      } as unknown as ethers.ContractReceipt;
    });

    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        mode: {
          balances: { relayer: '0.7' },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'optimismPortal',
            bridgeContract: PORTAL_ADDR,
            originReserveBuffer: '0.5',
          },
        },
        zora: {
          balances: { relayer: '0.7' },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'l1StandardBridge',
            bridgeContract: L1_BRIDGE_ADDR,
            originReserveBuffer: '0.5',
          },
        },
      },
    });

    const metrics = new KeyFunderMetrics(undefined);
    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
      metrics,
    });

    await keyFunder.fundAllChains();

    sinon.assert.calledOnce(sendTransaction);
    expect(liveOriginBalance.gte(ethers.utils.parseEther('0.5'))).to.equal(
      true,
    );
  });

  it('prevents duplicate bridging when multiple roles share the same recipient address while funds are in transit', async () => {
    const { multiProvider, sendTransaction } = createMockSetup();
    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: {
        relayer: { address: RELAYER_ADDR },
        validator: { address: RELAYER_ADDR },
      },
      chains: {
        mode: {
          balances: {
            relayer: '0.5',
            validator: '0.5',
          },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'optimismPortal',
            bridgeContract: PORTAL_ADDR,
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });
    await keyFunder.fundChain('mode');

    sinon.assert.calledOnce(sendTransaction);
  });

  it('persists attempt before broadcast, retains tx identity across confirmation failure, and reconciles on restart', async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'keyfunder-bridge-state-'),
    );
    const stateFile = path.join(tmpDir, 'bridge-state.json');

    try {
      const broadcastHash = `0x${'77'.repeat(32)}`;
      const setup1 = createMockSetup();

      // Simulate broadcast succeeding (onSubmissionAttempt + onSubmitted invoked),
      // followed by an origin confirmation RPC timeout wrapped in TransactionSubmissionError.
      setup1.sendTransaction.callsFake(
        async (_chain, _tx, options?: SendTransactionOptions) => {
          await options?.onSubmissionAttempt?.(broadcastHash);
          await options?.onSubmitted?.(broadcastHash);
          throw new TransactionSubmissionError(
            new Error('Timeout waiting for block confirmations'),
            'submitted',
            broadcastHash,
          );
        },
      );

      const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
        version: '1',
        roles: { relayer: { address: RELAYER_ADDR } },
        chains: {
          mode: {
            balances: { relayer: '0.5' },
            bridge: {
              stack: 'opStack',
              originChain: 'ethereum',
              mode: 'optimismPortal',
              bridgeContract: PORTAL_ADDR,
            },
          },
        },
      });

      const keyFunder1 = new KeyFunder(setup1.multiProvider, config, {
        logger: pino({ level: 'silent' }),
        bridgeStateFile: stateFile,
      });

      await expect(keyFunder1.fundChain('mode')).to.be.rejectedWith(
        'Timeout waiting for block confirmations',
      );

      // Verify state was persisted to disk with the retained depositTxHash
      const storeInspector = new FileBridgeStateStore(stateFile);
      const persisted = await storeInspector.get('mode', RELAYER_ADDR);
      expect(persisted?.depositTxHash).to.equal(broadcastHash);
      expect(persisted?.phase).to.equal('submitted');

      // Simulate service restart before L2 delivery completes: origin receipt is now mined (status = 1).
      const setup2 = createMockSetup({ destRoleBalance: BigNumber.from(0) });
      setup2.originProvider.getTransactionReceipt.resolves({
        status: 1,
        transactionHash: broadcastHash,
      } as unknown as ethers.providers.TransactionReceipt);

      const keyFunder2 = new KeyFunder(setup2.multiProvider, config, {
        logger: pino({ level: 'silent' }),
        bridgeStateFile: stateFile,
      });
      await keyFunder2.fundChain('mode');

      // Must NOT submit a duplicate bridge while the first deposit is confirmed and in transit!
      sinon.assert.notCalled(setup2.sendTransaction);
      const reconciled = await storeInspector.get('mode', RELAYER_ADDR);
      expect(reconciled?.phase).to.equal('confirmed');

      // Now simulate destination balance settling on L2: attempt is cleared and zero-deficit skip applies.
      const setup3 = createMockSetup({
        destRoleBalance: ethers.utils.parseEther('0.5'),
      });
      const keyFunder3 = new KeyFunder(setup3.multiProvider, config, {
        logger: pino({ level: 'silent' }),
        bridgeStateFile: stateFile,
      });
      await keyFunder3.fundChain('mode');

      sinon.assert.notCalled(setup3.sendTransaction);
      const cleared = await storeInspector.get('mode', RELAYER_ADDR);
      expect(cleared).to.equal(undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('clears persisted attempt and retries when reconciled origin deposit reverted on-chain', async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'keyfunder-bridge-revert-'),
    );
    const stateFile = path.join(tmpDir, 'bridge-state.json');

    try {
      const revertedHash = `0x${'99'.repeat(32)}`;
      const store = new FileBridgeStateStore(stateFile);
      await store.set({
        originChain: 'ethereum',
        destinationChain: 'mode',
        recipient: RELAYER_ADDR,
        funderAddress: FUNDER_ADDR,
        stack: 'opStack',
        mode: 'optimismPortal',
        bridgedAmount: ethers.utils.parseEther('0.5').toString(),
        baselineDestinationBalance: '0',
        depositTxHash: revertedHash,
        approvalTxHashes: [],
        phase: 'submitted',
        createdAtMs: Date.now() - 10_000,
        updatedAtMs: Date.now() - 10_000,
      });

      const { multiProvider, originProvider, sendTransaction } =
        createMockSetup();
      originProvider.getTransactionReceipt.resolves({
        status: 0,
        transactionHash: revertedHash,
      } as unknown as ethers.providers.TransactionReceipt);

      const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
        version: '1',
        roles: { relayer: { address: RELAYER_ADDR } },
        chains: {
          mode: {
            balances: { relayer: '0.5' },
            bridge: {
              stack: 'opStack',
              originChain: 'ethereum',
              mode: 'optimismPortal',
              bridgeContract: PORTAL_ADDR,
            },
          },
        },
      });

      const keyFunder = new KeyFunder(multiProvider, config, {
        logger: pino({ level: 'silent' }),
        bridgeStateFile: stateFile,
      });
      await keyFunder.fundChain('mode');

      sinon.assert.calledOnce(sendTransaction);
      const updated = await store.get('mode', RELAYER_ADDR);
      expect(updated?.depositTxHash).to.equal(`0x${'ab'.repeat(32)}`);
      expect(updated?.phase).to.equal('confirmed');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reconciles unbroadcast pre-crash prepared attempt via unadvanced origin nonce and retries cleanly', async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'keyfunder-bridge-precrash-'),
    );
    const stateFile = path.join(tmpDir, 'bridge-state.json');

    try {
      const precomputedHash = `0x${'55'.repeat(32)}`;
      const store = new FileBridgeStateStore(stateFile);
      await store.set({
        originChain: 'ethereum',
        destinationChain: 'mode',
        recipient: RELAYER_ADDR,
        funderAddress: FUNDER_ADDR,
        stack: 'opStack',
        mode: 'optimismPortal',
        bridgedAmount: ethers.utils.parseEther('0.5').toString(),
        baselineDestinationBalance: '0',
        originNonce: 7,
        depositTxHash: precomputedHash,
        approvalTxHashes: [],
        phase: 'prepared',
        createdAtMs: Date.now() - 5_000,
        updatedAtMs: Date.now() - 5_000,
      });

      const { multiProvider, originProvider, sendTransaction } =
        createMockSetup();
      // Pending nonce is still 7 and transaction is unknown => never broadcast
      originProvider.getTransactionCount.resolves(7);

      const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
        version: '1',
        roles: { relayer: { address: RELAYER_ADDR } },
        chains: {
          mode: {
            balances: { relayer: '0.5' },
            bridge: {
              stack: 'opStack',
              originChain: 'ethereum',
              mode: 'optimismPortal',
              bridgeContract: PORTAL_ADDR,
            },
          },
        },
      });

      const keyFunder = new KeyFunder(multiProvider, config, {
        logger: pino({ level: 'silent' }),
        bridgeStateFile: stateFile,
      });
      await keyFunder.fundChain('mode');

      sinon.assert.calledOnce(sendTransaction);
      const updated = await store.get('mode', RELAYER_ADDR);
      expect(updated?.phase).to.equal('confirmed');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
