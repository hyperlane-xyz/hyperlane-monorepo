import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { assert } from '@hyperlane-xyz/utils';

import { getKeysFromKeyValueStore } from '../utils/query.js';
import { EntityDetails, EntityField, RadixHookTypes } from '../utils/types.js';

function assertIsHookType(
  maybeHookType: string,
): maybeHookType is RadixHookTypes {
  switch (maybeHookType) {
    case RadixHookTypes.IGP:
    case RadixHookTypes.MERKLE_TREE:
      return true;
  }

  return false;
}

export async function getHookType(
  gateway: Readonly<GatewayApiClient>,
  hookAddress: string,
): Promise<RadixHookTypes> {
  const details =
    await gateway.state.getEntityDetailsVaultAggregated(hookAddress);
  const hookDetails = details.details;

  assert(
    hookDetails?.type === 'Component',
    `Expected the provided address "${hookAddress}" to be a radix component`,
  );

  const maybeHookType = hookDetails.blueprint_name;
  assert(
    assertIsHookType(maybeHookType),
    `Expected the provided address to be a Hook but got ${maybeHookType}`,
  );

  return maybeHookType;
}

export async function getIgpHookConfig(
  gateway: Readonly<GatewayApiClient>,
  hookAddress: string,
): Promise<{
  type: RadixHookTypes.IGP;
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
    await gateway.state.getEntityDetailsVaultAggregated(hookAddress);
  const hookDetails = details.details;

  assert(
    hookDetails?.type === 'Component',
    `Expected the provided address "${hookAddress}" to be a radix component`,
  );

  const hookType = hookDetails.blueprint_name;
  assert(
    hookType === RadixHookTypes.IGP,
    `Expected contract at address ${hookAddress} to be "${RadixHookTypes.IGP}" but got ${hookType}`,
  );

  const ownerResource = (details.details as EntityDetails).role_assignments
    .owner.rule.access_rule.proof_rule.requirement.resource;

  const { items: holders } =
    await gateway.extensions.getResourceHolders(ownerResource);

  const resourceHolders = [
    ...new Set(holders.map((item) => item.holder_address)),
  ];

  assert(
    resourceHolders.length === 1,
    `expected token holders of resource ${ownerResource} to be one, found ${resourceHolders.length} holders instead`,
  );

  const fields = (details.details as EntityDetails).state.fields;

  const destinationGasConfigsKeyValueStoreAddress: string | undefined =
    fields.find((f) => f.field_name === 'destination_gas_configs')?.value;
  assert(
    destinationGasConfigsKeyValueStoreAddress,
    `found no destination gas configs on hook ${hookAddress}`,
  );

  const keys = await getKeysFromKeyValueStore(
    gateway,
    destinationGasConfigsKeyValueStoreAddress,
  );

  const destinationGasConfigs = {};
  for (const key of keys) {
    const { entries } = await gateway.state.innerClient.keyValueStoreData({
      stateKeyValueStoreDataRequest: {
        key_value_store_address: destinationGasConfigsKeyValueStoreAddress,
        keys: [
          {
            key_hex: key.raw_hex,
          },
        ],
      },
    });

    const remoteDomain = (key.programmatic_json as EntityField)?.value ?? '0';

    const gasConfigFields = (entries[0].value.programmatic_json as EntityField)
      .fields;

    const gasOracleFields =
      gasConfigFields?.find((r) => r.field_name === 'gas_oracle')?.fields ?? [];

    Object.assign(destinationGasConfigs, {
      [remoteDomain]: {
        gasOracle: {
          tokenExchangeRate:
            gasOracleFields.find((r) => r.field_name === 'token_exchange_rate')
              ?.value ?? '0',
          gasPrice:
            gasOracleFields.find((r) => r.field_name === 'gas_price')?.value ??
            '0',
        },
        gasOverhead:
          gasConfigFields?.find((r) => r.field_name === 'gas_overhead')
            ?.value ?? '0',
      },
    });
  }

  return {
    type: RadixHookTypes.IGP,
    address: hookAddress,
    owner: resourceHolders[0],
    destinationGasConfigs,
  };
}

export async function getMerkleTreeHookConfig(
  gateway: Readonly<GatewayApiClient>,
  hookAddress: string,
): Promise<{
  type: RadixHookTypes.MERKLE_TREE;
  address: string;
}> {
  const details =
    await gateway.state.getEntityDetailsVaultAggregated(hookAddress);
  const hookDetails = details.details;

  assert(
    hookDetails?.type === 'Component',
    `Expected the provided address "${hookAddress}" to be a radix component`,
  );

  const hookType = hookDetails.blueprint_name;
  assert(
    hookType === RadixHookTypes.MERKLE_TREE,
    `Expected contract at address ${hookAddress} to be "${RadixHookTypes.MERKLE_TREE}" but got ${hookType}`,
  );

  return {
    type: RadixHookTypes.MERKLE_TREE,
    address: hookAddress,
  };
}
