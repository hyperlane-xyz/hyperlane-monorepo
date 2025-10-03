import {
  AccountData,
  DirectSecp256k1HdWallet,
  DirectSecp256k1Wallet,
  EncodeObject,
  OfflineSigner,
} from '@cosmjs/proto-signing';
import {
  AminoTypes,
  DeliverTxResponse,
  GasPrice,
  SigningStargateClient,
  StdFee,
  assertIsDeliverTxSuccess,
} from '@cosmjs/stargate';
import { CometClient, connectComet } from '@cosmjs/tendermint-rpc';

import { AltVM, assert } from '@hyperlane-xyz/utils';

import { COSMOS_MODULE_MESSAGE_REGISTRY as R } from '../registry.js';

import { CosmosNativeProvider } from './provider.js';

type TxOptions = {
  fee: StdFee | 'auto' | number;
  memo?: string;
};

export class CosmosNativeSigner
  extends CosmosNativeProvider
  implements AltVM.ISigner<EncodeObject, DeliverTxResponse>
{
  private readonly signer: SigningStargateClient;
  private readonly account: AccountData;
  private readonly options: TxOptions;

  static async connectWithSigner(
    rpcUrl: string,
    privateKey: string | OfflineSigner,
    extraParams?: Record<string, any>,
  ): Promise<AltVM.ISigner<EncodeObject>> {
    assert(extraParams, `extra params not defined`);
    assert(extraParams.gasPrice, `gasPrice not defined in extra params`);

    let wallet: OfflineSigner;

    if (typeof privateKey === 'string') {
      assert(
        extraParams.bech32Prefix,
        `bech32Prefix not defined in extra params`,
      );

      const isPrivateKey = new RegExp(/(^|\b)(0x)?[0-9a-fA-F]{64}(\b|$)/).test(
        privateKey,
      );

      if (isPrivateKey) {
        wallet = await DirectSecp256k1Wallet.fromKey(
          new Uint8Array(Buffer.from(privateKey, 'hex')),
          extraParams.bech32Prefix,
        );
      } else {
        wallet = await DirectSecp256k1HdWallet.fromMnemonic(privateKey, {
          prefix: extraParams.bech32Prefix,
        });
      }
    } else {
      wallet = privateKey;
    }

    // register all the custom amino tx types
    const aminoTypes = Object.values(R)
      .filter((r) => !!r.amino?.type) // filter out tx responses which have no amino type
      .reduce(
        (types, { proto, amino }) => ({
          ...types,
          [proto.type]: {
            aminoType: amino?.type,
            toAmino: amino?.converter?.toJSON ?? proto.converter.toJSON,
            fromAmino: amino?.converter?.fromJSON ?? proto.converter.fromJSON,
          },
        }),
        {},
      );

    const signer = await SigningStargateClient.connectWithSigner(
      rpcUrl,
      wallet,
      {
        aminoTypes: new AminoTypes({
          ...aminoTypes,
        }),
        gasPrice: GasPrice.fromString(extraParams.gasPrice),
      },
    );

    // register all the custom tx types
    Object.values(R).forEach(({ proto }) => {
      signer.registry.register(proto.type, proto.converter);
    });

    const cometClient = await connectComet(rpcUrl);
    const account = await wallet.getAccounts();

    return new CosmosNativeSigner(cometClient, signer, account[0], rpcUrl, {
      fee: 2,
      memo: '',
    });
  }

  protected constructor(
    cometClient: CometClient,
    signer: SigningStargateClient,
    account: AccountData,
    rpcUrl: string,
    options: TxOptions,
  ) {
    super(cometClient, rpcUrl);
    this.signer = signer;
    this.account = account;
    this.options = options;
  }

  private getProtoConverter(typeUrl: string) {
    for (const { proto } of Object.values(R)) {
      if (typeUrl === proto.type) {
        return proto.converter;
      }
    }

    throw new Error(`found no proto converter for type ${typeUrl}`);
  }

  private async submitTx(msg: EncodeObject): Promise<any> {
    const receipt = await this.signer.signAndBroadcast(
      this.account.address,
      [msg],
      this.options.fee,
      this.options.memo,
    );
    assertIsDeliverTxSuccess(receipt);

    const msgResponse = receipt.msgResponses[0];
    return this.getProtoConverter(msgResponse.typeUrl).decode(
      msgResponse.value,
    );
  }

  getSignerAddress(): string {
    return this.account.address;
  }

  async signAndBroadcast(
    transactions: EncodeObject[],
  ): Promise<DeliverTxResponse> {
    const receipt = await this.signer.signAndBroadcast(
      this.account.address,
      transactions,
      this.options.fee,
      this.options.memo,
    );
    assertIsDeliverTxSuccess(receipt);

    return receipt;
  }

  // ### TX CORE ###

  async createMailbox(
    req: Omit<AltVM.ReqCreateMailbox, 'signer'>,
  ): Promise<AltVM.ResCreateMailbox> {
    const msg = await this.populateCreateMailbox({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      mailboxId: result.id,
    };
  }

  async setDefaultIsm(
    req: Omit<AltVM.ReqSetDefaultIsm, 'signer'>,
  ): Promise<AltVM.ResSetDefaultIsm> {
    const msg = await this.populateSetDefaultIsm({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      ismId: req.ismId,
    };
  }

  async setDefaultHook(
    req: Omit<AltVM.ReqSetDefaultHook, 'signer'>,
  ): Promise<AltVM.ResSetDefaultHook> {
    const msg = await this.populateSetDefaultHook({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      hookId: req.hookId,
    };
  }

  async setRequiredHook(
    req: Omit<AltVM.ReqSetRequiredHook, 'signer'>,
  ): Promise<AltVM.ResSetRequiredHook> {
    const msg = await this.populateSetRequiredHook({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      hookId: req.hookId,
    };
  }

  async setMailboxOwner(
    req: Omit<AltVM.ReqSetMailboxOwner, 'signer'>,
  ): Promise<AltVM.ResSetMailboxOwner> {
    const msg = await this.populateSetMailboxOwner({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      newOwner: req.newOwner,
    };
  }

  async createMerkleRootMultisigIsm(
    req: Omit<AltVM.ReqCreateMerkleRootMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleRootMultisigIsm> {
    const msg = await this.populateCreateMerkleRootMultisigIsm({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      ismId: result.id,
    };
  }

  async createMessageIdMultisigIsm(
    req: Omit<AltVM.ReqCreateMessageIdMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMessageIdMultisigIsm> {
    const msg = await this.populateCreateMessageIdMultisigIsm({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      ismId: result.id,
    };
  }

  async createRoutingIsm(
    req: Omit<AltVM.ReqCreateRoutingIsm, 'signer'>,
  ): Promise<AltVM.ResCreateRoutingIsm> {
    const msg = await this.populateCreateRoutingIsm({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      ismId: result.id,
    };
  }

  async setRoutingIsmRoute(
    req: Omit<AltVM.ReqSetRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmRoute> {
    const msg = await this.populateSetRoutingIsmRoute({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      route: req.route,
    };
  }

  async removeRoutingIsmRoute(
    req: Omit<AltVM.ReqRemoveRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResRemoveRoutingIsmRoute> {
    const msg = await this.populateRemoveRoutingIsmRoute({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      domainId: req.domainId,
    };
  }

  async setRoutingIsmOwner(
    req: Omit<AltVM.ReqSetRoutingIsmOwner, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmOwner> {
    const msg = await this.populateSetRoutingIsmOwner({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      newOwner: req.newOwner,
    };
  }

  async createNoopIsm(
    req: Omit<AltVM.ReqCreateNoopIsm, 'signer'>,
  ): Promise<AltVM.ResCreateNoopIsm> {
    const msg = await this.populateCreateNoopIsm({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      ismId: result.id,
    };
  }

  async createMerkleTreeHook(
    req: Omit<AltVM.ReqCreateMerkleTreeHook, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleTreeHook> {
    const msg = await this.populateCreateMerkleTreeHook({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      hookId: result.id,
    };
  }

  async createInterchainGasPaymasterHook(
    req: Omit<AltVM.ReqCreateInterchainGasPaymasterHook, 'signer'>,
  ): Promise<AltVM.ResCreateInterchainGasPaymasterHook> {
    const msg = await this.populateCreateInterchainGasPaymasterHook({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      hookId: result.id,
    };
  }

  async setInterchainGasPaymasterHookOwner(
    req: Omit<AltVM.ReqSetInterchainGasPaymasterHookOwner, 'signer'>,
  ): Promise<AltVM.ResSetInterchainGasPaymasterHookOwner> {
    const msg = await this.populateSetInterchainGasPaymasterHookOwner({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      newOwner: req.newOwner,
    };
  }

  async setDestinationGasConfig(
    req: Omit<AltVM.ReqSetDestinationGasConfig, 'signer'>,
  ): Promise<AltVM.ResSetDestinationGasConfig> {
    const msg = await this.populateSetDestinationGasConfig({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      destinationGasConfig: req.destinationGasConfig,
    };
  }

  async createValidatorAnnounce(
    _req: Omit<AltVM.ReqCreateValidatorAnnounce, 'signer'>,
  ): Promise<AltVM.ResCreateValidatorAnnounce> {
    // Cosmos Native has no validator announce
    return { validatorAnnounceId: '' };
  }

  // ### TX WARP ###

  async createCollateralToken(
    req: Omit<AltVM.ReqCreateCollateralToken, 'signer'>,
  ): Promise<AltVM.ResCreateCollateralToken> {
    const msg = await this.populateCreateCollateralToken({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      tokenId: result.id,
    };
  }

  async createSyntheticToken(
    req: Omit<AltVM.ReqCreateSyntheticToken, 'signer'>,
  ): Promise<AltVM.ResCreateSyntheticToken> {
    const msg = await this.populateCreateSyntheticToken({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      tokenId: result.id,
    };
  }

  async setTokenOwner(
    req: Omit<AltVM.ReqSetTokenOwner, 'signer'>,
  ): Promise<AltVM.ResSetTokenOwner> {
    const msg = await this.populateSetTokenOwner({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      newOwner: req.newOwner,
    };
  }

  async setTokenIsm(
    req: Omit<AltVM.ReqSetTokenIsm, 'signer'>,
  ): Promise<AltVM.ResSetTokenIsm> {
    const msg = await this.populateSetTokenIsm({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      ismId: req.ismId,
    };
  }

  async enrollRemoteRouter(
    req: Omit<AltVM.ReqEnrollRemoteRouter, 'signer'>,
  ): Promise<AltVM.ResEnrollRemoteRouter> {
    const msg = await this.populateEnrollRemoteRouter({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      receiverDomainId: req.remoteRouter.receiverDomainId,
    };
  }

  async unenrollRemoteRouter(
    req: Omit<AltVM.ReqUnenrollRemoteRouter, 'signer'>,
  ): Promise<AltVM.ResUnenrollRemoteRouter> {
    const msg = await this.populateUnenrollRemoteRouter({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      receiverDomainId: req.receiverDomainId,
    };
  }

  async remoteTransfer(
    req: Omit<AltVM.ReqRemoteTransfer, 'signer'>,
  ): Promise<AltVM.ResRemoteTransfer> {
    const msg = await this.populateRemoteTransfer({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      messageId: result.message_id,
    };
  }
}
