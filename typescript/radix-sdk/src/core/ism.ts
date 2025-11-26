import {
  IsmArtifact,
  RawDomainRoutingIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  AnnotatedTx,
  ArtifactReader,
  ArtifactWriter,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';

import { RadixCorePopulate } from './populate.js';
import { RadixCoreQuery } from './query.js';

export class DomainRoutingIsmArtifactReader
  implements ArtifactReader<IsmArtifact<'domainRoutingIsm'>>
{
  constructor(private query: RadixCoreQuery) {}

  async read(address: string): Promise<RawDomainRoutingIsmConfig> {
    const routingIsm = await this.query.getRoutingIsm({ ism: address });

    // Convert routes array to domains record
    const domains: Record<string, string> = {};
    for (const route of routingIsm.routes) {
      domains[route.domainId.toString()] = route.ismAddress;
    }

    return {
      type: 'domainRoutingIsm',
      owner: routingIsm.owner,
      domains,
    };
  }
}

export class DomainRoutingIsmArtifactWriter
  implements ArtifactWriter<IsmArtifact<'domainRoutingIsm'>>
{
  constructor(
    private account: string,
    private query: RadixCoreQuery,
    private populate: RadixCorePopulate,
    private signer: RadixBaseSigner,
    private base: RadixBase,
  ) {}

  async create(
    config: RawDomainRoutingIsmConfig,
  ): Promise<[{ deployedIsm: string }, TxReceipt[]]> {
    const receipts: TxReceipt[] = [];

    // Convert domains record to routes array
    const routes = Object.entries(config.domains).map(
      ([domainId, ismAddress]) => ({
        domainId: parseInt(domainId),
        ismAddress,
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

    return [{ deployedIsm: ismAddress }, receipts];
  }

  async update(
    address: string,
    config: RawDomainRoutingIsmConfig,
  ): Promise<AnnotatedTx[]> {
    // Read current state
    const current = await this.query.getRoutingIsm({ ism: address });
    const txs: AnnotatedTx[] = [];

    // Build map of current routes
    const currentRoutes = new Map(
      current.routes.map((r) => [r.domainId.toString(), r.ismAddress]),
    );

    // Process routes
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
    for (const [domainIdStr, ismAddress] of Object.entries(config.domains)) {
      const domainId = parseInt(domainIdStr);
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
