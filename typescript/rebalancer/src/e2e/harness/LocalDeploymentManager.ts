import { maxUint256, pad, zeroAddress } from 'viem';
import { type Logger, pino } from 'pino';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';

import {
  ERC20Test__factory,
  HypERC20Collateral__factory,
  Mailbox__factory,
  MerkleTreeHook__factory,
  TrustedRelayerIsm__factory,
} from '@hyperlane-xyz/core';
import { type IRegistry, PartialRegistry } from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  type ChainName,
  HyperlaneSmartProvider,
  LocalAccountViemSigner,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, ensure0x, retryAsync } from '@hyperlane-xyz/utils';

import {
  ANVIL_TEST_PRIVATE_KEY,
  type ChainDeployment,
  type DeployedAddresses,
  TEST_CHAIN_CONFIGS,
  type TestChain,
} from '../fixtures/routes.js';

export interface LocalDeploymentContext {
  providers: Map<string, ReturnType<MultiProvider['getProvider']>>;
  registry: IRegistry;
  multiProvider: MultiProvider;
  deployedAddresses: DeployedAddresses;
}

const ANVIL_DEPLOYER_BALANCE_HEX = '0x56BC75E2D63100000';
const USDC_INITIAL_SUPPLY = '100000000000000';
const USDC_DECIMALS = 6;
const TOKEN_SCALE = 1n;

export class LocalDeploymentManager {
  private context?: LocalDeploymentContext;
  private containers: Map<string, StartedTestContainer> = new Map();
  private readonly logger: Logger;

  constructor() {
    this.logger = pino({ level: 'debug' }).child({
      module: 'LocalDeploymentManager',
    });
  }

  async start(): Promise<LocalDeploymentContext> {
    if (this.context) {
      throw new Error('LocalDeploymentManager already started');
    }

    const providersByChain = new Map<
      string,
      ReturnType<MultiProvider['getProvider']>
    >();
    const deployerWallet = new LocalAccountViemSigner(
      ensure0x(ANVIL_TEST_PRIVATE_KEY),
    );
    const deployerAddress = await deployerWallet.getAddress();

    const chainDeployments = {} as Record<TestChain, ChainDeployment>;
    const monitoredRouters = {} as Record<TestChain, { address: string }>;
    const bridgeRouters1 = {} as Record<TestChain, { address: string }>;
    const bridgeRouters2 = {} as Record<TestChain, { address: string }>;
    const tokens = {} as Record<TestChain, { address: string }>;

    try {
      for (let i = 0; i < TEST_CHAIN_CONFIGS.length; i++) {
        const config = TEST_CHAIN_CONFIGS[i];

        const container = await retryAsync(
          () =>
            new GenericContainer('ghcr.io/foundry-rs/foundry:latest')
              .withEntrypoint([
                'anvil',
                '--host',
                '0.0.0.0',
                '-p',
                '8545',
                '--chain-id',
                config.chainId.toString(),
              ])
              .withExposedPorts(8545)
              .withWaitStrategy(Wait.forLogMessage(/Listening on/))
              .start(),
          3,
          5000,
        );
        this.containers.set(config.name, container);
        const endpoint = `http://${container.getHost()}:${container.getMappedPort(8545)}`;
        const provider = HyperlaneSmartProvider.fromRpcUrl(
          config.chainId,
          endpoint,
        );
        providersByChain.set(config.name, provider);

        await provider.send('anvil_setBalance', [
          deployerAddress,
          ANVIL_DEPLOYER_BALANCE_HEX,
        ]);

        const deployer = deployerWallet.connect(provider);

        const mailbox = await new Mailbox__factory(deployer).deploy(
          config.domainId,
        );
        await mailbox.deployed();

        const ism = await new TrustedRelayerIsm__factory(deployer).deploy(
          mailbox.address,
          deployerAddress,
        );
        await ism.deployed();

        const merkleHook = await new MerkleTreeHook__factory(deployer).deploy(
          mailbox.address,
        );
        await merkleHook.deployed();

        await mailbox.initialize(
          deployerAddress,
          ism.address,
          merkleHook.address,
          merkleHook.address,
        );

        const token = await new ERC20Test__factory(deployer).deploy(
          'USDC',
          'USDC',
          USDC_INITIAL_SUPPLY,
          USDC_DECIMALS,
        );
        await token.deployed();

        const monitoredRoute = await new HypERC20Collateral__factory(
          deployer,
        ).deploy(token.address, TOKEN_SCALE, mailbox.address);
        await monitoredRoute.deployed();
        await monitoredRoute.initialize(
          zeroAddress,
          ism.address,
          deployerAddress,
        );

        const bridgeRoute1 = await new HypERC20Collateral__factory(
          deployer,
        ).deploy(token.address, TOKEN_SCALE, mailbox.address);
        await bridgeRoute1.deployed();
        await bridgeRoute1.initialize(
          zeroAddress,
          ism.address,
          deployerAddress,
        );

        const bridgeRoute2 = await new HypERC20Collateral__factory(
          deployer,
        ).deploy(token.address, TOKEN_SCALE, mailbox.address);
        await bridgeRoute2.deployed();
        await bridgeRoute2.initialize(
          zeroAddress,
          ism.address,
          deployerAddress,
        );

        chainDeployments[config.name] = {
          mailbox: mailbox.address,
          ism: ism.address,
          token: token.address,
          monitoredRouter: monitoredRoute.address,
          bridgeRouter1: bridgeRoute1.address,
          bridgeRouter2: bridgeRoute2.address,
        };

        tokens[config.name] = token;
        monitoredRouters[config.name] = monitoredRoute;
        bridgeRouters1[config.name] = bridgeRoute1;
        bridgeRouters2[config.name] = bridgeRoute2;
      }

      const routeGroups = [monitoredRouters, bridgeRouters1, bridgeRouters2];
      for (const routeMap of routeGroups) {
        for (const chain of TEST_CHAIN_CONFIGS) {
          const localRoute = routeMap[chain.name];
          const remoteDomains: number[] = [];
          const remoteRouters: string[] = [];

          for (const remote of TEST_CHAIN_CONFIGS) {
            if (remote.name === chain.name) continue;
            remoteDomains.push(remote.domainId);
            remoteRouters.push(
              pad(routeMap[remote.name].address as `0x${string}`, {
                size: 32,
              }),
            );
          }

          await localRoute.enrollRemoteRouters(remoteDomains, remoteRouters);
          await localRoute.addRebalancer(deployerAddress);
        }
      }

      for (const chain of TEST_CHAIN_CONFIGS) {
        const monitoredRoute = monitoredRouters[chain.name];
        for (const destination of TEST_CHAIN_CONFIGS) {
          if (destination.name === chain.name) continue;
          await monitoredRoute.addBridge(
            destination.domainId,
            bridgeRouters1[chain.name].address,
          );
          await monitoredRoute.addBridge(
            destination.domainId,
            bridgeRouters2[chain.name].address,
          );
        }
      }

      const bridgeSeedAmount = BigInt(USDC_INITIAL_SUPPLY) / 10n;
      for (const chain of TEST_CHAIN_CONFIGS) {
        const provider = providersByChain.get(chain.name)!;
        const deployer = deployerWallet.connect(provider);
        const token = ERC20Test__factory.connect(
          tokens[chain.name].address,
          deployer,
        );
        const seedBridge1Tx = await token.transfer(
          bridgeRouters1[chain.name].address,
          bridgeSeedAmount,
        );
        await seedBridge1Tx.wait();
        const seedBridge2Tx = await token.transfer(
          bridgeRouters2[chain.name].address,
          bridgeSeedAmount,
        );
        await seedBridge2Tx.wait();
      }

      const deployedAddresses: DeployedAddresses = {
        chains: chainDeployments,
        monitoredRoute: {
          anvil1: monitoredRouters.anvil1.address,
          anvil2: monitoredRouters.anvil2.address,
          anvil3: monitoredRouters.anvil3.address,
        },
        bridgeRoute1: {
          anvil1: bridgeRouters1.anvil1.address,
          anvil2: bridgeRouters1.anvil2.address,
          anvil3: bridgeRouters1.anvil3.address,
        },
        bridgeRoute2: {
          anvil1: bridgeRouters2.anvil1.address,
          anvil2: bridgeRouters2.anvil2.address,
          anvil3: bridgeRouters2.anvil3.address,
        },
        tokens: {
          anvil1: tokens.anvil1.address,
          anvil2: tokens.anvil2.address,
          anvil3: tokens.anvil3.address,
        },
      };

      const chainMetadata: Record<string, Partial<ChainMetadata>> = {};
      const chainAddresses: Record<string, Record<string, string>> = {};

      for (const config of TEST_CHAIN_CONFIGS) {
        chainMetadata[config.name] = {
          name: config.name,
          chainId: config.chainId,
          domainId: config.domainId,
          protocol: ProtocolType.Ethereum,
          rpcUrls: [
            {
              http: `http://${this.containers.get(config.name)!.getHost()}:${this.containers
                .get(config.name)!
                .getMappedPort(8545)}`,
            },
          ],
          blocks: { confirmations: 0, reorgPeriod: 0 },
          nativeToken: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          isTestnet: true,
        };

        chainAddresses[config.name] = {
          mailbox: deployedAddresses.chains[config.name].mailbox,
          interchainSecurityModule: deployedAddresses.chains[config.name].ism,
        };
      }

      const registry = new PartialRegistry({
        chainMetadata,
        chainAddresses,
      });
      const multiProvider = new MultiProvider(
        chainMetadata as Record<ChainName, ChainMetadata>,
      );

      const signerWallet = new LocalAccountViemSigner(
        ensure0x(ANVIL_TEST_PRIVATE_KEY),
      );
      for (const config of TEST_CHAIN_CONFIGS) {
        const provider = providersByChain.get(config.name)!;
        multiProvider.setProvider(config.name, provider);
        multiProvider.setSigner(config.name, signerWallet.connect(provider));
      }

      this.context = {
        providers: providersByChain,
        registry,
        multiProvider,
        deployedAddresses,
      };

      return this.context;
    } catch (error) {
      await this.stopContainers();
      this.containers.clear();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.context && this.containers.size === 0) {
      return;
    }

    await this.stopContainers();
    this.containers.clear();
    this.context = undefined;
  }

  getContext(): LocalDeploymentContext {
    if (!this.context) {
      throw new Error('LocalDeploymentManager not started');
    }
    return this.context;
  }

  getProvider(
    chain: string,
  ): ReturnType<MultiProvider['getProvider']> | undefined {
    return this.getContext().providers.get(chain);
  }

  getMultiProvider(): MultiProvider {
    return this.getContext().multiProvider;
  }

  getRegistry(): IRegistry {
    return this.getContext().registry;
  }

  private async stopContainers(): Promise<void> {
    const stopPromises = Array.from(this.containers.entries()).map(
      ([chain, container]) =>
        container.stop().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.debug(
            { chain, error: message },
            'Container stop failed (may already be dead)',
          );
        }),
    );
    await Promise.all(stopPromises);
  }
}
