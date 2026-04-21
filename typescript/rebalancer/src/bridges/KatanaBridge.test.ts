import { expect } from 'chai';
import { ethers } from 'ethers';
import { pino } from 'pino';

import { ProtocolType } from '@hyperlane-xyz/utils';

import type {
  BridgeQuote,
  ExternalBridgeConfig,
} from '../interfaces/IExternalBridge.js';
import { KatanaBridge, type KatanaBridgeRoute } from './KatanaBridge.js';
import {
  ETHEREUM_CHAIN_ID,
  KATANA_CHAIN_ID,
  KATANA_FORWARD_CONFIG,
  KATANA_REVERSE_CONFIG,
} from './katanaUtils.js';

const testLogger = pino({ level: 'silent' });
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_WALLET = new ethers.Wallet(TEST_PRIVATE_KEY);

const BRIDGE_CONFIG: ExternalBridgeConfig = {
  integrator: 'hyperlane',
  defaultSlippage: 0.005,
  chainMetadata: {
    ethereum: {
      chainId: ETHEREUM_CHAIN_ID,
      domainId: ETHEREUM_CHAIN_ID,
      protocol: ProtocolType.Ethereum,
      name: 'ethereum',
      displayName: 'Ethereum',
      rpcUrls: [{ http: 'https://ethereum.example' }],
    },
    katana: {
      chainId: KATANA_CHAIN_ID,
      domainId: KATANA_CHAIN_ID,
      protocol: ProtocolType.Ethereum,
      name: 'katana',
      displayName: 'Katana',
      rpcUrls: [{ http: 'https://katana.example' }],
    },
  },
};

class TestKatanaBridge extends KatanaBridge {
  routeResponses: any[] = [];
  transactionResponses: any[][] = [];
  claimResponses: Array<any | Error> = [];
  nextReceipts: ethers.providers.TransactionReceipt[] = [];
  sentTransactions: Array<{ chainId: number; tx: any }> = [];
  allowance = 0n;
  lastRouteRequest?: Record<string, unknown>;

  protected override async requestRoutes(params: {
    fromChainId: number;
    toChainId: number;
    fromTokenAddress: string;
    toTokenAddress: string;
    amount: string;
    fromAddress: string;
    toAddress: string;
    slippage: number;
  }): Promise<any[]> {
    this.lastRouteRequest = params;
    return this.routeResponses;
  }

  protected override async requestUnsignedTransaction(): Promise<any> {
    throw new Error('Unexpected build transaction call in test');
  }

  protected override async requestTransactions(): Promise<any[]> {
    return this.transactionResponses.shift() ?? [];
  }

  protected override async requestClaimTransaction(): Promise<any> {
    const next = this.claimResponses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('Missing claim response');
    return next;
  }

  protected override async readAllowance(): Promise<bigint> {
    return this.allowance;
  }

  protected override async sendPreparedTransaction(
    chainId: number,
    _privateKey: string,
    tx: any,
  ): Promise<ethers.providers.TransactionReceipt> {
    this.sentTransactions.push({ chainId, tx });
    const receipt = this.nextReceipts.shift();
    if (!receipt) throw new Error('Missing test receipt');
    return receipt;
  }

  protected override async sleep(): Promise<void> {}
}

function createReceipt(
  transactionHash: string,
): ethers.providers.TransactionReceipt {
  return { transactionHash } as ethers.providers.TransactionReceipt;
}

function createRoute(overrides?: Partial<any>): any {
  return {
    id: 'route-1',
    provider: ['agglayer'],
    fromChainId: ETHEREUM_CHAIN_ID,
    toChainId: KATANA_CHAIN_ID,
    fromAmount: '5000000',
    toAmount: '5000000',
    toAmountMin: '5000000',
    feeCosts: [],
    gasCosts: [{ amount: '1000000000000000' }],
    steps: [
      {
        estimate: {
          approvalAddress: '0x53e82abbb12638f09d9e624578ccb666217a765e',
        },
      },
    ],
    transactionRequest: {
      from: TEST_WALLET.address.toLowerCase(),
      to: '0x53e82abbb12638f09d9e624578ccb666217a765e',
      data: '0xdeadbeef',
      value: '0',
      gasLimit: '1000000',
      gasPrice: '1000000000',
      chainId: ETHEREUM_CHAIN_ID,
    },
    providerMetadata: {
      agglayer: {
        claimTransactionRequired: false,
      },
    },
    estimatedCompletionTime: 1200,
    ...overrides,
  };
}

function createTransaction(overrides?: Partial<any>): any {
  return {
    transactionHash: '0xsourcetx',
    transactionHashes: ['0xsourcetx'],
    status: 'BRIDGED',
    sending: {
      txHash: '0xsourcetx',
      network: {
        chainId: KATANA_CHAIN_ID,
        networkId: 20,
      },
    },
    receiving: null,
    metadata: {
      depositCount: 7,
    },
    ...overrides,
  };
}

describe('KatanaBridge', () => {
  it('quotes ethereum -> katana via ARC route', async () => {
    const bridge = new TestKatanaBridge(BRIDGE_CONFIG, testLogger);
    bridge.routeResponses = [createRoute()];

    const quote = await bridge.quote({
      fromChain: ETHEREUM_CHAIN_ID,
      toChain: KATANA_CHAIN_ID,
      fromToken: KATANA_FORWARD_CONFIG.fromToken,
      toToken: KATANA_FORWARD_CONFIG.toToken,
      fromAmount: 5_000_000n,
      fromAddress: TEST_WALLET.address,
      toAddress: TEST_WALLET.address,
    });

    expect(bridge.lastRouteRequest?.slippage).to.equal(0.5);
    expect(quote.fromAmount).to.equal(5_000_000n);
    expect(quote.toAmount).to.equal(5_000_000n);
    expect(quote.toAmountMin).to.equal(5_000_000n);
    expect(quote.gasCosts).to.equal(1_000_000_000_000_000n);
    expect(quote.route.claimTransactionRequired).to.equal(false);
    expect(quote.route.executionTx.chainId).to.equal(ETHEREUM_CHAIN_ID);
  });

  it('quotes katana -> ethereum via ARC route', async () => {
    const bridge = new TestKatanaBridge(BRIDGE_CONFIG, testLogger);
    bridge.routeResponses = [
      createRoute({
        fromChainId: KATANA_CHAIN_ID,
        toChainId: ETHEREUM_CHAIN_ID,
        transactionRequest: {
          from: TEST_WALLET.address.toLowerCase(),
          to: '0x2a3dd3eb832af982ec71669e178424b10dca2ede',
          data: '0xbeef',
          value: '0',
          gasLimit: '400000',
          gasPrice: '1000000000',
          chainId: KATANA_CHAIN_ID,
        },
        providerMetadata: {
          agglayer: {
            claimTransactionRequired: true,
          },
        },
      }),
    ];

    const quote = await bridge.quote({
      fromChain: KATANA_CHAIN_ID,
      toChain: ETHEREUM_CHAIN_ID,
      fromToken: KATANA_REVERSE_CONFIG.fromToken,
      toToken: KATANA_REVERSE_CONFIG.toToken,
      fromAmount: 5_000_000n,
      fromAddress: TEST_WALLET.address,
      toAddress: TEST_WALLET.address,
    });

    expect(quote.route.claimTransactionRequired).to.equal(true);
    expect(quote.route.executionTx.chainId).to.equal(KATANA_CHAIN_ID);
  });

  it('rejects reverse quote mode', async () => {
    const bridge = new TestKatanaBridge(BRIDGE_CONFIG, testLogger);

    await expect(
      bridge.quote({
        fromChain: ETHEREUM_CHAIN_ID,
        toChain: KATANA_CHAIN_ID,
        fromToken: KATANA_FORWARD_CONFIG.fromToken,
        toToken: KATANA_FORWARD_CONFIG.toToken,
        toAmount: 5_000_000n,
        fromAddress: TEST_WALLET.address,
      }),
    ).to.be.rejectedWith('KatanaBridge only supports fromAmount');
  });

  it('executes katana -> ethereum with approval and claim submission', async () => {
    const bridge = new TestKatanaBridge(BRIDGE_CONFIG, testLogger);
    bridge.routeResponses = [
      createRoute({
        fromChainId: KATANA_CHAIN_ID,
        toChainId: ETHEREUM_CHAIN_ID,
        transactionRequest: {
          from: TEST_WALLET.address.toLowerCase(),
          to: '0x2a3dd3eb832af982ec71669e178424b10dca2ede',
          data: '0xbeef',
          value: '0',
          gasLimit: '400000',
          gasPrice: '1000000000',
          chainId: KATANA_CHAIN_ID,
        },
        providerMetadata: {
          agglayer: {
            claimTransactionRequired: true,
          },
        },
      }),
    ];
    bridge.allowance = 0n;
    bridge.nextReceipts = [
      createReceipt('0xapprove'),
      createReceipt('0xsourcetx'),
      createReceipt('0xclaimtx'),
    ];
    bridge.transactionResponses = [[], [createTransaction()]];
    bridge.claimResponses = [
      {
        to: '0x2a3dd3eb832af982ec71669e178424b10dca2ede',
        data: '0xclaim',
        value: '0',
        gasLimit: '500000',
        gasPrice: '1000000000',
        chainId: ETHEREUM_CHAIN_ID,
      },
    ];

    const quote = (await bridge.quote({
      fromChain: KATANA_CHAIN_ID,
      toChain: ETHEREUM_CHAIN_ID,
      fromToken: KATANA_REVERSE_CONFIG.fromToken,
      toToken: KATANA_REVERSE_CONFIG.toToken,
      fromAmount: 5_000_000n,
      fromAddress: TEST_WALLET.address,
      toAddress: TEST_WALLET.address,
    })) as BridgeQuote<KatanaBridgeRoute>;

    const result = await bridge.execute(quote, {
      [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
    });

    expect(result.txHash).to.equal('0xsourcetx');
    expect(bridge.sentTransactions).to.have.length(3);
    expect(bridge.sentTransactions[0].chainId).to.equal(KATANA_CHAIN_ID);
    expect(bridge.sentTransactions[1].chainId).to.equal(KATANA_CHAIN_ID);
    expect(bridge.sentTransactions[2].chainId).to.equal(ETHEREUM_CHAIN_ID);
  });

  it('reads completion from ARC transaction status', async () => {
    const bridge = new TestKatanaBridge(BRIDGE_CONFIG, testLogger);
    bridge.routeResponses = [createRoute()];
    bridge.allowance = 5_000_000n;
    bridge.nextReceipts = [createReceipt('0xsourcetx')];

    const quote = (await bridge.quote({
      fromChain: ETHEREUM_CHAIN_ID,
      toChain: KATANA_CHAIN_ID,
      fromToken: KATANA_FORWARD_CONFIG.fromToken,
      toToken: KATANA_FORWARD_CONFIG.toToken,
      fromAmount: 5_000_000n,
      fromAddress: TEST_WALLET.address,
      toAddress: TEST_WALLET.address,
    })) as BridgeQuote<KatanaBridgeRoute>;

    await bridge.execute(quote, {
      [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
    });

    bridge.transactionResponses = [
      [
        createTransaction({
          transactionHash: '0xsourcetx',
          transactionHashes: ['0xsourcetx', '0xreceivingtx'],
          status: 'CLAIMED',
          sending: {
            txHash: '0xsourcetx',
            network: {
              chainId: ETHEREUM_CHAIN_ID,
              networkId: 0,
            },
          },
          receiving: {
            txHash: '0xreceivingtx',
            amount: '5000000',
          },
        }),
      ],
    ];

    const status = await bridge.getStatus(
      '0xsourcetx',
      ETHEREUM_CHAIN_ID,
      KATANA_CHAIN_ID,
    );

    expect(status).to.deep.equal({
      status: 'complete',
      receivingTxHash: '0xreceivingtx',
      receivedAmount: 5_000_000n,
    });
  });
});
