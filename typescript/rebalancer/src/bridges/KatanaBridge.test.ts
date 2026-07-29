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
  ERC20_ABI,
  ETHEREUM_CHAIN_ID,
  KATANA_CHAIN_ID,
  KATANA_FORWARD_CONFIG,
  KATANA_REVERSE_CONFIG,
  oftInterface,
  previewInterface,
} from './katanaUtils.js';

const testLogger = pino({ level: 'silent' });
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_WALLET = new ethers.Wallet(TEST_PRIVATE_KEY);
const TEST_GUID = ethers.utils.hexZeroPad('0x1111', 32);
const erc20Interface = new ethers.utils.Interface(ERC20_ABI);

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
  contractReadResults: string[] = [];
  contractReads: Array<{ chainId: number; to: string; data: string }> = [];
  currentBlockNumber = 1234;
  nextReceipts: ethers.providers.TransactionReceipt[] = [];
  receiptResponses = new Map<
    string,
    ethers.providers.TransactionReceipt | null
  >();
  transactionDetails = new Map<
    string,
    ethers.providers.TransactionResponse | null
  >();
  logResponses: ethers.providers.Log[][] = [];
  logFilters: ethers.providers.Filter[] = [];
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

  protected override async readContract(
    chainId: number,
    to: string,
    data: string,
  ): Promise<string> {
    this.contractReads.push({ chainId, to, data });
    const result = this.contractReadResults.shift();
    if (!result) throw new Error('Missing readContract response');
    return result;
  }

  protected override async getCurrentBlockNumber(
    _chainId: number,
  ): Promise<number> {
    return this.currentBlockNumber;
  }

  protected override async getTransactionReceipt(
    chainId: number,
    txHash: string,
  ): Promise<ethers.providers.TransactionReceipt | null> {
    return (
      this.receiptResponses.get(`${chainId}:${txHash.toLowerCase()}`) ?? null
    );
  }

  protected override async getTransaction(
    chainId: number,
    txHash: string,
  ): Promise<ethers.providers.TransactionResponse | null> {
    return (
      this.transactionDetails.get(`${chainId}:${txHash.toLowerCase()}`) ?? null
    );
  }

  protected override async getLogs(
    _chainId: number,
    filter: ethers.providers.Filter,
  ): Promise<ethers.providers.Log[]> {
    this.logFilters.push(filter);
    return this.logResponses.shift() ?? [];
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

class InspectingKatanaBridge extends KatanaBridge {
  getProviderFor(chainId: number): ethers.providers.StaticJsonRpcProvider {
    return this.getProvider(chainId);
  }
}

class FeeRefreshingKatanaBridge extends KatanaBridge {
  latestBlock: Partial<ethers.providers.Block> = {};
  feeData: ethers.providers.FeeData = {
    gasPrice: null,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
    lastBaseFeePerGas: null,
  };

  protected override async getLatestBlock(
    _chainId: number,
  ): Promise<ethers.providers.Block> {
    return this.latestBlock as ethers.providers.Block;
  }

  protected override async getFeeData(
    _chainId: number,
  ): Promise<ethers.providers.FeeData> {
    return this.feeData;
  }

  async inspectFeeOverrides(
    tx: any,
  ): Promise<
    Pick<
      ethers.providers.TransactionRequest,
      'gasPrice' | 'maxFeePerGas' | 'maxPriorityFeePerGas'
    >
  > {
    return this.resolveFeeOverrides(ETHEREUM_CHAIN_ID, tx);
  }
}

function createReceipt(
  transactionHash: string,
  logs: ethers.providers.Log[] = [],
): ethers.providers.TransactionReceipt {
  return { transactionHash, logs } as ethers.providers.TransactionReceipt;
}

function createOftSentLog(
  transactionHash: string,
  amount: bigint,
): ethers.providers.Log {
  const encoded = oftInterface.encodeEventLog(
    oftInterface.getEvent('OFTSent'),
    [
      TEST_GUID,
      30101,
      TEST_WALLET.address,
      amount.toString(),
      amount.toString(),
    ],
  );
  return {
    address: KATANA_REVERSE_CONFIG.shareOftAddress,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash,
  } as ethers.providers.Log;
}

function createOftReceivedLog(transactionHash: string): ethers.providers.Log {
  const encoded = oftInterface.encodeEventLog(
    oftInterface.getEvent('OFTReceived'),
    [TEST_GUID, 30375, KATANA_FORWARD_CONFIG.composerAddress, '4800000'],
  );
  return {
    address: KATANA_FORWARD_CONFIG.shareOftAddress,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash,
  } as ethers.providers.Log;
}

function createComposeSentLog(transactionHash: string): ethers.providers.Log {
  return {
    address: KATANA_REVERSE_CONFIG.composerAddress,
    topics: [ethers.utils.id('Sent(bytes32)'), TEST_GUID],
    data: '0x',
    transactionHash,
  } as ethers.providers.Log;
}

function createErc20TransferLog(
  transactionHash: string,
  token: string,
  recipient: string,
  amount: bigint,
): ethers.providers.Log {
  const encoded = erc20Interface.encodeEventLog(
    erc20Interface.getEvent('Transfer'),
    [ethers.constants.AddressZero, recipient, amount.toString()],
  );
  return {
    address: token,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash,
  } as ethers.providers.Log;
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

  it('quotes katana -> ethereum via OFT compose route', async () => {
    const bridge = new TestKatanaBridge(BRIDGE_CONFIG, testLogger);
    bridge.contractReadResults = [
      previewInterface.encodeFunctionResult('previewRedeem', ['4800000']),
      oftInterface.encodeFunctionResult('quoteSend', [
        { nativeFee: '400000000000000', lzTokenFee: '0' },
      ]),
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

    expect(quote.toAmount).to.equal(4_800_000n);
    expect(quote.toAmountMin).to.equal(4_776_000n);
    expect(quote.gasCosts).to.equal(400_000_000_000_000n);
    expect(quote.route.claimTransactionRequired).to.equal(false);
    expect(quote.route.statusMode).to.equal('oft');
    expect(quote.route.executionTx.chainId).to.equal(KATANA_CHAIN_ID);
    expect(quote.route.executionTx.to).to.equal(
      KATANA_REVERSE_CONFIG.shareOftAddress,
    );
    expect(quote.route.approvalAddress).to.equal(
      KATANA_REVERSE_CONFIG.shareOftAddress,
    );
    expect(bridge.contractReads[0].chainId).to.equal(ETHEREUM_CHAIN_ID);
    expect(bridge.contractReads[0].to).to.equal(
      KATANA_REVERSE_CONFIG.vaultAddress,
    );
    expect(bridge.contractReads[1].chainId).to.equal(KATANA_CHAIN_ID);
    expect(bridge.contractReads[1].to).to.equal(
      KATANA_REVERSE_CONFIG.shareOftAddress,
    );
  });

  it('rejects reverse quote mode', async () => {
    const bridge = new TestKatanaBridge(BRIDGE_CONFIG, testLogger);
    let error: unknown;
    try {
      await bridge.quote({
        fromChain: ETHEREUM_CHAIN_ID,
        toChain: KATANA_CHAIN_ID,
        fromToken: KATANA_FORWARD_CONFIG.fromToken,
        toToken: KATANA_FORWARD_CONFIG.toToken,
        toAmount: 5_000_000n,
        fromAddress: TEST_WALLET.address,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain(
      'KatanaBridge only supports fromAmount',
    );
  });

  it('executes katana -> ethereum with OFT approval and send', async () => {
    const bridge = new TestKatanaBridge(BRIDGE_CONFIG, testLogger);
    bridge.contractReadResults = [
      previewInterface.encodeFunctionResult('previewRedeem', ['4800000']),
      oftInterface.encodeFunctionResult('quoteSend', [
        { nativeFee: '400000000000000', lzTokenFee: '0' },
      ]),
    ];
    bridge.allowance = 0n;
    bridge.nextReceipts = [
      createReceipt('0xapprove'),
      createReceipt('0xsourcetx', [createOftSentLog('0xsourcetx', 5_000_000n)]),
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
    expect(bridge.sentTransactions).to.have.length(2);
    expect(bridge.sentTransactions[0].chainId).to.equal(KATANA_CHAIN_ID);
    expect(bridge.sentTransactions[1].chainId).to.equal(KATANA_CHAIN_ID);
    expect(bridge.sentTransactions[1].tx.to).to.equal(
      KATANA_REVERSE_CONFIG.shareOftAddress,
    );
    expect(bridge.sentTransactions[1].tx.value).to.equal('400000000000000');
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

  it('reads completion from OFT destination receipt', async () => {
    const bridge = new TestKatanaBridge(BRIDGE_CONFIG, testLogger);
    bridge.contractReadResults = [
      previewInterface.encodeFunctionResult('previewRedeem', ['4800000']),
      oftInterface.encodeFunctionResult('quoteSend', [
        { nativeFee: '400000000000000', lzTokenFee: '0' },
      ]),
    ];
    bridge.allowance = 5_000_000n;
    bridge.nextReceipts = [
      createReceipt('0xsourcetx', [createOftSentLog('0xsourcetx', 5_000_000n)]),
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

    await bridge.execute(quote, {
      [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
    });

    bridge.receiptResponses.set(
      `${KATANA_CHAIN_ID}:0xsourcetx`,
      createReceipt('0xsourcetx', [createOftSentLog('0xsourcetx', 5_000_000n)]),
    );
    bridge.logResponses = [[createOftReceivedLog('0xdesttx')]];
    bridge.receiptResponses.set(
      `${ETHEREUM_CHAIN_ID}:0xdesttx`,
      createReceipt('0xdesttx', [
        createErc20TransferLog(
          '0xdesttx',
          KATANA_REVERSE_CONFIG.toToken,
          TEST_WALLET.address,
          4_800_000n,
        ),
      ]),
    );

    const status = await bridge.getStatus(
      '0xsourcetx',
      KATANA_CHAIN_ID,
      ETHEREUM_CHAIN_ID,
    );

    expect(status).to.deep.equal({
      status: 'complete',
      receivingTxHash: '0xdesttx',
      receivedAmount: 4_800_000n,
    });
  });

  it('reads completion from follow-up composer tx after OFT receipt', async () => {
    const bridge = new TestKatanaBridge(BRIDGE_CONFIG, testLogger);
    bridge.contractReadResults = [
      previewInterface.encodeFunctionResult('previewRedeem', ['4800000']),
      oftInterface.encodeFunctionResult('quoteSend', [
        { nativeFee: '400000000000000', lzTokenFee: '0' },
      ]),
    ];
    bridge.allowance = 5_000_000n;
    bridge.nextReceipts = [
      createReceipt('0xsourcetx', [createOftSentLog('0xsourcetx', 5_000_000n)]),
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

    await bridge.execute(quote, {
      [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
    });

    bridge.receiptResponses.set(
      `${KATANA_CHAIN_ID}:0xsourcetx`,
      createReceipt('0xsourcetx', [createOftSentLog('0xsourcetx', 5_000_000n)]),
    );
    bridge.logResponses = [
      [createOftReceivedLog('0xdesttx')],
      [createComposeSentLog('0xcomposetx')],
    ];
    bridge.receiptResponses.set(
      `${ETHEREUM_CHAIN_ID}:0xdesttx`,
      createReceipt('0xdesttx'),
    );
    bridge.receiptResponses.set(
      `${ETHEREUM_CHAIN_ID}:0xcomposetx`,
      createReceipt('0xcomposetx', [
        createErc20TransferLog(
          '0xcomposetx',
          KATANA_REVERSE_CONFIG.toToken,
          TEST_WALLET.address,
          4_800_000n,
        ),
      ]),
    );

    const status = await bridge.getStatus(
      '0xsourcetx',
      KATANA_CHAIN_ID,
      ETHEREUM_CHAIN_ID,
    );

    expect(status).to.deep.equal({
      status: 'complete',
      receivingTxHash: '0xcomposetx',
      receivedAmount: 4_800_000n,
    });
  });

  it('rehydrates reverse OFT status from tx hash without prior execute state', async () => {
    const bridge = new TestKatanaBridge(BRIDGE_CONFIG, testLogger);
    bridge.currentBlockNumber = 100_000;
    bridge.transactionDetails.set(`${KATANA_CHAIN_ID}:0xsourcetx`, {
      from: TEST_WALLET.address,
    } as ethers.providers.TransactionResponse);
    bridge.receiptResponses.set(
      `${KATANA_CHAIN_ID}:0xsourcetx`,
      createReceipt('0xsourcetx', [createOftSentLog('0xsourcetx', 5_000_000n)]),
    );
    bridge.logResponses = [
      [createOftReceivedLog('0xdesttx')],
      [createComposeSentLog('0xcomposetx')],
    ];
    bridge.receiptResponses.set(
      `${ETHEREUM_CHAIN_ID}:0xdesttx`,
      createReceipt('0xdesttx'),
    );
    bridge.receiptResponses.set(
      `${ETHEREUM_CHAIN_ID}:0xcomposetx`,
      createReceipt('0xcomposetx', [
        createErc20TransferLog(
          '0xcomposetx',
          KATANA_REVERSE_CONFIG.toToken,
          TEST_WALLET.address,
          4_800_000n,
        ),
      ]),
    );

    const status = await bridge.getStatus(
      '0xsourcetx',
      KATANA_CHAIN_ID,
      ETHEREUM_CHAIN_ID,
    );

    expect(status).to.deep.equal({
      status: 'complete',
      receivingTxHash: '0xcomposetx',
      receivedAmount: 4_800_000n,
    });
    expect(bridge.logFilters[0].fromBlock).to.equal(50_001);
  });

  it('uses static EVM providers and ignores non-EVM chainId collisions', () => {
    const bridge = new InspectingKatanaBridge(
      {
        ...BRIDGE_CONFIG,
        chainMetadata: {
          ...BRIDGE_CONFIG.chainMetadata,
          collision: {
            chainId: ETHEREUM_CHAIN_ID,
            domainId: 999_999,
            protocol: ProtocolType.Sealevel,
            name: 'collision',
            displayName: 'Collision',
            rpcUrls: [{ http: 'https://wrong.example' }],
          },
        },
      },
      testLogger,
    );

    const provider = bridge.getProviderFor(ETHEREUM_CHAIN_ID);

    expect(provider).to.be.instanceOf(ethers.providers.StaticJsonRpcProvider);
    expect(provider.connection.url).to.equal('https://ethereum.example');
    expect(provider.network.chainId).to.equal(ETHEREUM_CHAIN_ID);
  });

  it('refreshes stale gas price when it is below base fee', async () => {
    const bridge = new FeeRefreshingKatanaBridge(BRIDGE_CONFIG, testLogger);
    bridge.latestBlock = {
      baseFeePerGas: ethers.BigNumber.from('1021381537'),
    };
    bridge.feeData = {
      gasPrice: ethers.BigNumber.from('1021881537'),
      maxFeePerGas: ethers.BigNumber.from('1200000000'),
      maxPriorityFeePerGas: ethers.BigNumber.from('1000000'),
      lastBaseFeePerGas: null,
    };

    const feeOverrides = await bridge.inspectFeeOverrides(
      createRoute().transactionRequest,
    );

    expect(feeOverrides.gasPrice).to.equal(undefined);
    expect(feeOverrides.maxFeePerGas?.toString()).to.equal('1200000000');
    expect(feeOverrides.maxPriorityFeePerGas?.toString()).to.equal('1000000');
  });

  it('keeps provided gas price when it is already viable', async () => {
    const bridge = new FeeRefreshingKatanaBridge(BRIDGE_CONFIG, testLogger);
    bridge.latestBlock = {
      baseFeePerGas: ethers.BigNumber.from('1000000000'),
    };

    const feeOverrides = await bridge.inspectFeeOverrides({
      ...createRoute().transactionRequest,
      gasPrice: '1100000000',
    });

    expect(feeOverrides.gasPrice?.toString()).to.equal('1100000000');
    expect(feeOverrides.maxFeePerGas).to.equal(undefined);
    expect(feeOverrides.maxPriorityFeePerGas).to.equal(undefined);
  });
});
