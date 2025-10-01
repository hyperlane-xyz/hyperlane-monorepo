import {
  AccountData,
  DirectSecp256k1HdWallet,
  DirectSecp256k1Wallet,
  EncodeObject,
} from '@cosmjs/proto-signing';
import {
  AminoTypes,
  GasPrice,
  SigningStargateClient,
  StdFee,
  assertIsDeliverTxSuccess,
} from '@cosmjs/stargate';
import { CometClient, connectComet } from '@cosmjs/tendermint-rpc';

import { MultiVM, assert } from '@hyperlane-xyz/utils';

import { COSMOS_MODULE_MESSAGE_REGISTRY as R } from '../registry.js';

import { CosmosNativeProvider } from './provider.js';

export class CosmosNativeSignerFactory
  implements MultiVM.MultiVmProviderFactory
{
  static async connectWithSigner(
    rpcUrl: string,
    privateKey: string,
    extraParams?: Record<string, any>,
  ): Promise<MultiVM.IMultiVMSigner> {
    assert(extraParams, `extra params not defined`);
    assert(
      extraParams.bech32Prefix,
      `bech32Prefix not defined in extra params`,
    );
    assert(extraParams.gasPrice, `gasPrice not defined in extra params`);

    let wallet;

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
      extraParams.rpcUrl,
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

    return new CosmosNativeSigner(cometClient, signer, account[0], {
      fee: 2,
      memo: '',
    });
  }
}

type TxOptions = {
  fee: StdFee | 'auto' | number;
  memo?: string;
};

export class CosmosNativeSigner
  extends CosmosNativeProvider
  implements MultiVM.IMultiVMSigner
{
  private readonly signer: SigningStargateClient;
  private readonly account: AccountData;
  private readonly options: TxOptions;

  constructor(
    cometClient: CometClient,
    signer: SigningStargateClient,
    account: AccountData,
    options: TxOptions,
  ) {
    super(cometClient);
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

    const { response } = this.signer.registry.decode(receipt.msgResponses[0]);
    return response;
  }

  getSignerAddress(): string {
    return this.account.address;
  }

  async signAndBroadcast(transactions: any[]): Promise<any[]> {
    const receipt = await this.signer.signAndBroadcast(
      this.account.address,
      transactions,
      this.options.fee,
      this.options.memo,
    );
    assertIsDeliverTxSuccess(receipt);

    return receipt.msgResponses;
  }

  // ### TX CORE ###

  async createMailbox(
    req: Omit<MultiVM.ReqCreateMailbox, 'signer'>,
  ): Promise<MultiVM.ResCreateMailbox> {
    const msg = await this.populateCreateMailbox({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      mailbox_id: result.id,
    };
  }

  async setDefaultIsm(
    req: Omit<MultiVM.ReqSetDefaultIsm, 'signer'>,
  ): Promise<MultiVM.ResSetDefaultIsm> {
    const msg = await this.populateSetDefaultIsm({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      ism_id: req.ism_id,
    };
  }

  async setDefaultHook(
    req: Omit<MultiVM.ReqSetDefaultHook, 'signer'>,
  ): Promise<MultiVM.ResSetDefaultHook> {
    const msg = await this.populateSetDefaultHook({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      hook_id: req.hook_id,
    };
  }

  async setRequiredHook(
    req: Omit<MultiVM.ReqSetRequiredHook, 'signer'>,
  ): Promise<MultiVM.ResSetRequiredHook> {
    const msg = await this.populateSetRequiredHook({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      hook_id: req.hook_id,
    };
  }

  async setMailboxOwner(
    req: Omit<MultiVM.ReqSetMailboxOwner, 'signer'>,
  ): Promise<MultiVM.ResSetMailboxOwner> {
    const msg = await this.populateSetMailboxOwner({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      new_owner: req.new_owner,
    };
  }

  async createMerkleRootMultisigIsm(
    req: Omit<MultiVM.ReqCreateMerkleRootMultisigIsm, 'signer'>,
  ): Promise<MultiVM.ResCreateMerkleRootMultisigIsm> {
    const msg = await this.populateCreateMerkleRootMultisigIsm({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      ism_id: result.id,
    };
  }

  async createMessageIdMultisigIsm(
    req: Omit<MultiVM.ReqCreateMessageIdMultisigIsm, 'signer'>,
  ): Promise<MultiVM.ResCreateMessageIdMultisigIsm> {
    const msg = await this.populateCreateMessageIdMultisigIsm({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      ism_id: result.id,
    };
  }

  async createRoutingIsm(
    req: Omit<MultiVM.ReqCreateRoutingIsm, 'signer'>,
  ): Promise<MultiVM.ResCreateRoutingIsm> {
    const msg = await this.populateCreateRoutingIsm({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      ism_id: result.id,
    };
  }

  async setRoutingIsmRoute(
    req: Omit<MultiVM.ReqSetRoutingIsmRoute, 'signer'>,
  ): Promise<MultiVM.ResSetRoutingIsmRoute> {
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
    req: Omit<MultiVM.ReqRemoveRoutingIsmRoute, 'signer'>,
  ): Promise<MultiVM.ResRemoveRoutingIsmRoute> {
    const msg = await this.populateRemoveRoutingIsmRoute({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      domain_id: req.domain_id,
    };
  }

  async setRoutingIsmOwner(
    _req: Omit<MultiVM.ResSetRoutingIsmOwner, 'signer'>,
  ): Promise<MultiVM.ResSetRoutingIsmOwner> {
    throw new Error('Cosmos Native does not support setRoutingIsmOwner');
  }

  async createNoopIsm(
    req: Omit<MultiVM.ReqCreateNoopIsm, 'signer'>,
  ): Promise<MultiVM.ResCreateNoopIsm> {
    const msg = await this.populateCreateNoopIsm({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      ism_id: result.id,
    };
  }

  async createMerkleTreeHook(
    req: Omit<MultiVM.ReqCreateMerkleTreeHook, 'signer'>,
  ): Promise<MultiVM.ResCreateMerkleTreeHook> {
    const msg = await this.populateCreateMerkleTreeHook({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      hook_id: result.id,
    };
  }

  async createInterchainGasPaymasterHook(
    req: Omit<MultiVM.ReqCreateInterchainGasPaymasterHook, 'signer'>,
  ): Promise<MultiVM.ResCreateInterchainGasPaymasterHook> {
    const msg = await this.populateCreateInterchainGasPaymasterHook({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      hook_id: result.id,
    };
  }

  async setInterchainGasPaymasterHookOwner(
    req: Omit<MultiVM.ReqSetInterchainGasPaymasterHookOwner, 'signer'>,
  ): Promise<MultiVM.ResSetInterchainGasPaymasterHookOwner> {
    const msg = await this.populateSetInterchainGasPaymasterHookOwner({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      new_owner: req.new_owner,
    };
  }

  async setDestinationGasConfig(
    req: Omit<MultiVM.ReqSetDestinationGasConfig, 'signer'>,
  ): Promise<MultiVM.ResSetDestinationGasConfig> {
    const msg = await this.populateSetDestinationGasConfig({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      destination_gas_config: req.destination_gas_config,
    };
  }

  async createValidatorAnnounce(
    _req: Omit<MultiVM.ReqCreateValidatorAnnounce, 'signer'>,
  ): Promise<MultiVM.ResCreateValidatorAnnounce> {
    throw new Error('Cosmos Native does not support createValidatorAnnounce');
  }

  // ### TX WARP ###

  async createCollateralToken(
    req: Omit<MultiVM.ReqCreateCollateralToken, 'signer'>,
  ): Promise<MultiVM.ResCreateCollateralToken> {
    const msg = await this.populateCreateCollateralToken({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      token_id: result.id,
    };
  }

  async createSyntheticToken(
    req: Omit<MultiVM.ReqCreateSyntheticToken, 'signer'>,
  ): Promise<MultiVM.ResCreateSyntheticToken> {
    const msg = await this.populateCreateSyntheticToken({
      ...req,
      signer: this.account.address,
    });

    const result = await this.submitTx(msg);
    return {
      token_id: result.id,
    };
  }

  async setTokenOwner(
    req: Omit<MultiVM.ReqSetTokenOwner, 'signer'>,
  ): Promise<MultiVM.ResSetTokenOwner> {
    const msg = await this.populateSetTokenOwner({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      new_owner: req.new_owner,
    };
  }

  async setTokenIsm(
    req: Omit<MultiVM.ReqSetTokenIsm, 'signer'>,
  ): Promise<MultiVM.ResSetTokenIsm> {
    const msg = await this.populateSetTokenIsm({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      ism_id: req.ism_id,
    };
  }

  async enrollRemoteRouter(
    req: Omit<MultiVM.ReqEnrollRemoteRouter, 'signer'>,
  ): Promise<MultiVM.ResEnrollRemoteRouter> {
    const msg = await this.populateEnrollRemoteRouter({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      receiver_domain_id: req.receiver_domain_id,
    };
  }

  async unenrollRemoteRouter(
    req: Omit<MultiVM.ReqUnenrollRemoteRouter, 'signer'>,
  ): Promise<MultiVM.ResUnenrollRemoteRouter> {
    const msg = await this.populateUnenrollRemoteRouter({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      receiver_domain_id: req.receiver_domain_id,
    };
  }

  async remoteTransfer(
    req: Omit<MultiVM.ReqRemoteTransfer, 'signer'>,
  ): Promise<MultiVM.ResRemoteTransfer> {
    const msg = await this.populateRemoteTransfer({
      ...req,
      signer: this.account.address,
    });

    await this.submitTx(msg);
    return {
      token_id: req.token_id,
    };
  }
}
