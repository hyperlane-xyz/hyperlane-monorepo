import { MINIMUM_GAS } from './mingas.js';
import { ProtocolType } from './types.js';

// ### QUERY BASE ###
export type ReqGetBalance = { address: string; denom: string };
export type ResGetBalance = bigint;

export type ReqGetTotalSupply = { denom: string };
export type ResGetTotalSupply = bigint;

export type ReqEstimateTransactionFee = {
  transaction: any;
  estimatedGasPrice: string;
  sender: string;
  senderPubKey?: string;
  memo?: string;
};
export type ResEstimateTransactionFee = {
  gasUnits: number;
  gasPrice: number;
  fee: number;
};

// ### QUERY CORE ###

export type ReqGetMailbox = { mailboxId: string };
export type ResGetMailbox = {
  address: string;
  owner: string;
  localDomain: number;
  defaultIsm: string;
  defaultHook: string;
  requiredHook: string;
  messageSent: number;
  messageReceived: number;
};

export type ReqDelivered = { mailboxId: string; messageId: string };
export type ResDelivered = boolean;

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

export type ReqGetIsmType = { ismId: string };
export type ResGetIsmType = IsmType;

export type ReqMessageIdMultisigIsm = { ismId: string };
export type ResMessageIdMultisigIsm = {
  address: string;
  threshold: number;
  validators: string[];
};

export type ReqMerkleRootMultisigIsm = { ismId: string };
export type ResMerkleRootMultisigIsm = {
  address: string;
  threshold: number;
  validators: string[];
};

export type ReqRoutingIsm = { ismId: string };
export type ResRoutingIsm = {
  address: string;
  owner: string;
  routes: {
    domainId: number;
    ismId: string;
  }[];
};

export type ReqNoopIsm = { ismId: string };
export type ResNoopIsm = {
  address: string;
};

export enum HookType {
  CUSTOM = 'custom',
  MERKLE_TREE = 'merkleTreeHook',
  INTERCHAIN_GAS_PAYMASTER = 'interchainGasPaymaster',
  AGGREGATION = 'aggregationHook',
  PROTOCOL_FEE = 'protocolFee',
  OP_STACK = 'opStackHook',
  ROUTING = 'domainRoutingHook',
  FALLBACK_ROUTING = 'fallbackRoutingHook',
  AMOUNT_ROUTING = 'amountRoutingHook',
  PAUSABLE = 'pausableHook',
  ARB_L2_TO_L1 = 'arbL2ToL1Hook',
  MAILBOX_DEFAULT = 'defaultHook',
  CCIP = 'ccipHook',
}

export type ReqGetHookType = { hookId: string };
export type ResGetHookType = HookType;

export type ReqGetInterchainGasPaymasterHook = { hookId: string };
export type ResGetInterchainGasPaymasterHook = {
  address: string;
  owner: string;
  destinationGasConfigs: {
    [domainId: string]: {
      gasOracle: {
        tokenExchangeRate: string;
        gasPrice: string;
      };
      gasOverhead: string;
    };
  };
};

export type ReqGetMerkleTreeHook = { hookId: string };
export type ResGetMerkleTreeHook = {
  address: string;
};

// ### QUERY WARP ###

export enum TokenType {
  COLLATERAL = 'COLLATERAL',
  SYNTHETIC = 'SYNTHETIC',
}

export type ReqGetToken = { tokenId: string };
export type ResGetToken = {
  address: string;
  owner: string;
  tokenType: TokenType;
  mailboxId: string;
  ismId: string;
  originDenom: string;
  name: string;
  symbol: string;
  description: string;
  divisibility: number;
};

export type ReqGetRemoteRouters = { tokenId: string };
export type ResGetRemoteRouters = {
  address: string;
  remoteRouters: {
    receiverDomainId: number;
    receiverContract: string;
    gas: string;
  }[];
};

export type ReqGetBridgedSupply = { tokenId: string };
export type ResGetBridgedSupply = bigint;

export type ReqQuoteRemoteTransfer = {
  tokenId: string;
  destinationDomainId: number;
  customHookId: string;
  customHookMetadata: string;
};
export type ResQuoteRemoteTransfer = { denom: string; amount: bigint };

// ### POPULATE CORE ###

export type ReqCreateMailbox = {
  signer: string;
  domainId: number;
  defaultIsmId: string;
};
export type ResCreateMailbox = { mailboxId: string };

export type ReqSetDefaultIsm = {
  signer: string;
  mailboxId: string;
  ismId: string;
};
export type ResSetDefaultIsm = {
  ismId: string;
};

export type ReqSetDefaultHook = {
  signer: string;
  mailboxId: string;
  hookId: string;
};
export type ResSetDefaultHook = {
  hookId: string;
};

export type ReqSetRequiredHook = {
  signer: string;
  mailboxId: string;
  hookId: string;
};
export type ResSetRequiredHook = {
  hookId: string;
};

export type ReqSetMailboxOwner = {
  signer: string;
  mailboxId: string;
  newOwner: string;
};
export type ResSetMailboxOwner = {
  newOwner: string;
};

export type ReqCreateMerkleRootMultisigIsm = {
  signer: string;
  validators: string[];
  threshold: number;
};
export type ResCreateMerkleRootMultisigIsm = {
  ismId: string;
};

export type ReqCreateMessageIdMultisigIsm = {
  signer: string;
  validators: string[];
  threshold: number;
};
export type ResCreateMessageIdMultisigIsm = {
  ismId: string;
};

export type ReqCreateRoutingIsm = {
  signer: string;
  routes: { ism: string; domainId: number }[];
};
export type ResCreateRoutingIsm = {
  ismId: string;
};

export type ReqSetRoutingIsmRoute = {
  signer: string;
  ismId: string;
  route: { domainId: number; ismId: string };
};
export type ResSetRoutingIsmRoute = {
  route: { domainId: number; ismId: string };
};

export type ReqRemoveRoutingIsmRoute = {
  signer: string;
  ismId: string;
  domainId: number;
};
export type ResRemoveRoutingIsmRoute = {
  domainId: number;
};

export type ReqSetRoutingIsmOwner = {
  signer: string;
  ismId: string;
  newOwner: string;
};
export type ResSetRoutingIsmOwner = {
  newOwner: string;
};

export type ReqCreateNoopIsm = {
  signer: string;
};
export type ResCreateNoopIsm = {
  ismId: string;
};

export type ReqCreateMerkleTreeHook = { signer: string; mailboxId: string };
export type ResCreateMerkleTreeHook = {
  hookId: string;
};

export type ReqCreateInterchainGasPaymasterHook = {
  signer: string;
  denom: string;
};
export type ResCreateInterchainGasPaymasterHook = {
  hookId: string;
};

export type ReqSetInterchainGasPaymasterHookOwner = {
  signer: string;
  hookId: string;
  newOwner: string;
};
export type ResSetInterchainGasPaymasterHookOwner = {
  newOwner: string;
};

export type ReqSetDestinationGasConfig = {
  signer: string;
  hookId: string;
  destinationGasConfig: {
    remoteDomainId: number;
    gasOracle: {
      tokenExchangeRate: string;
      gasPrice: string;
    };
    gasOverhead: string;
  };
};
export type ResSetDestinationGasConfig = {
  destinationGasConfig: {
    remoteDomainId: number;
    gasOracle: {
      tokenExchangeRate: string;
      gasPrice: string;
    };
    gasOverhead: string;
  };
};

export type ReqCreateValidatorAnnounce = {
  signer: string;
  mailboxId: string;
};
export type ResCreateValidatorAnnounce = {
  validatorAnnounceId: string;
};

// ### POPULATE WARP ###

export type ReqCreateCollateralToken = {
  signer: string;
  mailboxId: string;
  originDenom: string;
};
export type ResCreateCollateralToken = {
  tokenId: string;
};

export type ReqCreateSyntheticToken = {
  signer: string;
  mailboxId: string;
};
export type ResCreateSyntheticToken = {
  tokenId: string;
};

export type ReqSetTokenOwner = {
  signer: string;
  tokenId: string;
  newOwner: string;
};
export type ResSetTokenOwner = {
  newOwner: string;
};

export type ReqSetTokenIsm = {
  signer: string;
  tokenId: string;
  ismId: string;
};
export type ResSetTokenIsm = {
  ismId: string;
};

export type ReqEnrollRemoteRouter = {
  signer: string;
  tokenId: string;
  remoteRouter: {
    receiverDomainId: number;
    receiverAddress: string;
    gas: string;
  };
};
export type ResEnrollRemoteRouter = {
  receiverDomainId: number;
};

export type ReqUnenrollRemoteRouter = {
  signer: string;
  tokenId: string;
  receiverDomainId: number;
};
export type ResUnenrollRemoteRouter = {
  receiverDomainId: number;
};

export type ReqRemoteTransfer = {
  signer: string;
  tokenId: string;
  destinationDomainId: number;
  recipient: string;
  amount: string;
  customHookId: string;
  gasLimit: string;
  customHookMetadata: string;
  maxFee: { denom: string; amount: string };
};
export type ResRemoteTransfer = {
  messageId: string;
};

export type ResSignAndBroadcast = {
  height: number;
  transactionHash: string;
};

export interface IProvider<T = any> {
  // ### QUERY BASE ###

  isHealthy(): Promise<boolean>;

  getRpcUrls(): string[];

  getHeight(): Promise<number>;

  getBalance(req: ReqGetBalance): Promise<ResGetBalance>;

  getTotalSupply(req: ReqGetTotalSupply): Promise<ResGetTotalSupply>;

  estimateTransactionFee(
    req: ReqEstimateTransactionFee,
  ): Promise<ResEstimateTransactionFee>;

  // ### QUERY CORE ###

  getMailbox(req: ReqGetMailbox): Promise<ResGetMailbox>;

  delivered(req: ReqDelivered): Promise<ResDelivered>;

  getIsmType(req: ReqGetIsmType): Promise<ResGetIsmType>;

  getMessageIdMultisigIsm(
    req: ReqMessageIdMultisigIsm,
  ): Promise<ResMessageIdMultisigIsm>;

  getMerkleRootMultisigIsm(
    req: ReqMerkleRootMultisigIsm,
  ): Promise<ResMerkleRootMultisigIsm>;

  getRoutingIsm(req: ReqRoutingIsm): Promise<ResRoutingIsm>;

  getNoopIsm(req: ReqNoopIsm): Promise<ResNoopIsm>;

  getHookType(req: ReqGetHookType): Promise<ResGetHookType>;

  getInterchainGasPaymasterHook(
    req: ReqGetInterchainGasPaymasterHook,
  ): Promise<ResGetInterchainGasPaymasterHook>;

  getMerkleTreeHook(req: ReqGetMerkleTreeHook): Promise<ResGetMerkleTreeHook>;

  // ### QUERY WARP ###

  getToken(req: ReqGetToken): Promise<ResGetToken>;

  getRemoteRouters(req: ReqGetRemoteRouters): Promise<ResGetRemoteRouters>;

  getBridgedSupply(req: ReqGetBridgedSupply): Promise<ResGetBridgedSupply>;

  quoteRemoteTransfer(
    req: ReqQuoteRemoteTransfer,
  ): Promise<ResQuoteRemoteTransfer>;

  // ### POPULATE CORE ###

  populateCreateMailbox(req: ReqCreateMailbox): Promise<T>;

  populateSetDefaultIsm(req: ReqSetDefaultIsm): Promise<T>;

  populateSetDefaultHook(req: ReqSetDefaultHook): Promise<T>;

  populateSetRequiredHook(req: ReqSetRequiredHook): Promise<T>;

  populateSetMailboxOwner(req: ReqSetMailboxOwner): Promise<T>;

  populateCreateMerkleRootMultisigIsm(
    req: ReqCreateMerkleRootMultisigIsm,
  ): Promise<T>;

  populateCreateMessageIdMultisigIsm(
    req: ReqCreateMessageIdMultisigIsm,
  ): Promise<T>;

  populateCreateRoutingIsm(req: ReqCreateRoutingIsm): Promise<T>;

  populateSetRoutingIsmRoute(req: ReqSetRoutingIsmRoute): Promise<T>;

  populateRemoveRoutingIsmRoute(req: ReqRemoveRoutingIsmRoute): Promise<T>;

  populateSetRoutingIsmOwner(req: ReqSetRoutingIsmOwner): Promise<T>;

  populateCreateNoopIsm(req: ReqCreateNoopIsm): Promise<T>;

  populateCreateMerkleTreeHook(req: ReqCreateMerkleTreeHook): Promise<T>;

  populateCreateInterchainGasPaymasterHook(
    req: ReqCreateInterchainGasPaymasterHook,
  ): Promise<T>;

  populateSetInterchainGasPaymasterHookOwner(
    req: ReqSetInterchainGasPaymasterHookOwner,
  ): Promise<T>;

  populateSetDestinationGasConfig(req: ReqSetDestinationGasConfig): Promise<T>;

  populateCreateValidatorAnnounce(req: ReqCreateValidatorAnnounce): Promise<T>;

  // ### POPULATE WARP ###

  populateCreateCollateralToken(req: ReqCreateCollateralToken): Promise<T>;

  populateCreateSyntheticToken(req: ReqCreateSyntheticToken): Promise<T>;

  populateSetTokenOwner(req: ReqSetTokenOwner): Promise<T>;

  populateSetTokenIsm(req: ReqSetTokenIsm): Promise<T>;

  populateEnrollRemoteRouter(req: ReqEnrollRemoteRouter): Promise<T>;

  populateUnenrollRemoteRouter(req: ReqUnenrollRemoteRouter): Promise<T>;

  populateRemoteTransfer(req: ReqRemoteTransfer): Promise<T>;
}

export interface ISigner<T = any, R extends ResSignAndBroadcast = any>
  extends IProvider<T> {
  getSignerAddress(): string;

  signAndBroadcast(transactions: T[]): Promise<R>;

  // ### TX CORE ###

  createMailbox(
    req: Omit<ReqCreateMailbox, 'signer'>,
  ): Promise<ResCreateMailbox>;

  setDefaultIsm(
    req: Omit<ReqSetDefaultIsm, 'signer'>,
  ): Promise<ResSetDefaultIsm>;

  setDefaultHook(
    req: Omit<ReqSetDefaultHook, 'signer'>,
  ): Promise<ResSetDefaultHook>;

  setRequiredHook(
    req: Omit<ReqSetRequiredHook, 'signer'>,
  ): Promise<ResSetRequiredHook>;

  setMailboxOwner(
    req: Omit<ReqSetMailboxOwner, 'signer'>,
  ): Promise<ResSetMailboxOwner>;

  createMerkleRootMultisigIsm(
    req: Omit<ReqCreateMerkleRootMultisigIsm, 'signer'>,
  ): Promise<ResCreateMerkleRootMultisigIsm>;

  createMessageIdMultisigIsm(
    req: Omit<ReqCreateMessageIdMultisigIsm, 'signer'>,
  ): Promise<ResCreateMessageIdMultisigIsm>;

  createRoutingIsm(
    req: Omit<ReqCreateRoutingIsm, 'signer'>,
  ): Promise<ResCreateRoutingIsm>;

  setRoutingIsmRoute(
    req: Omit<ReqSetRoutingIsmRoute, 'signer'>,
  ): Promise<ResSetRoutingIsmRoute>;

  removeRoutingIsmRoute(
    req: Omit<ReqRemoveRoutingIsmRoute, 'signer'>,
  ): Promise<ResRemoveRoutingIsmRoute>;

  setRoutingIsmOwner(
    req: Omit<ReqSetRoutingIsmOwner, 'signer'>,
  ): Promise<ResSetRoutingIsmOwner>;

  createNoopIsm(
    req: Omit<ReqCreateNoopIsm, 'signer'>,
  ): Promise<ResCreateNoopIsm>;

  createMerkleTreeHook(
    req: Omit<ReqCreateMerkleTreeHook, 'signer'>,
  ): Promise<ResCreateMerkleTreeHook>;

  createInterchainGasPaymasterHook(
    req: Omit<ReqCreateInterchainGasPaymasterHook, 'signer'>,
  ): Promise<ResCreateInterchainGasPaymasterHook>;

  setInterchainGasPaymasterHookOwner(
    req: Omit<ReqSetInterchainGasPaymasterHookOwner, 'signer'>,
  ): Promise<ResSetInterchainGasPaymasterHookOwner>;

  setDestinationGasConfig(
    req: Omit<ReqSetDestinationGasConfig, 'signer'>,
  ): Promise<ResSetDestinationGasConfig>;

  createValidatorAnnounce(
    req: Omit<ReqCreateValidatorAnnounce, 'signer'>,
  ): Promise<ResCreateValidatorAnnounce>;

  // ### TX WARP ###

  createCollateralToken(
    req: Omit<ReqCreateCollateralToken, 'signer'>,
  ): Promise<ResCreateCollateralToken>;

  createSyntheticToken(
    req: Omit<ReqCreateSyntheticToken, 'signer'>,
  ): Promise<ResCreateSyntheticToken>;

  setTokenOwner(
    req: Omit<ReqSetTokenOwner, 'signer'>,
  ): Promise<ResSetTokenOwner>;

  setTokenIsm(req: Omit<ReqSetTokenIsm, 'signer'>): Promise<ResSetTokenIsm>;

  enrollRemoteRouter(
    req: Omit<ReqEnrollRemoteRouter, 'signer'>,
  ): Promise<ResEnrollRemoteRouter>;

  unenrollRemoteRouter(
    req: Omit<ReqUnenrollRemoteRouter, 'signer'>,
  ): Promise<ResUnenrollRemoteRouter>;

  remoteTransfer(
    req: Omit<ReqRemoteTransfer, 'signer'>,
  ): Promise<ResRemoteTransfer>;
}

export interface IProviderConnect {
  connect(_rpcs: string[]): Promise<IProvider>;
}

export interface ISignerConnect {
  connectWithSigner(
    _rpcs: string[],
    _privateKey: string,
    _extraParams: Record<string, any>,
  ): Promise<ISigner>;
}

abstract class IAltVMFactory {
  abstract getSupportedProtocols(): ProtocolType[];

  abstract supports(_protocol: ProtocolType): boolean;

  abstract getGas(_protocol: ProtocolType): MINIMUM_GAS;
}

export abstract class IProviderFactory extends IAltVMFactory {
  abstract get(chain: string): Promise<IProvider>;
}

export abstract class ISignerFactory extends IAltVMFactory {
  abstract get(chain: string): ISigner;
}
