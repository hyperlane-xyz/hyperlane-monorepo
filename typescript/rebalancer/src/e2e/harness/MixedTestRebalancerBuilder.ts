import { ethers } from 'ethers';
import { type Logger, pino } from 'pino';
import { PublicKey } from '@solana/web3.js';

import { HyperlaneCore, MultiProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { RebalancerConfig } from '../../config/RebalancerConfig.js';
import {
  DEFAULT_INTENT_TTL_MS,
  ExternalBridgeType,
  type StrategyConfig,
} from '../../config/types.js';
import {
  RebalancerOrchestrator,
  type RebalancerOrchestratorDeps,
} from '../../core/RebalancerOrchestrator.js';
import { RebalancerContextFactory } from '../../factories/RebalancerContextFactory.js';
import type { ExternalBridgeRegistry } from '../../interfaces/IExternalBridge.js';
import type { ConfirmedBlockTags } from '../../interfaces/IMonitor.js';

import {
  ANVIL_TEST_PRIVATE_KEY,
  ANVIL_USER_PRIVATE_KEY,
  type NativeDeployedAddresses,
  TEST_CHAINS,
} from '../fixtures/routes.js';
import {
  MAILBOX_PROGRAM_ID,
  MIXED_BALANCE_PRESETS,
  MIXED_SIGNER_PRESETS,
  SVM_CHAIN_NAME,
  SVM_NATIVE_MONITORED_ROUTE_ID,
  type SvmDeployedAddresses,
  buildMixedSvmEvmWarpCoreConfig,
  buildSvmChainMetadata,
} from '../fixtures/svm-routes.js';

import { CompositeForkIndexer } from './CompositeForkIndexer.js';
import { EvmForkIndexer } from './ForkIndexer.js';
import { MockExplorerClient } from './MockExplorerClient.js';
import {
  MockExternalBridge,
  type SvmBridgeContext,
} from './MockExternalBridge.js';
import { SvmEvmLocalDeploymentManager } from './SvmEvmLocalDeploymentManager.js';
import { SvmForkIndexer } from './SvmForkIndexer.js';
import {
  computeMixedBlockTags,
  drainSvmWarpRoute,
  fundSvmWarpRoute,
} from './SvmTestHelpers.js';
import type { TestRebalancerContext } from './TestRebalancer.js';

type MixedBalancePreset = keyof typeof MIXED_BALANCE_PRESETS;
type MixedBalanceConfig =
  | MixedBalancePreset
  | { evmBalances: Record<string, string>; svmLamports: number };
type MixedInventorySignerPreset = keyof typeof MIXED_SIGNER_PRESETS;
type MixedInventorySignerBalanceConfig =
  | MixedInventorySignerPreset
  | Record<string, string>;

const MIN_SVM_SIGNER_LAMPORTS = 1_000_000_000n;

export class MixedTestRebalancerBuilder {
  private manager?: SvmEvmLocalDeploymentManager;
  private evmAddresses?: NativeDeployedAddresses;
  private svmAddresses?: SvmDeployedAddresses;
  private svmPrivateKey?: string;
  private strategyConfig?: StrategyConfig[];
  private evmBalances?: Record<string, string>;
  private svmLamports?: number;
  private inventorySignerKey: string = ANVIL_USER_PRIVATE_KEY;
  private inventorySignerBalances?: Record<string, string>;
  private mockBridge?: MockExternalBridge;
  private readonly logger: Logger;

  constructor(logger?: Logger) {
    this.logger =
      logger ??
      pino({ level: 'debug' }).child({
        module: 'MixedTestRebalancerBuilder',
      });
  }

  withManager(manager: SvmEvmLocalDeploymentManager): this {
    this.manager = manager;
    return this;
  }

  withEvmAddresses(addrs: NativeDeployedAddresses): this {
    this.evmAddresses = addrs;
    return this;
  }

  withSvmAddresses(addrs: SvmDeployedAddresses): this {
    this.svmAddresses = addrs;
    return this;
  }

  withSvmPrivateKey(key: string): this {
    this.svmPrivateKey = key;
    return this;
  }

  withStrategyConfig(config: StrategyConfig[]): this {
    this.strategyConfig = config;
    return this;
  }

  withBalances(preset: MixedBalanceConfig): this {
    const config =
      typeof preset === 'string' ? MIXED_BALANCE_PRESETS[preset] : preset;
    this.evmBalances = config.evmBalances;
    this.svmLamports = config.svmLamports;
    return this;
  }

  withInventorySignerBalances(preset: MixedInventorySignerBalanceConfig): this {
    const config =
      typeof preset === 'string' ? MIXED_SIGNER_PRESETS[preset] : preset;
    const balances: Record<string, string> = {};
    for (const [chain, balance] of Object.entries(config)) {
      if (balance !== undefined) {
        balances[chain] = balance;
      }
    }
    this.inventorySignerBalances = balances;
    return this;
  }

  withMockExternalBridge(bridge: MockExternalBridge): this {
    this.mockBridge = bridge;
    return this;
  }

  withEvmBalances(balances: Record<string, string>): this {
    this.evmBalances = balances;
    return this;
  }

  withSvmBalance(lamports: number): this {
    this.svmLamports = lamports;
    return this;
  }

  withInventorySignerKey(key: string): this {
    this.inventorySignerKey = key;
    return this;
  }

  async build(): Promise<TestRebalancerContext> {
    if (!this.manager) throw new Error('Call withManager() before build()');
    if (!this.evmAddresses)
      throw new Error('Call withEvmAddresses() before build()');
    if (!this.svmAddresses)
      throw new Error('Call withSvmAddresses() before build()');
    if (!this.svmPrivateKey)
      throw new Error('Call withSvmPrivateKey() before build()');
    if (!this.strategyConfig || this.strategyConfig.length === 0)
      throw new Error('Call withStrategyConfig() before build()');

    const manager = this.manager;
    const evmAddresses = this.evmAddresses;
    const svmAddresses = this.svmAddresses;

    const evmManager = manager.getEvmDeploymentManager();
    const evmCtx = evmManager.getContext();
    const evmMP = evmCtx.multiProvider;

    const combinedMetadata = {
      ...evmMP.metadata,
      [SVM_CHAIN_NAME]: buildSvmChainMetadata(
        manager.getSvmChainManager().getRpcUrl(),
      ),
    };
    const workingMP = new MultiProvider(combinedMetadata, {
      providers: { ...evmMP.providers },
      signers: { ...evmMP.signers },
    });
    const deployerWallet = new ethers.Wallet(ANVIL_TEST_PRIVATE_KEY);
    for (const chain of TEST_CHAINS) {
      const provider = evmCtx.providers.get(chain);
      if (provider) {
        workingMP.setSigner(chain, deployerWallet.connect(provider));
      }
    }

    const mpp = manager.getMultiProtocolProvider();
    const registry = manager.getRegistry();

    const warpCoreConfig = buildMixedSvmEvmWarpCoreConfig(
      evmAddresses,
      svmAddresses,
      TEST_CHAINS as unknown as string[],
    );

    const evmSignerAddress = new ethers.Wallet(this.inventorySignerKey).address;
    const rebalancerConfig = new RebalancerConfig(
      SVM_NATIVE_MONITORED_ROUTE_ID,
      this.strategyConfig,
      DEFAULT_INTENT_TTL_MS,
      {
        [ProtocolType.Ethereum]: {
          address: evmSignerAddress,
          key: this.inventorySignerKey,
        },
        [ProtocolType.Sealevel]: {
          address: manager
            .getSvmChainManager()
            .getDeployerKeypair()
            .publicKey.toBase58(),
          key: this.svmPrivateKey,
        },
      },
      { lifi: { integrator: 'test' } },
    );

    const contextFactory = await RebalancerContextFactory.create(
      rebalancerConfig,
      workingMP,
      mpp,
      registry,
      this.logger,
      undefined,
      warpCoreConfig,
    );

    const coreAddresses: Record<string, Record<string, string>> = {};
    for (const chain of TEST_CHAINS) {
      coreAddresses[chain] = {
        mailbox: evmAddresses.chains[chain].mailbox,
        interchainSecurityModule: evmAddresses.chains[chain].ism,
      };
    }
    const hyperlaneCore = HyperlaneCore.fromAddressesMap(
      coreAddresses,
      workingMP,
    );

    const svmDeployerAddress = manager
      .getSvmChainManager()
      .getDeployerKeypair()
      .publicKey.toBase58();
    const rebalancerAddresses = [
      deployerWallet.address,
      evmSignerAddress,
      svmDeployerAddress,
    ];

    const evmForkIndexer = new EvmForkIndexer(
      evmCtx.providers,
      hyperlaneCore,
      rebalancerAddresses,
      this.logger,
    );

    const svmConnection = manager.getSvmChainManager().getConnection();
    const svmForkIndexer = new SvmForkIndexer(
      svmConnection,
      new PublicKey(MAILBOX_PROGRAM_ID),
      SVM_CHAIN_NAME,
      rebalancerAddresses,
      this.logger,
      hyperlaneCore,
    );

    const forkIndexer = new CompositeForkIndexer([
      evmForkIndexer,
      svmForkIndexer,
    ]);

    const getConfirmedBlockTags = async (): Promise<ConfirmedBlockTags> =>
      computeMixedBlockTags(evmCtx.providers, svmConnection, SVM_CHAIN_NAME);

    const initialBlockTags = await getConfirmedBlockTags();
    await forkIndexer.initialize(initialBlockTags);

    const mockExplorer = new MockExplorerClient(
      { userTransfers: [], rebalanceActions: [] },
      forkIndexer,
      getConfirmedBlockTags,
    );

    const svmBridgeCtx: SvmBridgeContext | undefined = svmAddresses.bridgeRouter
      ? {
          connection: svmConnection,
          warpRouter: svmAddresses.bridgeRouter,
          mailboxProgramId: MAILBOX_PROGRAM_ID,
          mpp: manager.getMultiProtocolProvider(),
          deployerKeypair: manager.getSvmChainManager().getDeployerKeypair(),
          evmCore: hyperlaneCore,
          evmMultiProvider: workingMP,
        }
      : undefined;

    const mockBridge =
      this.mockBridge ??
      new MockExternalBridge(
        evmAddresses,
        workingMP,
        hyperlaneCore,
        'native',
        undefined,
        svmBridgeCtx,
      );

    if (this.evmBalances) {
      for (const chain of TEST_CHAINS) {
        const balance = this.evmBalances[chain];
        if (balance !== undefined) {
          const provider = evmCtx.providers.get(chain);
          if (provider) {
            await provider.send('anvil_setBalance', [
              evmAddresses.monitoredRoute[chain],
              balance,
            ]);
          }
        }
      }
    }

    await drainSvmWarpRoute(manager, svmAddresses.warpTokenAta);

    if (this.svmLamports !== undefined) {
      await fundSvmWarpRoute(
        manager.getSvmChainManager(),
        svmAddresses.warpTokenAta,
        this.svmLamports,
      );
    }

    await this.ensureSvmSignerLamports(
      manager,
      svmDeployerAddress,
      MIN_SVM_SIGNER_LAMPORTS,
    );

    await this.ensureMinAmountCollateralCoverage(evmCtx, evmAddresses);

    const strategy = await contextFactory.createStrategy();
    const { tracker, adapter } =
      await contextFactory.createActionTracker(mockExplorer);
    await tracker.initialize();

    const rebalancerComponents = await contextFactory.createRebalancers(
      tracker,
      undefined,
      {
        [ExternalBridgeType.LiFi]: mockBridge,
      } as Partial<ExternalBridgeRegistry>,
    );

    const orchestratorDeps: RebalancerOrchestratorDeps = {
      strategy,
      rebalancers: rebalancerComponents?.rebalancers ?? [],
      actionTracker: tracker,
      inflightContextAdapter: adapter,
      rebalancerConfig,
      externalBridgeRegistry: rebalancerComponents?.externalBridgeRegistry,
      logger: this.logger,
    };
    const orchestrator = new RebalancerOrchestrator(orchestratorDeps);

    const signerBalances = this.inventorySignerBalances
      ? this.inventorySignerBalances
      : Object.fromEntries(
          TEST_CHAINS.map((chain) => [
            chain,
            ethers.utils.parseEther('20').toString(),
          ]),
        );

    for (const [chain, balance] of Object.entries(signerBalances)) {
      const provider = evmCtx.providers.get(chain);
      if (provider) {
        await provider.send('anvil_setBalance', [
          evmSignerAddress,
          ethers.utils.hexValue(ethers.BigNumber.from(balance)),
        ]);
      }
    }

    const inventoryConfig = rebalancerComponents?.inventoryConfig;

    return {
      orchestrator,
      strategy,
      tracker,
      mockExplorer,
      forkIndexer,
      multiProvider: workingMP,
      rebalancerConfig,
      contextFactory,
      inventoryConfig,
      createMonitor: (checkFrequency: number) =>
        contextFactory.createMonitor(checkFrequency, inventoryConfig),
      getConfirmedBlockTags,
    };
  }

  private async ensureMinAmountCollateralCoverage(
    evmCtx: ReturnType<
      ReturnType<
        SvmEvmLocalDeploymentManager['getEvmDeploymentManager']
      >['getContext']
    >,
    evmAddresses: NativeDeployedAddresses,
  ): Promise<void> {
    const strategy = this.strategyConfig?.[0] as StrategyConfig | undefined;
    if (!strategy || !('chains' in strategy)) return;

    let totalTargets = 0n;
    for (const [chain, config] of Object.entries(strategy.chains)) {
      if (!('minAmount' in config) || !config.minAmount) continue;
      const decimals = chain === SVM_CHAIN_NAME ? 9 : 18;
      totalTargets += BigInt(
        ethers.utils.parseUnits(config.minAmount.target, decimals).toString(),
      );
    }
    if (totalTargets === 0n) return;

    const evmTotal = Object.values(this.evmBalances ?? {}).reduce(
      (sum, balance) => sum + BigInt(balance),
      0n,
    );
    const svmTotal = BigInt(this.svmLamports ?? 0);
    const totalCollateral = evmTotal + svmTotal;

    if (totalCollateral >= totalTargets) return;

    const deficit = totalTargets - totalCollateral;
    const paddedDeficit =
      deficit + ethers.constants.WeiPerEther.div(10).toBigInt();
    const topUpChain = TEST_CHAINS[0];
    const current = BigInt(this.evmBalances?.[topUpChain] ?? '0');
    const updated = current + paddedDeficit;
    const provider = evmCtx.providers.get(topUpChain);
    if (!provider) return;

    await provider.send('anvil_setBalance', [
      evmAddresses.monitoredRoute[topUpChain],
      ethers.utils.hexValue(updated),
    ]);

    this.logger.info(
      {
        chain: topUpChain,
        oldBalance: current.toString(),
        newBalance: updated.toString(),
        deficit: deficit.toString(),
        totalTargets: totalTargets.toString(),
        totalCollateral: totalCollateral.toString(),
      },
      'Adjusted EVM collateral to satisfy minAmount strategy validation',
    );
  }

  private async ensureSvmSignerLamports(
    manager: SvmEvmLocalDeploymentManager,
    signerAddress: string,
    minLamports: bigint,
  ): Promise<void> {
    const connection = manager.getSvmChainManager().getConnection();
    const signer = new PublicKey(signerAddress);
    const current = BigInt(await connection.getBalance(signer, 'confirmed'));
    if (current >= minLamports) return;

    const topUp = minLamports - current;
    const signature = await connection.requestAirdrop(signer, Number(topUp));
    await connection.confirmTransaction(signature, 'confirmed');

    this.logger.debug(
      {
        signerAddress,
        oldBalance: current.toString(),
        newMinimum: minLamports.toString(),
        topUp: topUp.toString(),
      },
      'Funded SVM signer for mixed e2e test stability',
    );
  }
}
