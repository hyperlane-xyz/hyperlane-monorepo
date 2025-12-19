import { getProtocolProvider } from '@hyperlane-xyz/provider-sdk';
import { IProvider, ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import {
  ChainLookup,
  ChainMetadataForAltVM,
} from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedIsmArtifact,
  DerivedIsmConfig,
  IRawIsmArtifactManager,
  IsmConfig,
  IsmModuleAddresses,
  IsmModuleType,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  AnnotatedTx,
  HypModule,
  HypModuleArgs,
  HypReader,
  ModuleProvider,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';

import { IsmWriter } from './ism/generic-ism-writer.js';
import { createIsmReader } from './ism/generic-ism.js';
import {
  ismConfigToArtifact,
  shouldDeployNewIsm,
} from './ism/ism-config-utils.js';

/**
 * Adapter that wraps IsmReader to implement HypReader interface.
 * This bridges the Artifact API (used by IsmReader) with the Config API
 * (expected by HypReader).
 */
class IsmReaderAdapter implements HypReader<IsmModuleType> {
  private readonly reader;

  constructor(chainMetadata: ChainMetadataForAltVM, chainLookup: ChainLookup) {
    this.reader = createIsmReader(chainMetadata, chainLookup);
  }

  async read(address: string): Promise<DerivedIsmConfig> {
    return this.reader.deriveIsmConfig(address);
  }
}

/**
 * Adapter that wraps IsmWriter to implement HypModule interface.
 * This bridges the Artifact API (IsmWriter) with the Config API (HypModule).
 *
 * Key responsibilities:
 * - Convert Config API (IsmConfig) to Artifact API (IsmArtifactConfig)
 * - Convert Artifact API back to Config API for read operations
 * - Decide whether to deploy new ISM or update existing one
 * - Maintain backward compatibility with existing module provider interface
 */
class IsmModuleAdapter implements HypModule<IsmModuleType> {
  constructor(
    private readonly writer: IsmWriter,
    private readonly chainLookup: ChainLookup,
    private readonly args: HypModuleArgs<IsmModuleType>,
  ) {}

  async read(): Promise<DerivedIsmConfig> {
    // Use writer's inherited read() method and convert to DerivedIsmConfig
    return this.writer.deriveIsmConfig(this.args.addresses.deployedIsm);
  }

  serialize(): IsmModuleAddresses {
    return this.args.addresses;
  }

  async update(expectedConfig: IsmConfig): Promise<AnnotatedTx[]> {
    // Read current state
    const actualArtifact = await this.writer.read(
      this.args.addresses.deployedIsm,
    );

    // Convert expected config to artifact format
    const expectedArtifact = ismConfigToArtifact(
      expectedConfig,
      this.chainLookup,
    );

    // Decide: deploy new ISM or update existing one
    if (shouldDeployNewIsm(actualArtifact.config, expectedArtifact.config)) {
      // Deploy new ISM
      await this.writer.create(expectedArtifact);
      // TODO: Return txs to update mailbox's defaultIsm if needed
      // For now, return empty array (caller handles mailbox update)
      return [];
    }

    // Update existing ISM (only routing ISMs support updates)
    const deployedArtifact: DeployedIsmArtifact = {
      ...expectedArtifact,
      artifactState: ArtifactState.DEPLOYED,
      config: expectedArtifact.config,
      deployed: actualArtifact.deployed,
    };
    return this.writer.update(deployedArtifact);
  }
}

/**
 * Module provider that creates IsmWriter and adapts it to HypModule.
 */
class IsmModuleProvider implements ModuleProvider<IsmModuleType> {
  private readonly artifactManager: IRawIsmArtifactManager;

  constructor(
    private chainLookup: ChainLookup,
    private chainMetadata: ChainMetadataForAltVM,
    private mailboxAddress: string,
  ) {
    // Create artifact manager once in constructor
    const protocolProvider = getProtocolProvider(chainMetadata.protocol);
    this.artifactManager =
      protocolProvider.createIsmArtifactManager(chainMetadata);
  }

  async createModule(
    signer: ISigner<AnnotatedTx, TxReceipt>,
    config: IsmConfig,
  ): Promise<HypModule<IsmModuleType>> {
    // Create writer
    const writer = new IsmWriter(
      this.artifactManager,
      this.chainLookup,
      signer,
    );

    // Convert config and deploy
    const artifact = ismConfigToArtifact(config, this.chainLookup);
    const [deployed] = await writer.create(artifact);

    // Create module with deployed address
    const addresses: IsmModuleAddresses = {
      deployedIsm: deployed.deployed.address,
      mailbox: this.mailboxAddress,
    };

    return new IsmModuleAdapter(writer, this.chainLookup, {
      addresses,
      chain: this.chainMetadata.name,
      config,
    });
  }

  connectModule(
    signer: ISigner<AnnotatedTx, TxReceipt>,
    args: HypModuleArgs<IsmModuleType>,
  ): HypModule<IsmModuleType> {
    // Create writer
    const writer = new IsmWriter(
      this.artifactManager,
      this.chainLookup,
      signer,
    );

    return new IsmModuleAdapter(writer, this.chainLookup, args);
  }

  connectReader(_provider: IProvider<any>): HypReader<IsmModuleType> {
    return new IsmReaderAdapter(this.chainMetadata, this.chainLookup);
  }
}

export function ismModuleProvider(
  chainLookup: ChainLookup,
  chainMetadata: ChainMetadataForAltVM,
  mailboxAddress: string,
): ModuleProvider<IsmModuleType> {
  return new IsmModuleProvider(chainLookup, chainMetadata, mailboxAddress);
}
