import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import { pino } from 'pino';
import sinon from 'sinon';

import { ERC20__factory } from '@hyperlane-xyz/core';
import { MultiProvider } from '@hyperlane-xyz/sdk';

import {
  ChainConfigSchema,
  KeyFunderConfigSchema,
  type KeyFunderConfig,
} from '../config/types.js';

import {
  BRIDGE_INTERFACES,
  formatStandardHookMetadata,
} from './BridgeFunder.js';
import { KeyFunder } from './KeyFunder.js';

const RELAYER_ADDR = '0x1111111111111111111111111111111111111111';
const FUNDER_ADDR = '0x2222222222222222222222222222222222222222';
const PORTAL_ADDR = '0x3333333333333333333333333333333333333333';
const L1_BRIDGE_ADDR = '0x4444444444444444444444444444444444444444';
const INBOX_ADDR = '0x5555555555555555555555555555555555555555';
const MAILBOX_ADDR = '0x6666666666666666666666666666666666666666';
const HOOK_ADDR = '0x7777777777777777777777777777777777777777';
const GAS_TOKEN_ADDR = '0x8888888888888888888888888888888888888888';

function createMockSetup(params?: {
  destFunderBalance?: BigNumber;
  destRoleBalance?: BigNumber;
  originFunderBalance?: BigNumber;
}) {
  const destProvider = sinon.createStubInstance(
    ethers.providers.JsonRpcProvider,
  );
  destProvider.getBalance.resolves(
    params?.destRoleBalance ?? BigNumber.from(0),
  );

  const originProvider = sinon.createStubInstance(
    ethers.providers.JsonRpcProvider,
  );
  originProvider.call.rejects(new Error('quoteDispatch unmocked'));

  const destSigner = sinon.createStubInstance(ethers.Wallet);
  destSigner.getAddress.resolves(FUNDER_ADDR);
  destSigner.getBalance.resolves(
    params?.destFunderBalance ?? BigNumber.from(0),
  );

  const originSigner = sinon.createStubInstance(ethers.Wallet);
  originSigner.getAddress.resolves(FUNDER_ADDR);
  originSigner.getBalance.resolves(
    params?.originFunderBalance ?? ethers.utils.parseEther('10'),
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

  const sendTransaction = sinon.stub<
    Parameters<MultiProvider['sendTransaction']>,
    ReturnType<MultiProvider['sendTransaction']>
  >();
  sendTransaction.resolves({
    transactionHash: `0x${'ab'.repeat(32)}`,
  } as unknown as ethers.ContractReceipt);
  multiProvider.sendTransaction = sendTransaction;
  multiProvider.tryGetExplorerTxUrl.returns(null);

  return { multiProvider, sendTransaction, originProvider };
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

  it('bridges via Hyperlane Hook Mailbox.dispatch with StandardHookMetadata', async () => {
    const { multiProvider, sendTransaction } = createMockSetup();
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

    sinon.assert.calledOnce(sendTransaction);
    const tx = await Promise.resolve(sendTransaction.firstCall.args[1]);
    expect(tx.to).to.equal(MAILBOX_ADDR);
    const amount = ethers.utils.parseEther('0.25');
    expect(tx.value?.toString()).to.equal(amount.toString());
    const decoded = BRIDGE_INTERFACES.hyperlaneMailbox.decodeFunctionData(
      'dispatch',
      tx.data ?? '0x',
    );
    expect(decoded.destinationDomain).to.equal(8453);
    expect(decoded.customHook.toLowerCase()).to.equal(HOOK_ADDR);
    expect(decoded.customHookMetadata).to.equal(
      formatStandardHookMetadata({
        msgValue: amount,
        gasLimit: 300_000,
        refundAddress: FUNDER_ADDR,
      }),
    );
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

  it('approves and deposits custom ERC20 gas tokens via Arbitrum Orbit erc20Inbox', async () => {
    const tokenInterface = ERC20__factory.createInterface();
    const destProvider = new ethers.providers.JsonRpcProvider();
    sinon.stub(destProvider, 'call').callsFake(async (tx) => {
      const data = String(await tx.data);
      const { name } = tokenInterface.parseTransaction({ data });
      if (name === 'decimals') {
        return tokenInterface.encodeFunctionResult('decimals', [18]);
      }
      if (name === 'balanceOf') {
        return tokenInterface.encodeFunctionResult('balanceOf', [
          BigNumber.from(0),
        ]);
      }
      throw new Error(`Unexpected dest call: ${name}`);
    });

    const originProvider = new ethers.providers.JsonRpcProvider();
    sinon.stub(originProvider, 'call').callsFake(async (tx) => {
      const data = String(await tx.data);
      const { name } = tokenInterface.parseTransaction({ data });
      if (name === 'balanceOf') {
        return tokenInterface.encodeFunctionResult('balanceOf', [
          ethers.utils.parseEther('50'),
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

    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getProvider.callsFake((chain) =>
      chain === 'ethereum' ? originProvider : destProvider,
    );
    multiProvider.getSigner.callsFake((chain) =>
      chain === 'ethereum' ? originSigner : destSigner,
    );
    multiProvider.getSignerAddress.resolves(FUNDER_ADDR);
    multiProvider.getChainMetadata.returns({});
    const sendTransaction = sinon.stub<
      Parameters<MultiProvider['sendTransaction']>,
      ReturnType<MultiProvider['sendTransaction']>
    >();
    sendTransaction.resolves({
      transactionHash: `0x${'cd'.repeat(32)}`,
    } as unknown as ethers.ContractReceipt);
    multiProvider.sendTransaction = sendTransaction;

    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        orbitcustom: {
          erc20GasToken: { address: GAS_TOKEN_ADDR, decimals: 18 },
          balances: { relayer: '2' },
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
    await keyFunder.fundChain('orbitcustom');

    sinon.assert.calledTwice(sendTransaction);
    const firstTx = await Promise.resolve(sendTransaction.firstCall.args[1]);
    expect(firstTx.to).to.equal(GAS_TOKEN_ADDR);
    const secondTx = await Promise.resolve(sendTransaction.secondCall.args[1]);
    expect(secondTx.to).to.equal(INBOX_ADDR);
    const decoded = BRIDGE_INTERFACES.arbitrumErc20Inbox.decodeFunctionData(
      'depositERC20',
      secondTx.data ?? '0x',
    );
    expect(decoded._amount.toString()).to.equal(
      ethers.utils.parseEther('2').toString(),
    );
  });

  it('enforces originReserveBuffer and clamps to maxBridgeAmount', async () => {
    const { multiProvider, sendTransaction } = createMockSetup({
      originFunderBalance: ethers.utils.parseEther('1.02'),
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

    let caught: Error | undefined;
    try {
      await keyFunder.fundChain('mode');
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).to.be.instanceOf(Error);
    expect(caught?.message).to.include('Insufficient origin balance');
    sinon.assert.notCalled(sendTransaction);
  });
});
