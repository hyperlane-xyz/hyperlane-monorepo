import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
  isArtifactDeployed,
  isArtifactNew,
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
import { assert, eqAddressStarknet } from '@hyperlane-xyz/utils';

import { StarknetProvider } from '../clients/provider.js';
import { StarknetSigner } from '../clients/signer.js';
import { normalizeStarknetAddressSafe } from '../contracts.js';
import { getRoutingIsmConfig } from './ism-query.js';
import {
  getCreateRoutingIsmTx,
  getRemoveRoutingIsmRouteTx,
  getSetRoutingIsmOwnerTx,
  getSetRoutingIsmRouteTx,
} from './ism-tx.js';

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
    const routing = await getRoutingIsmConfig(
      this.provider.getRawProvider(),
      address,
    );
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
        assert(
          !isArtifactNew(domainIsm),
          `Routing ISM domain ${domainId} must be deployed before Starknet raw routing deployment`,
        );
        assert(
          isArtifactUnderived(domainIsm) || isArtifactDeployed(domainIsm),
          `Routing ISM domain ${domainId} has invalid state`,
        );
        return {
          domainId: Number(domainId),
          ismAddress: domainIsm.deployed.address,
        };
      },
    );

    const receipts: TxReceipt[] = [];
    const createTx = getCreateRoutingIsmTx(this.signer.getSignerAddress());
    const createReceipt = await this.signer.sendAndConfirmTransaction(createTx);
    receipts.push(createReceipt);
    const ismAddress = createReceipt.contractAddress;
    assert(ismAddress, 'failed to get Starknet routing ISM address');

    const rawProvider = this.signer.getRawProvider();
    for (const route of routes) {
      const tx = await getSetRoutingIsmRouteTx(rawProvider, {
        ismAddress,
        route,
      });
      receipts.push(await this.signer.sendAndConfirmTransaction(tx));
    }

    if (
      !eqAddressStarknet(artifact.config.owner, this.signer.getSignerAddress())
    ) {
      const ownerTx = await getSetRoutingIsmOwnerTx(rawProvider, {
        ismAddress,
        newOwner: artifact.config.owner,
      });
      receipts.push(await this.signer.sendAndConfirmTransaction(ownerTx));
    }

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: artifact.config,
        deployed: { address: ismAddress },
      },
      receipts,
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
    const rawProvider = this.signer.getRawProvider();

    for (const route of expectedRoutes) {
      const actualAddress = actualByDomain.get(route.domainId);
      if (
        !actualAddress ||
        !eqAddressStarknet(actualAddress, route.ismAddress)
      ) {
        updateTxs.push({
          annotation: `Setting routing ISM route ${route.domainId}`,
          ...(await getSetRoutingIsmRouteTx(rawProvider, {
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
          ...(await getRemoveRoutingIsmRouteTx(rawProvider, {
            ismAddress: artifact.deployed.address,
            domainId,
          })),
        });
      }
    }

    if (!eqAddressStarknet(current.config.owner, artifact.config.owner)) {
      updateTxs.push({
        annotation: `Updating routing ISM owner`,
        ...(await getSetRoutingIsmOwnerTx(rawProvider, {
          ismAddress: artifact.deployed.address,
          newOwner: artifact.config.owner,
        })),
      });
    }

    return updateTxs;
  }
}
