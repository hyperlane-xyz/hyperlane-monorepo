import { MsgCreateNoopIsmEncodeObject } from '../hyperlane/interchain_security/messages.js';
import { COSMOS_MODULE_MESSAGE_REGISTRY as MessageRegistry } from '../registry.js';

export async function getCreateTestIsmTx(
  fromAddress: string,
): Promise<MsgCreateNoopIsmEncodeObject> {
  return {
    typeUrl: MessageRegistry.MsgCreateNoopIsm.proto.type,
    value: MessageRegistry.MsgCreateNoopIsm.proto.converter.create({
      creator: fromAddress,
    }),
  };
}
