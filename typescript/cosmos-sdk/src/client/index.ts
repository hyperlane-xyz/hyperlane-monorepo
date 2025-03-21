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

import { createCoreAminoConverter } from './hyperlane/core/aminomessages.js';
import {
  MsgCreateMailboxEncodeObject,
  MsgProcessMessageEncodeObject,
  MsgSetMailboxEncodeObject,
} from './hyperlane/core/messages.js';
import { CoreExtension, setupCoreExtension } from './hyperlane/core/query.js';
import { createInterchainSecurityAminoConverter } from './hyperlane/interchain_security/aminomessages.js';
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
import { createPostDispatchAminoConverter } from './hyperlane/post_dispatch/aminomessages.js';
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
import { createWarpAminoConverter } from './hyperlane/warp/aminomessages.js';
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
    for (const typeUrl in REGISTRY) {
      if (REGISTRY[typeUrl]) {
        this.registry.register(typeUrl, REGISTRY[typeUrl]);
      }
    }
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
    super(cometClient, signer, {
      ...options,
      aminoTypes: new AminoTypes({
        ...options.aminoTypes,
        ...createCoreAminoConverter(),
        ...createInterchainSecurityAminoConverter(),
        ...createPostDispatchAminoConverter(),
        ...createWarpAminoConverter(),
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
    for (const typeUrl in REGISTRY) {
      if (REGISTRY[typeUrl]) {
        this.registry.register(typeUrl, REGISTRY[typeUrl]);
      }
    }

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
      typeUrl: '/hyperlane.core.v1.MsgCreateMailbox',
      value: {
        owner: this.account.address,
        ...value,
      },
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
      typeUrl: '/hyperlane.core.v1.MsgSetMailbox',
      value: {
        owner: this.account.address,
        ...value,
      },
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
      typeUrl: '/hyperlane.core.v1.MsgProcessMessage',
      value: {
        relayer: this.account.address,
        ...value,
      },
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
      typeUrl: '/hyperlane.core.v1.MsgCreateMessageIdMultisigIsm',
      value: {
        creator: this.account.address,
        ...value,
      },
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
      typeUrl: '/hyperlane.core.v1.MsgCreateMerkleRootMultisigIsm',
      value: {
        creator: this.account.address,
        ...value,
      },
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
      typeUrl: '/hyperlane.core.v1.MsgCreateNoopIsm',
      value: {
        creator: this.account.address,
        ...value,
      },
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
      typeUrl: '/hyperlane.core.v1.MsgAnnounceValidator',
      value: {
        creator: this.account.address,
        ...value,
      },
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
      typeUrl: '/hyperlane.core.v1.MsgCreateIgp',
      value: {
        owner: this.account.address,
        ...value,
      },
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
      typeUrl: '/hyperlane.core.v1.MsgSetIgpOwner',
      value: {
        owner: this.account.address,
        ...value,
      },
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
      typeUrl: '/hyperlane.core.v1.MsgSetDestinationGasConfig',
      value: {
        owner: this.account.address,
        ...value,
      },
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
      typeUrl: '/hyperlane.core.v1.MsgPayForGas',
      value: {
        sender: this.account.address,
        ...value,
      },
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
      typeUrl: '/hyperlane.core.v1.MsgClaim',
      value: {
        sender: this.account.address,
        ...value,
      },
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
      typeUrl: '/hyperlane.core.v1.MsgCreateMerkleTreeHook',
      value: {
        owner: this.account.address,
        ...value,
      },
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
      typeUrl: '/hyperlane.core.v1.MsgCreateNoopHook',
      value: {
        owner: this.account.address,
        ...value,
      },
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
      typeUrl: '/hyperlane.warp.v1.MsgCreateCollateralToken',
      value: {
        owner: this.account.address,
        ...value,
      },
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
      typeUrl: '/hyperlane.warp.v1.MsgCreateSyntheticToken',
      value: {
        owner: this.account.address,
        ...value,
      },
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
      typeUrl: '/hyperlane.warp.v1.MsgSetToken',
      value: {
        owner: this.account.address,
        ...value,
      },
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
      typeUrl: '/hyperlane.warp.v1.MsgEnrollRemoteRouter',
      value: {
        owner: this.account.address,
        ...value,
      },
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
      typeUrl: '/hyperlane.warp.v1.MsgUnrollRemoteRouter',
      value: {
        owner: this.account.address,
        ...value,
      },
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
      typeUrl: '/hyperlane.warp.v1.MsgRemoteTransfer',
      value: {
        sender: this.account.address,
        ...value,
      },
    };

    return this.signTx(msg, options);
  }
}
