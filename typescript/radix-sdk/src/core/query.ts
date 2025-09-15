import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { assert, ensure0x } from '@hyperlane-xyz/utils';

import { RadixBase } from '../utils/base.js';
import {
  EntityDetails,
  EntityField,
  Isms,
  MultisigIsms,
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
    local_domain: number;
    nonce: number;
    default_ism: string;
    default_hook: string;
    required_hook: string;
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
      local_domain: parseInt(
        fields.find((f) => f.field_name === 'local_domain')?.value ?? '0',
      ),
      nonce: parseInt(
        fields.find((f) => f.field_name === 'nonce')?.value ?? '0',
      ),
      default_ism:
        fields.find((f) => f.field_name === 'default_ism')?.fields?.at(0)
          ?.value ?? '',
      default_hook:
        fields.find((f) => f.field_name === 'default_hook')?.fields?.at(0)
          ?.value ?? '',
      required_hook:
        fields.find((f) => f.field_name === 'required_hook')?.fields?.at(0)
          ?.value ?? '',
    };

    return result;
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
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(ism);

    const fields = (details.details as EntityDetails).state.fields;

    const result = {
      address: ism,
      type: (details.details as EntityDetails).blueprint_name as MultisigIsms,
      validators: (
        fields.find((f) => f.field_name === 'validators')?.elements ?? []
      ).map((v) => ensure0x(v.hex)),
      threshold: parseInt(
        fields.find((f) => f.field_name === 'threshold')?.value ?? '0',
      ),
    };

    return result;
  }

  public async getRoutingIsm({ ism }: { ism: string }): Promise<{
    address: string;
    owner: string;
    routes: {
      domain: number;
      ism: string;
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

    const { items } = await this.gateway.state.innerClient.keyValueStoreKeys({
      stateKeyValueStoreKeysRequest: {
        key_value_store_address: routesKeyValueStore,
      },
    });

    const routes = [];

    for (const { key } of items) {
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

      const domain = parseInt(
        (key.programmatic_json as EntityField)?.value ?? '0',
      );
      const ism = (entries[0].value.programmatic_json as EntityField).value;

      routes.push({
        domain,
        ism,
      });
    }

    return {
      address: ism,
      owner: resourceHolders[0],
      routes,
    };
  }

  public async getIgpHook({ hook }: { hook: string }): Promise<{
    address: string;
    owner: string;
    destination_gas_configs: {
      [domain_id: string]: {
        gas_oracle: {
          token_exchange_rate: string;
          gas_price: string;
        };
        gas_overhead: string;
      };
    };
  }> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(hook);

    assert(
      (details.details as EntityDetails).blueprint_name ===
        'InterchainGasPaymaster',
      `Expected contract at address ${hook} to be "InterchainGasPaymaster" but got ${(details.details as EntityDetails).blueprint_name}`,
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

    const destination_gas_configs = {};

    const { items } = await this.gateway.state.innerClient.keyValueStoreKeys({
      stateKeyValueStoreKeysRequest: {
        key_value_store_address: destinationGasConfigsKeyValueStore,
      },
    });

    for (const { key } of items) {
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

      Object.assign(destination_gas_configs, {
        [remoteDomain]: {
          gas_oracle: {
            token_exchange_rate:
              gasOracleFields.find(
                (r) => r.field_name === 'token_exchange_rate',
              )?.value ?? '0',
            gas_price:
              gasOracleFields.find((r) => r.field_name === 'gas_price')
                ?.value ?? '0',
          },
          gas_overhead:
            gasConfigFields?.find((r) => r.field_name === 'gas_overhead')
              ?.value ?? '0',
        },
      });
    }

    return {
      address: hook,
      owner: resourceHolders[0],
      destination_gas_configs,
    };
  }

  public async getMerkleTreeHook({ hook }: { hook: string }): Promise<{
    address: string;
  }> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(hook);

    assert(
      (details.details as EntityDetails).blueprint_name === 'MerkleTreeHook',
      `Expected contract at address ${hook} to be "MerkleTreeHook" but got ${(details.details as EntityDetails).blueprint_name}`,
    );

    return {
      address: hook,
    };
  }
}
