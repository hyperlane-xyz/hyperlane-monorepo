import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import {
  AltvmRoutingIsmReader,
  AltvmRoutingIsmWriter,
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

function wrapTxCreator<T>(
  base: RadixBase,
  getTx: (addr: string, arg: T) => Promise<RadixSDKTransaction['manifest']>,
): (addr: string, arg: T) => Promise<RadixSDKTransaction> {
  return async (addr, arg) => ({
    networkId: base.getNetworkId(),
    manifest: await getTx(addr, arg),
  });
}

export class RadixRoutingIsmReader extends AltvmRoutingIsmReader<GatewayApiClient> {
  constructor(gateway: Readonly<GatewayApiClient>) {
    super(gateway, (client, address) =>
      getDomainRoutingIsmConfig(client, address),
    );
  }
}

export class RadixRoutingIsmWriter extends AltvmRoutingIsmWriter<
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
        create: wrapTxCreator(base, (signerAddress, routes) =>
          getCreateRoutingIsmTx(base, signerAddress, routes),
        ),
        setRoute: wrapTxCreator(base, (signerAddress, config) =>
          getSetRoutingIsmDomainIsmTx(base, signerAddress, config),
        ),
        removeRoute: wrapTxCreator(base, (signerAddress, config) =>
          getRemoveRoutingIsmDomainIsmTx(base, signerAddress, config),
        ),
        setOwner: wrapTxCreator(base, (signerAddress, config) =>
          getSetRoutingIsmOwnerTx(base, gateway, signerAddress, config),
        ),
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
