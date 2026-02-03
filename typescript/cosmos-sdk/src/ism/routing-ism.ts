import { type DeliverTxResponse } from '@cosmjs/stargate';

import {
  AltvmRoutingIsmReader,
  AltvmRoutingIsmWriter,
} from '@hyperlane-xyz/provider-sdk/ism';
import { eqAddressCosmos } from '@hyperlane-xyz/utils';

import { type CosmosNativeSigner } from '../clients/signer.js';
import { getNewContractAddress } from '../utils/base.js';
import { type AnnotatedEncodeObject } from '../utils/types.js';

import { type CosmosIsmQueryClient, getRoutingIsmConfig } from './ism-query.js';
import {
  getCreateRoutingIsmTx,
  getRemoveRoutingIsmRouteTx,
  getSetRoutingIsmOwnerTx,
  getSetRoutingIsmRouteTx,
} from './ism-tx.js';

/**
 * Reader for Cosmos Routing ISM (raw, with underived nested ISMs).
 * Returns nested ISMs as address-only references (UNDERIVED state).
 * The GenericIsmReader from deploy-sdk handles recursive expansion of nested ISMs.
 */
export class CosmosRoutingIsmReader extends AltvmRoutingIsmReader<CosmosIsmQueryClient> {
  constructor(query: CosmosIsmQueryClient) {
    super(query, (client, address) => getRoutingIsmConfig(client, address));
  }
}

/**
 * Writer for Cosmos Routing ISM (raw).
 * Handles deployment and updates of routing ISMs including domain route management and ownership transfers.
 */
export class CosmosRoutingIsmWriter extends AltvmRoutingIsmWriter<
  CosmosIsmQueryClient,
  AnnotatedEncodeObject,
  DeliverTxResponse
> {
  constructor(query: CosmosIsmQueryClient, signer: CosmosNativeSigner) {
    super(
      query,
      (client, address) => getRoutingIsmConfig(client, address),
      eqAddressCosmos,
      {
        create: getCreateRoutingIsmTx,
        setRoute: getSetRoutingIsmRouteTx,
        removeRoute: getRemoveRoutingIsmRouteTx,
        setOwner: getSetRoutingIsmOwnerTx,
      },
      async (receipt) => getNewContractAddress(receipt),
      () => signer.getSignerAddress(),
      async (tx) => signer.sendAndConfirmTransaction(tx),
    );
  }
}
