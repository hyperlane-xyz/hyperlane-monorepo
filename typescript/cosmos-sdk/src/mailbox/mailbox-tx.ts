import {
  type MsgCreateMailboxEncodeObject,
  type MsgSetMailboxEncodeObject,
} from '../hyperlane/core/messages.js';
import { COSMOS_MODULE_MESSAGE_REGISTRY as MessageRegistry } from '../registry.js';

/**
 * Create transaction to deploy a new mailbox.
 */
export function getCreateMailboxTx(
  fromAddress: string,
  config: {
    domainId: number;
    defaultIsmAddress: string;
  },
): MsgCreateMailboxEncodeObject {
  return {
    typeUrl: MessageRegistry.MsgCreateMailbox.proto.type,
    value: MessageRegistry.MsgCreateMailbox.proto.converter.create({
      local_domain: config.domainId,
      owner: fromAddress,
      default_ism: config.defaultIsmAddress,
    }),
  };
}

/**
 * Create transaction to set mailbox owner.
 */
export function getSetMailboxOwnerTx(
  fromAddress: string,
  config: {
    mailboxAddress: string;
    newOwner: string;
  },
): MsgSetMailboxEncodeObject {
  return {
    typeUrl: MessageRegistry.MsgSetMailbox.proto.type,
    value: MessageRegistry.MsgSetMailbox.proto.converter.create({
      owner: fromAddress,
      mailbox_id: config.mailboxAddress,
      new_owner: config.newOwner,
      renounce_ownership: !config.newOwner,
    }),
  };
}

/**
 * Create transaction to set mailbox default ISM.
 */
export function getSetMailboxDefaultIsmTx(
  fromAddress: string,
  config: {
    mailboxAddress: string;
    ismAddress: string;
  },
): MsgSetMailboxEncodeObject {
  return {
    typeUrl: MessageRegistry.MsgSetMailbox.proto.type,
    value: MessageRegistry.MsgSetMailbox.proto.converter.create({
      mailbox_id: config.mailboxAddress,
      default_ism: config.ismAddress,
      owner: fromAddress,
    }),
  };
}

/**
 * Create transaction to set mailbox default hook.
 */
export function getSetMailboxDefaultHookTx(
  fromAddress: string,
  config: {
    mailboxAddress: string;
    hookAddress: string;
  },
): MsgSetMailboxEncodeObject {
  return {
    typeUrl: MessageRegistry.MsgSetMailbox.proto.type,
    value: MessageRegistry.MsgSetMailbox.proto.converter.create({
      mailbox_id: config.mailboxAddress,
      default_hook: config.hookAddress,
      owner: fromAddress,
    }),
  };
}

/**
 * Create transaction to set mailbox required hook.
 */
export function getSetMailboxRequiredHookTx(
  fromAddress: string,
  config: {
    mailboxAddress: string;
    hookAddress: string;
  },
): MsgSetMailboxEncodeObject {
  return {
    typeUrl: MessageRegistry.MsgSetMailbox.proto.type,
    value: MessageRegistry.MsgSetMailbox.proto.converter.create({
      mailbox_id: config.mailboxAddress,
      required_hook: config.hookAddress,
      owner: fromAddress,
    }),
  };
}
