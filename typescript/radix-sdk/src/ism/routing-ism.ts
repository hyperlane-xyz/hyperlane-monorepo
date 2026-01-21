import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import { TransactionManifest } from '@radixdlt/radix-engine-toolkit';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactDeployed,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  BaseRoutingIsmRawReader,
  BaseRoutingIsmRawWriter,
  DeployedIsmAddress,
  RawRoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { eqAddressRadix } from '@hyperlane-xyz/utils';

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';
import {
  AnnotatedRadixTransaction,
  type RadixSDKReceipt,
} from '../utils/types.js';

import { getDomainRoutingIsmConfig } from './ism-query.js';
import {
  getCreateRoutingIsmTx,
  getRemoveRoutingIsmDomainIsmTx,
  getSetRoutingIsmDomainIsmTx,
  getSetRoutingIsmOwnerTx,
} from './ism-tx.js';

export class RadixRoutingIsmRawReader extends BaseRoutingIsmRawReader<GatewayApiClient> {
  constructor(gateway: Readonly<GatewayApiClient>) {
    super(gateway, (client, address) =>
      getDomainRoutingIsmConfig(client, address),
    );
  }
}

export class RadixRoutingIsmRawWriter
  extends BaseRoutingIsmRawWriter<
    GatewayApiClient,
    TransactionManifest,
    RadixSDKReceipt
  >
  implements ArtifactWriter<RawRoutingIsmArtifactConfig, DeployedIsmAddress>
{
  constructor(
    gateway: Readonly<GatewayApiClient>,
    signer: RadixBaseSigner,
    private readonly base: RadixBase,
  ) {
    super(
      gateway,
      (client, address) => getDomainRoutingIsmConfig(client, address),
      eqAddressRadix,
      {
        create: async (signerAddress, routes) =>
          getCreateRoutingIsmTx(base, signerAddress, routes),
        setRoute: async (signerAddress, config) =>
          getSetRoutingIsmDomainIsmTx(base, signerAddress, config),
        removeRoute: async (signerAddress, config) =>
          getRemoveRoutingIsmDomainIsmTx(base, signerAddress, config),
        setOwner: async (signerAddress, config) =>
          getSetRoutingIsmOwnerTx(base, gateway, signerAddress, config),
      },
      async (receipt) => base.getNewComponent(receipt),
      () => signer.getAddress(),
      async (tx) => signer.signAndBroadcast(tx),
    );
  }

  /**
   * Override update to add Radix-specific annotations
   */
  async update(
    artifact: ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddress>,
  ): Promise<AnnotatedRadixTransaction[]> {
    const { config, deployed } = artifact;
    const currentConfig = await this.read(deployed.address);

    // Get base transactions
    const baseTxs = await this.updateBase(artifact);

    // Add annotations
    const transactions: AnnotatedRadixTransaction[] = [];
    let txIndex = 0;

    // Annotate add/update transactions
    for (const [domainId, expectedIsm] of Object.entries(config.domains)) {
      const domain = parseInt(domainId);
      const currentIsmAddress = currentConfig.config.domains[domain]
        ? currentConfig.config.domains[domain].deployed.address
        : undefined;
      const expectedIsmAddress = expectedIsm.deployed.address;

      if (
        !currentIsmAddress ||
        !eqAddressRadix(currentIsmAddress, expectedIsmAddress)
      ) {
        transactions.push({
          annotation: `Set ism for domain ${domain} to ISM ${expectedIsmAddress} on ${IsmType.ROUTING}`,
          networkId: this.base.getNetworkId(),
          manifest: baseTxs[txIndex++],
        });
      }
    }

    // Annotate remove transactions
    for (const domainId of Object.keys(currentConfig.config.domains)) {
      const domain = parseInt(domainId);
      if (!config.domains[domain]) {
        transactions.push({
          annotation: `Remove ism for domain ${domain} on ${IsmType.ROUTING}`,
          networkId: this.base.getNetworkId(),
          manifest: baseTxs[txIndex++],
        });
      }
    }

    // Annotate ownership transfer if present
    if (!eqAddressRadix(config.owner, currentConfig.config.owner)) {
      transactions.push({
        annotation: `Transfer ownership of ${IsmType.ROUTING} from ${currentConfig.config.owner} to ${config.owner}`,
        networkId: this.base.getNetworkId(),
        manifest: baseTxs[txIndex++],
      });
    }

    return transactions;
  }
}
