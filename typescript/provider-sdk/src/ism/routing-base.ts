import { isNullish } from '@hyperlane-xyz/utils';

import { IsmType } from '../altvm.js';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  ArtifactState,
  type ArtifactUnderived,
} from '../artifact.js';
import {
  type DeployedIsmAddress,
  type RawRoutingIsmArtifactConfig,
} from '../ism.js';

/**
 * Route configuration returned by query functions.
 * Maps domain IDs to ISM addresses.
 */
export type RoutingIsmQueryResult = {
  address: string;
  owner: string;
  routes: Array<{ domainId: number; ismAddress: string }>;
};

/**
 * Transaction builders for routing ISM operations.
 * Protocol SDKs provide these as existing functions from ism-tx.ts
 */
export type RoutingIsmTxBuilders<TTx> = {
  /** Create a new routing ISM with initial routes */
  create: (
    signerAddress: string,
    routes: Array<{ domainId: number; ismAddress: string }>,
  ) => Promise<TTx> | TTx;
  /** Set or update a route for a domain */
  setRoute: (
    signerAddress: string,
    config: {
      ismAddress: string;
      domainIsm: { domainId: number; ismAddress: string };
    },
  ) => Promise<TTx> | TTx;
  /** Remove a route for a domain */
  removeRoute: (
    signerAddress: string,
    config: { ismAddress: string; domainId: number },
  ) => Promise<TTx> | TTx;
  /** Transfer ownership of the routing ISM */
  setOwner: (
    signerAddress: string,
    config: { ismAddress: string; newOwner: string },
  ) => Promise<TTx> | TTx;
};

/**
 * Base reader for routing ISMs (protocol-agnostic).
 * Reads on-chain routing ISM configuration and converts to artifact format.
 *
 * Protocol SDKs extend this and pass their query function in the constructor.
 * Note: Does not implement ArtifactReader to allow protocol SDKs to use their own types.
 */
export class BaseRoutingIsmRawReader<TClient> {
  constructor(
    protected readonly client: Readonly<TClient>,
    private readonly queryFn: (
      client: Readonly<TClient>,
      address: string,
    ) => Promise<RoutingIsmQueryResult>,
  ) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddress>
  > {
    const ismConfig = await this.queryFn(this.client, address);

    // Convert routes to UNDERIVED artifacts (address-only references)
    const domains: Record<number, ArtifactUnderived<DeployedIsmAddress>> = {};
    for (const route of ismConfig.routes) {
      domains[route.domainId] = {
        deployed: {
          address: route.ismAddress,
        },
        artifactState: ArtifactState.UNDERIVED,
      };
    }

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: IsmType.ROUTING,
        owner: ismConfig.owner,
        domains,
      },
      deployed: {
        address: ismConfig.address,
      },
    };
  }
}

/**
 * Base writer for routing ISMs (protocol-agnostic).
 * Handles deployment and updates of routing ISMs including domain route management and ownership transfers.
 *
 * Protocol SDKs extend this and pass their transaction builders and utility functions in the constructor.
 * Note: Does not implement ArtifactWriter to allow protocol SDKs to use their own types.
 */
export class BaseRoutingIsmRawWriter<
  TClient,
  TTx,
  TReceipt,
> extends BaseRoutingIsmRawReader<TClient> {
  constructor(
    client: Readonly<TClient>,
    queryFn: (
      client: Readonly<TClient>,
      address: string,
    ) => Promise<RoutingIsmQueryResult>,
    private readonly eqAddress: (a: string, b: string) => boolean,
    private readonly txBuilders: RoutingIsmTxBuilders<TTx>,
    private readonly extractAddress: (receipt: TReceipt) => Promise<string>,
    private readonly getSignerAddress: () => string | Promise<string>,
    private readonly signAndBroadcast: (tx: TTx) => Promise<TReceipt>,
  ) {
    super(client, queryFn);
  }

  async create(
    artifact: ArtifactNew<RawRoutingIsmArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddress>,
      TReceipt[],
    ]
  > {
    const { config } = artifact;
    const receipts: TReceipt[] = [];
    const signerAddress = await this.getSignerAddress();

    // Convert domains to routes
    const routes = Object.entries(config.domains).map(
      ([domainId, artifact]) => ({
        domainId: parseInt(domainId),
        ismAddress: artifact.deployed.address,
      }),
    );

    // Create the routing ISM
    const createTx = await this.txBuilders.create(signerAddress, routes);
    const createReceipt = await this.signAndBroadcast(createTx);
    receipts.push(createReceipt);
    const ismAddress = await this.extractAddress(createReceipt);

    // Transfer ownership if config.owner differs from signer
    if (!this.eqAddress(config.owner, signerAddress)) {
      const ownerTransferTx = await this.txBuilders.setOwner(signerAddress, {
        ismAddress,
        newOwner: config.owner,
      });

      const ownerReceipt = await this.signAndBroadcast(ownerTransferTx);
      receipts.push(ownerReceipt);
    }

    const deployedArtifact: ArtifactDeployed<
      RawRoutingIsmArtifactConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address: ismAddress,
      },
    };

    return [deployedArtifact, receipts];
  }

  protected async updateBase(
    artifact: ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddress>,
  ): Promise<TTx[]> {
    const { config, deployed } = artifact;
    const currentConfig = await this.read(deployed.address);
    const signerAddress = await this.getSignerAddress();

    const transactions: TTx[] = [];

    // Find domains to add or update
    for (const [domainId, expectedIsm] of Object.entries(config.domains)) {
      const domain = parseInt(domainId);
      const currentIsmAddress = currentConfig.config.domains[domain]
        ? currentConfig.config.domains[domain].deployed.address
        : undefined;

      const expectedIsmAddress = expectedIsm.deployed.address;

      if (
        isNullish(currentIsmAddress) ||
        !this.eqAddress(currentIsmAddress, expectedIsmAddress)
      ) {
        const transaction = await this.txBuilders.setRoute(signerAddress, {
          ismAddress: deployed.address,
          domainIsm: { domainId: domain, ismAddress: expectedIsmAddress },
        });

        transactions.push(transaction);
      }
    }

    // Find domains to remove
    for (const domainId of Object.keys(currentConfig.config.domains)) {
      const domain = parseInt(domainId);
      const desiredIsmAddress = config.domains[domain];

      if (isNullish(desiredIsmAddress)) {
        const transaction = await this.txBuilders.removeRoute(signerAddress, {
          ismAddress: deployed.address,
          domainId: domain,
        });

        transactions.push(transaction);
      }
    }

    // Owner transfer must be last transaction as the current owner executes all updates
    if (!this.eqAddress(config.owner, currentConfig.config.owner)) {
      const transaction = await this.txBuilders.setOwner(signerAddress, {
        ismAddress: deployed.address,
        newOwner: config.owner,
      });

      transactions.push(transaction);
    }

    return transactions;
  }
}
