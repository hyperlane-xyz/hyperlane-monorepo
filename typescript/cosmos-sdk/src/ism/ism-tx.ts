import {
  type MsgCreateMerkleRootMultisigIsmEncodeObject,
  type MsgCreateMessageIdMultisigIsmEncodeObject,
  type MsgCreateNoopIsmEncodeObject,
  type MsgCreateRoutingIsmEncodeObject,
  type MsgRemoveRoutingIsmDomainEncodeObject,
  type MsgSetRoutingIsmDomainEncodeObject,
  type MsgUpdateRoutingIsmOwnerEncodeObject,
} from '../hyperlane/interchain_security/messages.js';
import { COSMOS_MODULE_MESSAGE_REGISTRY as MessageRegistry } from '../registry.js';

export function getCreateTestIsmTx(
  fromAddress: string,
): MsgCreateNoopIsmEncodeObject {
  return {
    typeUrl: MessageRegistry.MsgCreateNoopIsm.proto.type,
    value: MessageRegistry.MsgCreateNoopIsm.proto.converter.create({
      creator: fromAddress,
    }),
  };
}

export function getCreateMessageIdMultisigIsmTx(
  fromAddress: string,
  config: { validators: string[]; threshold: number },
): MsgCreateMessageIdMultisigIsmEncodeObject {
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

export function getCreateMerkleRootMultisigIsmTx(
  fromAddress: string,
  config: { validators: string[]; threshold: number },
): MsgCreateMerkleRootMultisigIsmEncodeObject {
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

export function getCreateRoutingIsmTx(
  fromAddress: string,
  routes: Array<{ domainId: number; ismAddress: string }>,
): MsgCreateRoutingIsmEncodeObject {
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

export function getSetRoutingIsmRouteTx(
  ownerAddress: string,
  config: {
    ismAddress: string;
    domainIsm: { domainId: number; ismAddress: string };
  },
): MsgSetRoutingIsmDomainEncodeObject {
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

export function getRemoveRoutingIsmRouteTx(
  ownerAddress: string,
  config: { ismAddress: string; domainId: number },
): MsgRemoveRoutingIsmDomainEncodeObject {
  return {
    typeUrl: MessageRegistry.MsgRemoveRoutingIsmDomain.proto.type,
    value: MessageRegistry.MsgRemoveRoutingIsmDomain.proto.converter.create({
      owner: ownerAddress,
      ism_id: config.ismAddress,
      domain: config.domainId,
    }),
  };
}

export function getSetRoutingIsmOwnerTx(
  ownerAddress: string,
  config: { ismAddress: string; newOwner: string },
): MsgUpdateRoutingIsmOwnerEncodeObject {
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
