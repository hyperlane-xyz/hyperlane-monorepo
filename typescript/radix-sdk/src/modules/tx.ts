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

import { assert } from '@hyperlane-xyz/utils';

import { Account } from '../types.js';

import { RadixPopulate } from './populate.js';
import { RadixQuery } from './query.js';

export class RadixTx {
  private account: Account;

  protected query: RadixQuery;
  protected populate: RadixPopulate;
  protected networkId: number;
  protected gateway: GatewayApiClient;

  constructor(
    account: Account,
    query: RadixQuery,
    populate: RadixPopulate,
    networkId: number,
    gateway: GatewayApiClient,
  ) {
    this.account = account;
    this.query = query;
    this.populate = populate;
    this.networkId = networkId;
    this.gateway = gateway;
  }

  public async transfer({
    to_address,
    resource_address,
    amount,
  }: {
    to_address: string;
    resource_address: string;
    amount: string;
  }) {
    const transactionManifest = this.populate.transfer({
      from_address: this.account.address,
      to_address,
      resource_address,
      amount,
    });

    await this.signAndBroadcast(transactionManifest);
  }

  public async createMailbox({ domain_id }: { domain_id: number }) {
    const transactionManifest = this.populate.createMailbox({
      from_address: this.account.address,
      domain_id,
    });

    const intentHashTransactionId =
      await this.signAndBroadcast(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public async createMerkleTreeHook({ mailbox }: { mailbox: string }) {
    const transactionManifest = this.populate.createMerkleTreeHook({
      from_address: this.account.address,
      mailbox,
    });

    const intentHashTransactionId =
      await this.signAndBroadcast(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public async createMerkleRootMultisigIsm({
    validators,
    threshold,
  }: {
    validators: string[];
    threshold: number;
  }) {
    const transactionManifest = this.populate.createMerkleRootMultisigIsm({
      from_address: this.account.address,
      validators,
      threshold,
    });

    const intentHashTransactionId =
      await this.signAndBroadcast(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public async createMessageIdMultisigIsm({
    validators,
    threshold,
  }: {
    validators: string[];
    threshold: number;
  }) {
    const transactionManifest = this.populate.createMessageIdMultisigIsm({
      from_address: this.account.address,
      validators,
      threshold,
    });

    const intentHashTransactionId =
      await this.signAndBroadcast(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public async createNoopIsm() {
    const transactionManifest = this.populate.createNoopIsm({
      from_address: this.account.address,
    });

    const intentHashTransactionId =
      await this.signAndBroadcast(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public async createIgp({ denom }: { denom: string }) {
    const transactionManifest = this.populate.createIgp({
      from_address: this.account.address,
      denom,
    });

    const intentHashTransactionId =
      await this.signAndBroadcast(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public async setIgpOwner({
    igp,
    new_owner,
  }: {
    igp: string;
    new_owner: string;
  }) {
    const transactionManifest = await this.populate.setIgpOwner({
      from_address: this.account.address,
      igp,
      new_owner,
    });

    await this.signAndBroadcast(transactionManifest);
  }

  public async setDestinationGasConfig({
    igp,
    destination_gas_config,
  }: {
    igp: string;
    destination_gas_config: {
      remote_domain: string;
      gas_oracle: {
        token_exchange_rate: string;
        gas_price: string;
      };
      gas_overhead: string;
    };
  }) {
    const transactionManifest = await this.populate.setDestinationGasConfig({
      from_address: this.account.address,
      igp,
      destination_gas_config,
    });

    await this.signAndBroadcast(transactionManifest);
  }

  public async setMailboxOwner({
    mailbox,
    new_owner,
  }: {
    mailbox: string;
    new_owner: string;
  }) {
    const transactionManifest = await this.populate.setMailboxOwner({
      from_address: this.account.address,
      mailbox,
      new_owner,
    });

    await this.signAndBroadcast(transactionManifest);
  }

  public async createValidatorAnnounce({ mailbox }: { mailbox: string }) {
    const transactionManifest = this.populate.createValidatorAnnounce({
      from_address: this.account.address,
      mailbox,
    });

    const intentHashTransactionId =
      await this.signAndBroadcast(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public async setRequiredHook({
    mailbox,
    hook,
  }: {
    mailbox: string;
    hook: string;
  }) {
    const transactionManifest = await this.populate.setRequiredHook({
      from_address: this.account.address,
      mailbox,
      hook,
    });

    await this.signAndBroadcast(transactionManifest);
  }

  public async setDefaultHook({
    mailbox,
    hook,
  }: {
    mailbox: string;
    hook: string;
  }) {
    const transactionManifest = await this.populate.setDefaultHook({
      from_address: this.account.address,
      mailbox,
      hook,
    });

    await this.signAndBroadcast(transactionManifest);
  }

  public async setDefaultIsm({
    mailbox,
    ism,
  }: {
    mailbox: string;
    ism: string;
  }) {
    const transactionManifest = await this.populate.setDefaultIsm({
      from_address: this.account.address,
      mailbox,
      ism,
    });

    await this.signAndBroadcast(transactionManifest);
  }

  public async createCollateralToken({
    mailbox,
    origin_denom,
  }: {
    mailbox: string;
    origin_denom: string;
  }) {
    const transactionManifest = this.populate.createCollateralToken({
      from_address: this.account.address,
      mailbox,
      origin_denom,
    });

    const intentHashTransactionId =
      await this.signAndBroadcast(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public async createSyntheticToken({
    mailbox,
    name,
    symbol,
    description,
    divisibility,
  }: {
    mailbox: string;
    name: string;
    symbol: string;
    description: string;
    divisibility: number;
  }) {
    const transactionManifest = this.populate.createSyntheticToken({
      from_address: this.account.address,
      mailbox,
      name,
      symbol,
      description,
      divisibility,
    });

    const intentHashTransactionId =
      await this.signAndBroadcast(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public async setTokenOwner({
    token,
    new_owner,
  }: {
    token: string;
    new_owner: string;
  }) {
    const transactionManifest = await this.populate.setTokenOwner({
      from_address: this.account.address,
      token,
      new_owner,
    });

    await this.signAndBroadcast(transactionManifest);
  }

  public async setTokenIsm({ token, ism }: { token: string; ism: string }) {
    const transactionManifest = await this.populate.setTokenIsm({
      from_address: this.account.address,
      token,
      ism,
    });

    await this.signAndBroadcast(transactionManifest);
  }

  public async enrollRemoteRouter({
    token,
    receiver_domain,
    receiver_address,
    gas,
  }: {
    token: string;
    receiver_domain: number;
    receiver_address: string;
    gas: string;
  }) {
    const transactionManifest = await this.populate.enrollRemoteRouter({
      from_address: this.account.address,
      token,
      receiver_domain,
      receiver_address,
      gas,
    });

    await this.signAndBroadcast(transactionManifest);
  }

  public async unrollRemoteRouter({
    token,
    receiver_domain,
  }: {
    token: string;
    receiver_domain: number;
  }) {
    const transactionManifest = await this.populate.unrollRemoteRouter({
      from_address: this.account.address,
      token,
      receiver_domain,
    });

    await this.signAndBroadcast(transactionManifest);
  }

  public async remoteTransfer({
    token,
    destination_domain,
    recipient,
    amount,
    custom_hook_id,
    gas_limit,
    custom_hook_metadata,
    max_fee,
  }: {
    token: string;
    destination_domain: number;
    recipient: string;
    amount: string;
    custom_hook_id: string;
    gas_limit: string;
    custom_hook_metadata: string;
    max_fee: { denom: string; amount: string };
  }) {
    const transactionManifest = await this.populate.remoteTransfer({
      from_address: this.account.address,
      token,
      destination_domain,
      recipient,
      amount,
      custom_hook_id,
      gas_limit,
      custom_hook_metadata,
      max_fee,
    });

    await this.signAndBroadcast(transactionManifest);
  }

  public async signAndBroadcast(
    manifest: TransactionManifest,
  ): Promise<TransactionHash> {
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

    const transaction: NotarizedTransaction =
      await TransactionBuilder.new().then((builder) =>
        builder
          .header(transactionHeader)
          .manifest(manifest)
          .sign(this.signIntent)
          .notarize(this.notarizeIntent),
      );

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
    await this.query.pollForCommit(intentHashTransactionId.id);

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
    await this.query.pollForCommit(intentHashTransactionId);

    return intentHashTransactionId;
  }

  private async getNewComponent(transaction: TransactionHash): Promise<string> {
    const transactionReceipt =
      await this.gateway.transaction.getCommittedDetails(transaction.id);

    const receipt = transactionReceipt.transaction.receipt;
    assert(receipt, `found no receipt on transaction: ${transaction.id}`);

    const newGlobalGenericComponent = (
      receipt.state_updates as any
    ).new_global_entities.find(
      (entity: { entity_type: string }) =>
        entity.entity_type === 'GlobalGenericComponent',
    );
    assert(
      newGlobalGenericComponent,
      `found no newly created component on transaction: ${transaction.id}`,
    );

    return newGlobalGenericComponent.entity_address;
  }

  private signIntent = (hashToSign: Uint8Array): SignatureWithPublicKey => {
    return this.account.privateKey.signToSignatureWithPublicKey(hashToSign);
  };

  private notarizeIntent = (hashToSign: Uint8Array): Signature => {
    return this.account.privateKey.signToSignature(hashToSign);
  };
}
