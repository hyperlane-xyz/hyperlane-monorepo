// ### QUERY BASE ###
export type ReqGetBalance = { address: string; denom: string };
export type ResGetBalance = bigint;

export type ReqGetTotalSupply = { denom: string };
export type ResGetTotalSupply = bigint;

export type ReqEstimateTransactionFee = { transaction: any };
export type ResEstimateTransactionFee = {
  gasUnits: bigint;
  gasPrice: number;
  fee: bigint;
};

// ### QUERY CORE ###

export type ReqGetMailbox = { mailbox_id: string };
export type ResGetMailbox = {
  address: string;
  owner: string;
  local_domain: number;
  nonce: number;
  default_ism: string;
  default_hook: string;
  required_hook: string;
};

export type ReqGetIsmType = { ism_id: string };
export type ResGetIsmType =
  | 'MESSAGE_ID_MULTISIG_ISM'
  | 'MERKLE_ROOT_MULTISIG_ISM'
  | 'ROUTING_ISM'
  | 'NOOP_ISM';

export type ReqMessageIdMultisigIsm = { ism_id: string };
export type ResMessageIdMultisigIsm = {
  address: string;
  threshold: number;
  validators: string[];
};

export type ReqMerkleRootMultisigIsm = { ism_id: string };
export type ResMerkleRootMultisigIsm = {
  address: string;
  threshold: number;
  validators: string[];
};

export type ReqRoutingIsm = { ism_id: string };
export type ResRoutingIsm = {
  address: string;
  owner: string;
  routes: {
    domain: number;
    ism: string;
  }[];
};

export type ReqGetHookType = { hook_id: string };
export type ResGetHookType = 'INTERCHAIN_GAS_PAYMASTER' | 'MERKLE_TREE_HOOK';

export type ReqGetInterchainGasPaymasterHook = { hook_id: string };
export type ResGetInterchainGasPaymasterHook = {
  address: string;
  owner: string;
  destination_gas_configs: {
    [domain_id: string]: {
      gas_oracle: {
        token_exchange_rate: string;
        gas_price: string;
      };
      gas_overhead: string;
    };
  };
};

export type ReqGetMerkleTreeHook = { hook_id: string };
export type ResGetMerkleTreeHook = {
  address: string;
};

// ### QUERY WARP ###

export type ReqGetToken = { token_id: string };
export type ResGetToken = {
  address: string;
  owner: string;
  token_type: 'COLLATERAL' | 'SYNTHETIC';
  mailbox: string;
  ism: string;
  origin_denom: string;
  name: string;
  symbol: string;
  description: string;
  divisibility: number;
};

export type ReqGetRemoteRouters = { token_id: string };
export type ResGetRemoteRouters = {
  address: string;
  remote_routers: {
    receiver_domain: string;
    receiver_contract: string;
    gas: string;
  }[];
};

export type ReqGetBridgedSupply = { token_id: string };
export type ResGetBridgedSupply = bigint;

export type ReqQuoteRemoteTransfer = {
  token_id: string;
  destination_domain: number;
};
export type ResQuoteRemoteTransfer = { denom: string; amount: bigint };

// ### POPULATE CORE ###

export type ReqCreateMailbox = { signer: string; domain_id: number };
export type ResCreateMailbox = { mailbox_id: string };

export type ReqSetDefaultIsm = {
  signer: string;
  mailbox_id: string;
  ism_id: string;
};
export type ResSetDefaultIsm = {
  ism_id: string;
};

export type ReqSetDefaultHook = {
  signer: string;
  mailbox_id: string;
  hook_id: string;
};
export type ResSetDefaultHook = {
  hook_id: string;
};

export type ReqSetRequiredHook = {
  signer: string;
  mailbox_id: string;
  hook_id: string;
};
export type ResSetRequiredHook = {
  hook_id: string;
};

export type ReqSetMailboxOwner = {
  signer: string;
  mailbox_id: string;
  new_owner: string;
};
export type ResSetMailboxOwner = {
  new_owner: string;
};

export type ReqCreateMerkleRootMultisigIsm = {
  signer: string;
  validators: string[];
  threshold: number;
};
export type ResCreateMerkleRootMultisigIsm = {
  ism_id: string;
};

export type ReqCreateMessageIdMultisigIsm = {
  signer: string;
  validators: string[];
  threshold: number;
};
export type ResCreateMessageIdMultisigIsm = {
  ism_id: string;
};

export type ReqCreateRoutingIsm = {
  signer: string;
  routes: { ism: string; domain_id: number }[];
};
export type ResCreateRoutingIsm = {
  ism_id: string;
};

export type ReqSetRoutingIsmRoute = {
  signer: string;
  ism_id: string;
  route: { domain_id: number; ism_id: string };
};
export type ResSetRoutingIsmRoute = {
  route: { domain_id: number; ism_id: string };
};

export type ReqRemoveRoutingIsmRoute = {
  signer: string;
  ism_id: string;
  domain_id: number;
};
export type ResRemoveRoutingIsmRoute = {
  domain_id: number;
};

export type ReqSetRoutingIsmOwner = {
  signer: string;
  ism_id: string;
  new_owner: string;
};
export type ResSetRoutingIsmOwner = {
  new_owner: string;
};

export type ReqCreateNoopIsm = {
  signer: string;
};
export type ResCreateNoopIsm = {
  ism_id: string;
};

export type ReqCreateMerkleTreeHook = { signer: string; mailbox_id: string };
export type ResCreateMerkleTreeHook = {
  hook_id: string;
};

export type ReqCreateInterchainGasPaymasterHook = {
  signer: string;
  denom: string;
};
export type ResCreateInterchainGasPaymasterHook = {
  hook_id: string;
};

export type ReqSetInterchainGasPaymasterHookOwner = {
  signer: string;
  hook_id: string;
  new_owner: string;
};
export type ResSetInterchainGasPaymasterHookOwner = {
  new_owner: string;
};

export type ReqSetDestinationGasConfig = {
  signer: string;
  hook_id: string;
  destination_gas_config: {
    remote_domain_id: number;
    gas_oracle: {
      token_exchange_rate: string;
      gas_price: string;
    };
    gas_overhead: string;
  };
};
export type ResSetDestinationGasConfig = {
  destination_gas_config: {
    remote_domain_id: number;
    gas_oracle: {
      token_exchange_rate: string;
      gas_price: string;
    };
    gas_overhead: string;
  };
};

export type ReqCreateValidatorAnnounce = {
  signer: string;
  mailbox_id: string;
};
export type ResCreateValidatorAnnounce = {
  validator_announce_id: string;
};

// ### POPULATE WARP ###

export type ReqCreateCollateralToken = {
  signer: string;
  mailbox_id: string;
  origin_denom: string;
};
export type ResCreateCollateralToken = {
  token_id: string;
};

export type ReqCreateSyntheticToken = {
  signer: string;
  mailbox_id: string;
  origin_denom: string;
};
export type ResCreateSyntheticToken = {
  token_id: string;
};

export type ReqSetTokenOwner = {
  signer: string;
  token_id: string;
  new_owner: string;
};
export type ResSetTokenOwner = {
  new_owner: string;
};

export type ReqSetTokenIsm = {
  signer: string;
  token_id: string;
  ism_id: string;
};
export type ResSetTokenIsm = {
  ism_id: string;
};

export type ReqEnrollRemoteRouter = {
  signer: string;
  token_id: string;
  receiver_domain_id: number;
  receiver_address: string;
  gas: string;
};
export type ResEnrollRemoteRouter = {
  receiver_domain_id: string;
};

export type ReqUnenrollRemoteRouter = {
  signer: string;
  token_id: string;
  receiver_domain_id: number;
};
export type ResUnenrollRemoteRouter = {
  receiver_domain_id: string;
};

export type ReqRemoteTransfer = {
  signer: string;
  token_id: string;
  destination_domain_id: number;
  recipient: string;
  amount: string;
  custom_hook_id: string;
  gas_limit: string;
  custom_hook_metadata: string;
  max_fee: { denom: string; amount: string };
};
export type ResRemoteTransfer = {
  token_id: string;
};

export interface IMultiVM {
  // ### QUERY BASE ###

  isHealthy(): Promise<boolean>;

  getBalance(req: ReqGetBalance): Promise<ResGetBalance>;

  getTotalSupply(req: ReqGetTotalSupply): Promise<ResGetTotalSupply>;

  estimateTransactionFee(
    req: ReqEstimateTransactionFee,
  ): Promise<ResEstimateTransactionFee>;

  // ### QUERY CORE ###

  getMailbox(req: ReqGetMailbox): Promise<ResGetMailbox>;

  getIsmType(req: ReqGetIsmType): Promise<ResGetIsmType>;

  getMessageIdMultisigIsm(
    req: ReqMessageIdMultisigIsm,
  ): Promise<ResMessageIdMultisigIsm>;

  getMerkleRootMultisigIsm(
    req: ReqMerkleRootMultisigIsm,
  ): Promise<ResMerkleRootMultisigIsm>;

  getRoutingIsm(req: ReqRoutingIsm): Promise<ResRoutingIsm>;

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

  populateCreateMailbox(req: ReqCreateMailbox): Promise<ResCreateMailbox>;

  populateSetDefaultIsm(req: ReqSetDefaultIsm): Promise<ResSetDefaultIsm>;

  populateSetDefaultHook(req: ReqSetDefaultHook): Promise<ResSetDefaultHook>;

  populateSetRequiredHook(req: ReqSetRequiredHook): Promise<ResSetRequiredHook>;

  populateSetMailboxOwner(req: ReqSetMailboxOwner): Promise<ResSetMailboxOwner>;

  populateCreateMerkleRootMultisigIsm(
    req: ReqCreateMerkleRootMultisigIsm,
  ): Promise<ResCreateMerkleRootMultisigIsm>;

  populateCreateMessageIdMultisigIsm(
    req: ReqCreateMessageIdMultisigIsm,
  ): Promise<ResCreateMessageIdMultisigIsm>;

  populateCreateRoutingIsm(
    req: ReqCreateRoutingIsm,
  ): Promise<ResCreateRoutingIsm>;

  populateSetRoutingIsmRoute(
    req: ReqSetRoutingIsmRoute,
  ): Promise<ResSetRoutingIsmRoute>;

  populateRemoveRoutingIsmRoute(
    req: ReqRemoveRoutingIsmRoute,
  ): Promise<ResRemoveRoutingIsmRoute>;

  populateSetRoutingIsmOwner(
    req: ResSetRoutingIsmOwner,
  ): Promise<ResSetRoutingIsmOwner>;

  populateCreateNoopIsm(req: ReqCreateNoopIsm): Promise<ResCreateNoopIsm>;

  populateCreateMerkleTreeHook(
    req: ReqCreateMerkleTreeHook,
  ): Promise<ResCreateMerkleTreeHook>;

  populateCreateInterchainGasPaymasterHook(
    req: ReqCreateInterchainGasPaymasterHook,
  ): Promise<ResCreateInterchainGasPaymasterHook>;

  populateSetInterchainGasPaymasterHookOwner(
    req: ReqSetInterchainGasPaymasterHookOwner,
  ): Promise<ResSetInterchainGasPaymasterHookOwner>;

  populateSetDestinationGasConfig(
    req: ReqSetDestinationGasConfig,
  ): Promise<ResSetDestinationGasConfig>;

  populateCreateValidatorAnnounce(
    req: ReqCreateValidatorAnnounce,
  ): Promise<ResCreateValidatorAnnounce>;

  // ### POPULATE WARP ###

  populateCreateCollateralToken(
    req: ReqCreateCollateralToken,
  ): Promise<ResCreateCollateralToken>;

  populateCreateSyntheticToken(
    req: ReqCreateSyntheticToken,
  ): Promise<ResCreateSyntheticToken>;

  populateSetTokenOwner(req: ReqSetTokenOwner): Promise<ResSetTokenOwner>;

  populateSetTokenIsm(req: ReqSetTokenIsm): Promise<ResSetTokenIsm>;

  populateEnrollRemoteRouter(
    req: ReqEnrollRemoteRouter,
  ): Promise<ResEnrollRemoteRouter>;

  populateUnenrollRemoteRouter(
    req: ReqUnenrollRemoteRouter,
  ): Promise<ResUnenrollRemoteRouter>;

  populateRemoteTransfer(req: ReqRemoteTransfer): Promise<ResRemoteTransfer>;
}

export interface IMultiSigningVM {
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
    req: Omit<ResSetRoutingIsmOwner, 'signer'>,
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
