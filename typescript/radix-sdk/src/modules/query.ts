import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import {
  LTSRadixEngineToolkit,
  PrivateKey,
  generateRandomNonce,
} from '@radixdlt/radix-engine-toolkit';
import BigNumber from 'bignumber.js';
import { randomBytes } from 'crypto';

import { assert, ensure0x } from '@hyperlane-xyz/utils';

export class RadixQuery {
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

    assert(
      fungibleResource,
      `account with address ${address} has no resource with address ${resource}`,
    );

    if (fungibleResource.vaults.items.length !== 1) {
      return BigInt(0);
    }

    const { divisibility } = await this.getMetadata({ resource });

    return BigInt(
      new BigNumber(fungibleResource.vaults.items[0].amount)
        .times(new BigNumber(10).exponentiatedBy(divisibility))
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

    const { divisibility } = await this.getMetadata({ resource });

    return BigInt(
      new BigNumber((details.details as any).total_supply)
        .times(new BigNumber(10).exponentiatedBy(divisibility))
        .toFixed(0),
    );
  }

  public async getXrdTotalSupply(): Promise<bigint> {
    const xrdAddress = await this.getXrdAddress();
    return this.getTotalSupply({ resource: xrdAddress });
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
      token_type === 'Collateral' || token_type === 'Synthetic',
      `unknown token type: ${token_type}`,
    );

    const ismFields = fields.find((f: any) => f.field_name === 'ism').fields;

    const tokenTypeFields =
      fields.find((f: any) => f.field_name === 'token_type')?.fields ?? [];

    let origin_denom;
    let metadata = {
      name: '',
      symbol: '',
      description: '',
      divisibility: 0,
    };

    if (token_type === 'Collateral') {
      origin_denom =
        tokenTypeFields.find((t: any) => t.type_name === 'ResourceAddress')
          ?.value ?? '';

      metadata = await this.getMetadata({ resource: origin_denom });
    } else if (token_type === 'Synthetic') {
      origin_denom =
        (
          fields.find((f: any) => f.field_name === 'resource_manager')
            ?.fields ?? []
        ).find((r: any) => r.type_name === 'ResourceAddress')?.value ?? '';

      metadata = await this.getMetadata({ resource: origin_denom });
    }

    const result = {
      address: token,
      owner: resourceHolders[0],
      token_type,
      mailbox: fields.find((f: any) => f.field_name === 'mailbox')?.value ?? '',
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
    const pk = new PrivateKey.Ed25519(new Uint8Array(randomBytes(32)));

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
      !(response.receipt as any).error_message,
      `${(response.receipt as any).error_message}`,
    );

    const output = (response.receipt as any).output as any[];
    assert(output.length, `found no output for quote_remote_transfer method`);

    const entries = output[0].programmatic_json.entries as any[];
    assert(entries.length > 0, `quote_remote_transfer returned no resources`);
    assert(
      entries.length < 2,
      `quote_remote_transfer returned muliple resources`,
    );

    return {
      resource: entries[0].key.value,
      amount: BigInt(entries[0].value.value),
    };
  }
}
