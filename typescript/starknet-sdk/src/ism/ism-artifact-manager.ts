import { AltVM, ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactDeployed,
  ArtifactNew,
  ArtifactReader,
  ArtifactState,
  ArtifactWriter,
  isArtifactDeployed,
  isArtifactUnderived,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddress,
  DeployedRawIsmArtifact,
  IRawIsmArtifactManager,
  IsmType,
  RawIsmArtifactConfigs,
  altVMIsmTypeToProviderSdkType,
} from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { eqAddressStarknet } from '@hyperlane-xyz/utils';

import { StarknetProvider } from '../clients/provider.js';
import { StarknetSigner } from '../clients/signer.js';
import { normalizeStarknetAddressSafe } from '../contracts.js';

class StarknetTestIsmReader
  implements ArtifactReader<RawIsmArtifactConfigs['testIsm'], DeployedIsmAddress>
{
  constructor(protected readonly provider: StarknetProvider) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawIsmArtifactConfigs['testIsm'], DeployedIsmAddress>
  > {
    const noop = await this.provider.getNoopIsm({ ismAddress: address });
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: { type: AltVM.IsmType.TEST_ISM },
      deployed: { address: noop.address },
    };
  }
}

class StarknetTestIsmWriter
  extends StarknetTestIsmReader
  implements ArtifactWriter<RawIsmArtifactConfigs['testIsm'], DeployedIsmAddress>
{
  constructor(
    provider: StarknetProvider,
    private readonly signer: StarknetSigner,
  ) {
    super(provider);
  }

  async create(
    artifact: ArtifactNew<RawIsmArtifactConfigs['testIsm']>,
  ): Promise<
    [
      ArtifactDeployed<RawIsmArtifactConfigs['testIsm'], DeployedIsmAddress>,
      TxReceipt[],
    ]
  > {
    const created = await this.signer.createNoopIsm({});
    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: artifact.config,
        deployed: { address: created.ismAddress },
      },
      [],
    ];
  }

  async update(
    _artifact: ArtifactDeployed<
      RawIsmArtifactConfigs['testIsm'],
      DeployedIsmAddress
    >,
  ): Promise<AnnotatedTx[]> {
    return [];
  }
}

class StarknetMerkleRootMultisigIsmReader
  implements
    ArtifactReader<
      RawIsmArtifactConfigs['merkleRootMultisigIsm'],
      DeployedIsmAddress
    >
{
  constructor(protected readonly provider: StarknetProvider) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      RawIsmArtifactConfigs['merkleRootMultisigIsm'],
      DeployedIsmAddress
    >
  > {
    const ism = await this.provider.getMerkleRootMultisigIsm({
      ismAddress: address,
    });
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: AltVM.IsmType.MERKLE_ROOT_MULTISIG,
        validators: ism.validators,
        threshold: ism.threshold,
      },
      deployed: { address: ism.address },
    };
  }
}

class StarknetMerkleRootMultisigIsmWriter
  extends StarknetMerkleRootMultisigIsmReader
  implements
    ArtifactWriter<
      RawIsmArtifactConfigs['merkleRootMultisigIsm'],
      DeployedIsmAddress
    >
{
  constructor(
    provider: StarknetProvider,
    private readonly signer: StarknetSigner,
  ) {
    super(provider);
  }

  async create(
    artifact: ArtifactNew<RawIsmArtifactConfigs['merkleRootMultisigIsm']>,
  ): Promise<
    [
      ArtifactDeployed<
        RawIsmArtifactConfigs['merkleRootMultisigIsm'],
        DeployedIsmAddress
      >,
      TxReceipt[],
    ]
  > {
    const created = await this.signer.createMerkleRootMultisigIsm({
      validators: artifact.config.validators,
      threshold: artifact.config.threshold,
    });
    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: artifact.config,
        deployed: { address: created.ismAddress },
      },
      [],
    ];
  }

  async update(
    _artifact: ArtifactDeployed<
      RawIsmArtifactConfigs['merkleRootMultisigIsm'],
      DeployedIsmAddress
    >,
  ): Promise<AnnotatedTx[]> {
    return [];
  }
}

class StarknetMessageIdMultisigIsmReader
  implements
    ArtifactReader<
      RawIsmArtifactConfigs['messageIdMultisigIsm'],
      DeployedIsmAddress
    >
{
  constructor(protected readonly provider: StarknetProvider) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      RawIsmArtifactConfigs['messageIdMultisigIsm'],
      DeployedIsmAddress
    >
  > {
    const ism = await this.provider.getMessageIdMultisigIsm({
      ismAddress: address,
    });
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: AltVM.IsmType.MESSAGE_ID_MULTISIG,
        validators: ism.validators,
        threshold: ism.threshold,
      },
      deployed: { address: ism.address },
    };
  }
}

class StarknetMessageIdMultisigIsmWriter
  extends StarknetMessageIdMultisigIsmReader
  implements
    ArtifactWriter<
      RawIsmArtifactConfigs['messageIdMultisigIsm'],
      DeployedIsmAddress
    >
{
  constructor(
    provider: StarknetProvider,
    private readonly signer: StarknetSigner,
  ) {
    super(provider);
  }

  async create(
    artifact: ArtifactNew<RawIsmArtifactConfigs['messageIdMultisigIsm']>,
  ): Promise<
    [
      ArtifactDeployed<
        RawIsmArtifactConfigs['messageIdMultisigIsm'],
        DeployedIsmAddress
      >,
      TxReceipt[],
    ]
  > {
    const created = await this.signer.createMessageIdMultisigIsm({
      validators: artifact.config.validators,
      threshold: artifact.config.threshold,
    });
    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: artifact.config,
        deployed: { address: created.ismAddress },
      },
      [],
    ];
  }

  async update(
    _artifact: ArtifactDeployed<
      RawIsmArtifactConfigs['messageIdMultisigIsm'],
      DeployedIsmAddress
    >,
  ): Promise<AnnotatedTx[]> {
    return [];
  }
}

class StarknetRoutingIsmReader
  implements
    ArtifactReader<
      RawIsmArtifactConfigs['domainRoutingIsm'],
      DeployedIsmAddress
    >
{
  constructor(protected readonly provider: StarknetProvider) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      RawIsmArtifactConfigs['domainRoutingIsm'],
      DeployedIsmAddress
    >
  > {
    const routing = await this.provider.getRoutingIsm({ ismAddress: address });
    const domains: RawIsmArtifactConfigs['domainRoutingIsm']['domains'] = {};

    for (const route of routing.routes) {
      domains[route.domainId] = {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: route.ismAddress },
      };
    }

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: AltVM.IsmType.ROUTING,
        owner: routing.owner,
        domains,
      },
      deployed: { address: routing.address },
    };
  }
}

class StarknetRoutingIsmWriter
  extends StarknetRoutingIsmReader
  implements
    ArtifactWriter<
      RawIsmArtifactConfigs['domainRoutingIsm'],
      DeployedIsmAddress
    >
{
  constructor(
    provider: StarknetProvider,
    private readonly signer: StarknetSigner,
  ) {
    super(provider);
  }

  async create(
    artifact: ArtifactNew<RawIsmArtifactConfigs['domainRoutingIsm']>,
  ): Promise<
    [
      ArtifactDeployed<
        RawIsmArtifactConfigs['domainRoutingIsm'],
        DeployedIsmAddress
      >,
      TxReceipt[],
    ]
  > {
    const routes = Object.entries(artifact.config.domains).map(
      ([domainId, domainIsm]) => {
        if (isArtifactUnderived(domainIsm) || isArtifactDeployed(domainIsm)) {
          return {
            domainId: Number(domainId),
            ismAddress: domainIsm.deployed.address,
          };
        }

        throw new Error(
          `Routing ISM domain ${domainId} must be deployed before Starknet raw routing deployment`,
        );
      },
    );

    const created = await this.signer.createRoutingIsm({ routes });
    if (!eqAddressStarknet(artifact.config.owner, this.signer.getSignerAddress())) {
      await this.signer.setRoutingIsmOwner({
        ismAddress: created.ismAddress,
        newOwner: artifact.config.owner,
      });
    }

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: artifact.config,
        deployed: { address: created.ismAddress },
      },
      [],
    ];
  }

  async update(
    artifact: ArtifactDeployed<
      RawIsmArtifactConfigs['domainRoutingIsm'],
      DeployedIsmAddress
    >,
  ): Promise<AnnotatedTx[]> {
    const current = await this.read(artifact.deployed.address);

    const expectedRoutes = Object.entries(artifact.config.domains).map(
      ([domainId, domainIsm]) => {
        if (isArtifactUnderived(domainIsm) || isArtifactDeployed(domainIsm)) {
          return {
            domainId: Number(domainId),
            ismAddress: normalizeStarknetAddressSafe(domainIsm.deployed.address),
          };
        }

        throw new Error(`Routing ISM domain ${domainId} has invalid state`);
      },
    );

    const actualByDomain = new Map(
      Object.entries(current.config.domains).map(([domainId, domainIsm]) => [
        Number(domainId),
        normalizeStarknetAddressSafe(domainIsm.deployed.address),
      ]),
    );

    const expectedByDomain = new Map(
      expectedRoutes.map((route) => [route.domainId, route.ismAddress]),
    );

    const updateTxs: AnnotatedTx[] = [];

    for (const route of expectedRoutes) {
      const actualAddress = actualByDomain.get(route.domainId);
      if (!actualAddress || !eqAddressStarknet(actualAddress, route.ismAddress)) {
        updateTxs.push({
          annotation: `Setting routing ISM route ${route.domainId}`,
          ...(await this.signer.getSetRoutingIsmRouteTransaction({
            signer: this.signer.getSignerAddress(),
            ismAddress: artifact.deployed.address,
            route,
          })),
        });
      }
    }

    for (const [domainId] of actualByDomain) {
      if (!expectedByDomain.has(domainId)) {
        updateTxs.push({
          annotation: `Removing routing ISM route ${domainId}`,
          ...(await this.signer.getRemoveRoutingIsmRouteTransaction({
            signer: this.signer.getSignerAddress(),
            ismAddress: artifact.deployed.address,
            domainId,
          })),
        });
      }
    }

    if (!eqAddressStarknet(current.config.owner, artifact.config.owner)) {
      updateTxs.push({
        annotation: `Updating routing ISM owner`,
        ...(await this.signer.getSetRoutingIsmOwnerTransaction({
          signer: this.signer.getSignerAddress(),
          ismAddress: artifact.deployed.address,
          newOwner: artifact.config.owner,
        })),
      });
    }

    return updateTxs;
  }
}

export class StarknetIsmArtifactManager implements IRawIsmArtifactManager {
  private readonly provider: StarknetProvider;

  constructor(chainMetadata: ChainMetadataForAltVM) {
    this.provider = StarknetProvider.connect(
      (chainMetadata.rpcUrls ?? []).map(({ http }) => http),
      chainMetadata.chainId,
      { metadata: chainMetadata },
    );
  }

  async readIsm(address: string): Promise<DeployedRawIsmArtifact> {
    const type = await this.provider.getIsmType({ ismAddress: address });
    const reader = this.createReader(altVMIsmTypeToProviderSdkType(type));
    return reader.read(address) as Promise<DeployedRawIsmArtifact>;
  }

  createReader<T extends IsmType>(
    type: T,
  ): ArtifactReader<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    const readers: {
      [K in IsmType]: () => ArtifactReader<
        RawIsmArtifactConfigs[K],
        DeployedIsmAddress
      >;
    } = {
      testIsm: () => new StarknetTestIsmReader(this.provider),
      merkleRootMultisigIsm: () =>
        new StarknetMerkleRootMultisigIsmReader(this.provider),
      messageIdMultisigIsm: () =>
        new StarknetMessageIdMultisigIsmReader(this.provider),
      domainRoutingIsm: () => new StarknetRoutingIsmReader(this.provider),
    };

    const readerFactory = readers[type];
    if (!readerFactory) {
      throw new Error(`Unsupported Starknet ISM type: ${type}`);
    }
    return readerFactory() as ArtifactReader<
      RawIsmArtifactConfigs[T],
      DeployedIsmAddress
    >;
  }

  createWriter<T extends IsmType>(
    type: T,
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): ArtifactWriter<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    const starknetSigner = signer as StarknetSigner;

    const writers: {
      [K in IsmType]: () => ArtifactWriter<
        RawIsmArtifactConfigs[K],
        DeployedIsmAddress
      >;
    } = {
      testIsm: () => new StarknetTestIsmWriter(this.provider, starknetSigner),
      merkleRootMultisigIsm: () =>
        new StarknetMerkleRootMultisigIsmWriter(this.provider, starknetSigner),
      messageIdMultisigIsm: () =>
        new StarknetMessageIdMultisigIsmWriter(this.provider, starknetSigner),
      domainRoutingIsm: () =>
        new StarknetRoutingIsmWriter(this.provider, starknetSigner),
    };

    const writerFactory = writers[type];
    if (!writerFactory) {
      throw new Error(`Unsupported Starknet ISM type: ${type}`);
    }
    return writerFactory() as ArtifactWriter<
      RawIsmArtifactConfigs[T],
      DeployedIsmAddress
    >;
  }
}
