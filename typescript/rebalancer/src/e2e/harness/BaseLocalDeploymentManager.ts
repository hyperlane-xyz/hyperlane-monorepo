import { type Logger, pino } from 'pino';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';

import {
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
  TEST_CHAIN_CONFIGS,
} from '../fixtures/routes.js';

export interface LocalDeploymentContext<
  TDeployedAddresses extends {
    chains: Record<string, { mailbox: string; ism: string }>;
  },
> {
  providers: Map<string, ReturnType<MultiProvider['getProvider']>>;
  registry: IRegistry;
  multiProvider: MultiProvider;
  deployedAddresses: TDeployedAddresses;
}

const ANVIL_DEPLOYER_BALANCE_HEX = '0x56BC75E2D63100000';

export abstract class BaseLocalDeploymentManager<
  TDeployedAddresses extends {
    chains: Record<string, { mailbox: string; ism: string }>;
  },
> {
  private context?: LocalDeploymentContext<TDeployedAddresses>;
  private containers: Map<string, StartedTestContainer> = new Map();
  private readonly logger: Logger;

  constructor() {
    this.logger = pino({ level: 'debug' }).child({
      module: 'BaseLocalDeploymentManager',
    });
  }

  async start(): Promise<LocalDeploymentContext<TDeployedAddresses>> {
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
    const chainInfra: Record<
      string,
      { mailbox: string; ism: string; merkleHook: string; endpoint: string }
    > = {};

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

        chainInfra[config.name] = {
          mailbox: mailbox.address,
          ism: ism.address,
          merkleHook: merkleHook.address,
          endpoint,
        };
      }

      const deployedAddresses = await this.deployRoutes(
        deployerWallet,
        providersByChain,
        chainInfra,
      );

      const chainMetadata: Record<string, Partial<ChainMetadata>> = {};
      const chainAddresses: Record<string, Record<string, string>> = {};

      for (const config of TEST_CHAIN_CONFIGS) {
        chainMetadata[config.name] = {
          name: config.name,
          chainId: config.chainId,
          domainId: config.domainId,
          protocol: ProtocolType.Ethereum,
          rpcUrls: [{ http: chainInfra[config.name].endpoint }],
          blocks: { confirmations: 0, reorgPeriod: 0 },
          nativeToken: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          isTestnet: true,
        };

        chainAddresses[config.name] = {
          mailbox: chainInfra[config.name].mailbox,
          interchainSecurityModule: chainInfra[config.name].ism,
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

  getContext(): LocalDeploymentContext<TDeployedAddresses> {
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

  protected abstract deployRoutes(
    deployerWallet: LocalAccountViemSigner,
    providersByChain: Map<string, ReturnType<MultiProvider['getProvider']>>,
    chainInfra: Record<
      string,
      { mailbox: string; ism: string; merkleHook: string }
    >,
  ): Promise<TDeployedAddresses>;

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
