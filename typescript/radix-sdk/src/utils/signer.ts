import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import {
  NotarizedTransaction,
  RadixEngineToolkit,
  Signature,
  SignatureWithPublicKey,
  SimpleTransactionBuilder,
  TransactionBuilder,
  TransactionHash,
  TransactionHeader,
  TransactionManifest,
  generateRandomNonce,
} from '@radixdlt/radix-engine-toolkit';

import { RadixBase } from './base.js';
import { Account } from './types.js';

export class RadixSigner {
  protected networkId: number;
  protected gateway: GatewayApiClient;
  protected base: RadixBase;
  protected account: Account;

  constructor(
    networkId: number,
    gateway: GatewayApiClient,
    base: RadixBase,
    account: Account,
  ) {
    this.networkId = networkId;
    this.gateway = gateway;
    this.base = base;
    this.account = account;
  }

  public async signAndBroadcast(
    manifest: TransactionManifest,
  ): Promise<TransactionHash> {
    // transaction builder from official example:
    // https://github.com/radixdlt/typescript-radix-engine-toolkit?tab=readme-ov-file#constructing-transactions
    const constructionMetadata =
      await this.gateway.transaction.innerClient.transactionConstruction();

    const transactionHeader: TransactionHeader = {
      networkId: this.networkId,
      startEpochInclusive: constructionMetadata.ledger_state.epoch,
      endEpochExclusive: constructionMetadata.ledger_state.epoch + 2,
      nonce: generateRandomNonce(),
      notaryPublicKey: this.account.publicKey,
      notaryIsSignatory: true,
      tipPercentage: 0,
    };

    const builder = await TransactionBuilder.new();
    const transaction: NotarizedTransaction = await builder
      .header(transactionHeader)
      .manifest(manifest)
      .sign(this.signIntent)
      .notarize(this.notarizeIntent);

    const compiledNotarizedTransaction =
      await RadixEngineToolkit.NotarizedTransaction.compile(transaction);

    const intentHashTransactionId =
      await RadixEngineToolkit.NotarizedTransaction.intentHash(transaction);

    await this.gateway.transaction.innerClient.transactionSubmit({
      transactionSubmitRequest: {
        notarized_transaction_hex: Buffer.from(
          compiledNotarizedTransaction,
        ).toString('hex'),
      },
    });
    await this.base.pollForCommit(intentHashTransactionId.id);

    return intentHashTransactionId;
  }

  public async getTestnetXrd() {
    const constructionMetadata =
      await this.gateway.transaction.innerClient.transactionConstruction();

    const freeXrdForAccountTransaction =
      await SimpleTransactionBuilder.freeXrdFromFaucet({
        networkId: this.networkId,
        toAccount: this.account.address,
        validFromEpoch: constructionMetadata.ledger_state.epoch,
      });

    const intentHashTransactionId =
      freeXrdForAccountTransaction.transactionId.id;

    await this.gateway.transaction.innerClient.transactionSubmit({
      transactionSubmitRequest: {
        notarized_transaction_hex: freeXrdForAccountTransaction.toHex(),
      },
    });
    await this.base.pollForCommit(intentHashTransactionId);

    return intentHashTransactionId;
  }

  private signIntent = (hashToSign: Uint8Array): SignatureWithPublicKey => {
    return this.account.privateKey.signToSignatureWithPublicKey(hashToSign);
  };

  private notarizeIntent = (hashToSign: Uint8Array): Signature => {
    return this.account.privateKey.signToSignature(hashToSign);
  };
}
