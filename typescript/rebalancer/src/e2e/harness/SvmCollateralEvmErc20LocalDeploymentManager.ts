import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { PublicKey } from '@solana/web3.js';
import { ethers, providers } from 'ethers';
import { type Logger, pino } from 'pino';

import {
  ERC20Test__factory,
  HypERC20Collateral__factory,
} from '@hyperlane-xyz/core';
import { PartialRegistry } from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  MultiProtocolProvider,
  ProviderType,
} from '@hyperlane-xyz/sdk';
import {
  SvmCollateralTokenWriter,
  type SealevelProgramTarget as SvmProgramTarget,
} from '@hyperlane-xyz/sealevel-sdk';

import {
  ANVIL_TEST_PRIVATE_KEY,
  type Erc20InventoryChainDeployment,
  type Erc20InventoryDeployedAddresses,
  TEST_CHAIN_CONFIGS,
  type TestChain,
} from '../fixtures/routes.js';
import {
  AGAVE_BIN_DIR,
  MAILBOX_PROGRAM_ID,
  SVM_CHAIN_NAME,
  SVM_DOMAIN_ID,
  SVM_RPC_PORT,
  buildSvmChainMetadata,
  createSvmRpc,
  createSvmSigner,
} from '../fixtures/svm-routes.js';
import {
  type SvmCollateralDeployedAddresses,
  type SvmCollateralEvmErc20DeployedAddresses,
  USDC_DECIMALS,
  USDC_INITIAL_SUPPLY,
} from '../fixtures/svm-collateral-routes.js';

import { BaseLocalDeploymentManager } from './BaseLocalDeploymentManager.js';
import { SealevelLocalChainManager } from './SealevelLocalChainManager.js';

const TOKEN_SCALE = ethers.BigNumber.from(1);
const INVENTORY_INITIAL_ETH_BALANCE = '20000000000000000000';
const INVENTORY_ERC20_BRIDGE_SEED = '10000000000';
const INVENTORY_INITIAL_ERC20_BALANCE = '20000000000';
const REMOTE_SEALEVEL_DOMAIN = 13377;
const SPL_TOKEN_BIN = path.join(AGAVE_BIN_DIR, 'spl-token');

class CollateralEvmDeploymentManager extends BaseLocalDeploymentManager<Erc20InventoryDeployedAddresses> {
  constructor(private readonly inventorySignerAddress: string) {
    super();
  }

  protected async deployRoutes(
    deployerWallet: ethers.Wallet,
    providersByChain: Map<string, providers.JsonRpcProvider>,
    chainInfra: Record<
      string,
      { mailbox: string; ism: string; merkleHook: string }
    >,
  ): Promise<Erc20InventoryDeployedAddresses> {
    const deployerAddress = deployerWallet.address;
    const chainDeployments = {} as Record<
      TestChain,
      Erc20InventoryChainDeployment
    >;
    const monitoredRouters = {} as Record<TestChain, ethers.Contract>;
    const bridgeRouters = {} as Record<TestChain, ethers.Contract>;
    const tokens = {} as Record<TestChain, ethers.Contract>;

    for (const config of TEST_CHAIN_CONFIGS) {
      const provider = providersByChain.get(config.name)!;
      await provider.send('anvil_setBalance', [
        this.inventorySignerAddress,
        ethers.utils.hexValue(
          ethers.BigNumber.from(INVENTORY_INITIAL_ETH_BALANCE),
        ),
      ]);

      const deployer = deployerWallet.connect(provider);

      const token = await new ERC20Test__factory(deployer).deploy(
        'USDC',
        'USDC',
        USDC_INITIAL_SUPPLY,
        USDC_DECIMALS,
      );
      await token.deployed();

      const monitoredRoute = await new HypERC20Collateral__factory(
        deployer,
      ).deploy(
        token.address,
        TOKEN_SCALE,
        TOKEN_SCALE,
        chainInfra[config.name].mailbox,
      );
      await monitoredRoute.deployed();
      await monitoredRoute.initialize(
        ethers.constants.AddressZero,
        chainInfra[config.name].ism,
        deployerAddress,
      );

      const bridgeRoute = await new HypERC20Collateral__factory(
        deployer,
      ).deploy(
        token.address,
        TOKEN_SCALE,
        TOKEN_SCALE,
        chainInfra[config.name].mailbox,
      );
      await bridgeRoute.deployed();
      await bridgeRoute.initialize(
        ethers.constants.AddressZero,
        chainInfra[config.name].ism,
        deployerAddress,
      );

      chainDeployments[config.name as TestChain] = {
        mailbox: chainInfra[config.name].mailbox,
        ism: chainInfra[config.name].ism,
        monitoredRouter: monitoredRoute.address,
        bridgeRouter: bridgeRoute.address,
        token: token.address,
      };

      tokens[config.name as TestChain] = token;
      monitoredRouters[config.name as TestChain] = monitoredRoute;
      bridgeRouters[config.name as TestChain] = bridgeRoute;
    }

    for (const routeMap of [monitoredRouters, bridgeRouters]) {
      for (const chain of TEST_CHAIN_CONFIGS) {
        const localRoute = routeMap[chain.name];
        const remoteDomains: number[] = [];
        const remoteRouters: string[] = [];

        for (const remote of TEST_CHAIN_CONFIGS) {
          if (remote.name === chain.name) continue;
          remoteDomains.push(remote.domainId);
          remoteRouters.push(
            ethers.utils.hexZeroPad(routeMap[remote.name].address, 32),
          );
        }

        await localRoute.enrollRemoteRouters(remoteDomains, remoteRouters);
      }
    }

    for (const chain of TEST_CHAIN_CONFIGS) {
      const monitoredRoute = monitoredRouters[chain.name];
      await monitoredRoute.addRebalancer(deployerAddress);
      await monitoredRoute.addRebalancer(this.inventorySignerAddress);

      for (const destination of TEST_CHAIN_CONFIGS) {
        if (destination.name === chain.name) continue;
        await monitoredRoute.addBridge(
          destination.domainId,
          bridgeRouters[chain.name].address,
        );
      }
    }

    const bridgeSeedAmount = ethers.BigNumber.from(INVENTORY_ERC20_BRIDGE_SEED);
    const signerErc20Amount = ethers.BigNumber.from(
      INVENTORY_INITIAL_ERC20_BALANCE,
    );
    for (const chain of TEST_CHAIN_CONFIGS) {
      const provider = providersByChain.get(chain.name)!;
      const deployer = deployerWallet.connect(provider);
      const token = ERC20Test__factory.connect(
        tokens[chain.name].address,
        deployer,
      );
      await token.transfer(bridgeRouters[chain.name].address, bridgeSeedAmount);
      await token.transfer(this.inventorySignerAddress, signerErc20Amount);
    }

    return {
      chains: chainDeployments,
      monitoredRoute: {
        anvil1: monitoredRouters.anvil1.address,
        anvil2: monitoredRouters.anvil2.address,
        anvil3: monitoredRouters.anvil3.address,
      },
      bridgeRoute: {
        anvil1: bridgeRouters.anvil1.address,
        anvil2: bridgeRouters.anvil2.address,
        anvil3: bridgeRouters.anvil3.address,
      },
      tokens: {
        anvil1: tokens.anvil1.address,
        anvil2: tokens.anvil2.address,
        anvil3: tokens.anvil3.address,
      },
    };
  }
}

export class SvmCollateralEvmErc20LocalDeploymentManager {
  private readonly logger: Logger;
  private readonly rpcPort: number;
  private evmManager?: CollateralEvmDeploymentManager;
  private svmManager?: SealevelLocalChainManager;
  private deployedAddresses?: SvmCollateralEvmErc20DeployedAddresses;

  constructor(logger?: Logger, rpcPort: number = SVM_RPC_PORT) {
    this.logger =
      logger ??
      pino({ level: 'debug' }).child({
        module: 'SvmCollateralEvmErc20LocalDeploymentManager',
      });
    this.rpcPort = rpcPort;
  }

  async setup(): Promise<void> {
    if (this.evmManager || this.svmManager) {
      throw new Error(
        'SvmCollateralEvmErc20LocalDeploymentManager already setup',
      );
    }

    const svmManager = new SealevelLocalChainManager(this.logger, this.rpcPort);
    const inventorySignerAddress = this.deriveInventorySignerAddress(
      svmManager.getDeployerKeypair().publicKey.toBytes(),
    );
    const evmManager = new CollateralEvmDeploymentManager(
      inventorySignerAddress,
    );

    this.evmManager = evmManager;
    this.svmManager = svmManager;

    try {
      await evmManager.start();
      await svmManager.start();

      await svmManager.deployCore(SVM_DOMAIN_ID, [REMOTE_SEALEVEL_DOMAIN]);

      const splMint = await svmManager.createSplMint(USDC_DECIMALS);
      this.logger.info({ splMint }, 'SPL USDC mint created');

      const { escrowPda: monitoredEscrowPda } =
        await svmManager.deployCollateralWarpRoute(
          SVM_DOMAIN_ID,
          new Map(),
          splMint,
        );

      const { escrowPda: bridgeEscrowPda } =
        await svmManager.deployCollateralBridgeWarpRoute(
          SVM_DOMAIN_ID,
          new Map(),
          splMint,
        );

      const evmCtx = evmManager.getContext();
      const evmAddresses = evmCtx.deployedAddresses;

      await this.enrollEvmRoutersToSvmCollateral(
        evmAddresses,
        evmCtx,
        monitoredEscrowPda,
        false,
      );
      await this.enrollSvmCollateralRouterToEvmRouters(
        evmAddresses,
        svmManager.getCollateralWarpRouteProgramId(),
        splMint,
        false,
      );

      await this.enrollEvmRoutersToSvmCollateral(
        evmAddresses,
        evmCtx,
        bridgeEscrowPda,
        true,
      );
      await this.enrollSvmCollateralRouterToEvmRouters(
        evmAddresses,
        svmManager.getCollateralBridgeWarpRouteProgramId(),
        splMint,
        true,
      );

      await this.mintSplToSigner(splMint, inventorySignerAddress);

      this.deployedAddresses = {
        chains: evmAddresses.chains,
        monitoredRoute: evmAddresses.monitoredRoute,
        bridgeRoute: evmAddresses.bridgeRoute,
        tokens: evmAddresses.tokens,
        svm: {
          mailbox: MAILBOX_PROGRAM_ID,
          ism: svmManager.getIsmProgramId(),
          warpRouter: svmManager.getCollateralWarpRouteProgramId(),
          escrowPda: monitoredEscrowPda,
          splMint,
          bridgeRouter: svmManager.getCollateralBridgeWarpRouteProgramId(),
          bridgeEscrowPda,
        },
      };
    } catch (error) {
      await this.teardown();
      throw error;
    }
  }

  async teardown(): Promise<void> {
    const svmManager = this.svmManager;
    const evmManager = this.evmManager;

    this.svmManager = undefined;
    this.evmManager = undefined;
    this.deployedAddresses = undefined;

    if (svmManager) {
      await svmManager.stop();
    }
    if (evmManager) {
      await evmManager.stop();
    }
  }

  getDeployedAddresses(): SvmCollateralEvmErc20DeployedAddresses {
    if (!this.deployedAddresses) {
      throw new Error('Not setup. Call setup() first.');
    }
    return this.deployedAddresses;
  }

  getSvmDeployedAddresses(): SvmCollateralDeployedAddresses {
    return this.getDeployedAddresses().svm;
  }

  getSvmChainManager(): SealevelLocalChainManager {
    if (!this.svmManager) {
      throw new Error('SVM manager not initialized. Call setup first.');
    }
    return this.svmManager;
  }

  getEvmDeploymentManager(): CollateralEvmDeploymentManager {
    if (!this.evmManager) {
      throw new Error('EVM manager not initialized. Call setup first.');
    }
    return this.evmManager;
  }

  getMultiProtocolProvider(): MultiProtocolProvider {
    const evmMultiProvider = this.getEvmDeploymentManager().getMultiProvider();

    const combinedMetadata = {
      ...evmMultiProvider.metadata,
      [SVM_CHAIN_NAME]: buildSvmChainMetadata(
        this.getSvmChainManager().getRpcUrl(),
      ),
    };
    const mpp = new MultiProtocolProvider(combinedMetadata);

    for (const chain of Object.keys(evmMultiProvider.metadata)) {
      const provider = evmMultiProvider.providers[chain];
      if (provider) {
        mpp.setProvider(chain, {
          type: ProviderType.EthersV5,
          provider,
        });
      }
    }

    mpp.setProvider(SVM_CHAIN_NAME, {
      type: ProviderType.SolanaWeb3,
      provider: this.getSvmChainManager().getConnection(),
    });

    return mpp;
  }

  getChainMetadata(): Record<string, ChainMetadata> {
    const evmMultiProvider = this.getEvmDeploymentManager().getMultiProvider();
    return {
      ...(evmMultiProvider.metadata as Record<string, ChainMetadata>),
      [SVM_CHAIN_NAME]: buildSvmChainMetadata(
        this.getSvmChainManager().getRpcUrl(),
      ),
    };
  }

  getRegistry(): PartialRegistry {
    const evmManager = this.getEvmDeploymentManager();
    const evmContext = evmManager.getContext();
    const svmAddresses = this.getSvmDeployedAddresses();

    const chainMetadata = this.getChainMetadata();

    const chainAddresses: Record<string, Record<string, string>> = {
      [SVM_CHAIN_NAME]: {
        mailbox: svmAddresses.mailbox,
        interchainSecurityModule: svmAddresses.ism,
      },
    };

    for (const [chain, c] of Object.entries(
      evmContext.deployedAddresses.chains,
    )) {
      chainAddresses[chain] = {
        mailbox: c.mailbox,
        interchainSecurityModule: c.ism,
      };
    }

    return new PartialRegistry({ chainMetadata, chainAddresses });
  }

  async mintSplToEscrow(amount: bigint): Promise<void> {
    const addresses = this.getDeployedAddresses();
    await this.mintSplTokens(
      addresses.svm.splMint,
      addresses.svm.escrowPda,
      amount,
    );
  }

  async mintSplToEscrowAmount(amountDisplayUnits: string): Promise<void> {
    const addresses = this.getDeployedAddresses();
    this.runSplTokenCli([
      'mint',
      addresses.svm.splMint,
      amountDisplayUnits,
      addresses.svm.escrowPda,
    ]);
  }

  private async enrollEvmRoutersToSvmCollateral(
    evmAddresses: Erc20InventoryDeployedAddresses,
    evmCtx: any,
    svmEscrowPda: string,
    useBridgeRoutes: boolean,
  ): Promise<void> {
    const svmRouter = ethers.utils.hexZeroPad(
      ethers.utils.hexlify(new PublicKey(svmEscrowPda).toBytes()),
      32,
    );

    for (const chain of TEST_CHAIN_CONFIGS) {
      const provider = evmCtx.providers.get(chain.name);
      if (!provider) {
        throw new Error(`Missing EVM provider for ${chain.name}`);
      }

      const signer = new ethers.Wallet(ANVIL_TEST_PRIVATE_KEY, provider);
      const routerAddress = useBridgeRoutes
        ? evmAddresses.bridgeRoute[chain.name]
        : evmAddresses.monitoredRoute[chain.name];

      const route = HypERC20Collateral__factory.connect(routerAddress, signer);
      await route.enrollRemoteRouters([SVM_DOMAIN_ID], [svmRouter]);
    }
  }

  private async enrollSvmCollateralRouterToEvmRouters(
    evmAddresses: Erc20InventoryDeployedAddresses,
    svmProgramId: string,
    splMint: string,
    useBridgeRoutes: boolean,
  ): Promise<void> {
    const svmManager = this.getSvmChainManager();

    const rpc = createSvmRpc(svmManager.getRpcUrl());
    const signer = await createSvmSigner(svmManager.getRpcUrl());
    const writer = new SvmCollateralTokenWriter(
      {
        program: { programId: svmProgramId } as SvmProgramTarget,
        ataPayerFundingAmount: 1_000_000_000n,
      },
      rpc,
      signer,
    );

    const remoteRouters: Record<number, { address: string }> = {};
    const destinationGas: Record<number, string> = {};
    for (const chain of TEST_CHAIN_CONFIGS) {
      const routerAddress = useBridgeRoutes
        ? evmAddresses.bridgeRoute[chain.name]
        : evmAddresses.monitoredRoute[chain.name];
      remoteRouters[chain.domainId] = {
        address: ethers.utils.hexZeroPad(routerAddress, 32),
      };
      destinationGas[chain.domainId] = '0';
    }

    const currentArtifact = await writer.read(svmProgramId);
    const updateTxs = await writer.update({
      ...currentArtifact,
      config: {
        ...currentArtifact.config,
        remoteRouters,
        destinationGas,
      },
    });

    for (const tx of updateTxs) {
      await signer.send(tx);
    }
  }

  private async mintSplToSigner(
    splMint: string,
    _signerAddress: string,
  ): Promise<void> {
    this.runSplTokenCli(['create-account', splMint]);
    this.runSplTokenCli(['mint', splMint, '20000']);
  }

  private async mintSplTokens(
    _splMint: string,
    _tokenAccount: string,
    _amount: bigint,
  ): Promise<void> {
    const displayAmount = String(Number(_amount) / Math.pow(10, USDC_DECIMALS));
    this.runSplTokenCli(['mint', _splMint, displayAmount, _tokenAccount]);
  }

  private runSplTokenCli(args: string[]): void {
    const svmManager = this.getSvmChainManager();
    execFileSync(
      SPL_TOKEN_BIN,
      ['-C', svmManager.getSolanaConfigPath(), ...args],
      { encoding: 'utf8' },
    );
  }

  private deriveInventorySignerAddress(svmDeployerBytes: Uint8Array): string {
    const digest = ethers.utils.keccak256(svmDeployerBytes);
    return ethers.utils.getAddress(ethers.utils.hexDataSlice(digest, 12));
  }
}
