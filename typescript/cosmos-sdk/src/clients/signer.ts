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

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert, isUrl, strip0x } from '@hyperlane-xyz/utils';

import { COSMOS_MODULE_MESSAGE_REGISTRY as R } from '../registry.js';
import { getProtoConverter } from '../utils/base.js';

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
    rpcUrls: string[],
    privateKey: string | OfflineSigner,
    extraParams?: Record<string, any>,
  ): Promise<AltVM.ISigner<EncodeObject, DeliverTxResponse>> {
    assert(rpcUrls.length > 0, `got no rpcUrls`);
    assert(
      rpcUrls.every((rpc) => isUrl(rpc)),
      `invalid rpc urls: ${rpcUrls.join(', ')}`,
    );

    assert(extraParams, `extra params not defined`);
    assert(extraParams.metadata, `metadata not defined in extra params`);
    assert(
      extraParams.metadata.gasPrice,
      `gasPrice not defined in metadata extra params`,
    );

    let wallet: OfflineSigner;

    if (typeof privateKey === 'string') {
      assert(
        extraParams.metadata.bech32Prefix,
        `bech32Prefix not defined in metadata extra params`,
      );

      const isPrivateKey = new RegExp(/(^|\b)(0x)?[0-9a-fA-F]{64}(\b|$)/).test(
        privateKey,
      );

      if (isPrivateKey) {
        wallet = await DirectSecp256k1Wallet.fromKey(
          new Uint8Array(Buffer.from(strip0x(privateKey), 'hex')),
          extraParams.metadata.bech32Prefix,
        );
      } else {
        wallet = await DirectSecp256k1HdWallet.fromMnemonic(privateKey, {
          prefix: extraParams.metadata.bech32Prefix,
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
      rpcUrls[0],
      wallet,
      {
        aminoTypes: new AminoTypes({
          ...aminoTypes,
        }),
        gasPrice: GasPrice.fromString(
          `${extraParams.metadata.gasPrice.amount}${extraParams.metadata.gasPrice.denom}`,
        ),
      },
    );

    // register all the custom tx types
    Object.values(R).forEach(({ proto }) => {
      signer.registry.register(proto.type, proto.converter);
    });

    const cometClient = await connectComet(rpcUrls[0]);
    const account = await wallet.getAccounts();

    return new CosmosNativeSigner(cometClient, signer, account[0], rpcUrls, {
      fee: 2,
      memo: '',
    });
  }

  protected constructor(
    cometClient: CometClient,
    signer: SigningStargateClient,
    account: AccountData,
    rpcUrls: string[],
    options: TxOptions,
  ) {
    super(cometClient, rpcUrls);
    this.signer = signer;
    this.account = account;
    this.options = options;
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
    return getProtoConverter(msgResponse.typeUrl).decode(msgResponse.value);
  }

  getSignerAddress(): string {
    return this.account.address;
  }

  supportsTransactionBatching(): boolean {
    return true;
  }

  async transactionToPrintableJson(transaction: EncodeObject): Promise<object> {
    return transaction;
  }

  async sendAndConfirmTransaction(
    transaction: EncodeObject,
  ): Promise<DeliverTxResponse> {
    const receipt = await this.signer.signAndBroadcast(
      this.account.address,
      [transaction],
      this.options.fee,
      this.options.memo,
    );
    assertIsDeliverTxSuccess(receipt);

    return receipt;
  }

  async sendAndConfirmBatchTransactions(
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
    const msg = await this.getCreateMailboxTransaction({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      mailboxAddress: result.id,
    };
  }

  async setDefaultIsm(
    req: Omit<AltVM.ReqSetDefaultIsm, 'signer'>,
  ): Promise<AltVM.ResSetDefaultIsm> {
    const msg = await this.getSetDefaultIsmTransaction({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      ismAddress: req.ismAddress,
    };
  }

  async setDefaultHook(
    req: Omit<AltVM.ReqSetDefaultHook, 'signer'>,
  ): Promise<AltVM.ResSetDefaultHook> {
    const msg = await this.getSetDefaultHookTransaction({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      hookAddress: req.hookAddress,
    };
  }

  async setRequiredHook(
    req: Omit<AltVM.ReqSetRequiredHook, 'signer'>,
  ): Promise<AltVM.ResSetRequiredHook> {
    const msg = await this.getSetRequiredHookTransaction({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      hookAddress: req.hookAddress,
    };
  }

  async setMailboxOwner(
    req: Omit<AltVM.ReqSetMailboxOwner, 'signer'>,
  ): Promise<AltVM.ResSetMailboxOwner> {
    const msg = await this.getSetMailboxOwnerTransaction({
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
    const msg = await this.getCreateMerkleRootMultisigIsmTransaction({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      ismAddress: result.id,
    };
  }

  async createMessageIdMultisigIsm(
    req: Omit<AltVM.ReqCreateMessageIdMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMessageIdMultisigIsm> {
    const msg = await this.getCreateMessageIdMultisigIsmTransaction({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      ismAddress: result.id,
    };
  }

  async createRoutingIsm(
    req: Omit<AltVM.ReqCreateRoutingIsm, 'signer'>,
  ): Promise<AltVM.ResCreateRoutingIsm> {
    const msg = await this.getCreateRoutingIsmTransaction({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      ismAddress: result.id,
    };
  }

  async setRoutingIsmRoute(
    req: Omit<AltVM.ReqSetRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmRoute> {
    const msg = await this.getSetRoutingIsmRouteTransaction({
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
    const msg = await this.getRemoveRoutingIsmRouteTransaction({
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
    const msg = await this.getSetRoutingIsmOwnerTransaction({
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
    const msg = await this.getCreateNoopIsmTransaction({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      ismAddress: result.id,
    };
  }

  async createMerkleTreeHook(
    req: Omit<AltVM.ReqCreateMerkleTreeHook, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleTreeHook> {
    const msg = await this.getCreateMerkleTreeHookTransaction({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      hookAddress: result.id,
    };
  }

  async createInterchainGasPaymasterHook(
    req: Omit<AltVM.ReqCreateInterchainGasPaymasterHook, 'signer'>,
  ): Promise<AltVM.ResCreateInterchainGasPaymasterHook> {
    assert(req.denom, `denom required by ${CosmosNativeSigner.name}`);

    const msg = await this.getCreateInterchainGasPaymasterHookTransaction({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      hookAddress: result.id,
    };
  }

  async setInterchainGasPaymasterHookOwner(
    req: Omit<AltVM.ReqSetInterchainGasPaymasterHookOwner, 'signer'>,
  ): Promise<AltVM.ResSetInterchainGasPaymasterHookOwner> {
    const msg = await this.getSetInterchainGasPaymasterHookOwnerTransaction({
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
    const msg = await this.getSetDestinationGasConfigTransaction({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      destinationGasConfig: req.destinationGasConfig,
    };
  }

  async removeDestinationGasConfig(
    _req: Omit<AltVM.ReqRemoveDestinationGasConfig, 'signer'>,
  ): Promise<AltVM.ResRemoveDestinationGasConfig> {
    throw new Error(
      `RemoveDestinationGasConfig is currently not supported on Cosmos Native`,
    );
  }

  async createNoopHook(
    req: Omit<AltVM.ReqCreateNoopHook, 'signer'>,
  ): Promise<AltVM.ResCreateNoopHook> {
    const msg = await this.getCreateNoopHookTransaction({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      hookAddress: result.id,
    };
  }

  async createValidatorAnnounce(
    _req: Omit<AltVM.ReqCreateValidatorAnnounce, 'signer'>,
  ): Promise<AltVM.ResCreateValidatorAnnounce> {
    // Cosmos Native has no validator announce
    return { validatorAnnounceId: '' };
  }

  // ### TX WARP ###

  async createNativeToken(
    _req: Omit<AltVM.ReqCreateNativeToken, 'signer'>,
  ): Promise<AltVM.ResCreateNativeToken> {
    throw new Error(`Native Token is not supported on Cosmos Native`);
  }

  async createCollateralToken(
    req: Omit<AltVM.ReqCreateCollateralToken, 'signer'>,
  ): Promise<AltVM.ResCreateCollateralToken> {
    const msg = await this.getCreateCollateralTokenTransaction({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      tokenAddress: result.id,
    };
  }

  async createSyntheticToken(
    req: Omit<AltVM.ReqCreateSyntheticToken, 'signer'>,
  ): Promise<AltVM.ResCreateSyntheticToken> {
    const msg = await this.getCreateSyntheticTokenTransaction({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      tokenAddress: result.id,
    };
  }

  async setTokenOwner(
    req: Omit<AltVM.ReqSetTokenOwner, 'signer'>,
  ): Promise<AltVM.ResSetTokenOwner> {
    const msg = await this.getSetTokenOwnerTransaction({
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
    const msg = await this.getSetTokenIsmTransaction({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      ismAddress: req.ismAddress,
    };
  }

  async setTokenHook(
    _req: Omit<AltVM.ReqSetTokenHook, 'signer'>,
  ): Promise<AltVM.ResSetTokenHook> {
    throw new Error(`SetTokenHook is currently not supported on Cosmos Native`);
  }

  async enrollRemoteRouter(
    req: Omit<AltVM.ReqEnrollRemoteRouter, 'signer'>,
  ): Promise<AltVM.ResEnrollRemoteRouter> {
    const msg = await this.getEnrollRemoteRouterTransaction({
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
    const msg = await this.getUnenrollRemoteRouterTransaction({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      receiverDomainId: req.receiverDomainId,
    };
  }

  async transfer(
    req: Omit<AltVM.ReqTransfer, 'signer'>,
  ): Promise<AltVM.ResTransfer> {
    assert(req.denom, `denom required by ${CosmosNativeSigner.name}`);

    const msg = await this.getTransferTransaction({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      recipient: req.recipient,
    };
  }

  async remoteTransfer(
    req: Omit<AltVM.ReqRemoteTransfer, 'signer'>,
  ): Promise<AltVM.ResRemoteTransfer> {
    const msg = await this.getRemoteTransferTransaction({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      tokenAddress: req.tokenAddress,
    };
  }
}
