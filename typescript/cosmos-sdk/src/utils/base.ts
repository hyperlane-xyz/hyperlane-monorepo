import { DeliverTxResponse } from '@cosmjs/stargate';

import { assert } from '@hyperlane-xyz/utils';

import { COSMOS_MODULE_MESSAGE_REGISTRY as MessageRegistry } from '../registry.js';

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

export function getNewContractAddress(receipt: DeliverTxResponse): string {
  const [msg] = receipt.msgResponses;
  assert(msg, 'Expected at least one response in the transaction receipt');

  const proto = getProtoConverter(msg.typeUrl);
  const decodedInput: any = proto.decode(msg.value);

  assert(
    decodedInput.id,
    'Expected the id field to be defined on component creation tx',
  );
  return decodedInput.id;
}
