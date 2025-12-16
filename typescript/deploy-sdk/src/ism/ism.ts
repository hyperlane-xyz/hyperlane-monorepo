import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { IProvider, ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactNew,
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedIsmAddresses,
  DeployedIsmArtifact,
  IRawIsmArtifactManager,
  IsmArtifactConfig,
  STATIC_ISM_TYPES,
  altVMIsmTypeToProviderSdkType,
} from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { Logger, rootLogger } from '@hyperlane-xyz/utils';

import { RoutingIsmReader, RoutingIsmWriter } from './routing-ism.js';

export class IsmReader
  implements ArtifactReader<IsmArtifactConfig, DeployedIsmAddresses>
{
  protected readonly logger: Logger = rootLogger.child({
    module: IsmReader.name,
  });
  private readonly routingIsmReader: RoutingIsmReader;

  constructor(
    protected readonly chainLookup: ChainLookup,
    protected readonly provider: IProvider,
    protected readonly artifactManager: IRawIsmArtifactManager,
  ) {
    this.routingIsmReader = new RoutingIsmReader(
      this.chainLookup,
      this.provider,
      this.artifactManager,
    );
  }

  async read(address: string): Promise<DeployedIsmArtifact> {
    const ismType = await this.provider.getIsmType({ ismAddress: address });

    const providerIsmType = altVMIsmTypeToProviderSdkType(ismType);

    let reader;
    if (providerIsmType === AltVM.IsmType.ROUTING) {
      reader = this.routingIsmReader;
    } else {
      reader = this.artifactManager.createReader(providerIsmType);
    }

    return reader.read(address);
  }
}

export class IsmWriter
  extends IsmReader
  implements ArtifactWriter<IsmArtifactConfig, DeployedIsmAddresses>
{
  private readonly routingIsmWriter: RoutingIsmWriter;

  constructor(
    provider: IProvider,
    artifactManager: IRawIsmArtifactManager,
    chainLookup: ChainLookup,
    private readonly signer: ISigner<AnnotatedTx, TxReceipt>,
  ) {
    super(chainLookup, provider, artifactManager);

    this.routingIsmWriter = new RoutingIsmWriter(
      this.provider,
      this.artifactManager,
      this.chainLookup,
      this.signer,
    );
  }

  async create(
    artifact: ArtifactNew<IsmArtifactConfig>,
  ): Promise<[DeployedIsmArtifact, TxReceipt[]]> {
    const { config, artifactState } = artifact;

    if (config.type === AltVM.IsmType.ROUTING) {
      return this.routingIsmWriter.create({
        config,
        artifactState,
      });
    }

    const writer = this.artifactManager.createWriter(config.type, this.signer);
    return writer.create({ config, artifactState });
  }

  async update(artifact: DeployedIsmArtifact): Promise<AnnotatedTx[]> {
    const { config, artifactState, deployed } = artifact;

    const currentIsmType = await this.provider.getIsmType({
      ismAddress: deployed.address,
    });

    // Conditions for deploying a new ISM:
    // - If updating a proper ISM config whose types are different.
    // - If it is not a mutable ISM.
    if (
      currentIsmType !== config.type ||
      STATIC_ISM_TYPES.includes(currentIsmType)
    ) {
      await this.create({
        config,
      });

      return [];
    }

    if (config.type === AltVM.IsmType.ROUTING) {
      return this.routingIsmWriter.update({
        config,
        artifactState,
        deployed,
      });
    }

    const writer = this.artifactManager.createWriter(config.type, this.signer);

    return writer.update({ config, artifactState, deployed });
  }
}
