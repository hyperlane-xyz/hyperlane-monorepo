import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import {
  BaseRoutingIsmRawReader,
  BaseRoutingIsmRawWriter,
} from '@hyperlane-xyz/provider-sdk/ism';
import { eqAddressRadix } from '@hyperlane-xyz/utils';

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';
import {
  type RadixSDKReceipt,
  type RadixSDKTransaction,
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

export class RadixRoutingIsmRawWriter extends BaseRoutingIsmRawWriter<
  GatewayApiClient,
  RadixSDKTransaction,
  RadixSDKReceipt
> {
  constructor(
    gateway: Readonly<GatewayApiClient>,
    signer: RadixBaseSigner,
    base: RadixBase,
  ) {
    super(
      gateway,
      (client, address) => getDomainRoutingIsmConfig(client, address),
      eqAddressRadix,
      {
        create: async (signerAddress, routes) => ({
          networkId: base.getNetworkId(),
          manifest: await getCreateRoutingIsmTx(base, signerAddress, routes),
        }),
        setRoute: async (signerAddress, config) => ({
          networkId: base.getNetworkId(),
          manifest: await getSetRoutingIsmDomainIsmTx(
            base,
            signerAddress,
            config,
          ),
        }),
        removeRoute: async (signerAddress, config) => ({
          networkId: base.getNetworkId(),
          manifest: await getRemoveRoutingIsmDomainIsmTx(
            base,
            signerAddress,
            config,
          ),
        }),
        setOwner: async (signerAddress, config) => ({
          networkId: base.getNetworkId(),
          manifest: await getSetRoutingIsmOwnerTx(
            base,
            gateway,
            signerAddress,
            config,
          ),
        }),
      },
      async (receipt) => base.getNewComponent(receipt),
      () => signer.getAddress(),
      async (tx) => {
        // tx.manifest is always TransactionManifest (not string) from our builders
        // but TypeScript sees RadixSDKTransaction.manifest as TransactionManifest | string
        if (typeof tx.manifest === 'string') {
          throw new Error('Expected TransactionManifest, got string');
        }
        return signer.signAndBroadcast(tx.manifest);
      },
    );
  }
}
