import {
  PrivateKey,
  generateRandomNonce,
} from '@radixdlt/radix-engine-toolkit';
import { BigNumber } from 'bignumber.js';
import { utils } from 'ethers';

import { assert, ensure0x } from '@hyperlane-xyz/utils';

import {
  EntityDetails,
  EntityField,
  Isms,
  MultisigIsms,
  Receipt,
} from '../types.js';

import { RadixBase } from './base.js';

export class RadixQuery extends RadixBase {
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

  public async getToken({ token }: { token: string }): Promise<{
    address: string;
    owner: string;
    token_type: 'Collateral' | 'Synthetic';
    mailbox: string;
    ism: string;
    origin_denom: string;
    name: string;
    symbol: string;
    description: string;
    divisibility: number;
  }> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(token);

    assert(
      (details.details as EntityDetails).blueprint_name === 'HypToken',
      `Expected contract at address ${token} to be "HypToken" but got ${(details.details as EntityDetails).blueprint_name}`,
    );

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

    const fields = (details.details as EntityDetails).state.fields;

    const token_type =
      fields.find((f) => f.field_name === 'token_type')?.variant_name ?? '';
    assert(
      token_type === 'Collateral' || token_type === 'Synthetic',
      `unknown token type: ${token_type}`,
    );

    const ismFields = fields.find((f) => f.field_name === 'ism')?.fields ?? [];

    const tokenTypeFields =
      fields.find((f) => f.field_name === 'token_type')?.fields ?? [];

    let origin_denom;
    let metadata = {
      name: '',
      symbol: '',
      description: '',
      divisibility: 0,
    };

    if (token_type === 'Collateral') {
      origin_denom =
        tokenTypeFields.find((t) => t.type_name === 'ResourceAddress')?.value ??
        '';

      metadata = await this.getMetadata({ resource: origin_denom });
    } else if (token_type === 'Synthetic') {
      origin_denom =
        (
          fields.find((f) => f.field_name === 'resource_manager')?.fields ?? []
        ).find((r) => r.type_name === 'ResourceAddress')?.value ?? '';

      metadata = await this.getMetadata({ resource: origin_denom });
    }

    const result = {
      address: token,
      owner: resourceHolders[0],
      token_type: token_type as 'Collateral' | 'Synthetic',
      mailbox: fields.find((f) => f.field_name === 'mailbox')?.value ?? '',
      ism: ismFields[0]?.value ?? '',
      origin_denom,
      ...metadata,
    };

    return result;
  }

  public async getRemoteRouters({ token }: { token: string }): Promise<{
    address: string;
    remote_routers: {
      receiver_domain: string;
      receiver_contract: string;
      gas: string;
    }[];
  }> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(token);

    assert(
      (details.details as EntityDetails).blueprint_name === 'HypToken',
      `Expected contract at address ${token} to be "HypToken" but got ${(details.details as EntityDetails).blueprint_name}`,
    );

    const fields = (details.details as EntityDetails).state.fields;

    const enrolledRoutersKeyValueStore =
      fields.find((f) => f.field_name === 'enrolled_routers')?.value ?? '';
    assert(
      enrolledRoutersKeyValueStore,
      `found no enrolled routers on token ${token}`,
    );

    const remote_routers = [];

    const { items } = await this.gateway.state.innerClient.keyValueStoreKeys({
      stateKeyValueStoreKeysRequest: {
        key_value_store_address: enrolledRoutersKeyValueStore,
      },
    });

    for (const { key } of items) {
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

      const routerFields =
        (entries[0].value.programmatic_json as EntityField)?.fields ?? [];

      remote_routers.push({
        receiver_domain:
          routerFields.find((r) => r.field_name === 'domain')?.value ?? '',
        receiver_contract:
          routerFields.find((r) => r.field_name === 'recipient')?.hex ?? '',
        gas: routerFields.find((r) => r.field_name === 'gas')?.value ?? '',
      });
    }

    const result = {
      address: token,
      remote_routers,
    };

    return result;
  }

  public async getBridgedSupply({ token }: { token: string }): Promise<bigint> {
    const { token_type, origin_denom } = await this.getToken({ token });

    switch (token_type) {
      case 'Collateral': {
        // if the token is collateral we get the token contract balance
        // of the origin denom
        return this.getBalance({ address: token, resource: origin_denom });
      }
      case 'Synthetic': {
        // if the token is synthetic we get the total supply of the synthetic
        // resource
        return this.getTotalSupply({ resource: origin_denom });
      }
      default: {
        throw new Error(`unknown token type: ${token_type}`);
      }
    }
  }

  public async quoteRemoteTransfer({
    token,
    destination_domain,
  }: {
    token: string;
    destination_domain: number;
  }): Promise<{ resource: string; amount: bigint }> {
    const pk = new PrivateKey.Ed25519(new Uint8Array(utils.randomBytes(32)));

    const constructionMetadata =
      await this.gateway.transaction.innerClient.transactionConstruction();

    const response =
      await this.gateway.transaction.innerClient.transactionPreview({
        transactionPreviewRequest: {
          manifest: `
CALL_METHOD
    Address("${token}")
    "quote_remote_transfer"
    ${destination_domain}u32
    Bytes("0000000000000000000000000000000000000000000000000000000000000000")
    Decimal("0")
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
    assert(output.length, `found no output for quote_remote_transfer method`);

    const entries = output[0].programmatic_json.entries;
    assert(entries.length > 0, `quote_remote_transfer returned no resources`);
    assert(
      entries.length < 2,
      `quote_remote_transfer returned multiple resources`,
    );

    return {
      resource: entries[0].key.value,
      amount: BigInt(
        new BigNumber(entries[0].value.value)
          .times(new BigNumber(10).pow(18))
          .integerValue(BigNumber.ROUND_FLOOR)
          .toFixed(0),
      ),
    };
  }
}
