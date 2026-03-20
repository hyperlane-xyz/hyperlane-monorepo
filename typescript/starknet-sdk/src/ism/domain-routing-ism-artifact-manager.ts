import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
  isArtifactDeployed,
  isArtifactUnderived,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedIsmAddress,
  type RawIsmArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { eqAddressStarknet } from '@hyperlane-xyz/utils';

import { StarknetProvider } from '../clients/provider.js';
import { StarknetSigner } from '../clients/signer.js';
import { normalizeStarknetAddressSafe } from '../contracts.js';

export class StarknetRoutingIsmReader implements ArtifactReader<
  RawIsmArtifactConfigs['domainRoutingIsm'],
  DeployedIsmAddress
> {
  constructor(protected readonly provider: StarknetProvider) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      RawIsmArtifactConfigs['domainRoutingIsm'],
      DeployedIsmAddress
    >
  > {
    const routing = await this.provider.getRoutingIsm({
      ismAddress: address,
    });
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
        type: 'domainRoutingIsm',
        owner: routing.owner,
        domains,
      },
      deployed: { address: routing.address },
    };
  }
}

export class StarknetRoutingIsmWriter
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
    if (
      !eqAddressStarknet(artifact.config.owner, this.signer.getSignerAddress())
    ) {
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
            ismAddress: normalizeStarknetAddressSafe(
              domainIsm.deployed.address,
            ),
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
      if (
        !actualAddress ||
        !eqAddressStarknet(actualAddress, route.ismAddress)
      ) {
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
