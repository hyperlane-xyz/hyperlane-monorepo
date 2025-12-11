import { CostingParameters, FeeSummary } from '@radixdlt/babylon-core-api-sdk';
import {
  GatewayApiClient,
  TransactionStatusResponse,
} from '@radixdlt/babylon-gateway-api-sdk';
import {
  LTSRadixEngineToolkit,
  ManifestBuilder,
  ManifestSborStringRepresentation,
  RadixEngineToolkit,
  TransactionManifest,
  Value,
  address,
  bucket,
  decimal,
  enumeration,
  expression,
  generateRandomNonce,
} from '@radixdlt/radix-engine-toolkit';
import { BigNumber } from 'bignumber.js';
import { Decimal } from 'decimal.js';

import { assert } from '@hyperlane-xyz/utils';

import { READ_ACCOUNT_HEX_PUBLIC_KEY } from './constants.js';
import { EntityDetails, INSTRUCTIONS, RadixSDKReceipt } from './types.js';
import { stringToTransactionManifest } from './utils.js';

export class RadixBase {
  protected networkId: number;
  protected gateway: GatewayApiClient;
  protected gasMultiplier: number;
  protected hyperlanePackageDefAddress: string;

  constructor(
    networkId: number,
    gateway: GatewayApiClient,
    gasMultiplier: number,
    hyperlanePackageDefAddress: string,
  ) {
    this.networkId = networkId;
    this.gateway = gateway;
    this.gasMultiplier = gasMultiplier;
    this.hyperlanePackageDefAddress = hyperlanePackageDefAddress;
  }

  public async getXrdAddress() {
    const knownAddresses = await LTSRadixEngineToolkit.Derive.knownAddresses(
      this.networkId,
    );
    return knownAddresses.resources.xrdResource;
  }

  public getHyperlanePackageDefAddress(): string {
    return this.hyperlanePackageDefAddress;
  }

  public async isGatewayHealthy(): Promise<boolean> {
    const status = await this.gateway.status.getCurrent();
    return status.ledger_state.state_version > 0;
  }

  // Code adapted from:
  // https://github.com/radixdlt/typescript-radix-engine-toolkit/blob/34f04995ef897d3f2a672a6373eea4b379afc793/src/lts/builders.ts#L122
  public async createXrdFaucetTransactionManifest(
    toAccount: string,
    amount: number = 10000,
  ): Promise<TransactionManifest> {
    const knownAddresses = await LTSRadixEngineToolkit.Derive.knownAddresses(
      this.networkId,
    );
    const faucetComponentAddress = knownAddresses.components.faucet;
    const xrdResourceAddress = knownAddresses.resources.xrdResource;

    return new ManifestBuilder()
      .callMethod(faucetComponentAddress, 'lock_fee', [decimal('10')])
      .callMethod(faucetComponentAddress, 'free', [])
      .takeFromWorktop(
        xrdResourceAddress,
        new Decimal(amount),
        (builder, bucketId) => {
          return builder.callMethod(toAccount, 'try_deposit_or_abort', [
            bucket(bucketId),
            enumeration(0),
          ]);
        },
      )
      .build();
  }

  public async getStateVersion(): Promise<number> {
    const status = await this.gateway.status.getCurrent();
    return status.ledger_state.state_version;
  }

  public async estimateTransactionFee({
    transactionManifest,
  }: {
    transactionManifest: TransactionManifest | string;
  }): Promise<{ gasUnits: bigint; gasPrice: number; fee: bigint }> {
    const constructionMetadata =
      await this.gateway.transaction.innerClient.transactionConstruction();

    const manifest =
      typeof transactionManifest === 'string'
        ? transactionManifest
        : ((
            await RadixEngineToolkit.Instructions.convert(
              transactionManifest.instructions,
              this.networkId,
              'String',
            )
          ).value as string);

    const response =
      await this.gateway.transaction.innerClient.transactionPreview({
        transactionPreviewRequest: {
          manifest,
          nonce: generateRandomNonce(),
          signer_public_keys: [
            {
              key_type: 'EddsaEd25519',
              key_hex: READ_ACCOUNT_HEX_PUBLIC_KEY,
            },
          ],
          flags: {
            use_free_credit: true,
            // we have to enable this flag because the signer of the tx is a random pk
            // this allows us to simulate txs for different addresses - even if we don't have accesse to their public key
            assume_all_signature_proofs: true,
          },
          start_epoch_inclusive: constructionMetadata.ledger_state.epoch,
          end_epoch_exclusive: constructionMetadata.ledger_state.epoch + 2,
        },
      });

    assert(
      !(response.receipt as any).error_message,
      `${(response.receipt as any).error_message}`,
    );

    const fee_summary: FeeSummary = (response.receipt as any).fee_summary;
    const costing_parameters: CostingParameters = (response.receipt as any)
      .costing_parameters;

    const gasUnits =
      BigInt(fee_summary.execution_cost_units_consumed) +
      BigInt(fee_summary.finalization_cost_units_consumed);
    const fee = BigInt(
      new BigNumber(fee_summary.xrd_total_execution_cost)
        .plus(BigNumber(fee_summary.xrd_total_finalization_cost))
        .plus(BigNumber(fee_summary.xrd_total_storage_cost))
        .times(new BigNumber(10).exponentiatedBy(18))
        .toFixed(0),
    );
    const gasPrice =
      (parseFloat(costing_parameters.execution_cost_unit_price) +
        parseFloat(costing_parameters.finalization_cost_unit_price)) *
      0.5; // average out the cost parameters to get a more accurate estimate

    return {
      gasUnits,
      fee,
      gasPrice,
    };
  }

  public async getMetadata({ resource }: { resource: string }): Promise<{
    name: string;
    symbol: string;
    description: string;
    decimals: number;
  }> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(resource);

    const result = {
      name:
        (
          details.metadata.items.find((i) => i.key === 'name')?.value
            .typed as any
        ).value ?? '',
      symbol:
        (
          details.metadata.items.find((i) => i.key === 'symbol')?.value
            .typed as any
        ).value ?? '',
      description:
        (
          details.metadata.items.find((i) => i.key === 'description')?.value
            .typed as any
        ).value ?? '',
      decimals: (details.details as any).divisibility as number,
    };

    return result;
  }

  public async getXrdMetadata(): Promise<{
    name: string;
    symbol: string;
    description: string;
    decimals: number;
  }> {
    const xrdAddress = await this.getXrdAddress();
    return this.getMetadata({ resource: xrdAddress });
  }

  public async getBalance({
    address,
    resource,
  }: {
    address: string;
    resource: string;
  }): Promise<bigint> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(address);

    const fungibleResource = details.fungible_resources.items.find(
      (r) => r.resource_address === resource,
    );

    if (!fungibleResource) {
      return BigInt(0);
    }

    if (fungibleResource.vaults.items.length !== 1) {
      return BigInt(0);
    }

    const { decimals } = await this.getMetadata({ resource });

    return BigInt(
      new BigNumber(fungibleResource.vaults.items[0].amount)
        .times(new BigNumber(10).exponentiatedBy(decimals))
        .toFixed(0),
    );
  }

  public async getXrdBalance({
    address,
  }: {
    address: string;
  }): Promise<bigint> {
    const xrdAddress = await this.getXrdAddress();
    return this.getBalance({ address, resource: xrdAddress });
  }

  public async getTotalSupply({
    resource,
  }: {
    resource: string;
  }): Promise<bigint> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(resource);

    const { decimals } = await this.getMetadata({ resource });

    return BigInt(
      new BigNumber((details.details as any).total_supply)
        .times(new BigNumber(10).exponentiatedBy(decimals))
        .toFixed(0),
    );
  }

  public async getXrdTotalSupply(): Promise<bigint> {
    const xrdAddress = await this.getXrdAddress();
    return this.getTotalSupply({ resource: xrdAddress });
  }

  public async pollForCommit(
    intentHashTransactionId: string,
  ): Promise<RadixSDKReceipt> {
    // we try to poll for 2 minutes
    const pollAttempts = 120;
    const pollDelayMs = 1000;

    for (let i = 0; i < pollAttempts; i++) {
      let statusOutput: TransactionStatusResponse;

      try {
        statusOutput =
          await this.gateway.transaction.innerClient.transactionStatus({
            transactionStatusRequest: { intent_hash: intentHashTransactionId },
          });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
        continue;
      }

      switch (statusOutput.intent_status) {
        case 'Pending': {
          await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
          continue;
        }
        case 'LikelyButNotCertainRejection': {
          if (statusOutput.error_message) {
            throw new Error(
              `Transaction ${intentHashTransactionId} was not committed successfully - instead it resulted in: ${statusOutput.intent_status} with description: ${statusOutput.error_message}`,
            );
          }

          await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
          continue;
        }
        case 'CommittedSuccess': {
          try {
            const committedDetails =
              await this.gateway.transaction.getCommittedDetails(
                intentHashTransactionId,
              );

            return {
              ...committedDetails,
              transactionHash: intentHashTransactionId,
            };
          } catch {
            await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
            continue;
          }
        }
        case 'CommittedFailure': {
          // You will typically wish to build a new transaction and try again.
          throw new Error(
            `Transaction ${intentHashTransactionId} was not committed successfully - instead it resulted in: ${statusOutput.intent_status} with description: ${statusOutput.error_message}`,
          );
        }
        case 'CommitPendingOutcomeUnknown': {
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

    throw new Error(`reached poll limit of ${pollAttempts} attempts`);
  }

  public async getNewComponent(receipt: RadixSDKReceipt): Promise<string> {
    const r = receipt.transaction.receipt;
    assert(r, `found no receipt on transaction: ${receipt.transactionHash}`);

    const newGlobalGenericComponent = (
      r.state_updates as any
    ).new_global_entities.find(
      (entity: { entity_type: string }) =>
        entity.entity_type === 'GlobalGenericComponent',
    );
    assert(
      newGlobalGenericComponent,
      `found no newly created component on transaction: ${receipt.transactionHash}`,
    );

    return newGlobalGenericComponent.entity_address;
  }

  public async createCallFunctionManifest(
    from_address: string,
    package_address: string | number,
    blueprint_name: string,
    function_name: string,
    args: Value[],
  ) {
    const simulationManifest = new ManifestBuilder()
      .callMethod(from_address, INSTRUCTIONS.LOCK_FEE, [decimal(0)])
      .callFunction(package_address, blueprint_name, function_name, args)
      .callMethod(from_address, INSTRUCTIONS.TRY_DEPOSIT_BATCH_OR_ABORT, [
        expression('EntireWorktop'),
        enumeration(0),
      ])
      .build();

    const { fee } = await this.estimateTransactionFee({
      transactionManifest: simulationManifest,
    });

    return new ManifestBuilder()
      .callMethod(from_address, INSTRUCTIONS.LOCK_FEE, [
        decimal(
          new BigNumber(fee.toString())
            .times(this.gasMultiplier)
            .dividedBy(new BigNumber(10).exponentiatedBy(18))
            .toFixed(),
        ),
      ])
      .callFunction(package_address, blueprint_name, function_name, args)
      .callMethod(from_address, INSTRUCTIONS.TRY_DEPOSIT_BATCH_OR_ABORT, [
        expression('EntireWorktop'),
        enumeration(0),
      ])
      .build();
  }

  public async createCallMethodManifestWithOwner(
    from_address: string,
    contract_address: string,
    method_name: string,
    args: Value[],
  ) {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(
        contract_address,
      );

    const ownerResource = (details.details as EntityDetails).role_assignments
      .owner.rule.access_rule.proof_rule.requirement.resource;

    const simulationManifest = new ManifestBuilder()
      .callMethod(from_address, INSTRUCTIONS.LOCK_FEE, [decimal(0)])
      .callMethod(from_address, INSTRUCTIONS.CREATE_PROOF_OF_AMOUNT, [
        address(ownerResource),
        decimal(1),
      ])
      .callMethod(contract_address, method_name, args)
      .callMethod(from_address, INSTRUCTIONS.TRY_DEPOSIT_BATCH_OR_ABORT, [
        expression('EntireWorktop'),
        enumeration(0),
      ])
      .build();

    const { fee } = await this.estimateTransactionFee({
      transactionManifest: simulationManifest,
    });

    return new ManifestBuilder()
      .callMethod(from_address, INSTRUCTIONS.LOCK_FEE, [
        decimal(
          new BigNumber(fee.toString())
            .times(this.gasMultiplier)
            .dividedBy(new BigNumber(10).exponentiatedBy(18))
            .toFixed(),
        ),
      ])
      .callMethod(from_address, INSTRUCTIONS.CREATE_PROOF_OF_AMOUNT, [
        address(ownerResource),
        decimal(1),
      ])
      .callMethod(contract_address, method_name, args)
      .callMethod(from_address, INSTRUCTIONS.TRY_DEPOSIT_BATCH_OR_ABORT, [
        expression('EntireWorktop'),
        enumeration(0),
      ])
      .build();
  }

  public async transfer({
    from_address,
    to_address,
    resource_address,
    amount,
  }: {
    from_address: string;
    to_address: string;
    resource_address: string;
    /**
     * The amount MUST be in decimal representation
     */
    amount: string;
  }) {
    const simulationManifest = new ManifestBuilder()
      .callMethod(from_address, INSTRUCTIONS.LOCK_FEE, [decimal(0)])
      .callMethod(from_address, INSTRUCTIONS.WITHDRAW, [
        address(resource_address),
        decimal(amount),
      ])
      .takeFromWorktop(
        resource_address,
        new Decimal(amount),
        (builder, bucketId) =>
          builder.callMethod(to_address, INSTRUCTIONS.TRY_DEPOSIT_OR_ABORT, [
            bucket(bucketId),
            enumeration(0),
          ]),
      )
      .build();

    const { fee } = await this.estimateTransactionFee({
      transactionManifest: simulationManifest,
    });

    return new ManifestBuilder()
      .callMethod(from_address, INSTRUCTIONS.LOCK_FEE, [
        decimal(
          new BigNumber(fee.toString())
            .times(this.gasMultiplier)
            .dividedBy(new BigNumber(10).exponentiatedBy(18))
            .toFixed(),
        ),
      ])
      .callMethod(from_address, INSTRUCTIONS.WITHDRAW, [
        address(resource_address),
        decimal(amount),
      ])
      .takeFromWorktop(
        resource_address,
        new Decimal(amount),
        (builder, bucketId) =>
          builder.callMethod(to_address, INSTRUCTIONS.TRY_DEPOSIT_OR_ABORT, [
            bucket(bucketId),
            enumeration(0),
          ]),
      )
      .build();
  }

  // TS implementation of the publish_package_advanced method as it is not exposed/implemented in the TS Radix toolkit SDK
  // see: https://github.com/radixdlt/radixdlt-scrypto/blob/92c7db3e1bf79f99abaa9e1217451548d3feb63d/radix-transactions/src/builder/manifest_builder.rs#L1484-L1507
  public async createPublishPackageManifest(params: {
    from_address: string;
    code: Uint8Array;
    packageDefinition: Uint8Array;
  }): Promise<TransactionManifest> {
    const { from_address, code, packageDefinition } = params;

    // This should be the manifest representation of the package definition
    const decodedManifestPackageDefinition =
      await RadixEngineToolkit.ManifestSbor.decodeToString(
        packageDefinition,
        this.networkId,
        ManifestSborStringRepresentation.ManifestString,
      );

    // Using the hash method from the radix toolkit package
    // as it uses the blake32 algorithm
    // see:
    // - https://github.com/radixdlt/radixdlt-scrypto/blob/92c7db3e1bf79f99abaa9e1217451548d3feb63d/radix-common/src/crypto/hash.rs#L69-L71
    const codeHashHex = Buffer.from(
      LTSRadixEngineToolkit.Utils.hash(code),
    ).toString('hex');

    // The arguments of the PUBLISH_PACKAGE_ADVANCED function are:
    // owner rule definition
    // package definition
    // blake32 hash of the compiled code
    // metadata
    // Address reservation for the published package
    // see: https://docs.radixdlt.com/docs/manifest-instructions#:~:text=COPY-,PUBLISH_PACKAGE_ADVANCED,-(alias)
    const manifestString = `
      CALL_METHOD
          Address("${from_address}")
          "lock_fee"
          Decimal("160");

      PUBLISH_PACKAGE_ADVANCED
          Enum<0u8>()
          ${decodedManifestPackageDefinition}
          Blob("${codeHashHex}")
          Map<String, Tuple>()
          Enum<0u8>();

      CALL_METHOD
          Address("${from_address}")
          "try_deposit_batch_or_abort"
          Expression("ENTIRE_WORKTOP")
          Enum<0u8>();
      `;

    const manifest = await stringToTransactionManifest(
      manifestString,
      this.networkId,
    );

    // Workaround to access the private blobs property as the
    // TransactionManifestBuilder does not expose a method for
    // registering a blob as the Rust implementation does
    // see:
    // - https://github.com/radixdlt/radixdlt-scrypto/blob/92c7db3e1bf79f99abaa9e1217451548d3feb63d/radix-transactions/src/builder/manifest_builder.rs#L1484-L1507
    // - https://github.com/radixdlt/radixdlt-scrypto/blob/92c7db3e1bf79f99abaa9e1217451548d3feb63d/radix-transactions/src/builder/manifest_builder.rs#L333-L336
    manifest['blobs'].push(code);

    return manifest;
  }
}
