import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import {
  PrivateKey,
  generateRandomNonce,
} from '@radixdlt/radix-engine-toolkit';
import { BigNumber } from 'bignumber.js';
import { utils } from 'ethers';

import { assert } from '@hyperlane-xyz/utils';

import { RadixBase } from '../utils/base.js';
import { EntityDetails, EntityField, Receipt } from '../utils/types.js';

export class RadixWarpQuery {
  protected networkId: number;
  protected gateway: GatewayApiClient;
  protected base: RadixBase;

  constructor(networkId: number, gateway: GatewayApiClient, base: RadixBase) {
    this.networkId = networkId;
    this.gateway = gateway;
    this.base = base;
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

      metadata = await this.base.getMetadata({ resource: origin_denom });
    } else if (token_type === 'Synthetic') {
      origin_denom =
        (
          fields.find((f) => f.field_name === 'resource_manager')?.fields ?? []
        ).find((r) => r.type_name === 'ResourceAddress')?.value ?? '';

      metadata = await this.base.getMetadata({ resource: origin_denom });
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
        return this.base.getBalance({ address: token, resource: origin_denom });
      }
      case 'Synthetic': {
        // if the token is synthetic we get the total supply of the synthetic
        // resource
        return this.base.getTotalSupply({ resource: origin_denom });
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
