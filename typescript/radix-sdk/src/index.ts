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
  bucket,
  decimal,
  enumeration,
  expression,
  generateRandomNonce,
  str,
  tuple,
  u8,
  u32,
  u64,
} from '@radixdlt/radix-engine-toolkit';
import { getRandomValues } from 'crypto';
import { Decimal } from 'decimal.js';

import { assert, ensure0x, strip0x } from '@hyperlane-xyz/utils';

import { bytes } from './utils.js';

const applicationName = 'hyperlane';
const packageAddress =
  'package_tdx_2_1p4faa3cx72v0gwguntycgewxnlun34kpkpezf7m7arqyh9crr0v3f3';

type Account = {
  privateKey: PrivateKey;
  publicKey: PublicKey;
  address: string;
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

  public async getXrdAddress() {
    const knownAddresses = await LTSRadixEngineToolkit.Derive.knownAddresses(
      this.networkId,
    );
    return knownAddresses.resources.xrdResource;
  }

  public async getBalance(address: string, resource: string) {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(address);

    const fungibleResource = details.fungible_resources.items.find(
      (r) => r.resource_address === resource,
    );

    if (!fungibleResource || fungibleResource.vaults.items.length !== 1) {
      return '0';
    }

    return fungibleResource.vaults.items[0].amount;
  }

  public async getXrdBalance(address: string) {
    const xrdAddress = await this.getXrdAddress();
    return this.getBalance(address, xrdAddress);
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

    const ownerResource = (details.details as any).role_assignments.owner.rule
      .access_rule.proof_rule.requirement.resource;

    const { items } =
      await this.gateway.extensions.getResourceHolders(ownerResource);

    const resourceHolders = [
      ...new Set(items.map((item) => item.holder_address)),
    ];

    assert(
      resourceHolders.length === 1,
      `expected token holders of resource ${ownerResource} to be one, found ${resourceHolders.length} holders instead`,
    );

    const result = {
      address: mailbox,
      owner: resourceHolders[0],
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
      ).map((v: any) => ensure0x(v.hex)),
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

    const ownerResource = (details.details as any).role_assignments.owner.rule
      .access_rule.proof_rule.requirement.resource;

    const { items } =
      await this.gateway.extensions.getResourceHolders(ownerResource);

    const resourceHolders = [
      ...new Set(items.map((item) => item.holder_address)),
    ];

    assert(
      resourceHolders.length === 1,
      `expected token holders of resource ${ownerResource} to be one, found ${resourceHolders.length} holders instead`,
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
      owner: resourceHolders[0],
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

  public async queryToken(token: string): Promise<{
    address: string;
    owner: string;
    tokenType: 'COLLATERAL' | 'SYNTHETIC';
    mailbox: string;
    ism: string;
  }> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(token);

    assert(
      (details.details as any).blueprint_name === 'HypToken',
      `Expected contract at address ${token} to be "HypToken" but got ${(details.details as any).blueprint_name}`,
    );

    const ownerResource = (details.details as any).role_assignments.owner.rule
      .access_rule.proof_rule.requirement.resource;

    const { items } =
      await this.gateway.extensions.getResourceHolders(ownerResource);

    const resourceHolders = [
      ...new Set(items.map((item) => item.holder_address)),
    ];

    assert(
      resourceHolders.length === 1,
      `expected token holders of resource ${ownerResource} to be one, found ${resourceHolders.length} holders instead`,
    );

    const fields = (details.details as any).state.fields;

    const tokenType =
      fields.find((f: any) => f.field_name === 'token_type')?.variant_name ??
      '';
    assert(
      tokenType === 'COLLATERAL' || tokenType === 'SYNTHETIC',
      `unknown token type: ${tokenType}`,
    );

    const ismFields = fields.find((f: any) => f.field_name === 'ism').fields;

    const result = {
      address: token,
      owner: resourceHolders[0],
      tokenType,
      mailbox: fields.find((f: any) => f.field_name === 'mailbox')?.value ?? '',
      ism: ismFields[0]?.value ?? '',
    };

    return result;
  }

  public async queryEnrolledRouters(token: string): Promise<{
    address: string;
    enrolledRouters: {
      receiverDomain: string;
      receiverContract: string;
      gas: string;
    }[];
  }> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(token);

    assert(
      (details.details as any).blueprint_name === 'HypToken',
      `Expected contract at address ${token} to be "HypToken" but got ${(details.details as any).blueprint_name}`,
    );

    const fields = (details.details as any).state.fields;

    const enrolledRoutersKeyValueStore =
      fields.find((f: any) => f.field_name === 'enrolled_routers')?.value ?? '';
    assert(
      enrolledRoutersKeyValueStore,
      `found no enrolled routers on token ${token}`,
    );

    const enrolledRouters = [];

    const { items } = await this.gateway.state.innerClient.keyValueStoreKeys({
      stateKeyValueStoreKeysRequest: {
        key_value_store_address: enrolledRoutersKeyValueStore,
      },
    });

    for (const { key } of items) {
      const domainId = (key.programmatic_json as any).value;
      console.log('domainId', domainId);

      const { entries } =
        await this.gateway.state.innerClient.keyValueStoreData({
          stateKeyValueStoreDataRequest: {
            key_value_store_address: enrolledRoutersKeyValueStore,
            keys: [
              {
                key_hex: key.raw_hex,
              },
            ],
          },
        });

      const routerFields = (entries[0].value.programmatic_json as any).fields;

      enrolledRouters.push({
        receiverDomain: routerFields.find((r: any) => r.field_name === 'domain')
          .value,
        receiverContract: routerFields.find(
          (r: any) => r.field_name === 'recipient',
        ).hex,
        gas: routerFields.find((r: any) => r.field_name === 'gas').value,
      });
    }

    const result = {
      address: token,
      enrolledRouters,
    };

    return result;
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
    return new RadixSigningSDK(account, options);
  }

  public getAddress() {
    return this.account.address;
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

  private async createCallMethodManifestWithOwner(
    addr: string,
    methodName: string,
    args: Value[],
  ) {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(addr);

    const ownerResource = (details.details as any).role_assignments.owner.rule
      .access_rule.proof_rule.requirement.resource;

    return new ManifestBuilder()
      .callMethod(
        'component_sim1cptxxxxxxxxxfaucetxxxxxxxxx000527798379xxxxxxxxxhkrefh',
        'lock_fee',
        [decimal(this.gasAmount)],
      )
      .callMethod(this.account.address, 'create_proof_of_amount', [
        address(ownerResource),
        decimal(1),
      ])
      .callMethod(addr, methodName, args)
      .callMethod(this.account.address, 'try_deposit_batch_or_refund', [
        expression('EntireWorktop'),
        enumeration(0),
      ])
      .build();
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

  public populateTransfer(
    toAddress: string,
    resourceAddress: string,
    amount: string,
  ) {
    return new ManifestBuilder()
      .callMethod(
        'component_sim1cptxxxxxxxxxfaucetxxxxxxxxx000527798379xxxxxxxxxhkrefh',
        'lock_fee',
        [decimal(this.gasAmount)],
      )
      .callMethod(this.account.address, 'withdraw', [
        address(resourceAddress),
        decimal(amount),
      ])
      .takeFromWorktop(
        resourceAddress,
        new Decimal(amount),
        (builder, bucketId) =>
          builder.callMethod(toAddress, 'try_deposit_or_abort', [
            bucket(bucketId),
          ]),
      )
      .build();
  }

  public async transfer(
    toAddress: string,
    resourceAddress: string,
    amount: string,
  ) {
    const transactionManifest = this.populateTransfer(
      toAddress,
      resourceAddress,
      amount,
    );

    const intentHashTransactionId =
      await this.signAndBroadcast(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public populateCreateMailbox(domainId: number) {
    return this.createCallFunctionManifest(
      packageAddress,
      'Mailbox',
      'mailbox_instantiate',
      [u32(domainId)],
    );
  }

  public async createMailbox(domainId: number) {
    const transactionManifest = this.populateCreateMailbox(domainId);

    const intentHashTransactionId =
      await this.signAndBroadcast(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public async populateSetIgpOwner(igp: string, newOwner: string) {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(igp);

    const resource = (details.details as any).role_assignments.owner.rule
      .access_rule.proof_rule.requirement.resource;

    return this.populateTransfer(newOwner, resource, '1');
  }

  public async setIgpOwner(igp: string, newOwner: string) {
    const transactionManifest = await this.populateSetIgpOwner(igp, newOwner);

    const intentHashTransactionId =
      await this.signAndBroadcast(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public populateCreateMerkleTreeHook(mailbox: string) {
    return this.createCallFunctionManifest(
      packageAddress,
      'MerkleTreeHook',
      'instantiate',
      [address(mailbox)],
    );
  }

  public async createMerkleTreeHook(mailbox: string) {
    const transactionManifest = this.populateCreateMerkleTreeHook(mailbox);

    const intentHashTransactionId =
      await this.signAndBroadcast(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public populateCreateMerkleRootMultisigIsm(
    validators: string[],
    threshold: number,
  ) {
    return this.createCallFunctionManifest(
      packageAddress,
      'MerkleRootMultisigIsm',
      'instantiate',
      [
        array(ValueKind.Array, ...validators.map((v) => bytes(strip0x(v)))),
        u64(threshold),
      ],
    );
  }

  public async createMerkleRootMultisigIsm(
    validators: string[],
    threshold: number,
  ) {
    const transactionManifest = this.populateCreateMerkleRootMultisigIsm(
      validators,
      threshold,
    );

    const intentHashTransactionId =
      await this.signAndBroadcast(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public populateCreateMessageIdMultisigIsm(
    validators: string[],
    threshold: number,
  ) {
    return this.createCallFunctionManifest(
      packageAddress,
      'MessageIdMultisigIsm',
      'instantiate',
      [
        array(ValueKind.Array, ...validators.map((v) => bytes(strip0x(v)))),
        u64(threshold),
      ],
    );
  }

  public async createMessageIdMultisigIsm(
    validators: string[],
    threshold: number,
  ) {
    const transactionManifest = this.populateCreateMessageIdMultisigIsm(
      validators,
      threshold,
    );

    const intentHashTransactionId =
      await this.signAndBroadcast(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public populateCreateNoopIsm() {
    return this.createCallFunctionManifest(
      packageAddress,
      'NoopIsm',
      'instantiate',
      [],
    );
  }

  public async createNoopIsm() {
    const transactionManifest = this.populateCreateNoopIsm();

    const intentHashTransactionId =
      await this.signAndBroadcast(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public populateCreateIgp(denom: string) {
    return this.createCallFunctionManifest(
      packageAddress,
      'InterchainGasPaymaster',
      'instantiate',
      [address(denom)],
    );
  }

  public async createIgp(denom: string) {
    const transactionManifest = this.populateCreateIgp(denom);

    const intentHashTransactionId =
      await this.signAndBroadcast(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public async populateSetMailboxOwner(mailbox: string, newOwner: string) {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(mailbox);

    const resource = (details.details as any).role_assignments.owner.rule
      .access_rule.proof_rule.requirement.resource;

    return this.populateTransfer(newOwner, resource, '1');
  }

  public async setMailboxOwner(mailbox: string, newOwner: string) {
    const transactionManifest = await this.populateSetMailboxOwner(
      mailbox,
      newOwner,
    );

    const intentHashTransactionId =
      await this.signAndBroadcast(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public populateCreateValidatorAnnounce(mailbox: string) {
    return this.createCallFunctionManifest(
      packageAddress,
      'ValidatorAnnounce',
      'instantiate',
      [address(mailbox)],
    );
  }

  public async createValidatorAnnounce(mailbox: string) {
    const transactionManifest = this.populateCreateValidatorAnnounce(mailbox);

    const intentHashTransactionId =
      await this.signAndBroadcast(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public populateSetRequiredHook(mailbox: string, hook: string) {
    return this.createCallMethodManifest(mailbox, 'set_required_hook', [
      address(hook),
    ]);
  }

  public async setRequiredHook(mailbox: string, hook: string) {
    const transactionManifest = this.populateSetRequiredHook(mailbox, hook);

    await this.signAndBroadcast(transactionManifest);
  }

  public populateSetDefaultHook(mailbox: string, hook: string) {
    return this.createCallMethodManifest(mailbox, 'set_default_hook', [
      address(hook),
    ]);
  }

  public async setDefaultHook(mailbox: string, hook: string) {
    const transactionManifest = this.populateSetDefaultHook(mailbox, hook);

    await this.signAndBroadcast(transactionManifest);
  }

  public populateSetDefaultIsm(mailbox: string, ism: string) {
    return this.createCallMethodManifest(mailbox, 'set_default_ism', [
      address(ism),
    ]);
  }

  public async setDefaultIsm(mailbox: string, ism: string) {
    const transactionManifest = this.populateSetDefaultIsm(mailbox, ism);

    await this.signAndBroadcast(transactionManifest);
  }

  public populateCreateCollateralToken(mailbox: string, originDenom: string) {
    return this.createCallFunctionManifest(
      packageAddress,
      'HypToken',
      'instantiate',
      [enumeration(0, address(originDenom)), address(mailbox)],
    );
  }

  public async createCollateralToken(mailbox: string, originDenom: string) {
    const transactionManifest = this.populateCreateCollateralToken(
      mailbox,
      originDenom,
    );

    const intentHashTransactionId =
      await this.signAndBroadcast(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public populateCreateSyntheticToken(
    mailbox: string,
    name: string,
    symbol: string,
    description: string,
    divisibility: number,
  ) {
    return this.createCallFunctionManifest(
      packageAddress,
      'HypToken',
      'instantiate',
      [
        enumeration(
          1,
          tuple(str(name), str(symbol), str(description), u8(divisibility)),
        ),
        address(mailbox),
      ],
    );
  }

  public async createSyntheticToken(
    mailbox: string,
    name: string,
    symbol: string,
    description: string,
    divisibility: number,
  ) {
    const transactionManifest = this.populateCreateSyntheticToken(
      mailbox,
      name,
      symbol,
      description,
      divisibility,
    );

    const intentHashTransactionId =
      await this.signAndBroadcast(transactionManifest);

    return await this.getNewComponent(intentHashTransactionId);
  }

  public async populateSetTokenIsm(token: string, ism: string) {
    return this.createCallMethodManifestWithOwner(token, 'set_ism', [
      enumeration(1, address(ism)),
    ]);
  }

  public async setTokenIsm(token: string, ism: string) {
    const transactionManifest = await this.populateSetTokenIsm(token, ism);

    await this.signAndBroadcast(transactionManifest);
  }

  public async populateEnrollRemoteRouter(
    token: string,
    receiverDomain: number,
    receiverAddress: string,
    gas: string,
  ) {
    return this.createCallMethodManifestWithOwner(
      token,
      'enroll_remote_router',
      [u32(receiverDomain), bytes(strip0x(receiverAddress)), decimal(gas)],
    );
  }

  public async enrollRemoteRouter(
    token: string,
    receiverDomain: number,
    receiverAddress: string,
    gas: string,
  ) {
    const transactionManifest = await this.populateEnrollRemoteRouter(
      token,
      receiverDomain,
      receiverAddress,
      gas,
    );

    await this.signAndBroadcast(transactionManifest);
  }

  public async populateUnrollRemoteRouter(
    token: string,
    receiverDomain: number,
  ) {
    return this.createCallMethodManifestWithOwner(
      token,
      'unroll_remote_router',
      [u32(receiverDomain)],
    );
  }

  public async unrollRemoteRouter(token: string, receiverDomain: number) {
    const transactionManifest = await this.populateUnrollRemoteRouter(
      token,
      receiverDomain,
    );

    await this.signAndBroadcast(transactionManifest);
  }
}

// TODO: RADIX
// const main = async () => {
//   const sdk = await RadixSigningSDK.fromPrivateKey(
//     '4f61d7cd8c2bebd01ff86da87001cbe0a2349fa5ba43ef95eee5d0d817b035cc',
//     {
//       networkId: NetworkId.Stokenet,
//     },
//   );

//   const balance = await sdk.getXrdBalance(sdk.getAddress());
//   console.log('xrd balance', balance);
// await sdk.getTestnetXrd();

// const mailbox = await sdk.createMailbox(75898670);
// console.log('created mailbox with id', mailbox, '\n');

// const merkleTreeHook = await sdk.createMerkleTreeHook(mailbox);
// console.log('created merkleTreeHook with id', merkleTreeHook, '\n');

// const merkleRootMultisigIsm = await sdk.createMerkleRootMultisigIsm(
//   ['0x0c60e7eCd06429052223C78452F791AAb5C5CAc6'],
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

// const xrd = await sdk.getXrdAddress();
// const collateral = await sdk.createCollateralToken(
//   'component_tdx_2_1cq2vyesapheluv2a796am85cdl7rcgnjkawwkp3axxetv4zcfjzl40',
//   xrd,
// );
// console.log('created collateral token with id', collateral);

// const c = await sdk.queryToken(
//   'component_tdx_2_1cz57khz7zqlppt4jwng5znvzur47yed474h5ck9mdudwdwh2ux8n80',
// );
// console.log('collateral token state', JSON.stringify(c), '\n');

// await sdk.setTokenIsm(
//   'component_tdx_2_1cz57khz7zqlppt4jwng5znvzur47yed474h5ck9mdudwdwh2ux8n80',
//   'component_tdx_2_1czefsgch7kvgvlw2ht5shkna00vjfaexr03xavlcuy73yka6rydr6g',
// );

// const synthetic = await sdk.createSyntheticToken(
//   'component_tdx_2_1cq2vyesapheluv2a796am85cdl7rcgnjkawwkp3axxetv4zcfjzl40',
//   '',
//   '',
//   '',
//   1,
// );
// console.log('created synthetic token with id', synthetic);

//   const s = await sdk.queryToken(
//     'component_tdx_2_1czxew56q0yglq62tvvapyr5gqp8vcswlwzh62999ahrr35gc5jxg32',
//   );
//   console.log('synthetic token state', JSON.stringify(s));

//   await sdk.enrollRemoteRouter(
//     'component_tdx_2_1czxew56q0yglq62tvvapyr5gqp8vcswlwzh62999ahrr35gc5jxg32',
//     1337,
//     '0000000000000000000000000000000000000000000000000000000000000001',
//     '100',
//   );

//   const r = await sdk.queryEnrolledRouters(
//     'component_tdx_2_1czxew56q0yglq62tvvapyr5gqp8vcswlwzh62999ahrr35gc5jxg32',
//     1337,
//   );
//   console.log('query enrolled router', JSON.stringify(r));
// };

// main();
