import { TransactionCommittedDetailsResponse } from '@radixdlt/babylon-gateway-api-sdk';
import {
  PrivateKey,
  PublicKey,
  TransactionManifest,
} from '@radixdlt/radix-engine-toolkit';

import { AltVM } from '@hyperlane-xyz/provider-sdk';

export interface RadixSDKTransaction {
  networkId: number;
  manifest: TransactionManifest | string;
}

export interface RadixSDKReceipt extends TransactionCommittedDetailsResponse {
  transactionHash: string;
}

// https://docs.radixdlt.com/docs/manifest-instructions
export enum INSTRUCTIONS {
  LOCK_FEE = 'lock_fee',
  INSTANTIATE = 'instantiate',
  WITHDRAW = 'withdraw',
  TRY_DEPOSIT_BATCH_OR_ABORT = 'try_deposit_batch_or_abort',
  TRY_DEPOSIT_OR_ABORT = 'try_deposit_or_abort',
  CREATE_PROOF_OF_AMOUNT = 'create_proof_of_amount',
}

export type Account = {
  privateKey: PrivateKey;
  publicKey: PublicKey;
  address: string;
};

export interface RadixSDKOptions {
  networkId?: number;
  gasMultiplier?: number;
  rpcUrls: string[];
  gatewayUrls?: string[];
  packageAddress?: string;
}

export interface MultisigIsmReq {
  validators: string[];
  threshold: number;
}

export enum RadixIsmTypes {
  MERKLE_ROOT_MULTISIG = 'MerkleRootMultisigIsm',
  MESSAGE_ID_MULTISIG = 'MessageIdMultisigIsm',
  ROUTING_ISM = 'RoutingIsm',
  NOOP_ISM = 'NoopIsm',
}

export function ismTypeFromRadixIsmType(
  radixIsmType: RadixIsmTypes,
): AltVM.IsmType {
  switch (radixIsmType) {
    case RadixIsmTypes.MERKLE_ROOT_MULTISIG: {
      return AltVM.IsmType.MERKLE_ROOT_MULTISIG;
    }
    case RadixIsmTypes.MESSAGE_ID_MULTISIG: {
      return AltVM.IsmType.MESSAGE_ID_MULTISIG;
    }
    case RadixIsmTypes.ROUTING_ISM: {
      return AltVM.IsmType.ROUTING;
    }
    case RadixIsmTypes.NOOP_ISM: {
      return AltVM.IsmType.TEST_ISM;
    }
    default:
      throw new Error(`Unknown ISM ModuleType: ${radixIsmType}`);
  }
}

export type MultisigIsms =
  | RadixIsmTypes.MERKLE_ROOT_MULTISIG
  | RadixIsmTypes.MESSAGE_ID_MULTISIG
  | RadixIsmTypes.NOOP_ISM;

export type Isms =
  | RadixIsmTypes.MERKLE_ROOT_MULTISIG
  | RadixIsmTypes.MESSAGE_ID_MULTISIG
  | RadixIsmTypes.ROUTING_ISM
  | RadixIsmTypes.NOOP_ISM;

export enum RadixHookTypes {
  IGP = 'InterchainGasPaymaster',
  MERKLE_TREE = 'MerkleTreeHook',
}

export type Hooks = RadixHookTypes.IGP | RadixHookTypes.MERKLE_TREE;

export interface EntityField {
  field_name: string;
  type_name: string;
  variant_name?: string;
  value?: any;
  elements?: any[];
  fields?: EntityField[];
  hex?: string;
}

export interface EntityDetails {
  blueprint_name: string;
  state: {
    fields: EntityField[];
  };
  role_assignments: {
    owner: {
      rule: {
        access_rule: {
          proof_rule: {
            requirement: {
              resource: string;
            };
          };
        };
      };
    };
  };
}

export interface Receipt {
  output: {
    programmatic_json:
      | {
          entries: {
            key: {
              value: any;
            };
            value: {
              value: any;
            };
          }[];
        }
      | { kind: string; value: any };
  }[];
  error_message?: string;
}
