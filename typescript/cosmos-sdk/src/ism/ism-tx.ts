import {
  MsgCreateMerkleRootMultisigIsmEncodeObject,
  MsgCreateMessageIdMultisigIsmEncodeObject,
  MsgCreateNoopIsmEncodeObject,
  MsgCreateRoutingIsmEncodeObject,
  MsgRemoveRoutingIsmDomainEncodeObject,
  MsgSetRoutingIsmDomainEncodeObject,
  MsgUpdateRoutingIsmOwnerEncodeObject,
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

export async function getCreateRoutingIsmTx(
  fromAddress: string,
  routes: Array<{ domainId: number; ismAddress: string }>,
): Promise<MsgCreateRoutingIsmEncodeObject> {
  return {
    typeUrl: MessageRegistry.MsgCreateRoutingIsm.proto.type,
    value: MessageRegistry.MsgCreateRoutingIsm.proto.converter.create({
      creator: fromAddress,
      routes: routes.map((r) => ({
        domain: r.domainId,
        ism: r.ismAddress,
      })),
    }),
  };
}

export async function getSetRoutingIsmRouteTx(
  ownerAddress: string,
  config: {
    ismAddress: string;
    domainIsm: { domainId: number; ismAddress: string };
  },
): Promise<MsgSetRoutingIsmDomainEncodeObject> {
  return {
    typeUrl: MessageRegistry.MsgSetRoutingIsmDomain.proto.type,
    value: MessageRegistry.MsgSetRoutingIsmDomain.proto.converter.create({
      owner: ownerAddress,
      ism_id: config.ismAddress,
      route: {
        domain: config.domainIsm.domainId,
        ism: config.domainIsm.ismAddress,
      },
    }),
  };
}

export async function getRemoveRoutingIsmRouteTx(
  ownerAddress: string,
  config: { ismAddress: string; domainId: number },
): Promise<MsgRemoveRoutingIsmDomainEncodeObject> {
  return {
    typeUrl: MessageRegistry.MsgRemoveRoutingIsmDomain.proto.type,
    value: MessageRegistry.MsgRemoveRoutingIsmDomain.proto.converter.create({
      owner: ownerAddress,
      ism_id: config.ismAddress,
      domain: config.domainId,
    }),
  };
}

export async function getSetRoutingIsmOwnerTx(
  ownerAddress: string,
  config: { ismAddress: string; newOwner: string },
): Promise<MsgUpdateRoutingIsmOwnerEncodeObject> {
  return {
    typeUrl: MessageRegistry.MsgUpdateRoutingIsmOwner.proto.type,
    value: MessageRegistry.MsgUpdateRoutingIsmOwner.proto.converter.create({
      owner: ownerAddress,
      ism_id: config.ismAddress,
      new_owner: config.newOwner,
      renounce_ownership: !config.newOwner,
    }),
  };
}
