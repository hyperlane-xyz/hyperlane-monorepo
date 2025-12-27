import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import {
  DerivedIsm,
  IsmArtifactConfig,
  RawDomainRoutingIsmConfig,
  RawIsmArtifactReader,
  RawIsmArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  AnnotatedTx,
  Artifact,
  ArtifactDeployed,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';

import { getDomainRoutingIsmConfig, getIsmType } from '../ism/ism-query.js';
import {
  getCreateRoutingIsmTx,
  getRemoveRoutingIsmDomainIsmTx,
  getSetRoutingIsmDomainIsmTx,
  getSetRoutingIsmOwnerTx,
} from '../ism/ism-tx.js';
import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';
import { RadixIsmTypes } from '../utils/types.js';

import {
  MerkleRootMultisigIsmArtifactReader,
  MessageIdMultisigIsmArtifactReader,
} from './multisig-ism.js';
import { TestIsmArtifactReader } from './test-ism.js';

export class DomainRoutingIsmArtifactReader
  implements RawIsmArtifactReader<'domainRoutingIsm'>
{
  constructor(private gateway: GatewayApiClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<RawDomainRoutingIsmConfig, DerivedIsm>> {
    const routingIsm = await getDomainRoutingIsmConfig(this.gateway, address);

    // Convert routes array to domains record with full nested artifacts
    const domains: Record<
      string,
      ArtifactDeployed<IsmArtifactConfig, DerivedIsm>
    > = {};
    for (const route of routingIsm.routes) {
      const nestedArtifact = await this.readIsmArtifact(route.ismAddress);
      domains[route.domainId.toString()] = nestedArtifact;
    }

    return {
      artifactState: 'deployed',
      config: {
        type: 'domainRoutingIsm',
        owner: routingIsm.owner,
        domains,
      },
      deployed: {
        address,
      },
    };
  }

  private async readIsmArtifact(
    address: string,
  ): Promise<ArtifactDeployed<IsmArtifactConfig, DerivedIsm>> {
    const ismType = await getIsmType(this.gateway, address);

    switch (ismType) {
      case RadixIsmTypes.NOOP_ISM: {
        const reader = new TestIsmArtifactReader(this.gateway);
        return reader.read(address);
      }
      case RadixIsmTypes.MERKLE_ROOT_MULTISIG: {
        const reader = new MerkleRootMultisigIsmArtifactReader(this.gateway);
        return reader.read(address);
      }
      case RadixIsmTypes.MESSAGE_ID_MULTISIG: {
        const reader = new MessageIdMultisigIsmArtifactReader(this.gateway);
        return reader.read(address);
      }
      case RadixIsmTypes.ROUTING_ISM: {
        // Recursively read nested routing ISMs
        return this.read(address);
      }
      default:
        throw new Error(`Unsupported ISM type: ${ismType}`);
    }
  }
}

export class DomainRoutingIsmArtifactWriter
  implements RawIsmArtifactWriter<'domainRoutingIsm'>
{
  constructor(
    private account: string,
    private gateway: GatewayApiClient,
    private base: RadixBase,
    private signer: RadixBaseSigner,
  ) {}

  async create(
    artifact: Artifact<RawDomainRoutingIsmConfig>,
  ): Promise<
    [ArtifactDeployed<RawDomainRoutingIsmConfig, DerivedIsm>, TxReceipt[]]
  > {
    // Extract config from artifact (same for both new and deployed)
    const config: RawDomainRoutingIsmConfig = artifact.config;
    const receipts: TxReceipt[] = [];

    // Convert domains record to routes array, extracting addresses from nested artifacts
    // All nested artifacts are ArtifactDeployed for raw types
    const routes = Object.entries(config.domains).map(
      ([domainId, nestedArtifact]) => ({
        domainId: parseInt(domainId),
        ismAddress: nestedArtifact.deployed.address,
      }),
    );

    // Create the routing ISM
    const createManifest = await getCreateRoutingIsmTx(
      this.base,
      this.account,
      routes,
    );
    const createReceipt = await this.signer.signAndBroadcast(createManifest);
    receipts.push(createReceipt);

    const ismAddress = await this.base.getNewComponent(createReceipt);

    // Transfer ownership if needed
    if (config.owner !== this.account) {
      const ownerManifest = await getSetRoutingIsmOwnerTx(
        this.base,
        this.gateway,
        this.account,
        {
          ismAddress,
          newOwner: config.owner,
        },
      );
      const ownerReceipt = await this.signer.signAndBroadcast(ownerManifest);
      receipts.push(ownerReceipt);
    }

    return [
      {
        artifactState: 'deployed',
        config,
        deployed: {
          address: ismAddress,
        },
      },
      receipts,
    ];
  }

  async update(
    address: string,
    artifact: ArtifactDeployed<RawDomainRoutingIsmConfig, DerivedIsm>,
  ): Promise<AnnotatedTx[]> {
    const config = artifact.config;

    // Read current state
    const current = await getDomainRoutingIsmConfig(this.gateway, address);
    const txs: AnnotatedTx[] = [];

    // Build map of current routes
    const currentRoutes = new Map(
      current.routes.map((r) => [r.domainId.toString(), r.ismAddress]),
    );

    // Process routes, extracting addresses from nested artifacts
    const desiredDomains = new Set(Object.keys(config.domains));

    // Remove routes that are no longer desired
    for (const [domainIdStr] of currentRoutes.entries()) {
      if (!desiredDomains.has(domainIdStr)) {
        const domainId = parseInt(domainIdStr);
        const manifest = await getRemoveRoutingIsmDomainIsmTx(
          this.base,
          current.owner,
          {
            ismAddress: address,
            domainId,
          },
        );
        txs.push({
          annotation: `Remove route for domain ${domainId}`,
          manifest,
        } as AnnotatedTx);
      }
    }

    // Add or update routes
    for (const [domainIdStr, nestedArtifact] of Object.entries(
      config.domains,
    )) {
      const domainId = parseInt(domainIdStr);
      const nestedIsmAddress = nestedArtifact.deployed.address;
      const currentIsmAddress = currentRoutes.get(domainIdStr);

      if (currentIsmAddress !== nestedIsmAddress) {
        const manifest = await getSetRoutingIsmDomainIsmTx(
          this.base,
          current.owner,
          {
            ismAddress: address,
            domainIsm: { domainId, ismAddress: nestedIsmAddress },
          },
        );
        const action = currentIsmAddress ? 'Update' : 'Add';
        txs.push({
          annotation: `${action} route for domain ${domainId} to ${nestedIsmAddress}`,
          manifest,
        } as AnnotatedTx);
      }
    }

    // Update owner if needed
    if (current.owner !== config.owner) {
      const manifest = await getSetRoutingIsmOwnerTx(
        this.base,
        this.gateway,
        current.owner,
        {
          ismAddress: address,
          newOwner: config.owner,
        },
      );
      txs.push({
        annotation: `Transfer ownership to ${config.owner}`,
        manifest,
      } as AnnotatedTx);
    }

    return txs;
  }
}
