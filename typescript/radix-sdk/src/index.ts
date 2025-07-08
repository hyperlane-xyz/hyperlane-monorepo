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
  decimal,
  enumeration,
  expression,
  generateRandomNonce,
  u32,
  u64,
} from '@radixdlt/radix-engine-toolkit';
import { getRandomValues } from 'crypto';

import { assert } from '@hyperlane-xyz/utils';

import { bytes } from './utils.js';

const applicationName = 'hyperlane';
const dashboardBase = 'https://stokenet-dashboard.radixdlt.com'; // For mainnet, use "https://dashboard.radixdlt.com"

type Account = {
  privateKey: PrivateKey;
  publicKey: PublicKey;
  address: string;
  dashboardLink: string;
};

export { NetworkId };

export interface RadixSDKOptions {
  networkId?: number;
}

export interface RadixSDKSigningOptions extends RadixSDKOptions {
  gasAmount?: number;
}

export class RadixSDK {
  protected networkId: number;
  protected gateway: GatewayApiClient;

  constructor(options?: RadixSDKOptions) {
    this.networkId = options?.networkId ?? NetworkId.Mainnet;

    this.gateway = GatewayApiClient.initialize({
      applicationName,
      networkId: this.networkId,
    });
  }

  public async queryMailbox(mailbox: string): Promise<{
    address: string;
    owner: string;
    localDomain: number;
    nonce: number;
    defaultIsm: string;
    defaultHook: string;
    requiredHook: string;
  }> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(mailbox);
    const fields = (details.details as any).state.fields;

    const result = {
      address: mailbox,
      owner: '',
      localDomain: parseInt(
        fields.find((f: any) => f.field_name === 'local_domain').value,
      ),
      nonce: parseInt(fields.find((f: any) => f.field_name === 'nonce').value),
      defaultIsm: fields.find((f: any) => f.field_name === 'default_ism')
        .fields[0].value,
      defaultHook: fields.find((f: any) => f.field_name === 'default_hook')
        .fields[0].value,
      requiredHook: fields.find((f: any) => f.field_name === 'required_hook')
        .fields[0].value,
    };

    return result;
  }

  public async queryIsm(ism: string): Promise<{
    address: string;
    type: 'MerkleRootMultisigIsm' | 'MessageIdMultisigIsm' | 'NoopIsm';
    validators: string[];
    threshold: number;
  }> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(ism);

    const fields = (details.details as any).state.fields;

    const result = {
      address: ism,
      type: (details.details as any).blueprint_name,
      validators: (
        fields.find((f: any) => f.field_name === 'validators')?.elements ?? []
      ).map((v: any) => v.hex),
      threshold: parseInt(
        fields.find((f: any) => f.field_name === 'threshold')?.value ?? '0',
      ),
    };

    return result;
  }

  public async queryIgpHook(hook: string): Promise<{
    address: string;
    owner: string;
    destinationGasConfigs: {
      [domainId: string]: {
        gasOracle: {
          tokenExchangeRate: string;
          gasPrice: string;
        };
        gasOverhead: string;
      };
    };
  }> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(hook);

    assert(
      (details.details as any).blueprint_name === 'InterchainGasPaymaster',
      `Expected contract at address ${hook} to be "InterchainGasPaymaster" but got ${(details.details as any).blueprint_name}`,
    );

    const fields = (details.details as any).state.fields;
    const destinationGasConfigs = {};

    const entries: any[] =
      fields.find((f: any) => f.field_name === 'destination_gas_configs')
        ?.entries ?? [];

    for (const entry of entries) {
      const domainId = entry.key.value;

      const gasOverhead =
        entry.value.fields.find((f: any) => f.field_name === 'gas_overhead')
          ?.value ?? '0';

      const gasOracle =
        entry.value.fields.find((f: any) => f.field_name === 'gas_oracle')
          ?.fields ?? [];

      const tokenExchangeRate =
        gasOracle.find((f: any) => f.field_name === 'token_exchange_rate')
          ?.value ?? '0';

      const gasPrice =
        gasOracle.find((f: any) => f.field_name === 'gas_price')?.value ?? '0';

      Object.assign(destinationGasConfigs, {
        [domainId]: {
          gasOracle: {
            tokenExchangeRate,
            gasPrice,
          },
          gasOverhead,
        },
      });
    }

    return {
      address: hook,
      owner: '',
      destinationGasConfigs,
    };
  }

  public async queryMerkleTreeHook(hook: string): Promise<{
    address: string;
  }> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(hook);

    assert(
      (details.details as any).blueprint_name === 'MerkleTreeHook',
      `Expected contract at address ${hook} to be "MerkleTreeHook" but got ${(details.details as any).blueprint_name}`,
    );

    return {
      address: hook,
    };
  }
}

export class RadixSigningSDK extends RadixSDK {
  private gasAmount: number;

  private account: Account;

  constructor(account: Account, options?: RadixSDKSigningOptions) {
    super(options);

    this.account = account;
    this.gasAmount = options?.gasAmount ?? 5000;
  }

  public async getXrdAddress() {
    const knownAddresses = await LTSRadixEngineToolkit.Derive.knownAddresses(
      this.networkId,
    );
    return knownAddresses.resources.xrdResource;
  }

  private static async generateNewEd25519VirtualAccount(
    privateKey: string,
    networkId: number,
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

  public static async fromRandomPrivateKey(options?: RadixSDKOptions) {
    const privateKey = Buffer.from(
      await this.generateSecureRandomBytes(32),
    ).toString('hex');
    const account = await this.generateNewEd25519VirtualAccount(
      privateKey,
      options?.networkId ?? NetworkId.Mainnet,
    );
    return new RadixSigningSDK(account, options);
  }

  public static async fromPrivateKey(
    privateKey: string,
    options?: RadixSDKOptions,
  ) {
    const account = await this.generateNewEd25519VirtualAccount(
      privateKey,
      options?.networkId ?? NetworkId.Mainnet,
    );
    return new RadixSigningSDK(account);
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
    await this.pollForCommit(intentHashTransactionId);

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
        [decimal(this.gasAmount)],
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
        [decimal(this.gasAmount)],
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
        await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
        continue;
      }

      switch (statusOutput.intent_status) {
        case 'CommittedSuccess':
          return;
        case 'CommittedFailure':
          // You will typically wish to build a new transaction and try again.
          throw new Error(
            `Transaction ${intentHashTransactionId} was not committed successfully - instead it resulted in: ${statusOutput.intent_status} with description: ${statusOutput.error_message}`,
          );
        case 'CommitPendingOutcomeUnknown':
          // We keep polling
          if (i < pollAttempts) {
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

  public async createMerkleRootMultisigIsm(
    validators: string[],
    threshold: number,
  ) {
    const transactionManifest = this.createCallFunctionManifest(
      'package_tdx_2_1p5p5p5xsp0gde442jpyw4renphj7thkg0esulfsyl806nqc309gvp4',
      'MerkleRootMultisigIsm',
      'instantiate',
      [
        array(ValueKind.Array, ...validators.map((v) => bytes(v))),
        u64(threshold),
      ],
    );

    const intentHashTransactionId =
      await this.submitTransaction(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public async createMessageIdMultisig(
    validators: string[],
    threshold: number,
  ) {
    const transactionManifest = this.createCallFunctionManifest(
      'package_tdx_2_1p5p5p5xsp0gde442jpyw4renphj7thkg0esulfsyl806nqc309gvp4',
      'MessageIdMultisigIsm',
      'instantiate',
      [
        array(ValueKind.Blob, ...validators.map((v) => bytes(v))),
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

  public async createValidatorAnnounce(mailbox: string) {
    const transactionManifest = this.createCallFunctionManifest(
      'package_tdx_2_1p5p5p5xsp0gde442jpyw4renphj7thkg0esulfsyl806nqc309gvp4',
      'ValidatorAnnounce',
      'instantiate',
      [address(mailbox)],
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

// TODO: RADIX
// const main = async () => {
//   const sdk = new RadixSDK({
//     networkId: NetworkId.Stokenet,
//   });
// await sdk.getTestnetXrd();

// const mailbox = await sdk.createMailbox(75898670);
// console.log('created mailbox with id', mailbox, '\n');

// const merkleTreeHook = await sdk.createMerkleTreeHook(mailbox);
// console.log('created merkleTreeHook with id', merkleTreeHook, '\n');

// const merkleRootMultisigIsm = await sdk.createMerkleRootMultisigIsm(
//   ['0c60e7eCd06429052223C78452F791AAb5C5CAc6'],
//   1,
// );
// console.log(
//   'created merkleRootMultisigIsm with id',
//   merkleRootMultisigIsm,
//   '\n',
// );

// const xrd = await sdk.getXrdAddress();
// const igp = await sdk.createIgp(xrd);
// console.log('created igp with id', igp, '\n');

// await sdk.setRequiredHook(mailbox, merkleTreeHook);
// console.log('set required hook\n');

// await sdk.setDefaultHook(mailbox, igp);
// console.log('set default hook\n');

// await sdk.setDefaultIsm(mailbox, merkleRootMultisigIsm);
// console.log('set default ism\n');

// const m = await sdk.queryMailbox(
//   'component_tdx_2_1cqaet9grt80sn9k07hqjtugfg974x2pzmc7k3kcndqqv7895a6v8ux',
// );
// console.log('mailbox state', m, '\n');

// const i = await sdk.queryIsm(merkleRootMultisigIsm);
// console.log('ism state', i, '\n');

//   const h = await sdk.queryIgpHook(
//     'component_tdx_2_1crrt89w8hd5jvvh49jcqgl9wmvmauw0k0wf7yafzahfc276xzu3ak2',
//   );
//   console.log('igp hook state', JSON.stringify(h), '\n');
// };

// main();
