import { TransactionCommittedDetailsResponse } from '@radixdlt/babylon-gateway-api-sdk';
import {
  PrivateKey,
  PublicKey,
  TransactionManifest,
} from '@radixdlt/radix-engine-toolkit';

import { Annotated } from '@hyperlane-xyz/utils';

export interface RadixSDKTransaction {
  networkId: number;
  manifest: TransactionManifest | string;
}

export type AnnotatedRadixTransaction = Annotated<RadixSDKTransaction>;

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

export type MultisigIsms =
  | RadixIsmTypes.MERKLE_ROOT_MULTISIG
  | RadixIsmTypes.MESSAGE_ID_MULTISIG;

export enum RadixHookTypes {
  IGP = 'InterchainGasPaymaster',
  MERKLE_TREE = 'MerkleTreeHook',
}

export const RadixWarpTokenType = {
  COLLATERAL: 'Collateral',
  SYNTHETIC: 'Synthetic',
} as const;

export type RadixWarpTokenType =
  (typeof RadixWarpTokenType)[keyof typeof RadixWarpTokenType];

export interface BaseRadixWarpTokenConfig<TType extends RadixWarpTokenType> {
  owner: string;
  mailbox: string;
  interchainSecurityModule?: string;
  remoteRouters: Record<number, { address: string }>;
  destinationGas: Record<number, string>;
  name?: string;
  symbol?: string;
  decimals?: number;
  type: TType;
}

export interface RadixSyntheticWarpTokenConfig
  extends BaseRadixWarpTokenConfig<'Synthetic'> {
  name: string;
  symbol: string;
  decimals: number;
}

export interface RadixCollateralWarpTokenConfig
  extends BaseRadixWarpTokenConfig<'Collateral'> {
  token: string;
}

export type RadixWarpTokenConfig =
  | RadixSyntheticWarpTokenConfig
  | RadixCollateralWarpTokenConfig;

export interface RadixElement {
  kind: string;
  type_name: string;
  element_kind: string;
  hex: string;
}

export interface EntityField {
  field_name: string;
  type_name: string;
  variant_name?: string;
  value?: any;
  elements?: RadixElement[];
  fields?: EntityField[];
  hex?: string;
  kind: string;
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
