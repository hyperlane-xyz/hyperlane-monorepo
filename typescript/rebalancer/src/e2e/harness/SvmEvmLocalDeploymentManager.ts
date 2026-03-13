import { PublicKey } from '@solana/web3.js';
import { ethers } from 'ethers';
import { type Logger, pino } from 'pino';

import { HypNative__factory } from '@hyperlane-xyz/core';
import { PartialRegistry } from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  MultiProtocolProvider,
  ProviderType,
} from '@hyperlane-xyz/sdk';
import {
  SvmNativeTokenWriter,
  type SvmProgramTarget,
} from '@hyperlane-xyz/svm-sdk';

import {
  ANVIL_TEST_PRIVATE_KEY,
  type NativeDeployedAddresses,
  TEST_CHAIN_CONFIGS,
} from '../fixtures/routes.js';
import {
  type SvmDeployedAddresses,
  SVM_CHAIN_METADATA,
  SVM_CHAIN_NAME,
  SVM_DOMAIN_ID,
  createSvmRpc,
  createSvmSigner,
} from '../fixtures/svm-routes.js';

import { NativeLocalDeploymentManager } from './NativeLocalDeploymentManager.js';
import { SealevelLocalChainManager } from './SealevelLocalChainManager.js';

const REMOTE_SEALEVEL_DOMAIN = 13377;

export class SvmEvmLocalDeploymentManager {
  private readonly logger: Logger;
  private evmManager?: NativeLocalDeploymentManager;
  private svmManager?: SealevelLocalChainManager;
  private svmDeployedAddresses?: SvmDeployedAddresses;

  constructor(logger?: Logger) {
    this.logger =
      logger ??
      pino({ level: 'debug' }).child({
        module: 'SvmEvmLocalDeploymentManager',
      });
  }

  async setup(): Promise<void> {
    if (this.evmManager || this.svmManager) {
      throw new Error('SvmEvmLocalDeploymentManager already setup');
    }

    const svmManager = new SealevelLocalChainManager(this.logger);
    const inventorySignerAddress = this.deriveInventorySignerAddress(
      svmManager.getDeployerKeypair().publicKey.toBytes(),
    );
    const evmManager = new NativeLocalDeploymentManager(inventorySignerAddress);

    this.evmManager = evmManager;
    this.svmManager = svmManager;

    try {
      await evmManager.start();
      await svmManager.start();

      await svmManager.deployCore(SVM_DOMAIN_ID, [REMOTE_SEALEVEL_DOMAIN]);
      const { tokenPda } = await svmManager.deployWarpRoute(
        SVM_DOMAIN_ID,
        new Map(),
      );
      this.svmDeployedAddresses = svmManager.getDeployedAddresses();

      await this.enrollEvmRoutersToSvm(tokenPda);
      await this.enrollSvmRouterToEvmRouters();
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
    this.svmDeployedAddresses = undefined;

    if (svmManager) {
      await svmManager.stop();
    }
    if (evmManager) {
      await evmManager.stop();
    }
  }

  getMultiProtocolProvider(): MultiProtocolProvider {
    const evmMultiProvider = this.getEvmDeploymentManager().getMultiProvider();

    // extendChainMetadata only merges into existing chains, not add new ones.
    // So we construct a new MPP with combined metadata directly.
    const combinedMetadata = {
      ...evmMultiProvider.metadata,
      [SVM_CHAIN_NAME]: SVM_CHAIN_METADATA,
    };
    const mpp = new MultiProtocolProvider(combinedMetadata);

    // Copy EVM providers from the MultiProvider
    for (const chain of Object.keys(evmMultiProvider.metadata)) {
      const provider = evmMultiProvider.providers[chain];
      if (provider) {
        mpp.setProvider(chain, {
          type: ProviderType.EthersV5,
          provider,
        });
      }
    }

    // Set SVM provider
    mpp.setProvider(SVM_CHAIN_NAME, {
      type: ProviderType.SolanaWeb3,
      provider: this.getSvmChainManager().getConnection(),
    });

    return mpp;
  }

  getEvmDeploymentManager(): NativeLocalDeploymentManager {
    if (!this.evmManager) {
      throw new Error(
        'EVM deployment manager not initialized. Call setup first.',
      );
    }
    return this.evmManager;
  }

  getSvmChainManager(): SealevelLocalChainManager {
    if (!this.svmManager) {
      throw new Error('SVM chain manager not initialized. Call setup first.');
    }
    return this.svmManager;
  }

  getRegistry(): PartialRegistry {
    return this.buildRegistry();
  }

  getSvmDeployedAddresses(): SvmDeployedAddresses {
    if (!this.svmDeployedAddresses) {
      throw new Error('SVM deployed addresses unavailable. Call setup first.');
    }
    return this.svmDeployedAddresses;
  }

  private buildRegistry(): PartialRegistry {
    const evmManager = this.getEvmDeploymentManager();
    const evmContext = evmManager.getContext();
    const svmAddresses = this.getSvmDeployedAddresses();

    const chainMetadata: Record<string, ChainMetadata> = {
      ...(evmManager.getMultiProvider().metadata as Record<
        string,
        ChainMetadata
      >),
      [SVM_CHAIN_NAME]: SVM_CHAIN_METADATA,
    };

    const chainAddresses: Record<string, Record<string, string>> = {
      [SVM_CHAIN_NAME]: {
        mailbox: svmAddresses.mailbox,
        interchainSecurityModule: svmAddresses.ism,
      },
    };

    for (const chain of TEST_CHAIN_CONFIGS) {
      chainAddresses[chain.name] = {
        mailbox: evmContext.deployedAddresses.chains[chain.name].mailbox,
        interchainSecurityModule:
          evmContext.deployedAddresses.chains[chain.name].ism,
      };
    }

    return new PartialRegistry({ chainMetadata, chainAddresses });
  }

  private async enrollEvmRoutersToSvm(svmTokenPda: string): Promise<void> {
    const evmManager = this.getEvmDeploymentManager();
    const deployedAddresses = evmManager.getContext().deployedAddresses;

    const svmRouter = ethers.utils.hexZeroPad(
      ethers.utils.hexlify(new PublicKey(svmTokenPda).toBytes()),
      32,
    );

    for (const chain of TEST_CHAIN_CONFIGS) {
      const provider = evmManager.getProvider(chain.name);
      if (!provider) {
        throw new Error(`Missing EVM provider for ${chain.name}`);
      }

      const signer = new ethers.Wallet(ANVIL_TEST_PRIVATE_KEY, provider);
      const monitoredRoute = HypNative__factory.connect(
        deployedAddresses.monitoredRoute[chain.name],
        signer,
      );

      await monitoredRoute.enrollRemoteRouters([SVM_DOMAIN_ID], [svmRouter]);
    }
  }

  private async enrollSvmRouterToEvmRouters(): Promise<void> {
    const deployedAddresses: NativeDeployedAddresses =
      this.getEvmDeploymentManager().getContext().deployedAddresses;
    const svmManager = this.getSvmChainManager();
    const warpProgramId = svmManager.getWarpRouteProgramId();

    const rpc = createSvmRpc();
    const signer = await createSvmSigner();
    const writer = new SvmNativeTokenWriter(
      {
        program: { programId: warpProgramId } as SvmProgramTarget,
        ataPayerFundingAmount: 1_000_000_000n,
      },
      rpc,
      signer,
    );

    const remoteRouters: Record<number, { address: string }> = {};
    const destinationGas: Record<number, string> = {};
    for (const chain of TEST_CHAIN_CONFIGS) {
      const router = ethers.utils.hexZeroPad(
        deployedAddresses.monitoredRoute[chain.name],
        32,
      );
      remoteRouters[chain.domainId] = { address: router };
      destinationGas[chain.domainId] = '0';
    }

    const currentArtifact = await writer.read(warpProgramId);
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

  private deriveInventorySignerAddress(svmDeployerBytes: Uint8Array): string {
    const digest = ethers.utils.keccak256(svmDeployerBytes);
    return ethers.utils.getAddress(ethers.utils.hexDataSlice(digest, 12));
  }
}
