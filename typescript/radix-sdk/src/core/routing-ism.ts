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

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';

import {
  MerkleRootMultisigIsmArtifactReader,
  MessageIdMultisigIsmArtifactReader,
} from './multisig-ism.js';
import { RadixCorePopulate } from './populate.js';
import { RadixCoreQuery } from './query.js';
import { TestIsmArtifactReader } from './test-ism.js';

export class DomainRoutingIsmArtifactReader
  implements RawIsmArtifactReader<'domainRoutingIsm'>
{
  constructor(private query: RadixCoreQuery) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<RawDomainRoutingIsmConfig, DerivedIsm>> {
    const routingIsm = await this.query.getRoutingIsm({ ism: address });

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
    const ismType = await this.query.getIsmType({ ism: address });

    switch (ismType) {
      case 'NoopIsm': {
        const reader = new TestIsmArtifactReader(this.query);
        return reader.read(address);
      }
      case 'MerkleRootMultisigIsm': {
        const reader = new MerkleRootMultisigIsmArtifactReader(this.query);
        return reader.read(address);
      }
      case 'MessageIdMultisigIsm': {
        const reader = new MessageIdMultisigIsmArtifactReader(this.query);
        return reader.read(address);
      }
      case 'RoutingIsm': {
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
    private query: RadixCoreQuery,
    private populate: RadixCorePopulate,
    private signer: RadixBaseSigner,
    private base: RadixBase,
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
    const createManifest = await this.populate.createRoutingIsm({
      from_address: this.account,
      routes,
    });
    const createReceipt = await this.signer.signAndBroadcast(createManifest);
    receipts.push(createReceipt);

    const ismAddress = await this.base.getNewComponent(createReceipt);

    // Transfer ownership if needed
    if (config.owner !== this.account) {
      const ownerManifest = await this.populate.setRoutingIsmOwner({
        from_address: this.account,
        ism: ismAddress,
        new_owner: config.owner,
      });
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
    const current = await this.query.getRoutingIsm({ ism: address });
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
        const manifest = await this.populate.removeRoutingIsmRoute({
          from_address: current.owner,
          ism: address,
          domain: domainId,
        });
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
      const ismAddress = nestedArtifact.deployed.address;
      const currentIsmAddress = currentRoutes.get(domainIdStr);

      if (currentIsmAddress !== ismAddress) {
        const manifest = await this.populate.setRoutingIsmRoute({
          from_address: current.owner,
          ism: address,
          route: { domainId, ismAddress },
        });
        const action = currentIsmAddress ? 'Update' : 'Add';
        txs.push({
          annotation: `${action} route for domain ${domainId} to ${ismAddress}`,
          manifest,
        } as AnnotatedTx);
      }
    }

    // Update owner if needed
    if (current.owner !== config.owner) {
      const manifest = await this.populate.setRoutingIsmOwner({
        from_address: current.owner,
        ism: address,
        new_owner: config.owner,
      });
      txs.push({
        annotation: `Transfer ownership to ${config.owner}`,
        manifest,
      } as AnnotatedTx);
    }

    return txs;
  }
}
