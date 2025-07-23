import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { assert, ensure0x } from '@hyperlane-xyz/utils';

export class RadixQuery {
  protected networkId: number;
  protected gateway: GatewayApiClient;

  constructor(networkId: number, gateway: GatewayApiClient) {
    this.networkId = networkId;
    this.gateway = gateway;
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
      local_domain: parseInt(
        fields.find((f: any) => f.field_name === 'local_domain').value,
      ),
      nonce: parseInt(fields.find((f: any) => f.field_name === 'nonce').value),
      default_ism: fields.find((f: any) => f.field_name === 'default_ism')
        .fields[0].value,
      default_hook: fields.find((f: any) => f.field_name === 'default_hook')
        .fields[0].value,
      required_hook: fields.find((f: any) => f.field_name === 'required_hook')
        .fields[0].value,
    };

    return result;
  }

  public async getIsm({ ism }: { ism: string }): Promise<{
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
    const destination_gas_configs = {};

    const entries: any[] =
      fields.find((f: any) => f.field_name === 'destination_gas_configs')
        ?.entries ?? [];

    for (const entry of entries) {
      const domainId = entry.key.value;

      const gas_overhead =
        entry.value.fields.find((f: any) => f.field_name === 'gas_overhead')
          ?.value ?? '0';

      const gas_oracle =
        entry.value.fields.find((f: any) => f.field_name === 'gas_oracle')
          ?.fields ?? [];

      const token_exchange_rate =
        gas_oracle.find((f: any) => f.field_name === 'token_exchange_rate')
          ?.value ?? '0';

      const gas_price =
        gas_oracle.find((f: any) => f.field_name === 'gas_price')?.value ?? '0';

      Object.assign(destination_gas_configs, {
        [domainId]: {
          gas_oracle: {
            token_exchange_rate,
            gas_price,
          },
          gas_overhead,
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
      (details.details as any).blueprint_name === 'MerkleTreeHook',
      `Expected contract at address ${hook} to be "MerkleTreeHook" but got ${(details.details as any).blueprint_name}`,
    );

    return {
      address: hook,
    };
  }

  public async getToken({ token }: { token: string }): Promise<{
    address: string;
    owner: string;
    token_type: 'COLLATERAL' | 'SYNTHETIC';
    mailbox: string;
    ism: string;
    origin_denom: string;
    name?: string;
    symbol?: string;
    description?: string;
    divisibility?: number;
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

    const token_type =
      fields.find((f: any) => f.field_name === 'token_type')?.variant_name ??
      '';
    assert(
      token_type === 'COLLATERAL' || token_type === 'SYNTHETIC',
      `unknown token type: ${token_type}`,
    );

    const ismFields = fields.find((f: any) => f.field_name === 'ism').fields;

    const tokenTypeFields =
      fields.find((f: any) => f.field_name === 'token_type')?.fields ?? [];

    const name =
      tokenTypeFields.find((t: any) => t.field_name === 'name')?.value ?? '';

    const symbol =
      tokenTypeFields.find((t: any) => t.field_name === 'symbol')?.value ?? '';

    const description =
      tokenTypeFields.find((t: any) => t.field_name === 'description')?.value ??
      '';

    const divisibility = parseInt(
      tokenTypeFields.find((t: any) => t.field_name === 'description')?.value ??
        '0',
    );

    let origin_denom;

    if (token_type === 'COLLATERAL') {
      origin_denom =
        tokenTypeFields.find((t: any) => t.type_name === 'ResourceAddress')
          ?.value ?? '';
    } else if (token_type === 'SYNTHETIC') {
      origin_denom =
        (
          fields.find((f: any) => f.field_name === 'resource_manager')
            ?.fields ?? []
        ).find((r: any) => r.type_name === 'ResourceAddress')?.value ?? '';
    }

    const result = {
      address: token,
      owner: resourceHolders[0],
      token_type,
      mailbox: fields.find((f: any) => f.field_name === 'mailbox')?.value ?? '',
      ism: ismFields[0]?.value ?? '',
      origin_denom,
      name,
      symbol,
      description,
      divisibility,
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

    const remote_routers = [];

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

      remote_routers.push({
        receiver_domain: routerFields.find(
          (r: any) => r.field_name === 'domain',
        ).value,
        receiver_contract: routerFields.find(
          (r: any) => r.field_name === 'recipient',
        ).hex,
        gas: routerFields.find((r: any) => r.field_name === 'gas').value,
      });
    }

    const result = {
      address: token,
      remote_routers,
    };

    return result;
  }
}
