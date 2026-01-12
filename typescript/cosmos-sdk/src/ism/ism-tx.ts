import {
  MsgCreateMerkleRootMultisigIsmEncodeObject,
  MsgCreateMessageIdMultisigIsmEncodeObject,
  MsgCreateNoopIsmEncodeObject,
} from '../hyperlane/interchain_security/messages.js';
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

export async function getCreateMessageIdMultisigIsmTx(
  fromAddress: string,
  config: { validators: string[]; threshold: number },
): Promise<MsgCreateMessageIdMultisigIsmEncodeObject> {
  return {
    typeUrl: MessageRegistry.MsgCreateMessageIdMultisigIsm.proto.type,
    value: MessageRegistry.MsgCreateMessageIdMultisigIsm.proto.converter.create(
      {
        creator: fromAddress,
        validators: config.validators,
        threshold: config.threshold,
      },
    ),
  };
}

export async function getCreateMerkleRootMultisigIsmTx(
  fromAddress: string,
  config: { validators: string[]; threshold: number },
): Promise<MsgCreateMerkleRootMultisigIsmEncodeObject> {
  return {
    typeUrl: MessageRegistry.MsgCreateMerkleRootMultisigIsm.proto.type,
    value:
      MessageRegistry.MsgCreateMerkleRootMultisigIsm.proto.converter.create({
        creator: fromAddress,
        validators: config.validators,
        threshold: config.threshold,
      }),
  };
}
