import { IBaseProvider } from '../base-provider.js';

export enum IsmType {
  CUSTOM = 'custom',
  OP_STACK = 'opStackIsm',
  ROUTING = 'domainRoutingIsm',
  FALLBACK_ROUTING = 'defaultFallbackRoutingIsm',
  AMOUNT_ROUTING = 'amountRoutingIsm',
  INTERCHAIN_ACCOUNT_ROUTING = 'interchainAccountRouting',
  AGGREGATION = 'staticAggregationIsm',
  STORAGE_AGGREGATION = 'storageAggregationIsm',
  MERKLE_ROOT_MULTISIG = 'merkleRootMultisigIsm',
  MESSAGE_ID_MULTISIG = 'messageIdMultisigIsm',
  STORAGE_MERKLE_ROOT_MULTISIG = 'storageMerkleRootMultisigIsm',
  STORAGE_MESSAGE_ID_MULTISIG = 'storageMessageIdMultisigIsm',
  TEST_ISM = 'testIsm',
  PAUSABLE = 'pausableIsm',
  TRUSTED_RELAYER = 'trustedRelayerIsm',
  ARB_L2_TO_L1 = 'arbL2ToL1Ism',
  WEIGHTED_MERKLE_ROOT_MULTISIG = 'weightedMerkleRootMultisigIsm',
  WEIGHTED_MESSAGE_ID_MULTISIG = 'weightedMessageIdMultisigIsm',
  CCIP = 'ccipIsm',
  OFFCHAIN_LOOKUP = 'offchainLookupIsm',
}

export type ReqGetIsmType = { ismAddress: string };

export type ReqMessageIdMultisigIsm = { ismAddress: string };
export type ResMessageIdMultisigIsm = {
  address: string;
  threshold: number;
  validators: string[];
};

export type ReqMerkleRootMultisigIsm = { ismAddress: string };
export type ResMerkleRootMultisigIsm = {
  address: string;
  threshold: number;
  validators: string[];
};

export type ReqRoutingIsm = { ismAddress: string };
export type ResRoutingIsm = {
  address: string;
  owner: string;
  routes: {
    domainId: number;
    ismAddress: string;
  }[];
};

export type ReqNoopIsm = { ismAddress: string };
export type ResNoopIsm = {
  address: string;
};

export type ReqSetRoutingIsmRoute = {
  signer: string;
  ismAddress: string;
  route: { domainId: number; ismAddress: string };
};
export type ResSetRoutingIsmRoute = {
  route: { domainId: number; ismAddress: string };
};

export type ReqRemoveRoutingIsmRoute = {
  signer: string;
  ismAddress: string;
  domainId: number;
};
export type ResRemoveRoutingIsmRoute = {
  domainId: number;
};

export type ReqSetRoutingIsmOwner = {
  signer: string;
  ismAddress: string;
  newOwner: string;
};
export type ResSetRoutingIsmOwner = {
  newOwner: string;
};

export interface IIsmProvider<T = any> extends IBaseProvider {
  getIsmType(req: ReqGetIsmType): Promise<IsmType>;

  getMessageIdMultisigIsm(
    req: ReqMessageIdMultisigIsm,
  ): Promise<ResMessageIdMultisigIsm>;

  getMerkleRootMultisigIsm(
    req: ReqMerkleRootMultisigIsm,
  ): Promise<ResMerkleRootMultisigIsm>;

  getRoutingIsm(req: ReqRoutingIsm): Promise<ResRoutingIsm>;

  getNoopIsm(req: ReqNoopIsm): Promise<ResNoopIsm>;

  getSetRoutingIsmRouteTransaction(req: ReqSetRoutingIsmRoute): Promise<T[]>;

  getRemoveRoutingIsmRouteTransaction(
    req: ReqRemoveRoutingIsmRoute,
  ): Promise<T[]>;

  getSetRoutingIsmOwnerTransaction(req: ReqSetRoutingIsmOwner): Promise<T[]>;
}
