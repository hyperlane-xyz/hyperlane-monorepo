import { CostingParameters, FeeSummary } from '@radixdlt/babylon-core-api-sdk';
import {
  GatewayApiClient,
  TransactionStatusResponse,
} from '@radixdlt/babylon-gateway-api-sdk';
import {
  LTSRadixEngineToolkit,
  PrivateKey,
  RadixEngineToolkit,
  TransactionManifest,
  generateRandomNonce,
} from '@radixdlt/radix-engine-toolkit';
import { utils } from 'ethers';

import { assert } from '@hyperlane-xyz/utils';

export class RadixBase {
  protected networkId: number;
  protected gateway: GatewayApiClient;

  constructor(networkId: number, gateway: GatewayApiClient) {
    this.networkId = networkId;
    this.gateway = gateway;
  }

  public async getXrdAddress() {
    const knownAddresses = await LTSRadixEngineToolkit.Derive.knownAddresses(
      this.networkId,
    );
    return knownAddresses.resources.xrdResource;
  }

  public async isGatewayHealthy(): Promise<boolean> {
    const status = await this.gateway.status.getCurrent();
    return status.ledger_state.state_version > 0;
  }

  public async estimateTransactionFee({
    transactionManifest,
  }: {
    transactionManifest: TransactionManifest;
  }): Promise<{ gasUnits: bigint; gasPrice: bigint; fee: bigint }> {
    const pk = new PrivateKey.Ed25519(new Uint8Array(utils.randomBytes(32)));
    const constructionMetadata =
      await this.gateway.transaction.innerClient.transactionConstruction();

    const manifest = (
      await RadixEngineToolkit.Instructions.convert(
        transactionManifest.instructions,
        this.networkId,
        'String',
      )
    ).value as string;

    const response =
      await this.gateway.transaction.innerClient.transactionPreview({
        transactionPreviewRequest: {
          manifest,
          nonce: generateRandomNonce(),
          signer_public_keys: [
            {
              key_type: 'EddsaEd25519',
              key_hex: pk.publicKeyHex(),
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
    const fee =
      (BigInt(fee_summary.xrd_total_execution_cost) +
        BigInt(fee_summary.xrd_total_finalization_cost) +
        BigInt(fee_summary.xrd_total_storage_cost)) *
      10n ** 18n;
    const gasPrice = BigInt(
      (parseFloat(costing_parameters.execution_cost_unit_price) +
        parseFloat(costing_parameters.finalization_cost_unit_price)) *
        0.5,
    ); // average out the cost parameters to get a more accurate estimate

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
    divisibility: number;
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
      divisibility: (details.details as any).divisibility as number,
    };

    return result;
  }

  public async getXrdMetadata(): Promise<{
    name: string;
    symbol: string;
    description: string;
    divisibility: number;
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

    const { divisibility } = await this.getMetadata({ resource });

    return (
      BigInt(fungibleResource.vaults.items[0].amount) *
      10n ** BigInt(divisibility)
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

    const { divisibility } = await this.getMetadata({ resource });

    return (
      BigInt((details.details as any).total_supply) *
      10n ** BigInt(divisibility)
    );
  }

  public async getXrdTotalSupply(): Promise<bigint> {
    const xrdAddress = await this.getXrdAddress();
    return this.getTotalSupply({ resource: xrdAddress });
  }

  public async pollForCommit(intentHashTransactionId: string): Promise<void> {
    const pollAttempts = 500;
    const pollDelayMs = 10000;

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
}
