import {
  type AccountData,
  DirectSecp256k1HdWallet,
  DirectSecp256k1Wallet,
  type EncodeObject,
  type OfflineSigner,
} from '@cosmjs/proto-signing';
import {
  AminoTypes,
  type DeliverTxResponse,
  GasPrice,
  SigningStargateClient,
  type StdFee,
  assertIsDeliverTxSuccess,
} from '@cosmjs/stargate';
import { type CometClient, connectComet } from '@cosmjs/tendermint-rpc';

import { type AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert, isUrl, strip0x } from '@hyperlane-xyz/utils';

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
    rpcUrls: string[],
    privateKey: string | OfflineSigner,
    extraParams?: Record<string, any>,
  ): Promise<CosmosNativeSigner> {
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
}
