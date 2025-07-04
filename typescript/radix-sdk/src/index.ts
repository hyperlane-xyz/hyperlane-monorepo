import {
  GatewayApiClient,
  TransactionStatusResponse,
} from '@radixdlt/babylon-gateway-api-sdk';
import {
  LTSRadixEngineToolkit,
  ManifestBuilder,
  NetworkId,
  NotarizedTransaction,
  PrivateKey,
  PublicKey,
  RadixEngineToolkit,
  Signature,
  SignatureWithPublicKey,
  SimpleTransactionBuilder,
  TransactionBuilder,
  TransactionHash,
  TransactionHeader,
  TransactionManifest,
  Value,
  ValueKind,
  address,
  array,
  blob,
  decimal,
  enumeration,
  expression,
  generateRandomNonce,
  u32,
  u64,
} from '@radixdlt/radix-engine-toolkit';
import { getRandomValues } from 'crypto';

import { assert } from '@hyperlane-xyz/utils';

const networkId = NetworkId.Stokenet; // For mainnet, use NetworkId.Mainnet
const applicationName = 'Hyperlane Test';
const dashboardBase = 'https://stokenet-dashboard.radixdlt.com'; // For mainnet, use "https://dashboard.radixdlt.com"

type Account = {
  privateKey: PrivateKey;
  publicKey: PublicKey;
  address: string;
  dashboardLink: string;
};

export class RadixSDK {
  private gateway: GatewayApiClient;
  private account: Account;

  constructor(account: Account) {
    this.account = account;

    this.gateway = GatewayApiClient.initialize({
      applicationName,
      networkId,
    });
  }

  public async getXrdAddress() {
    const knownAddresses =
      await LTSRadixEngineToolkit.Derive.knownAddresses(networkId);
    return knownAddresses.resources.xrdResource;
  }

  private static async generateNewEd25519VirtualAccount(
    privateKey: string,
  ): Promise<Account> {
    const pk = new PrivateKey.Ed25519(
      new Uint8Array(Buffer.from(privateKey, 'hex')),
    );
    const publicKey = pk.publicKey();
    const address = await LTSRadixEngineToolkit.Derive.virtualAccountAddress(
      publicKey,
      networkId,
    );
    return {
      privateKey: pk,
      publicKey,
      address,
      dashboardLink: `${dashboardBase}/account/${address}`,
    };
  }

  public static async fromRandomPrivateKey() {
    const privateKey = Buffer.from(
      await this.generateSecureRandomBytes(32),
    ).toString('hex');
    const account = await this.generateNewEd25519VirtualAccount(privateKey);
    return new RadixSDK(account);
  }

  public static async fromPrivateKey(privateKey: string) {
    const account = await this.generateNewEd25519VirtualAccount(privateKey);
    return new RadixSDK(account);
  }

  public async getTestnetXrd() {
    const constructionMetadata =
      await this.gateway.transaction.innerClient.transactionConstruction();

    const freeXrdForAccountTransaction =
      await SimpleTransactionBuilder.freeXrdFromFaucet({
        networkId,
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
    await this.pollForCommit(intentHashTransactionId);

    console.log(
      `Account ${this.account.address} has been topped up with 10000 Testnet XRD: ${dashboardBase}/transaction/${intentHashTransactionId}`,
    );

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

  private static async generateSecureRandomBytes(
    count: number,
  ): Promise<Uint8Array> {
    const byteArray = new Uint8Array(count);
    getRandomValues(byteArray);
    return byteArray;
  }

  private signIntent = (hashToSign: Uint8Array): SignatureWithPublicKey => {
    return this.account.privateKey.signToSignatureWithPublicKey(hashToSign);
  };

  private notarizeIntent = (hashToSign: Uint8Array): Signature => {
    return this.account.privateKey.signToSignature(hashToSign);
  };

  private createCallFunctionManifest(
    packageAddress: string | number,
    blueprintName: string,
    functionName: string,
    args: Value[],
  ) {
    return new ManifestBuilder()
      .callMethod(
        'component_sim1cptxxxxxxxxxfaucetxxxxxxxxx000527798379xxxxxxxxxhkrefh',
        'lock_fee',
        [decimal(5000)],
      )
      .callFunction(packageAddress, blueprintName, functionName, args)
      .callMethod(this.account.address, 'try_deposit_batch_or_refund', [
        expression('EntireWorktop'),
        enumeration(0),
      ])
      .build();
  }

  private createCallMethodManifest(
    address: string | number,
    methodName: string,
    args: Value[],
  ) {
    return new ManifestBuilder()
      .callMethod(
        'component_sim1cptxxxxxxxxxfaucetxxxxxxxxx000527798379xxxxxxxxxhkrefh',
        'lock_fee',
        [decimal(5000)],
      )
      .callMethod(address, methodName, args)
      .callMethod(this.account.address, 'try_deposit_batch_or_refund', [
        expression('EntireWorktop'),
        enumeration(0),
      ])
      .build();
  }

  private async submitTransaction(
    manifest: TransactionManifest,
  ): Promise<TransactionHash> {
    const constructionMetadata =
      await this.gateway.transaction.innerClient.transactionConstruction();

    const transactionHeader: TransactionHeader = {
      networkId,
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
    await this.pollForCommit(intentHashTransactionId.id);

    return intentHashTransactionId;
  }

  private async pollForCommit(intentHashTransactionId: string): Promise<void> {
    const pollAttempts = 200;
    const pollDelayMs = 5000;

    for (let i = 0; i < pollAttempts; i++) {
      let statusOutput: TransactionStatusResponse;

      try {
        statusOutput =
          await this.gateway.transaction.innerClient.transactionStatus({
            transactionStatusRequest: { intent_hash: intentHashTransactionId },
          });
      } catch (err) {
        console.log(
          `error getting transaction status of ${intentHashTransactionId} - retrying in ${pollDelayMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
        continue;
      }

      switch (statusOutput.intent_status) {
        case 'CommittedSuccess':
          console.info(
            `Transaction ${intentHashTransactionId} was committed successfully: ${dashboardBase}/transaction/${intentHashTransactionId}`,
          );
          return;
        case 'CommittedFailure':
          // You will typically wish to build a new transaction and try again.
          throw new Error(
            `Transaction ${intentHashTransactionId} was not committed successfully - instead it resulted in: ${statusOutput.intent_status} with description: ${statusOutput.error_message}`,
          );
        case 'CommitPendingOutcomeUnknown':
          // We keep polling
          if (i < pollAttempts) {
            console.debug(
              `Transaction ${intentHashTransactionId} [status poll ${
                i + 1
              }/${pollAttempts} - retrying in ${pollDelayMs}ms] - STATUS: ${
                statusOutput.intent_status
              } DESCRIPTION: ${statusOutput.intent_status_description}`,
            );
            await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
          } else {
            throw new Error(
              `Transaction ${intentHashTransactionId} was not committed successfully within ${pollAttempts} poll attempts over ${
                pollAttempts * pollDelayMs
              }ms - instead it resulted in STATUS: ${
                statusOutput.intent_status
              } DESCRIPTION: ${statusOutput.intent_status_description}`,
            );
          }
      }
    }
  }

  public async createMailbox(domainId: number) {
    const transactionManifest = this.createCallFunctionManifest(
      'package_tdx_2_1p5p5p5xsp0gde442jpyw4renphj7thkg0esulfsyl806nqc309gvp4',
      'Mailbox',
      'mailbox_instantiate',
      [u32(domainId)],
    );

    const intentHashTransactionId =
      await this.submitTransaction(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public async createMerkleTreeHook(mailbox: string) {
    const transactionManifest = this.createCallFunctionManifest(
      'package_tdx_2_1p5p5p5xsp0gde442jpyw4renphj7thkg0esulfsyl806nqc309gvp4',
      'MerkleTreeHook',
      'instantiate',
      [address(mailbox)],
    );

    const intentHashTransactionId =
      await this.submitTransaction(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  // TODO: fix ethereum address
  public async createMerkleRootMultisigIsm(
    validators: string[],
    threshold: number,
  ) {
    const transactionManifest = this.createCallFunctionManifest(
      'package_tdx_2_1p5p5p5xsp0gde442jpyw4renphj7thkg0esulfsyl806nqc309gvp4',
      'MerkleRootMultisigIsm',
      'instantiate',
      [
        array(ValueKind.Blob, ...validators.map((v) => blob(v))),
        u64(threshold),
      ],
    );

    const intentHashTransactionId =
      await this.submitTransaction(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  // TODO: fix ethereum address
  public async createMessageIdMultisig(
    validators: string[],
    threshold: number,
  ) {
    const transactionManifest = this.createCallFunctionManifest(
      'package_tdx_2_1p5p5p5xsp0gde442jpyw4renphj7thkg0esulfsyl806nqc309gvp4',
      'MessageIdMultisigIsm',
      'instantiate',
      [
        array(ValueKind.Blob, ...validators.map((v) => blob(v))),
        u64(threshold),
      ],
    );

    const intentHashTransactionId =
      await this.submitTransaction(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public async createNoopIsm() {
    const transactionManifest = this.createCallFunctionManifest(
      'package_tdx_2_1p5p5p5xsp0gde442jpyw4renphj7thkg0esulfsyl806nqc309gvp4',
      'NoopIsm',
      'instantiate',
      [],
    );

    const intentHashTransactionId =
      await this.submitTransaction(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public async createIgp(denom: string) {
    const transactionManifest = this.createCallFunctionManifest(
      'package_tdx_2_1p5p5p5xsp0gde442jpyw4renphj7thkg0esulfsyl806nqc309gvp4',
      'InterchainGasPaymaster',
      'instantiate',
      [address(denom)],
    );

    const intentHashTransactionId =
      await this.submitTransaction(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public async setRequiredHook(mailbox: string, hook: string) {
    const transactionManifest = this.createCallMethodManifest(
      mailbox,
      'set_required_hook',
      [address(hook)],
    );

    await this.submitTransaction(transactionManifest);
  }

  public async setDefaultHook(mailbox: string, hook: string) {
    const transactionManifest = this.createCallMethodManifest(
      mailbox,
      'set_default_hook',
      [address(hook)],
    );

    await this.submitTransaction(transactionManifest);
  }

  public async setDefaultIsm(mailbox: string, ism: string) {
    const transactionManifest = this.createCallMethodManifest(
      mailbox,
      'set_default_ism',
      [address(ism)],
    );

    await this.submitTransaction(transactionManifest);
  }
}

const main = async () => {
  const sdk = await RadixSDK.fromRandomPrivateKey();
  await sdk.getTestnetXrd();

  const mailbox = await sdk.createMailbox(75898670);
  console.log('created mailbox with id', mailbox, '\n');

  const merkleTreeHook = await sdk.createMerkleTreeHook(mailbox);
  console.log('created merkleTreeHook with id', merkleTreeHook, '\n');

  const noopIsm = await sdk.createNoopIsm();
  console.log('created noopIsm with id', noopIsm, '\n');

  const xrd = await sdk.getXrdAddress();
  const igp = await sdk.createIgp(xrd);
  console.log('created igp with id', igp);

  await sdk.setRequiredHook(mailbox, merkleTreeHook);
  console.log('set required hook\n');

  await sdk.setDefaultHook(mailbox, igp);
  console.log('set default hook\n');

  await sdk.setDefaultIsm(mailbox, noopIsm);
  console.log('set default ism\n');
};

// @ts-ignore
const getMailboxState = async () => {
  const gateway = GatewayApiClient.initialize({
    applicationName,
    networkId,
  });

  const transactionReceipt = await gateway.state.innerClient.stateEntityDetails(
    {
      stateEntityDetailsRequest: {
        addresses: [
          'component_tdx_2_1cr4cc66g9prezvyw9vhznsx4wm0admw6a2q4mxewfvpzx09mp049wc',
        ],
      },
    },
  );

  console.log((transactionReceipt.items[0].details as any).state.fields);
};

main();
// getTransactionDetails();
// getMailboxState();
