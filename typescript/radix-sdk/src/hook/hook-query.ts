import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { assert } from '@hyperlane-xyz/utils';

import {
  getComponentOwner,
  getComponentState,
  getFieldValueFromEntityState,
  getKeysFromKvStore,
  getRadixComponentDetails,
} from '../utils/base-query.js';
import { EntityField, RadixHookTypes } from '../utils/types.js';

function isHookType(maybeHookType: string): maybeHookType is RadixHookTypes {
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
  const hookDetails = await getRadixComponentDetails(
    gateway,
    hookAddress,
    'hook',
  );

  const hookType = hookDetails.blueprint_name;
  assert(
    isHookType(hookType),
    `Expected component at address ${hookAddress} to be a hook but got ${hookType}`,
  );

  return hookType;
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
  const hookDetails = await getRadixComponentDetails(
    gateway,
    hookAddress,
    RadixHookTypes.IGP,
  );

  const hookType = hookDetails.blueprint_name;
  assert(
    hookType === RadixHookTypes.IGP,
    `Expected component at address ${hookAddress} to be "${RadixHookTypes.IGP}" but got ${hookType}`,
  );

  const owner = await getComponentOwner(gateway, hookAddress, hookDetails);

  const hookState = getComponentState(hookAddress, hookDetails);
  const destinationGasConfigsKeyValueStoreAddress =
    getFieldValueFromEntityState(
      'destination_gas_configs',
      hookAddress,
      hookState,
    );

  const keys = await getKeysFromKvStore(
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

    const rawRemoteDomain = key.programmatic_json;
    assert(
      rawRemoteDomain.kind === 'U32',
      `Expected domain id to be stored as a number on IGP at address ${hookAddress}`,
    );
    const remoteDomain = rawRemoteDomain.value;

    const [entry] = entries;
    assert(
      entry,
      `Expected to find at least one entry for gas config with key ${remoteDomain} on IGP at address ${hookAddress}`,
    );

    const rawGasConfig = entry.value.programmatic_json;
    assert(
      rawGasConfig.kind === 'Tuple',
      `Expected gasConfig to be an object on IGP at address ${hookAddress}`,
    );

    const gasConfigFields = (rawGasConfig as EntityField).fields ?? [];
    const gasOracleFields =
      gasConfigFields?.find((r) => r.field_name === 'gas_oracle')?.fields ?? [];

    Object.assign(destinationGasConfigs, {
      [remoteDomain]: {
        gasOracle: {
          tokenExchangeRate: getFieldValueFromEntityState(
            'token_exchange_rate',
            hookAddress,
            {
              fields: gasOracleFields,
            },
          ),
          gasPrice: getFieldValueFromEntityState('gas_price', hookAddress, {
            fields: gasOracleFields,
          }),
        },
        gasOverhead: getFieldValueFromEntityState('gas_overhead', hookAddress, {
          fields: gasConfigFields,
        }),
      },
    });
  }

  return {
    type: RadixHookTypes.IGP,
    address: hookAddress,
    owner,
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
  const hookDetails = await getRadixComponentDetails(
    gateway,
    hookAddress,
    RadixHookTypes.MERKLE_TREE,
  );

  const hookType = hookDetails.blueprint_name;
  assert(
    hookType === RadixHookTypes.MERKLE_TREE,
    `Expected component at address ${hookAddress} to be "${RadixHookTypes.MERKLE_TREE}" but got ${hookType}`,
  );

  return {
    type: RadixHookTypes.MERKLE_TREE,
    address: hookAddress,
  };
}
