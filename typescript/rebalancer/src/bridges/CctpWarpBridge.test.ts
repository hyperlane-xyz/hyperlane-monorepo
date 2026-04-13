import { expect } from 'chai';
import { ethers } from 'ethers';
import { pino } from 'pino';
import Sinon from 'sinon';

import type { IRegistry } from '@hyperlane-xyz/registry';
import {
  HyperlaneCore,
  MultiProvider,
  type WarpTypedTransaction,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { CctpWarpBridge } from './CctpWarpBridge.js';

const testLogger = pino({ level: 'silent' });

class TestableCctpWarpBridge extends CctpWarpBridge {
  public selectedPath(): string {
    return this.getSelectedRegistryRelativePath();
  }
}

function createMockRegistry(): IRegistry {
  return {
    uri: '/tmp/mock-registry',
  } as IRegistry;
}

function createFakeToken(chainName: string, connectedTo?: string) {
  const token = {
    chainName,
    amount: (amount: bigint) => ({ amount, token }),
    getConnectionForChain: (destination: string) =>
      destination === connectedTo ? { token: destination } : undefined,
  };
  return token;
}

function encodeWarpRouteBody(amount: bigint): string {
  const recipient = ethers.utils.hexZeroPad('0x1234', 32);
  const encodedAmount = ethers.utils.hexZeroPad(
    ethers.BigNumber.from(amount.toString()).toHexString(),
    32,
  );
  return `${recipient}${encodedAmount.slice(2)}`;
}

describe('CctpWarpBridge', () => {
  let sandbox: Sinon.SinonSandbox;
  let multiProvider: Sinon.SinonStubbedInstance<MultiProvider>;

  beforeEach(() => {
    sandbox = Sinon.createSandbox();
    multiProvider = sandbox.createStubInstance(MultiProvider);
    multiProvider.getChainId.callsFake((chain) => {
      if (chain === 'ethereum') return 1;
      if (chain === 'arbitrum') return 42161;
      throw new Error(`Unexpected chain ${String(chain)}`);
    });
    multiProvider.getDomainId.callsFake((chain) => {
      if (chain === 'ethereum') return 1;
      if (chain === 'arbitrum') return 42161;
      throw new Error(`Unexpected chain ${String(chain)}`);
    });
    multiProvider.getProtocol.returns(ProtocolType.Ethereum);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('selects the fast registry config path', () => {
    const bridge = new TestableCctpWarpBridge(
      { mode: 'fast' },
      multiProvider as unknown as MultiProvider,
      createMockRegistry(),
      testLogger,
    );

    expect(bridge.selectedPath()).to.equal(
      'deployments/warp_routes/USDC/mainnet-cctp-v2-fast-config.yaml',
    );
  });

  it('selects the standard registry config path', () => {
    const bridge = new TestableCctpWarpBridge(
      { mode: 'standard' },
      multiProvider as unknown as MultiProvider,
      createMockRegistry(),
      testLogger,
    );

    expect(bridge.selectedPath()).to.equal(
      'deployments/warp_routes/USDC/mainnet-cctp-v2-standard-config.yaml',
    );
  });

  it('rejects toAmount quotes', async () => {
    const bridge = new CctpWarpBridge(
      { mode: 'fast' },
      multiProvider as unknown as MultiProvider,
      createMockRegistry(),
      testLogger,
    );

    try {
      await bridge.quote({
        fromChain: 1,
        toChain: 42161,
        fromToken: '0xfrom',
        toToken: '0xto',
        fromAddress: '0x123',
        toAmount: 1n,
      });
      expect.fail('Expected quote to throw');
    } catch (error) {
      expect((error as Error).message).to.include(
        'does not support toAmount quotes',
      );
    }
  });

  it('quotes using the selected warp route pair and token fee output', async () => {
    const bridge = new CctpWarpBridge(
      { mode: 'fast' },
      multiProvider as unknown as MultiProvider,
      createMockRegistry(),
      testLogger,
    );
    const fromToken = createFakeToken('ethereum', 'arbitrum');
    const toToken = createFakeToken('arbitrum');
    const estimateTransferRemoteFees = sandbox.stub().resolves({
      interchainQuote: { amount: 55n },
      localQuote: { amount: 0n },
      tokenFeeQuote: { amount: 7n },
    });

    sandbox.stub(bridge as any, 'getContext').resolves({
      warpCore: {
        tokens: [fromToken, toToken],
        estimateTransferRemoteFees,
      },
    });

    const quote = await bridge.quote({
      fromChain: 1,
      toChain: 42161,
      fromToken: '0xignored-from',
      toToken: '0xignored-to',
      fromAddress: '0xsender',
      fromAmount: 100n,
    });

    expect(quote.tool).to.equal('hyperlane-cctp-warp');
    expect(quote.fromAmount).to.equal(100n);
    expect(quote.toAmount).to.equal(93n);
    expect(quote.toAmountMin).to.equal(93n);
    expect(quote.gasCosts).to.equal(55n);
    expect(quote.feeCosts).to.equal(7n);
    expect(quote.route).to.deep.equal({
      mode: 'fast',
      fromChainName: 'ethereum',
      toChainName: 'arbitrum',
      fromAddress: '0xsender',
      toAddress: '0xsender',
    });
    expect(estimateTransferRemoteFees.calledOnce).to.equal(true);
  });

  it('executes transfer txs and returns the dispatched message id as transferId', async () => {
    const bridge = new CctpWarpBridge(
      { mode: 'fast' },
      multiProvider as unknown as MultiProvider,
      createMockRegistry(),
      testLogger,
    );
    const fromToken = createFakeToken('ethereum', 'arbitrum');
    const toToken = createFakeToken('arbitrum');
    const transferTxs = sandbox.stub().resolves([
      {
        category: 'approval',
        type: 'ethersV5',
      } as unknown as WarpTypedTransaction,
      {
        category: 'transfer',
        type: 'ethersV5',
      } as unknown as WarpTypedTransaction,
    ]);
    const provider = {
      getTransactionReceipt: sandbox.stub().resolves({ logs: [] }),
    };

    sandbox.stub(bridge as any, 'getContext').resolves({
      warpCore: {
        tokens: [fromToken, toToken],
        getTransferRemoteTxs: transferTxs,
        multiProvider: {
          getChainMetadata: sandbox.stub().returns({}),
        },
      },
    });
    sandbox
      .stub(bridge as any, 'sendWarpTransaction')
      .onFirstCall()
      .resolves('0xapprove')
      .onSecondCall()
      .resolves('0xtransfer');
    multiProvider.getProvider.returns(provider as any);
    sandbox
      .stub(HyperlaneCore, 'getDispatchedMessages')
      .returns([{ id: '0xmessage-id' } as any]);

    const result = await bridge.execute(
      {
        id: 'quote-id',
        tool: 'hyperlane-cctp-warp',
        fromAmount: 100n,
        toAmount: 100n,
        toAmountMin: 100n,
        executionDuration: 0,
        gasCosts: 0n,
        feeCosts: 0n,
        route: {
          mode: 'fast',
          fromChainName: 'ethereum',
          toChainName: 'arbitrum',
          fromAddress: '0xsender',
          toAddress: '0xrecipient',
        },
        requestParams: {
          fromChain: 1,
          toChain: 42161,
          fromToken: '0xignored-from',
          toToken: '0xignored-to',
          fromAddress: '0xsender',
          fromAmount: 100n,
        },
      },
      { [ProtocolType.Ethereum]: '0xabc123' },
    );

    expect(result).to.deep.equal({
      txHash: '0xtransfer',
      fromChain: 1,
      toChain: 42161,
      transferId: '0xmessage-id',
    });
  });

  it('returns pending status when the message has not been delivered', async () => {
    const bridge = new CctpWarpBridge(
      { mode: 'fast' },
      multiProvider as unknown as MultiProvider,
      createMockRegistry(),
      testLogger,
    );
    const provider = {
      getTransactionReceipt: sandbox.stub().resolves({ logs: [] }),
    };

    sandbox.stub(bridge as any, 'getContext').resolves({
      warpCore: {
        tokens: [createFakeToken('ethereum'), createFakeToken('arbitrum')],
      },
      hyperlaneCore: {
        getDestination: sandbox.stub().returns('arbitrum'),
        isDelivered: sandbox.stub().resolves(false),
      },
    });
    multiProvider.getProvider.returns(provider as any);
    sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([
      {
        id: '0xmessage-id',
        parsed: { body: encodeWarpRouteBody(88n) },
      } as any,
    ]);

    const status = await bridge.getStatus('0xtx', 1, 42161);
    expect(status).to.deep.equal({ status: 'pending' });
  });

  it('returns complete status with processed tx hash and parsed received amount', async () => {
    const bridge = new CctpWarpBridge(
      { mode: 'fast' },
      multiProvider as unknown as MultiProvider,
      createMockRegistry(),
      testLogger,
    );
    const provider = {
      getTransactionReceipt: sandbox.stub().resolves({ logs: [] }),
    };

    sandbox.stub(bridge as any, 'getContext').resolves({
      warpCore: {
        tokens: [createFakeToken('ethereum'), createFakeToken('arbitrum')],
      },
      hyperlaneCore: {
        getDestination: sandbox.stub().returns('arbitrum'),
        isDelivered: sandbox.stub().resolves(true),
        getProcessedReceipt: sandbox
          .stub()
          .resolves({ transactionHash: '0xprocessed' }),
      },
    });
    multiProvider.getProvider.returns(provider as any);
    sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([
      {
        id: '0xmessage-id',
        parsed: { body: encodeWarpRouteBody(91n) },
      } as any,
    ]);

    const status = await bridge.getStatus('0xtx', 1, 42161);
    expect(status).to.deep.equal({
      status: 'complete',
      receivingTxHash: '0xprocessed',
      receivedAmount: 91n,
    });
  });
});
