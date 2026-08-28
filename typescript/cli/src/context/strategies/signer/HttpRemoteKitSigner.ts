import {
  type Address,
  type SignatureDictionary,
  type Transaction,
  type TransactionPartialSigner,
  address,
  getBase64EncodedWireTransaction,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  verifySignature,
} from '@solana/kit';

import { ProtocolType, assert, eqAddressSol } from '@hyperlane-xyz/utils';

import type { HttpSignerClient } from './HttpSignerClient.js';

const transactionDecoder = getTransactionDecoder();

export class HttpRemoteKitSigner implements TransactionPartialSigner {
  readonly address: Address;

  private constructor(
    private readonly chain: string,
    addressValue: string,
    private readonly client: HttpSignerClient,
  ) {
    this.address = address(addressValue);
  }

  static async create(
    chain: string,
    client: HttpSignerClient,
  ): Promise<HttpRemoteKitSigner> {
    const account = await client.getAccount(chain);
    assert(
      account.chain === chain,
      `HTTP signer returned account for ${account.chain}, expected ${chain}`,
    );
    assert(
      account.protocol === ProtocolType.Sealevel,
      `HTTP signer account for ${chain} uses ${account.protocol}, expected sealevel`,
    );
    assert(
      account.curve === 'ed25519',
      `HTTP signer account for ${chain} uses ${account.curve}, expected ed25519`,
    );
    return new HttpRemoteKitSigner(chain, account.address, client);
  }

  async signTransactions(
    transactions: readonly Transaction[],
  ): Promise<readonly SignatureDictionary[]> {
    return Promise.all(
      transactions.map((transaction) => this.sign(transaction)),
    );
  }

  private async sign(transaction: Transaction): Promise<SignatureDictionary> {
    assert(
      this.address in transaction.signatures,
      `HTTP signer ${this.address} is not a required transaction signer`,
    );
    const unsignedWire = getBase64EncodedWireTransaction(transaction);
    const response = await this.client.signEncodedTransaction(this.chain, {
      encoding: 'base64',
      value: unsignedWire,
    });
    assert(
      eqAddressSol(response.signerAddress, this.address),
      `HTTP signer response address mismatch for ${this.chain}`,
    );
    assert(
      response.signedTransaction.encoding === 'base64',
      'HTTP signer returned a non-base64 Sealevel transaction',
    );
    const signed = transactionDecoder.decode(
      Buffer.from(response.signedTransaction.value, 'base64'),
    );
    assert(
      Buffer.from(transaction.messageBytes).equals(
        Buffer.from(signed.messageBytes),
      ),
      'HTTP signer modified the Sealevel transaction message',
    );
    const signature = signed.signatures[this.address];
    assert(signature, `HTTP signer response omitted ${this.address} signature`);
    const publicKey = await getPublicKeyFromAddress(this.address);
    assert(
      await verifySignature(publicKey, signature, transaction.messageBytes),
      `HTTP signer returned an invalid signature for ${this.address}`,
    );
    return { [this.address]: signature };
  }
}
