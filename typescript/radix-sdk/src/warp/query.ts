import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import { generateRandomNonce } from '@radixdlt/radix-engine-toolkit';
import { BigNumber } from 'bignumber.js';

import { assert } from '@hyperlane-xyz/utils';

import { getKeysFromKvStore } from '../utils/base-query.js';
import { RadixBase } from '../utils/base.js';
import { READ_ACCOUNT_HEX_PUBLIC_KEY } from '../utils/constants.js';
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
    tokenType: 'Collateral' | 'Synthetic';
    mailboxAddress: string;
    ismAddress: string;
    hookAddress: string;
    denom: string;
    name: string;
    symbol: string;
    description: string;
    decimals: number;
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
      decimals: 0,
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
      tokenType: token_type as 'Collateral' | 'Synthetic',
      mailboxAddress:
        fields.find((f) => f.field_name === 'mailbox')?.value ?? '',
      ismAddress: ismFields[0]?.value ?? '',
      hookAddress: '',
      denom: origin_denom,
      ...metadata,
    };

    return result;
  }

  public async getRemoteRouters({ token }: { token: string }): Promise<{
    address: string;
    remoteRouters: {
      receiverDomainId: number;
      receiverAddress: string;
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

    const remoteRouters = [];

    const keys = await getKeysFromKvStore(
      this.gateway,
      enrolledRoutersKeyValueStore,
    );

    for (const key of keys) {
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

      remoteRouters.push({
        receiverDomainId: parseInt(
          routerFields.find((r) => r.field_name === 'domain')?.value ?? '',
        ),
        receiverAddress:
          routerFields.find((r) => r.field_name === 'recipient')?.hex ?? '',
        gas: routerFields.find((r) => r.field_name === 'gas')?.value ?? '',
      });
    }

    const result = {
      address: token,
      remoteRouters,
    };

    return result;
  }

  public async getBridgedSupply({ token }: { token: string }): Promise<bigint> {
    const { tokenType, denom } = await this.getToken({ token });

    switch (tokenType) {
      case 'Collateral': {
        // if the token is collateral we get the token contract balance
        // of the origin denom
        return this.base.getBalance({ address: token, resource: denom });
      }
      case 'Synthetic': {
        // if the token is synthetic we get the total supply of the synthetic
        // resource
        return this.base.getTotalSupply({ resource: denom });
      }
      default: {
        throw new Error(`unknown token type: ${tokenType}`);
      }
    }
  }

  public async quoteRemoteTransfer({
    token,
    destination_domain,
  }: {
    token: string;
    destination_domain: number;
  }): Promise<{ denom: string; amount: bigint }> {
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
              key_hex: READ_ACCOUNT_HEX_PUBLIC_KEY,
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

    const programmaticJson = output[0].programmatic_json;
    assert(
      'entries' in programmaticJson,
      'programmatic_json is not in the expected format',
    );

    const entries = programmaticJson.entries;
    assert(entries.length > 0, `quote_remote_transfer returned no resources`);
    assert(
      entries.length < 2,
      `quote_remote_transfer returned multiple resources`,
    );

    return {
      denom: entries[0].key.value,
      amount: BigInt(
        new BigNumber(entries[0].value.value)
          .times(new BigNumber(10).pow(18))
          .integerValue(BigNumber.ROUND_FLOOR)
          .toFixed(0),
      ),
    };
  }
}
