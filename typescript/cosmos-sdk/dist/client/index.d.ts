import {
  AccountData,
  EncodeObject,
  OfflineSigner,
} from '@cosmjs/proto-signing';
import {
  BankExtension,
  DeliverTxResponse,
  HttpEndpoint,
  QueryClient,
  SigningStargateClient,
  SigningStargateClientOptions,
  StargateClient,
  StargateClientOptions,
  StdFee,
} from '@cosmjs/stargate';
import { CometClient } from '@cosmjs/tendermint-rpc';
import {
  MsgAnnounceValidator,
  MsgCreateMerkleRootMultisigIsm,
  MsgCreateMessageIdMultisigIsm,
  MsgCreateNoopIsm,
} from 'src/types/hyperlane/core/interchain_security/v1/tx';
import {
  MsgClaim,
  MsgCreateIgp,
  MsgCreateMerkleTreeHook,
  MsgCreateNoopHook,
  MsgPayForGas,
  MsgSetDestinationGasConfig,
  MsgSetIgpOwner,
} from 'src/types/hyperlane/core/post_dispatch/v1/tx';
import {
  MsgCreateMailbox,
  MsgProcessMessage,
  MsgSetMailbox,
} from 'src/types/hyperlane/core/v1/tx';
import {
  MsgCreateCollateralToken,
  MsgCreateSyntheticToken,
  MsgEnrollRemoteRouter,
  MsgRemoteTransfer,
  MsgSetToken,
  MsgUnrollRemoteRouter,
} from 'src/types/hyperlane/warp/v1/tx';

import { CoreExtension } from './hyperlane/core/query';
import { InterchainSecurityExtension } from './hyperlane/interchain_security/query';
import { PostDispatchExtension } from './hyperlane/post_dispatch/query';
import { WarpExtension } from './hyperlane/warp/query';

export type HyperlaneQueryClient = QueryClient &
  BankExtension &
  WarpExtension &
  CoreExtension &
  InterchainSecurityExtension &
  PostDispatchExtension;
export declare class HyperlaneModuleClient extends StargateClient {
  query: HyperlaneQueryClient;
  protected constructor(
    cometClient: CometClient,
    options: StargateClientOptions,
  );
  static connect(
    endpoint: string | HttpEndpoint,
    options?: StargateClientOptions,
  ): Promise<HyperlaneModuleClient>;
  simulate(
    signerAddress: string,
    messages: readonly EncodeObject[],
    memo: string | undefined,
  ): Promise<number>;
}
export declare class SigningHyperlaneModuleClient extends SigningStargateClient {
  query: HyperlaneQueryClient;
  protected account: AccountData;
  private readonly GAS_MULTIPLIER;
  protected constructor(
    cometClient: CometClient,
    signer: OfflineSigner,
    account: AccountData,
    options: SigningStargateClientOptions,
  );
  static connectWithSigner(
    endpoint: string | HttpEndpoint,
    signer: OfflineSigner,
    options?: SigningStargateClientOptions,
  ): Promise<SigningHyperlaneModuleClient>;
  private signTx;
  createMailbox(
    value: Omit<MsgCreateMailbox, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse>;
  setMailbox(
    value: Omit<MsgSetMailbox, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse>;
  processMessage(
    value: Omit<MsgProcessMessage, 'relayer'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse>;
  createMessageIdMultisigIsm(
    value: Omit<MsgCreateMessageIdMultisigIsm, 'creator'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse>;
  createMerklerootMultisigIsm(
    value: Omit<MsgCreateMerkleRootMultisigIsm, 'creator'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse>;
  createNoopIsm(
    value: Omit<MsgCreateNoopIsm, 'creator'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse>;
  announceValidator(
    value: Omit<MsgAnnounceValidator, 'creator'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse>;
  createIgp(
    value: Omit<MsgCreateIgp, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse>;
  setIgpOwner(
    value: Omit<MsgSetIgpOwner, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse>;
  setDestinationGasConfig(
    value: Omit<MsgSetDestinationGasConfig, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse>;
  payForGas(
    value: Omit<MsgPayForGas, 'sender'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse>;
  claim(
    value: Omit<MsgClaim, 'sender'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse>;
  createMerkleTreeHook(
    value: Omit<MsgCreateMerkleTreeHook, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse>;
  createNoopHook(
    value: Omit<MsgCreateNoopHook, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse>;
  createCollateralToken(
    value: Omit<MsgCreateCollateralToken, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse>;
  createSyntheticToken(
    value: Omit<MsgCreateSyntheticToken, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse>;
  setToken(
    value: Omit<MsgSetToken, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse>;
  enrollRemoteRouter(
    value: Omit<MsgEnrollRemoteRouter, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse>;
  unrollRemoteRouter(
    value: Omit<MsgUnrollRemoteRouter, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse>;
  remoteTransfer(
    value: Omit<MsgRemoteTransfer, 'sender'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse>;
}
