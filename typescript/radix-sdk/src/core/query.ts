import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import {
  PrivateKey,
  generateRandomNonce,
} from '@radixdlt/radix-engine-toolkit';
import { utils } from 'ethers';

import { assert, strip0x } from '@hyperlane-xyz/utils';

import { getMultisigIsmConfig } from '../ism/query.js';
import { RadixBase } from '../utils/base.js';
import {
  EntityDetails,
  EntityField,
  Hooks,
  Isms,
  MultisigIsms,
  RadixHookTypes,
  Receipt,
} from '../utils/types.js';

export class RadixCoreQuery {
  protected networkId: number;
  protected gateway: GatewayApiClient;
  protected base: RadixBase;

  constructor(networkId: number, gateway: GatewayApiClient, base: RadixBase) {
    this.networkId = networkId;
    this.gateway = gateway;
    this.base = base;
  }

  public async getMailbox({ mailbox }: { mailbox: string }): Promise<{
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
    const fields = (details.details as EntityDetails).state.fields;

    const ownerResource = (details.details as EntityDetails).role_assignments
      .owner.rule.access_rule.proof_rule.requirement.resource;

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
        fields.find((f) => f.field_name === 'local_domain')?.value ?? '0',
      ),
      nonce: parseInt(
        fields.find((f) => f.field_name === 'nonce')?.value ?? '0',
      ),
      defaultIsm:
        fields.find((f) => f.field_name === 'default_ism')?.fields?.at(0)
          ?.value ?? '',
      defaultHook:
        fields.find((f) => f.field_name === 'default_hook')?.fields?.at(0)
          ?.value ?? '',
      requiredHook:
        fields.find((f) => f.field_name === 'required_hook')?.fields?.at(0)
          ?.value ?? '',
    };

    return result;
  }

  public async isMessageDelivered({
    mailbox,
    message_id,
  }: {
    mailbox: string;
    message_id: string;
  }): Promise<boolean> {
    const pk = new PrivateKey.Ed25519(new Uint8Array(utils.randomBytes(32)));

    const constructionMetadata =
      await this.gateway.transaction.innerClient.transactionConstruction();

    const response =
      await this.gateway.transaction.innerClient.transactionPreview({
        transactionPreviewRequest: {
          manifest: `
  CALL_METHOD
      Address("${mailbox}")
      "delivered"
      Bytes("${strip0x(message_id)}")
  ;
  `,
          nonce: generateRandomNonce(),
          signer_public_keys: [
            {
              key_type: 'EddsaEd25519',
              key_hex: pk.publicKeyHex(),
            },
          ],
          flags: {
            use_free_credit: true,
          },
          start_epoch_inclusive: constructionMetadata.ledger_state.epoch,
          end_epoch_exclusive: constructionMetadata.ledger_state.epoch + 2,
        },
      });

    assert(
      !(response.receipt as Receipt).error_message,
      `${(response.receipt as Receipt).error_message}`,
    );

    const output = (response.receipt as Receipt).output;
    assert(output.length, `found no output for delivered method`);

    return (output[0].programmatic_json as { value: boolean }).value;
  }

  public async getIsmType({ ism }: { ism: string }): Promise<Isms> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(ism);

    return (details.details as EntityDetails).blueprint_name as Isms;
  }

  public async getMultisigIsm({ ism }: { ism: string }): Promise<{
    address: string;
    type: MultisigIsms;
    threshold: number;
    validators: string[];
  }> {
    return getMultisigIsmConfig(this.gateway, { ismAddress: ism });
  }

  public async getRoutingIsm({ ism }: { ism: string }): Promise<{
    address: string;
    owner: string;
    routes: {
      domainId: number;
      ismAddress: string;
    }[];
  }> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(ism);

    const ownerResource = (details.details as EntityDetails).role_assignments
      .owner.rule.access_rule.proof_rule.requirement.resource;

    const { items: holders } =
      await this.gateway.extensions.getResourceHolders(ownerResource);

    const resourceHolders = [
      ...new Set(holders.map((item) => item.holder_address)),
    ];

    assert(
      resourceHolders.length === 1,
      `expected token holders of resource ${ownerResource} to be one, found ${resourceHolders.length} holders instead`,
    );

    const type = (details.details as EntityDetails).blueprint_name;
    assert(
      type === 'RoutingIsm',
      `ism is not a RoutingIsm, instead got ${type}`,
    );

    const fields = (details.details as EntityDetails).state.fields;

    const routesKeyValueStore =
      fields.find((f) => f.field_name === 'routes')?.value ?? '';
    assert(routesKeyValueStore, `found no routes on RoutingIsm ${ism}`);

    const keys = await this.base.getKeysFromKeyValueStore(routesKeyValueStore);

    const routes = [];

    for (const key of keys) {
      const { entries } =
        await this.gateway.state.innerClient.keyValueStoreData({
          stateKeyValueStoreDataRequest: {
            key_value_store_address: routesKeyValueStore,
            keys: [
              {
                key_hex: key.raw_hex,
              },
            ],
          },
        });

      const domainId = parseInt(
        (key.programmatic_json as EntityField)?.value ?? '0',
      );
      const ismAddress = (entries[0].value.programmatic_json as EntityField)
        .value;

      routes.push({
        domainId,
        ismAddress,
      });
    }

    return {
      address: ism,
      owner: resourceHolders[0],
      routes,
    };
  }

  public async getHookType({ hook }: { hook: string }): Promise<Hooks> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(hook);

    return (details.details as EntityDetails).blueprint_name as Hooks;
  }

  public async getIgpHook({ hook }: { hook: string }): Promise<{
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
      (details.details as EntityDetails).blueprint_name === RadixHookTypes.IGP,
      `Expected contract at address ${hook} to be "${RadixHookTypes.IGP}" but got ${(details.details as EntityDetails).blueprint_name}`,
    );

    const ownerResource = (details.details as EntityDetails).role_assignments
      .owner.rule.access_rule.proof_rule.requirement.resource;

    const { items: holders } =
      await this.gateway.extensions.getResourceHolders(ownerResource);

    const resourceHolders = [
      ...new Set(holders.map((item) => item.holder_address)),
    ];

    assert(
      resourceHolders.length === 1,
      `expected token holders of resource ${ownerResource} to be one, found ${resourceHolders.length} holders instead`,
    );

    const fields = (details.details as EntityDetails).state.fields;

    const destinationGasConfigsKeyValueStore =
      fields.find((f) => f.field_name === 'destination_gas_configs')?.value ??
      '';

    assert(
      destinationGasConfigsKeyValueStore,
      `found no destination gas configs on hook ${hook}`,
    );

    const destinationGasConfigs = {};

    const keys = await this.base.getKeysFromKeyValueStore(
      destinationGasConfigsKeyValueStore,
    );

    for (const key of keys) {
      const { entries } =
        await this.gateway.state.innerClient.keyValueStoreData({
          stateKeyValueStoreDataRequest: {
            key_value_store_address: destinationGasConfigsKeyValueStore,
            keys: [
              {
                key_hex: key.raw_hex,
              },
            ],
          },
        });

      const remoteDomain = (key.programmatic_json as EntityField)?.value ?? '0';

      const gasConfigFields = (
        entries[0].value.programmatic_json as EntityField
      ).fields;

      const gasOracleFields =
        gasConfigFields?.find((r) => r.field_name === 'gas_oracle')?.fields ??
        [];

      Object.assign(destinationGasConfigs, {
        [remoteDomain]: {
          gasOracle: {
            tokenExchangeRate:
              gasOracleFields.find(
                (r) => r.field_name === 'token_exchange_rate',
              )?.value ?? '0',
            gasPrice:
              gasOracleFields.find((r) => r.field_name === 'gas_price')
                ?.value ?? '0',
          },
          gasOverhead:
            gasConfigFields?.find((r) => r.field_name === 'gas_overhead')
              ?.value ?? '0',
        },
      });
    }

    return {
      address: hook,
      owner: resourceHolders[0],
      destinationGasConfigs,
    };
  }

  public async getMerkleTreeHook({ hook }: { hook: string }): Promise<{
    address: string;
  }> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(hook);

    assert(
      (details.details as EntityDetails).blueprint_name ===
        RadixHookTypes.MERKLE_TREE,
      `Expected contract at address ${hook} to be "${RadixHookTypes.MERKLE_TREE}" but got ${(details.details as EntityDetails).blueprint_name}`,
    );

    return {
      address: hook,
    };
  }
}
