import { PublicKey } from '@solana/web3.js';
import { ethers } from 'ethers';
import { type Logger, pino } from 'pino';

import {
  ERC20Test__factory,
  HypERC20Collateral__factory,
} from '@hyperlane-xyz/core';
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
  TEST_CHAINS,
} from '../fixtures/routes.js';
import { MAILBOX_PROGRAM_ID, SVM_CHAIN_NAME } from '../fixtures/svm-routes.js';
import {
  COLLATERAL_BALANCE_PRESETS,
  COLLATERAL_SIGNER_PRESETS,
  SVM_COLLATERAL_MONITORED_ROUTE_ID,
  USDC_DECIMALS,
  type SvmCollateralEvmErc20DeployedAddresses,
  buildMixedCollateralStrategyConfig,
  buildMixedCollateralWarpCoreConfig,
} from '../fixtures/svm-collateral-routes.js';

import { CompositeForkIndexer } from './CompositeForkIndexer.js';
import { EvmForkIndexer } from './ForkIndexer.js';
import { MockExplorerClient } from './MockExplorerClient.js';
import {
  MockExternalBridge,
  type SvmBridgeContext,
} from './MockExternalBridge.js';
import { SvmCollateralEvmErc20LocalDeploymentManager } from './SvmCollateralEvmErc20LocalDeploymentManager.js';
import { SvmForkIndexer } from './SvmForkIndexer.js';
import { computeMixedBlockTags } from './SvmTestHelpers.js';
import type { TestRebalancerContext } from './TestRebalancer.js';

type CollateralBalancePreset = keyof typeof COLLATERAL_BALANCE_PRESETS;
type CollateralBalanceConfig =
  | CollateralBalancePreset
  | { evmUsdcBalances: Record<string, string>; svmSplEscrowAmount: bigint };
type CollateralSignerPreset = keyof typeof COLLATERAL_SIGNER_PRESETS;
type CollateralSignerConfig = CollateralSignerPreset | Record<string, string>;

const MIN_SVM_SIGNER_LAMPORTS = 1_000_000_000n;

export class MixedCollateralTestRebalancerBuilder {
  private manager?: SvmCollateralEvmErc20LocalDeploymentManager;
  private strategyConfig?: StrategyConfig[];
  private evmUsdcBalances?: Record<string, string>;
  private svmSplEscrowAmount?: bigint;
  private inventorySignerKey: string = ANVIL_USER_PRIVATE_KEY;
  private inventorySignerErc20Balances?: Record<string, string>;
  private mockBridge?: MockExternalBridge;
  private readonly logger: Logger;

  constructor(logger?: Logger) {
    this.logger =
      logger ??
      pino({ level: 'debug' }).child({
        module: 'MixedCollateralTestRebalancerBuilder',
      });
  }

  withManager(manager: SvmCollateralEvmErc20LocalDeploymentManager): this {
    this.manager = manager;
    return this;
  }

  withStrategyConfig(config: StrategyConfig[]): this {
    this.strategyConfig = config;
    return this;
  }

  withBalances(preset: CollateralBalanceConfig): this {
    const config =
      typeof preset === 'string' ? COLLATERAL_BALANCE_PRESETS[preset] : preset;
    this.evmUsdcBalances = config.evmUsdcBalances;
    this.svmSplEscrowAmount = config.svmSplEscrowAmount;
    return this;
  }

  withInventorySignerBalances(preset: CollateralSignerConfig): this {
    const config =
      typeof preset === 'string' ? COLLATERAL_SIGNER_PRESETS[preset] : preset;
    const balances: Record<string, string> = {};
    for (const [chain, balance] of Object.entries(config)) {
      if (balance !== undefined) {
        balances[chain] = balance;
      }
    }
    this.inventorySignerErc20Balances = balances;
    return this;
  }

  withMockExternalBridge(bridge: MockExternalBridge): this {
    this.mockBridge = bridge;
    return this;
  }

  withInventorySignerKey(key: string): this {
    this.inventorySignerKey = key;
    return this;
  }

  async build(): Promise<TestRebalancerContext> {
    if (!this.manager) throw new Error('Call withManager() before build()');
    if (!this.strategyConfig || this.strategyConfig.length === 0) {
      throw new Error('Call withStrategyConfig() before build()');
    }

    const manager = this.manager;
    const addresses = manager.getDeployedAddresses();
    const svmAddresses = addresses.svm;

    const evmManager = manager.getEvmDeploymentManager();
    const evmCtx = evmManager.getContext();
    const evmMP = evmCtx.multiProvider;

    const combinedMetadata = {
      ...evmMP.metadata,
      [SVM_CHAIN_NAME]: manager.getChainMetadata()[SVM_CHAIN_NAME],
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

    const warpCoreConfig = buildMixedCollateralWarpCoreConfig(addresses);

    const evmSignerAddress = new ethers.Wallet(this.inventorySignerKey).address;
    const strategyToUse =
      this.strategyConfig ?? buildMixedCollateralStrategyConfig();

    const rebalancerConfig = new RebalancerConfig(
      SVM_COLLATERAL_MONITORED_ROUTE_ID,
      strategyToUse,
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
          key: JSON.stringify(
            Array.from(
              manager.getSvmChainManager().getDeployerKeypair().secretKey,
            ),
          ),
        },
      },
      { lifi: { integrator: 'test' } },
    );

    const registry = manager.getRegistry();

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
        mailbox: addresses.chains[chain].mailbox,
        interchainSecurityModule: addresses.chains[chain].ism,
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
          tokenType: 'collateral',
          collateralMint: svmAddresses.splMint,
        }
      : undefined;

    const mockBridge =
      this.mockBridge ??
      new MockExternalBridge(
        addresses,
        workingMP,
        hyperlaneCore,
        'erc20',
        undefined,
        svmBridgeCtx,
      );

    await this.applyEvmUsdcBalances(evmCtx, addresses);

    await this.ensureCollateralCoverage(evmCtx, addresses, strategyToUse);

    await this.applyEvmSignerErc20Balances(evmCtx, addresses, evmSignerAddress);

    await this.ensureSvmSignerLamports(
      manager,
      svmDeployerAddress,
      MIN_SVM_SIGNER_LAMPORTS,
    );

    if (this.svmSplEscrowAmount !== undefined && this.svmSplEscrowAmount > 0n) {
      await manager.mintSplToEscrow(this.svmSplEscrowAmount);
    }

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

  private async applyEvmUsdcBalances(
    evmCtx: ReturnType<
      ReturnType<
        SvmCollateralEvmErc20LocalDeploymentManager['getEvmDeploymentManager']
      >['getContext']
    >,
    addresses: SvmCollateralEvmErc20DeployedAddresses,
  ): Promise<void> {
    if (!this.evmUsdcBalances) return;

    for (const chain of TEST_CHAINS) {
      const balance = this.evmUsdcBalances[chain];
      if (balance === undefined) continue;

      const provider = evmCtx.providers.get(chain);
      if (!provider) continue;

      const deployer = new ethers.Wallet(ANVIL_TEST_PRIVATE_KEY, provider);
      const token = ERC20Test__factory.connect(
        addresses.tokens[chain],
        deployer,
      );
      const monitoredRoute = HypERC20Collateral__factory.connect(
        addresses.monitoredRoute[chain],
        deployer,
      );

      const currentBalance = await token.balanceOf(
        addresses.monitoredRoute[chain],
      );
      const target = ethers.BigNumber.from(balance);

      if (target.gt(currentBalance)) {
        const diff = target.sub(currentBalance);
        await token.transfer(addresses.monitoredRoute[chain], diff);
      } else if (target.lt(currentBalance)) {
        await monitoredRoute.transferFrom(
          addresses.monitoredRoute[chain],
          deployer.address,
          currentBalance.sub(target),
        );
      }
    }
  }

  private async applyEvmSignerErc20Balances(
    evmCtx: ReturnType<
      ReturnType<
        SvmCollateralEvmErc20LocalDeploymentManager['getEvmDeploymentManager']
      >['getContext']
    >,
    addresses: SvmCollateralEvmErc20DeployedAddresses,
    signerAddress: string,
  ): Promise<void> {
    const balances = this.inventorySignerErc20Balances ?? {};

    for (const chain of TEST_CHAINS) {
      const target = balances[chain];
      if (target === undefined) continue;

      const provider = evmCtx.providers.get(chain);
      if (!provider) continue;

      const deployer = new ethers.Wallet(ANVIL_TEST_PRIVATE_KEY, provider);
      const token = ERC20Test__factory.connect(
        addresses.tokens[chain],
        deployer,
      );

      const current = await token.balanceOf(signerAddress);
      const targetBN = ethers.BigNumber.from(target);

      if (targetBN.gt(current)) {
        await token.transfer(signerAddress, targetBN.sub(current));
      }
    }
  }

  private async ensureCollateralCoverage(
    evmCtx: ReturnType<
      ReturnType<
        SvmCollateralEvmErc20LocalDeploymentManager['getEvmDeploymentManager']
      >['getContext']
    >,
    addresses: SvmCollateralEvmErc20DeployedAddresses,
    strategyConfigs: StrategyConfig[],
  ): Promise<void> {
    let totalTargets = 0n;
    for (const cfg of strategyConfigs) {
      for (const [, chainCfg] of Object.entries(cfg.chains)) {
        if ('minAmount' in chainCfg && chainCfg.minAmount) {
          totalTargets += ethers.utils
            .parseUnits(chainCfg.minAmount.target, USDC_DECIMALS)
            .toBigInt();
        }
      }
    }
    if (totalTargets === 0n) return;

    const evmTotal = Object.values(this.evmUsdcBalances ?? {}).reduce(
      (sum, bal) => sum + BigInt(bal),
      0n,
    );
    const svmTotal = this.svmSplEscrowAmount ?? 0n;
    const totalCollateral = evmTotal + svmTotal;

    if (totalCollateral >= totalTargets) return;

    const deficit = totalTargets - totalCollateral + 1n;
    const topUpChain = TEST_CHAINS[0];
    const provider = evmCtx.providers.get(topUpChain);
    if (!provider) return;

    const deployer = new ethers.Wallet(ANVIL_TEST_PRIVATE_KEY, provider);
    const token = ERC20Test__factory.connect(
      addresses.tokens[topUpChain],
      deployer,
    );
    await token.transfer(
      addresses.monitoredRoute[topUpChain],
      ethers.BigNumber.from(deficit),
    );
  }

  private async ensureSvmSignerLamports(
    manager: SvmCollateralEvmErc20LocalDeploymentManager,
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
  }
}
