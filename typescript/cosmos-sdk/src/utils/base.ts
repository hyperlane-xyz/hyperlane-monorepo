import { DeliverTxResponse } from '@cosmjs/stargate';

import { assert } from '@hyperlane-xyz/utils';

import { COSMOS_MODULE_MESSAGE_REGISTRY as MessageRegistry } from '../registry.js';

/**
 * Looks up the protobuf converter for a given message type URL.
 *
 * @param typeUrl - The message type URL (e.g., "/hyperlane.core.v1.MsgCreateMailbox")
 * @returns The protobuf converter that can encode/decode messages of this type
 * @throws Error if no converter is found for the given type URL
 */
export function getProtoConverter(
  typeUrl: string,
): (typeof MessageRegistry)[keyof typeof MessageRegistry]['proto']['converter'] {
  for (const { proto } of Object.values(MessageRegistry)) {
    if (typeUrl === proto.type) {
      return proto.converter;
    }
  }

  throw new Error(`found no proto converter for type ${typeUrl}`);
}

/**
 * Extracts the newly created contract address from a transaction receipt.
 * Used for ISM, Hook, and other component creation transactions that return an ID.
 *
 * @param receipt - The transaction receipt from a component creation transaction
 * @returns The address/ID of the newly created contract
 * @throws Error if the receipt is missing a message response or the ID field
 */
export function getNewContractAddress(receipt: DeliverTxResponse): string {
  const [msg] = receipt.msgResponses;
  assert(msg, 'Expected at least one response in the transaction receipt');

  const proto = getProtoConverter(msg.typeUrl);
  const decodedInput: any = proto.decode(msg.value);

  assert(
    decodedInput.id,
    'Expected the id field to be defined on contract creation tx',
  );
  return decodedInput.id;
}
