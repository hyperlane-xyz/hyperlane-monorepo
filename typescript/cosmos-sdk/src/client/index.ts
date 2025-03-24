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

import {
  MsgAnnounceValidator,
  MsgCreateMerkleRootMultisigIsm,
  MsgCreateMessageIdMultisigIsm,
  MsgCreateNoopIsm,
} from '../types/hyperlane/core/interchain_security/v1/tx.js';
import {
  MsgClaim,
  MsgCreateIgp,
  MsgCreateMerkleTreeHook,
  MsgCreateNoopHook,
  MsgPayForGas,
  MsgSetDestinationGasConfig,
  MsgSetIgpOwner,
} from '../types/hyperlane/core/post_dispatch/v1/tx.js';
import {
  MsgCreateMailbox,
  MsgProcessMessage,
  MsgSetMailbox,
} from '../types/hyperlane/core/v1/tx.js';
import {
  MsgCreateCollateralToken,
  MsgCreateSyntheticToken,
  MsgEnrollRemoteRouter,
  MsgRemoteTransfer,
  MsgSetToken,
  MsgUnrollRemoteRouter,
} from '../types/hyperlane/warp/v1/tx.js';

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

export type HyperlaneQueryClient = QueryClient &
  BankExtension &
  WarpExtension &
  CoreExtension &
  InterchainSecurityExtension &
  PostDispatchExtension;

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
  protected account: AccountData;
  private readonly GAS_MULTIPLIER = 1.6;

  protected constructor(
    cometClient: CometClient,
    signer: OfflineSigner,
    account: AccountData,
    options: SigningStargateClientOptions,
  ) {
    // register all the custom amino tx types
    const aminoTypes = Object.values(REGISTRY).reduce(
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

  private async signTx(
    msg: EncodeObject,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ) {
    const result = await this.signAndBroadcast(
      this.account.address,
      [msg],
      options?.fee ?? this.GAS_MULTIPLIER,
      options?.memo,
    );
    assertIsDeliverTxSuccess(result);

    return result;
  }

  public async createMailbox(
    value: Omit<MsgCreateMailbox, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse> {
    const msg: MsgCreateMailboxEncodeObject = {
      typeUrl: REGISTRY.MsgCreateMailbox.proto.type,
      value: REGISTRY.MsgCreateMailbox.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.signTx(msg, options);
  }

  public async setMailbox(
    value: Omit<MsgSetMailbox, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse> {
    const msg: MsgSetMailboxEncodeObject = {
      typeUrl: REGISTRY.MsgSetMailbox.proto.type,
      value: REGISTRY.MsgSetMailbox.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.signTx(msg, options);
  }

  public async processMessage(
    value: Omit<MsgProcessMessage, 'relayer'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse> {
    const msg: MsgProcessMessageEncodeObject = {
      typeUrl: REGISTRY.MsgProcessMessage.proto.type,
      value: REGISTRY.MsgProcessMessage.proto.converter.create({
        ...value,
        relayer: this.account.address,
      }),
    };

    return this.signTx(msg, options);
  }

  public async createMessageIdMultisigIsm(
    value: Omit<MsgCreateMessageIdMultisigIsm, 'creator'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse> {
    const msg: MsgCreateMessageIdMultisigIsmEncodeObject = {
      typeUrl: REGISTRY.MsgCreateMessageIdMultisigIsm.proto.type,
      value: REGISTRY.MsgCreateMessageIdMultisigIsm.proto.converter.create({
        ...value,
        creator: this.account.address,
      }),
    };

    return this.signTx(msg, options);
  }

  public async createMerklerootMultisigIsm(
    value: Omit<MsgCreateMerkleRootMultisigIsm, 'creator'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse> {
    const msg: MsgCreateMerkleRootMultisigIsmEncodeObject = {
      typeUrl: REGISTRY.MsgCreateMerkleRootMultisigIsm.proto.type,
      value: REGISTRY.MsgCreateMerkleRootMultisigIsm.proto.converter.create({
        ...value,
        creator: this.account.address,
      }),
    };

    return this.signTx(msg, options);
  }

  public async createNoopIsm(
    value: Omit<MsgCreateNoopIsm, 'creator'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse> {
    const msg: MsgCreateNoopIsmEncodeObject = {
      typeUrl: REGISTRY.MsgCreateNoopIsm.proto.type,
      value: REGISTRY.MsgCreateNoopIsm.proto.converter.create({
        ...value,
        creator: this.account.address,
      }),
    };

    return this.signTx(msg, options);
  }

  public async announceValidator(
    value: Omit<MsgAnnounceValidator, 'creator'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse> {
    const msg: MsgAnnounceValidatorEncodeObject = {
      typeUrl: REGISTRY.MsgAnnounceValidator.proto.type,
      value: REGISTRY.MsgAnnounceValidator.proto.converter.create({
        ...value,
        creator: this.account.address,
      }),
    };

    return this.signTx(msg, options);
  }

  public async createIgp(
    value: Omit<MsgCreateIgp, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse> {
    const msg: MsgCreateIgpEncodeObject = {
      typeUrl: REGISTRY.MsgCreateIgp.proto.type,
      value: REGISTRY.MsgCreateIgp.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.signTx(msg, options);
  }

  public async setIgpOwner(
    value: Omit<MsgSetIgpOwner, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse> {
    const msg: MsgSetIgpOwnerEncodeObject = {
      typeUrl: REGISTRY.MsgSetIgpOwner.proto.type,
      value: REGISTRY.MsgSetIgpOwner.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.signTx(msg, options);
  }

  public async setDestinationGasConfig(
    value: Omit<MsgSetDestinationGasConfig, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse> {
    const msg: MsgSetDestinationGasConfigEncodeObject = {
      typeUrl: REGISTRY.MsgSetDestinationGasConfig.proto.type,
      value: REGISTRY.MsgSetDestinationGasConfig.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.signTx(msg, options);
  }

  public async payForGas(
    value: Omit<MsgPayForGas, 'sender'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse> {
    const msg: MsgPayForGasEncodeObject = {
      typeUrl: REGISTRY.MsgPayForGas.proto.type,
      value: REGISTRY.MsgPayForGas.proto.converter.create({
        ...value,
        sender: this.account.address,
      }),
    };

    return this.signTx(msg, options);
  }

  public async claim(
    value: Omit<MsgClaim, 'sender'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse> {
    const msg: MsgClaimEncodeObject = {
      typeUrl: REGISTRY.MsgClaim.proto.type,
      value: REGISTRY.MsgClaim.proto.converter.create({
        ...value,
        sender: this.account.address,
      }),
    };

    return this.signTx(msg, options);
  }

  public async createMerkleTreeHook(
    value: Omit<MsgCreateMerkleTreeHook, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse> {
    const msg: MsgCreateMerkleTreeHookEncodeObject = {
      typeUrl: REGISTRY.MsgCreateMerkleTreeHook.proto.type,
      value: REGISTRY.MsgCreateMerkleTreeHook.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.signTx(msg, options);
  }

  public async createNoopHook(
    value: Omit<MsgCreateNoopHook, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse> {
    const msg: MsgCreateNoopHookEncodeObject = {
      typeUrl: REGISTRY.MsgCreateNoopHook.proto.type,
      value: REGISTRY.MsgCreateNoopHook.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.signTx(msg, options);
  }

  public async createCollateralToken(
    value: Omit<MsgCreateCollateralToken, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse> {
    const msg: MsgCreateCollateralTokenEncodeObject = {
      typeUrl: REGISTRY.MsgCreateCollateralToken.proto.type,
      value: REGISTRY.MsgCreateCollateralToken.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.signTx(msg, options);
  }

  public async createSyntheticToken(
    value: Omit<MsgCreateSyntheticToken, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse> {
    const msg: MsgCreateSyntheticTokenEncodeObject = {
      typeUrl: REGISTRY.MsgCreateSyntheticToken.proto.type,
      value: REGISTRY.MsgCreateSyntheticToken.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.signTx(msg, options);
  }

  public async setToken(
    value: Omit<MsgSetToken, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse> {
    const msg: MsgSetTokenEncodeObject = {
      typeUrl: REGISTRY.MsgSetToken.proto.type,
      value: REGISTRY.MsgSetToken.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.signTx(msg, options);
  }

  public async enrollRemoteRouter(
    value: Omit<MsgEnrollRemoteRouter, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse> {
    const msg: MsgEnrollRemoteRouterEncodeObject = {
      typeUrl: REGISTRY.MsgEnrollRemoteRouter.proto.type,
      value: REGISTRY.MsgEnrollRemoteRouter.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.signTx(msg, options);
  }

  public async unrollRemoteRouter(
    value: Omit<MsgUnrollRemoteRouter, 'owner'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse> {
    const msg: MsgUnrollRemoteRouterEncodeObject = {
      typeUrl: REGISTRY.MsgUnrollRemoteRouter.proto.type,
      value: REGISTRY.MsgUnrollRemoteRouter.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.signTx(msg, options);
  }

  public async remoteTransfer(
    value: Omit<MsgRemoteTransfer, 'sender'>,
    options?: {
      fee?: StdFee | 'auto' | number;
      memo?: string;
    },
  ): Promise<DeliverTxResponse> {
    const msg: MsgRemoteTransferEncodeObject = {
      typeUrl: REGISTRY.MsgRemoteTransfer.proto.type,
      value: REGISTRY.MsgRemoteTransfer.proto.converter.create({
        ...value,
        sender: this.account.address,
      }),
    };

    return this.signTx(msg, options);
  }
}
