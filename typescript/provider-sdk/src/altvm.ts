import { MinimumRequiredGasByAction } from './mingas.js';
import type { ProtocolType } from './protocol.js';

// ### QUERY BASE ###
export type ReqGetBalance = { address: string; denom?: string };

export type ReqGetTotalSupply = { denom?: string };

export type ReqEstimateTransactionFee<T> = {
  transaction: T;
  estimatedGasPrice?: string;
  senderAddress?: string;
  senderPubKey?: string;
};
export type ResEstimateTransactionFee = {
  gasUnits: bigint;
  gasPrice: number;
  fee: bigint;
};

// ### QUERY CORE ###

export type ReqGetMailbox = { mailboxAddress: string };
export type ResGetMailbox = {
  address: string;
  owner: string;
  localDomain: number;
  defaultIsm: string;
  defaultHook: string;
  requiredHook: string;
  nonce: number;
};

export type ReqIsMessageDelivered = {
  mailboxAddress: string;
  messageId: string;
};

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

export type ReqGetHookType = { hookAddress: string };

export type ReqGetInterchainGasPaymasterHook = { hookAddress: string };
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

export type ReqGetMerkleTreeHook = { hookAddress: string };
export type ResGetMerkleTreeHook = {
  address: string;
};

export type ReqGetNoopHook = { hookAddress: string };
export type ResGetNoopHook = {
  address: string;
};

// ### QUERY WARP ###

export enum TokenType {
  synthetic = 'synthetic',
  syntheticRebase = 'syntheticRebase',
  syntheticUri = 'syntheticUri',
  collateral = 'collateral',
  collateralVault = 'collateralVault',
  collateralVaultRebase = 'collateralVaultRebase',
  XERC20 = 'xERC20',
  XERC20Lockbox = 'xERC20Lockbox',
  collateralFiat = 'collateralFiat',
  collateralUri = 'collateralUri',
  collateralCctp = 'collateralCctp',
  native = 'native',
  nativeOpL2 = 'nativeOpL2',
  nativeOpL1 = 'nativeOpL1',
  nativeScaled = 'nativeScaled',
}

export type ReqGetToken = { tokenAddress: string };
export type ResGetToken = {
  address: string;
  owner: string;
  tokenType: TokenType;
  mailboxAddress: string;
  ismAddress: string;
  hookAddress: string;
  denom: string;
  name: string;
  symbol: string;
  decimals: number;
};

export type ReqGetRemoteRouters = { tokenAddress: string };
export type ResGetRemoteRouters = {
  address: string;
  remoteRouters: {
    receiverDomainId: number;
    receiverAddress: string;
    gas: string;
  }[];
};

export type ReqGetBridgedSupply = { tokenAddress: string };

export type ReqQuoteRemoteTransfer = {
  tokenAddress: string;
  destinationDomainId: number;
  customHookAddress?: string;
  customHookMetadata?: string;
};
export type ResQuoteRemoteTransfer = { denom: string; amount: bigint };

// ### POPULATE CORE ###

export type ReqCreateMailbox = {
  signer: string;
  domainId: number;
  defaultIsmAddress?: string;
};
export type ResCreateMailbox<R> = { mailboxAddress: string; receipts: R[] };

export type ReqSetDefaultIsm = {
  signer: string;
  mailboxAddress: string;
  ismAddress: string;
};
export type ResSetDefaultIsm<R> = {
  receipts: R[];
};

export type ReqSetDefaultHook = {
  signer: string;
  mailboxAddress: string;
  hookAddress: string;
};
export type ResSetDefaultHook<R> = {
  receipts: R[];
};

export type ReqSetRequiredHook = {
  signer: string;
  mailboxAddress: string;
  hookAddress: string;
};
export type ResSetRequiredHook<R> = {
  receipts: R[];
};

export type ReqSetMailboxOwner = {
  signer: string;
  mailboxAddress: string;
  newOwner: string;
};
export type ResSetMailboxOwner<R> = {
  receipts: R[];
};

export type ReqCreateMerkleRootMultisigIsm = {
  signer: string;
  validators: string[];
  threshold: number;
};
export type ResCreateMerkleRootMultisigIsm<R> = {
  ismAddress: string;
  receipts: R[];
};

export type ReqCreateMessageIdMultisigIsm = {
  signer: string;
  validators: string[];
  threshold: number;
};
export type ResCreateMessageIdMultisigIsm<R> = {
  ismAddress: string;
  receipts: R[];
};

export type ReqCreateRoutingIsm = {
  signer: string;
  routes: { ismAddress: string; domainId: number }[];
};
export type ResCreateRoutingIsm<R> = {
  ismAddress: string;
  receipts: R[];
};

export type ReqSetRoutingIsmRoute = {
  signer: string;
  ismAddress: string;
  route: { domainId: number; ismAddress: string };
};
export type ResSetRoutingIsmRoute<R> = {
  receipts: R[];
};

export type ReqRemoveRoutingIsmRoute = {
  signer: string;
  ismAddress: string;
  domainId: number;
};
export type ResRemoveRoutingIsmRoute<R> = {
  receipts: R[];
};

export type ReqSetRoutingIsmOwner = {
  signer: string;
  ismAddress: string;
  newOwner: string;
};
export type ResSetRoutingIsmOwner<R> = {
  receipts: R[];
};

export type ReqCreateNoopIsm = {
  signer: string;
};
export type ResCreateNoopIsm<R> = {
  ismAddress: string;
  receipts: R[];
};

export type ReqCreateMerkleTreeHook = {
  signer: string;
  mailboxAddress: string;
};
export type ResCreateMerkleTreeHook<R> = {
  hookAddress: string;
  receipts: R[];
};

export type ReqCreateInterchainGasPaymasterHook = {
  signer: string;
  mailboxAddress: string;
  denom?: string;
};
export type ResCreateInterchainGasPaymasterHook<R> = {
  hookAddress: string;
  receipts: R[];
};

export type ReqSetInterchainGasPaymasterHookOwner = {
  signer: string;
  hookAddress: string;
  newOwner: string;
};
export type ResSetInterchainGasPaymasterHookOwner<R> = {
  receipts: R[];
};

export type ReqSetDestinationGasConfig = {
  signer: string;
  hookAddress: string;
  destinationGasConfig: {
    remoteDomainId: number;
    gasOracle: {
      tokenExchangeRate: string;
      gasPrice: string;
    };
    gasOverhead: string;
  };
};
export type ResSetDestinationGasConfig<R> = {
  receipts: R[];
};

export type ReqRemoveDestinationGasConfig = {
  signer: string;
  hookAddress: string;
  remoteDomainId: number;
};
export type ResRemoveDestinationGasConfig<R> = {
  receipts: R[];
};

export type ReqCreateNoopHook = {
  signer: string;
  mailboxAddress: string;
};
export type ResCreateNoopHook<R> = {
  hookAddress: string;
  receipts: R[];
};

export type ReqCreateValidatorAnnounce = {
  signer: string;
  mailboxAddress: string;
};
export type ResCreateValidatorAnnounce<R> = {
  validatorAnnounceAddress: string;
  receipts: R[];
};

// ### POPULATE WARP ###

export type ReqCreateNativeToken = {
  signer: string;
  mailboxAddress: string;
  warpSuffix?: string;
};
export type ResCreateNativeToken<R> = {
  tokenAddress: string;
  receipts: R[];
};

export type ReqCreateCollateralToken = {
  signer: string;
  mailboxAddress: string;
  collateralDenom: string;
  warpSuffix?: string;
};
export type ResCreateCollateralToken<R> = {
  tokenAddress: string;
  receipts: R[];
};

export type ReqCreateSyntheticToken = {
  signer: string;
  mailboxAddress: string;
  name: string;
  denom: string;
  decimals: number;
  warpSuffix?: string;
};
export type ResCreateSyntheticToken<R> = {
  tokenAddress: string;
  receipts: R[];
};

export type ReqSetTokenOwner = {
  signer: string;
  tokenAddress: string;
  newOwner: string;
};
export type ResSetTokenOwner<R> = {
  receipts: R[];
};

export type ReqSetTokenIsm = {
  signer: string;
  tokenAddress: string;
  ismAddress: string;
};
export type ResSetTokenIsm<R> = {
  receipts: R[];
};

export type ReqSetTokenHook = {
  signer: string;
  tokenAddress: string;
  hookAddress: string;
};
export type ResSetTokenHook<R> = {
  receipts: R[];
};

export type ReqEnrollRemoteRouter = {
  signer: string;
  tokenAddress: string;
  remoteRouter: {
    receiverDomainId: number;
    receiverAddress: string;
    gas: string;
  };
};
export type ResEnrollRemoteRouter<R> = {
  receipts: R[];
};

export type ReqUnenrollRemoteRouter = {
  signer: string;
  tokenAddress: string;
  receiverDomainId: number;
};
export type ResUnenrollRemoteRouter<R> = {
  receipts: R[];
};

export type ReqTransfer = {
  signer: string;
  recipient: string;
  denom?: string;
  amount: string;
};
export type ResTransfer<R> = {
  receipts: R[];
};

export type ReqRemoteTransfer = {
  signer: string;
  tokenAddress: string;
  destinationDomainId: number;
  recipient: string;
  amount: string;
  gasLimit: string;
  maxFee: { denom: string; amount: string };
  customHookAddress?: string;
  customHookMetadata?: string;
};
export type ResRemoteTransfer<R> = {
  receipts: R[];
};

export interface IProvider<T = any> {
  // ### QUERY BASE ###

  isHealthy(): Promise<boolean>;

  getRpcUrls(): string[];

  getHeight(): Promise<number>;

  getBalance(req: ReqGetBalance): Promise<bigint>;

  getTotalSupply(req: ReqGetTotalSupply): Promise<bigint>;

  estimateTransactionFee(
    req: ReqEstimateTransactionFee<T>,
  ): Promise<ResEstimateTransactionFee>;

  // ### QUERY CORE ###

  getMailbox(req: ReqGetMailbox): Promise<ResGetMailbox>;

  isMessageDelivered(req: ReqIsMessageDelivered): Promise<boolean>;

  getIsmType(req: ReqGetIsmType): Promise<IsmType>;

  getMessageIdMultisigIsm(
    req: ReqMessageIdMultisigIsm,
  ): Promise<ResMessageIdMultisigIsm>;

  getMerkleRootMultisigIsm(
    req: ReqMerkleRootMultisigIsm,
  ): Promise<ResMerkleRootMultisigIsm>;

  getRoutingIsm(req: ReqRoutingIsm): Promise<ResRoutingIsm>;

  getNoopIsm(req: ReqNoopIsm): Promise<ResNoopIsm>;

  getHookType(req: ReqGetHookType): Promise<HookType>;

  getInterchainGasPaymasterHook(
    req: ReqGetInterchainGasPaymasterHook,
  ): Promise<ResGetInterchainGasPaymasterHook>;

  getMerkleTreeHook(req: ReqGetMerkleTreeHook): Promise<ResGetMerkleTreeHook>;

  getNoopHook(req: ReqGetNoopHook): Promise<ResGetNoopHook>;

  // ### QUERY WARP ###

  getToken(req: ReqGetToken): Promise<ResGetToken>;

  getRemoteRouters(req: ReqGetRemoteRouters): Promise<ResGetRemoteRouters>;

  getBridgedSupply(req: ReqGetBridgedSupply): Promise<bigint>;

  quoteRemoteTransfer(
    req: ReqQuoteRemoteTransfer,
  ): Promise<ResQuoteRemoteTransfer>;

  // ### GET CORE TXS ###

  getCreateMailboxTransaction(req: ReqCreateMailbox): Promise<T>;

  getSetDefaultIsmTransaction(req: ReqSetDefaultIsm): Promise<T>;

  getSetDefaultHookTransaction(req: ReqSetDefaultHook): Promise<T>;

  getSetRequiredHookTransaction(req: ReqSetRequiredHook): Promise<T>;

  getSetMailboxOwnerTransaction(req: ReqSetMailboxOwner): Promise<T>;

  getCreateMerkleRootMultisigIsmTransaction(
    req: ReqCreateMerkleRootMultisigIsm,
  ): Promise<T>;

  getCreateMessageIdMultisigIsmTransaction(
    req: ReqCreateMessageIdMultisigIsm,
  ): Promise<T>;

  getCreateRoutingIsmTransaction(req: ReqCreateRoutingIsm): Promise<T>;

  getSetRoutingIsmRouteTransaction(req: ReqSetRoutingIsmRoute): Promise<T>;

  getRemoveRoutingIsmRouteTransaction(
    req: ReqRemoveRoutingIsmRoute,
  ): Promise<T>;

  getSetRoutingIsmOwnerTransaction(req: ReqSetRoutingIsmOwner): Promise<T>;

  getCreateNoopIsmTransaction(req: ReqCreateNoopIsm): Promise<T>;

  getCreateMerkleTreeHookTransaction(req: ReqCreateMerkleTreeHook): Promise<T>;

  getCreateInterchainGasPaymasterHookTransaction(
    req: ReqCreateInterchainGasPaymasterHook,
  ): Promise<T>;

  getSetInterchainGasPaymasterHookOwnerTransaction(
    req: ReqSetInterchainGasPaymasterHookOwner,
  ): Promise<T>;

  getSetDestinationGasConfigTransaction(
    req: ReqSetDestinationGasConfig,
  ): Promise<T>;

  getRemoveDestinationGasConfigTransaction(
    req: ReqRemoveDestinationGasConfig,
  ): Promise<T>;

  getCreateNoopHookTransaction(req: ReqCreateNoopHook): Promise<T>;

  getCreateValidatorAnnounceTransaction(
    req: ReqCreateValidatorAnnounce,
  ): Promise<T>;

  // ### GET WARP TXS ###

  getCreateNativeTokenTransaction(req: ReqCreateNativeToken): Promise<T>;

  getCreateCollateralTokenTransaction(
    req: ReqCreateCollateralToken,
  ): Promise<T>;

  getCreateSyntheticTokenTransaction(req: ReqCreateSyntheticToken): Promise<T>;

  getSetTokenOwnerTransaction(req: ReqSetTokenOwner): Promise<T>;

  getSetTokenIsmTransaction(req: ReqSetTokenIsm): Promise<T>;

  getSetTokenHookTransaction(req: ReqSetTokenHook): Promise<T>;

  getEnrollRemoteRouterTransaction(req: ReqEnrollRemoteRouter): Promise<T>;

  getUnenrollRemoteRouterTransaction(req: ReqUnenrollRemoteRouter): Promise<T>;

  getTransferTransaction(req: ReqTransfer): Promise<T>;

  getRemoteTransferTransaction(req: ReqRemoteTransfer): Promise<T>;
}

export interface ISigner<T, R> extends IProvider<T> {
  getSignerAddress(): string;

  supportsTransactionBatching(): boolean;

  transactionToPrintableJson(transaction: T): Promise<object>;

  sendAndConfirmTransaction(transaction: T): Promise<R>;

  sendAndConfirmBatchTransactions(transactions: T[]): Promise<R>;

  // ### TX CORE ###

  createMailbox(
    req: Omit<ReqCreateMailbox, 'signer'>,
  ): Promise<ResCreateMailbox<R>>;

  setDefaultIsm(
    req: Omit<ReqSetDefaultIsm, 'signer'>,
  ): Promise<ResSetDefaultIsm<R>>;

  setDefaultHook(
    req: Omit<ReqSetDefaultHook, 'signer'>,
  ): Promise<ResSetDefaultHook<R>>;

  setRequiredHook(
    req: Omit<ReqSetRequiredHook, 'signer'>,
  ): Promise<ResSetRequiredHook<R>>;

  setMailboxOwner(
    req: Omit<ReqSetMailboxOwner, 'signer'>,
  ): Promise<ResSetMailboxOwner<R>>;

  createMerkleRootMultisigIsm(
    req: Omit<ReqCreateMerkleRootMultisigIsm, 'signer'>,
  ): Promise<ResCreateMerkleRootMultisigIsm<R>>;

  createMessageIdMultisigIsm(
    req: Omit<ReqCreateMessageIdMultisigIsm, 'signer'>,
  ): Promise<ResCreateMessageIdMultisigIsm<R>>;

  createRoutingIsm(
    req: Omit<ReqCreateRoutingIsm, 'signer'>,
  ): Promise<ResCreateRoutingIsm<R>>;

  setRoutingIsmRoute(
    req: Omit<ReqSetRoutingIsmRoute, 'signer'>,
  ): Promise<ResSetRoutingIsmRoute<R>>;

  removeRoutingIsmRoute(
    req: Omit<ReqRemoveRoutingIsmRoute, 'signer'>,
  ): Promise<ResRemoveRoutingIsmRoute<R>>;

  setRoutingIsmOwner(
    req: Omit<ReqSetRoutingIsmOwner, 'signer'>,
  ): Promise<ResSetRoutingIsmOwner<R>>;

  createNoopIsm(
    req: Omit<ReqCreateNoopIsm, 'signer'>,
  ): Promise<ResCreateNoopIsm<R>>;

  createMerkleTreeHook(
    req: Omit<ReqCreateMerkleTreeHook, 'signer'>,
  ): Promise<ResCreateMerkleTreeHook<R>>;

  createInterchainGasPaymasterHook(
    req: Omit<ReqCreateInterchainGasPaymasterHook, 'signer'>,
  ): Promise<ResCreateInterchainGasPaymasterHook<R>>;

  setInterchainGasPaymasterHookOwner(
    req: Omit<ReqSetInterchainGasPaymasterHookOwner, 'signer'>,
  ): Promise<ResSetInterchainGasPaymasterHookOwner<R>>;

  setDestinationGasConfig(
    req: Omit<ReqSetDestinationGasConfig, 'signer'>,
  ): Promise<ResSetDestinationGasConfig<R>>;

  removeDestinationGasConfig(
    req: Omit<ReqRemoveDestinationGasConfig, 'signer'>,
  ): Promise<ResRemoveDestinationGasConfig<R>>;

  createNoopHook(
    req: Omit<ReqCreateNoopHook, 'signer'>,
  ): Promise<ResCreateNoopHook<R>>;

  createValidatorAnnounce(
    req: Omit<ReqCreateValidatorAnnounce, 'signer'>,
  ): Promise<ResCreateValidatorAnnounce<R>>;

  // ### TX WARP ###

  createNativeToken(
    req: Omit<ReqCreateNativeToken, 'signer'>,
  ): Promise<ResCreateNativeToken<R>>;

  createCollateralToken(
    req: Omit<ReqCreateCollateralToken, 'signer'>,
  ): Promise<ResCreateCollateralToken<R>>;

  createSyntheticToken(
    req: Omit<ReqCreateSyntheticToken, 'signer'>,
  ): Promise<ResCreateSyntheticToken<R>>;

  setTokenOwner(
    req: Omit<ReqSetTokenOwner, 'signer'>,
  ): Promise<ResSetTokenOwner<R>>;

  setTokenIsm(req: Omit<ReqSetTokenIsm, 'signer'>): Promise<ResSetTokenIsm<R>>;

  setTokenHook(
    req: Omit<ReqSetTokenHook, 'signer'>,
  ): Promise<ResSetTokenHook<R>>;

  enrollRemoteRouter(
    req: Omit<ReqEnrollRemoteRouter, 'signer'>,
  ): Promise<ResEnrollRemoteRouter<R>>;

  unenrollRemoteRouter(
    req: Omit<ReqUnenrollRemoteRouter, 'signer'>,
  ): Promise<ResUnenrollRemoteRouter<R>>;

  transfer(req: Omit<ReqTransfer, 'signer'>): Promise<ResTransfer<R>>;

  remoteTransfer(
    req: Omit<ReqRemoteTransfer, 'signer'>,
  ): Promise<ResRemoteTransfer<R>>;
}

export interface IProviderConnect {
  connect(
    _rpcs: string[],
    _chainId: string | number,
    _extraParams?: Record<string, any>,
  ): Promise<IProvider>;
}

export interface ISignerConnect<T, R> {
  connectWithSigner(
    _rpcs: string[],
    _privateKey: string,
    _extraParams: Record<string, any>,
  ): Promise<ISigner<T, R>>;
}

export abstract class ISupportedProtocols {
  abstract getSupportedProtocols(): ProtocolType[];

  abstract supports(_protocol: ProtocolType): boolean;

  abstract getMinGas(_protocol: ProtocolType): MinimumRequiredGasByAction;
}

export abstract class IProviderFactory extends ISupportedProtocols {
  abstract get(chain: string): Promise<IProvider>;
}

export abstract class ISignerFactory<T, R> extends ISupportedProtocols {
  abstract get(chain: string): ISigner<T, R>;
}
