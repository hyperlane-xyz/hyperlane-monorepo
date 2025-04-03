import { Pubkey } from '@cosmjs/amino';
import { Uint53 } from '@cosmjs/math';
import {
  AccountData,
  EncodeObject,
  OfflineSigner,
  Registry,
} from '@cosmjs/proto-signing';
import {
  AminoTypes,
  BankExtension,
  DeliverTxResponse,
  HttpEndpoint,
  QueryClient,
  SigningStargateClient,
  SigningStargateClientOptions,
  StargateClient,
  StargateClientOptions,
  StdFee,
  assertIsDeliverTxSuccess,
  defaultRegistryTypes,
  setupBankExtension,
} from '@cosmjs/stargate';
import { CometClient, connectComet } from '@cosmjs/tendermint-rpc';

import { coreTx, isTx, pdTx, warpTx } from '@hyperlane-xyz/cosmos-types';

import {
  MsgCreateMailboxEncodeObject,
  MsgProcessMessageEncodeObject,
  MsgSetMailboxEncodeObject,
} from './hyperlane/core/messages.js';
import { CoreExtension, setupCoreExtension } from './hyperlane/core/query.js';
import {
  MsgAnnounceValidatorEncodeObject,
  MsgCreateMerkleRootMultisigIsmEncodeObject,
  MsgCreateMessageIdMultisigIsmEncodeObject,
  MsgCreateNoopIsmEncodeObject,
} from './hyperlane/interchain_security/messages.js';
import {
  InterchainSecurityExtension,
  setupInterchainSecurityExtension,
} from './hyperlane/interchain_security/query.js';
import {
  MsgClaimEncodeObject,
  MsgCreateIgpEncodeObject,
  MsgCreateMerkleTreeHookEncodeObject,
  MsgCreateNoopHookEncodeObject,
  MsgPayForGasEncodeObject,
  MsgSetDestinationGasConfigEncodeObject,
  MsgSetIgpOwnerEncodeObject,
} from './hyperlane/post_dispatch/messages.js';
import {
  PostDispatchExtension,
  setupPostDispatchExtension,
} from './hyperlane/post_dispatch/query.js';
import {
  MsgCreateCollateralTokenEncodeObject,
  MsgCreateSyntheticTokenEncodeObject,
  MsgEnrollRemoteRouterEncodeObject,
  MsgRemoteTransferEncodeObject,
  MsgSetTokenEncodeObject,
  MsgUnrollRemoteRouterEncodeObject,
} from './hyperlane/warp/messages.js';
import { WarpExtension, setupWarpExtension } from './hyperlane/warp/query.js';
import { REGISTRY } from './registry/index.js';

export * from './registry/index.js';

export * from './hyperlane/core/messages.js';
export * from './hyperlane/core/query.js';

export * from './hyperlane/interchain_security/messages.js';
export * from './hyperlane/interchain_security/query.js';

export * from './hyperlane/post_dispatch/messages.js';
export * from './hyperlane/post_dispatch/query.js';

export * from './hyperlane/warp/messages.js';
export * from './hyperlane/warp/query.js';

export type HyperlaneQueryClient = QueryClient &
  BankExtension &
  WarpExtension &
  CoreExtension &
  InterchainSecurityExtension &
  PostDispatchExtension;

export interface TxResponse<R> extends DeliverTxResponse {
  response: R;
}

export class HyperlaneModuleClient extends StargateClient {
  readonly query: HyperlaneQueryClient;
  public registry: Registry;

  protected constructor(
    cometClient: CometClient,
    options: StargateClientOptions,
  ) {
    super(cometClient, options);

    this.query = QueryClient.withExtensions(
      cometClient,
      setupBankExtension,
      setupCoreExtension,
      setupInterchainSecurityExtension,
      setupPostDispatchExtension,
      setupWarpExtension,
    );

    this.registry = new Registry([...defaultRegistryTypes]);

    // register all the custom tx types
    Object.values(REGISTRY).forEach(({ proto }) => {
      this.registry.register(proto.type, proto.converter);
    });
  }

  static async connect(
    endpoint: string | HttpEndpoint,
    options: StargateClientOptions = {},
  ): Promise<HyperlaneModuleClient> {
    const client = await connectComet(endpoint);
    return new HyperlaneModuleClient(client, options);
  }

  public async simulate(
    signerAddress: string,
    signerPubKey: Pubkey,
    messages: any[],
    memo: string | undefined,
  ): Promise<number> {
    const queryClient = this.getQueryClient()!;

    const { sequence } = await this.getSequence(signerAddress);
    const { gasInfo } = await queryClient.tx.simulate(
      messages,
      memo,
      signerPubKey,
      sequence,
    );
    return Uint53.fromString(gasInfo?.gasUsed.toString() ?? '0').toNumber();
  }
}

export class SigningHyperlaneModuleClient extends SigningStargateClient {
  public query: HyperlaneQueryClient;
  public account: AccountData;
  public readonly GAS_MULTIPLIER = 1.6;

  protected constructor(
    cometClient: CometClient,
    signer: OfflineSigner,
    account: AccountData,
    options: SigningStargateClientOptions,
  ) {
    // register all the custom amino tx types
    const aminoTypes = Object.values(REGISTRY)
      .filter((r) => !!r.amino.type) // filter out tx responses which have no amino type
      .reduce(
        (types, { proto, amino }) => ({
          ...types,
          [proto.type]: {
            aminoType: amino.type,
            toAmino: (amino.converter as any)?.toJSON ?? proto.converter.toJSON,
            fromAmino:
              (amino.converter as any)?.fromJSON ?? proto.converter.fromJSON,
          },
        }),
        {},
      );

    super(cometClient, signer, {
      ...options,
      aminoTypes: new AminoTypes({
        ...options.aminoTypes,
        ...aminoTypes,
      }),
    });

    this.query = QueryClient.withExtensions(
      cometClient,
      setupBankExtension,
      setupCoreExtension,
      setupInterchainSecurityExtension,
      setupPostDispatchExtension,
      setupWarpExtension,
    );

    // register all the custom tx types
    Object.values(REGISTRY).forEach(({ proto }) => {
      this.registry.register(proto.type, proto.converter);
    });

    this.account = account;
  }

  static async connectWithSigner(
    endpoint: string | HttpEndpoint,
    signer: OfflineSigner,
    options: SigningStargateClientOptions = {},
  ): Promise<SigningHyperlaneModuleClient> {
    const client = await connectComet(endpoint);
    const [account] = await signer.getAccounts();
    return new SigningHyperlaneModuleClient(client, signer, account, options);
  }

  static async createWithSigner(
    cometclient: CometClient,
    signer: OfflineSigner,
    options: SigningStargateClientOptions = {},
  ): Promise<SigningHyperlaneModuleClient> {
    const [account] = await signer.getAccounts();
    return new SigningHyperlaneModuleClient(
      cometclient,
      signer,
      account,
      options,
    );
  }

  private async submitTx<T>(
    msg: EncodeObject,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<TxResponse<T>> {
    const result = await this.signAndBroadcast(
      this.account.address,
      [msg],
      options?.fee ?? this.GAS_MULTIPLIER,
      options?.memo,
    );
    assertIsDeliverTxSuccess(result);

    return {
      ...result,
      response: this.registry.decode(result.msgResponses[0]),
    };
  }

  public async createMailbox(
    value: Omit<coreTx.MsgCreateMailbox, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<TxResponse<coreTx.MsgCreateMailboxResponse>> {
    const msg: MsgCreateMailboxEncodeObject = {
      typeUrl: REGISTRY.MsgCreateMailbox.proto.type,
      value: REGISTRY.MsgCreateMailbox.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async setMailbox(
    value: Omit<coreTx.MsgSetMailbox, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<TxResponse<coreTx.MsgSetMailboxResponse>> {
    const msg: MsgSetMailboxEncodeObject = {
      typeUrl: REGISTRY.MsgSetMailbox.proto.type,
      value: REGISTRY.MsgSetMailbox.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async processMessage(
    value: Omit<coreTx.MsgProcessMessage, 'relayer'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<TxResponse<coreTx.MsgProcessMessageResponse>> {
    const msg: MsgProcessMessageEncodeObject = {
      typeUrl: REGISTRY.MsgProcessMessage.proto.type,
      value: REGISTRY.MsgProcessMessage.proto.converter.create({
        ...value,
        relayer: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async createMessageIdMultisigIsm(
    value: Omit<isTx.MsgCreateMessageIdMultisigIsm, 'creator'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<TxResponse<isTx.MsgCreateMessageIdMultisigIsmResponse>> {
    const msg: MsgCreateMessageIdMultisigIsmEncodeObject = {
      typeUrl: REGISTRY.MsgCreateMessageIdMultisigIsm.proto.type,
      value: REGISTRY.MsgCreateMessageIdMultisigIsm.proto.converter.create({
        ...value,
        creator: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async createMerklerootMultisigIsm(
    value: Omit<isTx.MsgCreateMerkleRootMultisigIsm, 'creator'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<TxResponse<isTx.MsgCreateMerkleRootMultisigIsmResponse>> {
    const msg: MsgCreateMerkleRootMultisigIsmEncodeObject = {
      typeUrl: REGISTRY.MsgCreateMerkleRootMultisigIsm.proto.type,
      value: REGISTRY.MsgCreateMerkleRootMultisigIsm.proto.converter.create({
        ...value,
        creator: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async createNoopIsm(
    value: Omit<isTx.MsgCreateNoopIsm, 'creator'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<TxResponse<isTx.MsgCreateNoopIsmResponse>> {
    const msg: MsgCreateNoopIsmEncodeObject = {
      typeUrl: REGISTRY.MsgCreateNoopIsm.proto.type,
      value: REGISTRY.MsgCreateNoopIsm.proto.converter.create({
        ...value,
        creator: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async announceValidator(
    value: Omit<isTx.MsgAnnounceValidator, 'creator'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<TxResponse<isTx.MsgAnnounceValidatorResponse>> {
    const msg: MsgAnnounceValidatorEncodeObject = {
      typeUrl: REGISTRY.MsgAnnounceValidator.proto.type,
      value: REGISTRY.MsgAnnounceValidator.proto.converter.create({
        ...value,
        creator: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async createIgp(
    value: Omit<pdTx.MsgCreateIgp, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<TxResponse<pdTx.MsgCreateIgpResponse>> {
    const msg: MsgCreateIgpEncodeObject = {
      typeUrl: REGISTRY.MsgCreateIgp.proto.type,
      value: REGISTRY.MsgCreateIgp.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async setIgpOwner(
    value: Omit<pdTx.MsgSetIgpOwner, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<TxResponse<pdTx.MsgSetIgpOwnerResponse>> {
    const msg: MsgSetIgpOwnerEncodeObject = {
      typeUrl: REGISTRY.MsgSetIgpOwner.proto.type,
      value: REGISTRY.MsgSetIgpOwner.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async setDestinationGasConfig(
    value: Omit<pdTx.MsgSetDestinationGasConfig, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<TxResponse<pdTx.MsgSetDestinationGasConfigResponse>> {
    const msg: MsgSetDestinationGasConfigEncodeObject = {
      typeUrl: REGISTRY.MsgSetDestinationGasConfig.proto.type,
      value: REGISTRY.MsgSetDestinationGasConfig.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async payForGas(
    value: Omit<pdTx.MsgPayForGas, 'sender'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<TxResponse<pdTx.MsgPayForGasResponse>> {
    const msg: MsgPayForGasEncodeObject = {
      typeUrl: REGISTRY.MsgPayForGas.proto.type,
      value: REGISTRY.MsgPayForGas.proto.converter.create({
        ...value,
        sender: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async claim(
    value: Omit<pdTx.MsgClaim, 'sender'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<TxResponse<pdTx.MsgClaimResponse>> {
    const msg: MsgClaimEncodeObject = {
      typeUrl: REGISTRY.MsgClaim.proto.type,
      value: REGISTRY.MsgClaim.proto.converter.create({
        ...value,
        sender: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async createMerkleTreeHook(
    value: Omit<pdTx.MsgCreateMerkleTreeHook, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<TxResponse<pdTx.MsgCreateMerkleTreeHookResponse>> {
    const msg: MsgCreateMerkleTreeHookEncodeObject = {
      typeUrl: REGISTRY.MsgCreateMerkleTreeHook.proto.type,
      value: REGISTRY.MsgCreateMerkleTreeHook.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async createNoopHook(
    value: Omit<pdTx.MsgCreateNoopHook, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<TxResponse<pdTx.MsgCreateNoopHookResponse>> {
    const msg: MsgCreateNoopHookEncodeObject = {
      typeUrl: REGISTRY.MsgCreateNoopHook.proto.type,
      value: REGISTRY.MsgCreateNoopHook.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async createCollateralToken(
    value: Omit<warpTx.MsgCreateCollateralToken, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<TxResponse<warpTx.MsgCreateCollateralTokenResponse>> {
    const msg: MsgCreateCollateralTokenEncodeObject = {
      typeUrl: REGISTRY.MsgCreateCollateralToken.proto.type,
      value: REGISTRY.MsgCreateCollateralToken.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async createSyntheticToken(
    value: Omit<warpTx.MsgCreateSyntheticToken, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<TxResponse<warpTx.MsgCreateSyntheticTokenResponse>> {
    const msg: MsgCreateSyntheticTokenEncodeObject = {
      typeUrl: REGISTRY.MsgCreateSyntheticToken.proto.type,
      value: REGISTRY.MsgCreateSyntheticToken.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async setToken(
    value: Omit<warpTx.MsgSetToken, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<TxResponse<warpTx.MsgSetTokenResponse>> {
    const msg: MsgSetTokenEncodeObject = {
      typeUrl: REGISTRY.MsgSetToken.proto.type,
      value: REGISTRY.MsgSetToken.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async enrollRemoteRouter(
    value: Omit<warpTx.MsgEnrollRemoteRouter, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<TxResponse<warpTx.MsgEnrollRemoteRouterResponse>> {
    const msg: MsgEnrollRemoteRouterEncodeObject = {
      typeUrl: REGISTRY.MsgEnrollRemoteRouter.proto.type,
      value: REGISTRY.MsgEnrollRemoteRouter.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async unrollRemoteRouter(
    value: Omit<warpTx.MsgUnrollRemoteRouter, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<TxResponse<warpTx.MsgUnrollRemoteRouterResponse>> {
    const msg: MsgUnrollRemoteRouterEncodeObject = {
      typeUrl: REGISTRY.MsgUnrollRemoteRouter.proto.type,
      value: REGISTRY.MsgUnrollRemoteRouter.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async remoteTransfer(
    value: Omit<warpTx.MsgRemoteTransfer, 'sender'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<TxResponse<warpTx.MsgRemoteTransferResponse>> {
    const msg: MsgRemoteTransferEncodeObject = {
      typeUrl: REGISTRY.MsgRemoteTransfer.proto.type,
      value: REGISTRY.MsgRemoteTransfer.proto.converter.create({
        ...value,
        sender: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }
}
