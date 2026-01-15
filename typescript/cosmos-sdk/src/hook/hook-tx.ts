import {
  MsgCreateIgpEncodeObject,
  MsgCreateMerkleTreeHookEncodeObject,
  MsgSetDestinationGasConfigEncodeObject,
  MsgSetIgpOwnerEncodeObject,
} from '../hyperlane/post_dispatch/messages.js';
import { COSMOS_MODULE_MESSAGE_REGISTRY as MessageRegistry } from '../registry.js';

/**
 * Build transaction to create a MerkleTree hook.
 *
 * @param fromAddress - Address of the transaction sender
 * @param mailboxAddress - Address of the mailbox this hook will be attached to
 * @returns EncodeObject for MsgCreateMerkleTreeHook transaction
 */
export async function getCreateMerkleTreeHookTx(
  fromAddress: string,
  mailboxAddress: string,
): Promise<MsgCreateMerkleTreeHookEncodeObject> {
  return {
    typeUrl: MessageRegistry.MsgCreateMerkleTreeHook.proto.type,
    value: MessageRegistry.MsgCreateMerkleTreeHook.proto.converter.create({
      owner: fromAddress,
      mailbox_id: mailboxAddress,
    }),
  };
}

/**
 * Build transaction to create an IGP (Interchain Gas Paymaster) hook.
 *
 * @param fromAddress - Address of the transaction sender
 * @param denom - Native token denomination for gas payments
 * @returns EncodeObject for MsgCreateIgp transaction
 */
export async function getCreateIgpTx(
  fromAddress: string,
  denom: string,
): Promise<MsgCreateIgpEncodeObject> {
  return {
    typeUrl: MessageRegistry.MsgCreateIgp.proto.type,
    value: MessageRegistry.MsgCreateIgp.proto.converter.create({
      owner: fromAddress,
      denom,
    }),
  };
}

/**
 * Build transaction to set the owner of an IGP hook.
 *
 * @param fromAddress - Address of the transaction sender (must be current owner)
 * @param config - Configuration with IGP address and new owner
 * @returns EncodeObject for MsgSetIgpOwner transaction
 */
export async function getSetIgpOwnerTx(
  fromAddress: string,
  config: {
    igpAddress: string;
    newOwner: string;
  },
): Promise<MsgSetIgpOwnerEncodeObject> {
  return {
    typeUrl: MessageRegistry.MsgSetIgpOwner.proto.type,
    value: MessageRegistry.MsgSetIgpOwner.proto.converter.create({
      owner: fromAddress,
      igp_id: config.igpAddress,
      new_owner: config.newOwner,
      renounce_ownership: !config.newOwner,
    }),
  };
}

/**
 * Build transaction to set destination gas configuration for an IGP hook.
 *
 * @param fromAddress - Address of the transaction sender (must be owner)
 * @param config - Configuration with IGP address and destination gas config
 * @returns EncodeObject for MsgSetDestinationGasConfig transaction
 */
export async function getSetIgpDestinationGasConfigTx(
  fromAddress: string,
  config: {
    igpAddress: string;
    destinationGasConfig: {
      remoteDomainId: number;
      gasOracle: {
        tokenExchangeRate: string;
        gasPrice: string;
      };
      gasOverhead: string;
    };
  },
): Promise<MsgSetDestinationGasConfigEncodeObject> {
  return {
    typeUrl: MessageRegistry.MsgSetDestinationGasConfig.proto.type,
    value: MessageRegistry.MsgSetDestinationGasConfig.proto.converter.create({
      owner: fromAddress,
      igp_id: config.igpAddress,
      destination_gas_config: {
        remote_domain: config.destinationGasConfig.remoteDomainId,
        gas_overhead: config.destinationGasConfig.gasOverhead,
        gas_oracle: {
          token_exchange_rate:
            config.destinationGasConfig.gasOracle.tokenExchangeRate,
          gas_price: config.destinationGasConfig.gasOracle.gasPrice,
        },
      },
    }),
  };
}
