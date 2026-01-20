import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { assert } from '@hyperlane-xyz/utils';

import {
  getComponentOwner,
  getComponentState,
  getFieldValueFromEntityState,
  getKeysFromKvStore,
  getRadixComponentDetails,
} from '../utils/base-query.js';
import { RadixBase } from '../utils/base.js';
import { EntityField } from '../utils/types.js';

/**
 * Gets token configuration from chain.
 * Helper function for artifact readers.
 */
export async function getWarpTokenConfig(
  gateway: Readonly<GatewayApiClient>,
  base: Readonly<RadixBase>,
  tokenAddress: string,
): Promise<{
  address: string;
  owner: string;
  tokenType: 'Collateral' | 'Synthetic';
  mailboxAddress: string;
  ismAddress: string;
  denom: string;
  name: string;
  symbol: string;
  description: string;
  decimals: number;
}> {
  const tokenDetails = await getRadixComponentDetails(
    gateway,
    tokenAddress,
    'HypToken',
  );

  assert(
    tokenDetails.blueprint_name === 'HypToken',
    `Expected component at address ${tokenAddress} to be "HypToken" but got ${tokenDetails.blueprint_name}`,
  );

  const owner = await getComponentOwner(gateway, tokenAddress, tokenDetails);
  const tokenState = getComponentState(tokenAddress, tokenDetails);

  const token_type = tokenState.fields.find(
    (f) => f.field_name === 'token_type',
  )?.variant_name;

  assert(
    token_type === 'Collateral' || token_type === 'Synthetic',
    `Unknown token type: ${token_type}`,
  );

  const ismFields =
    tokenState.fields.find((f) => f.field_name === 'ism')?.fields ?? [];
  const ismAddress = ismFields[0]?.value ?? '';

  const mailboxAddress = getFieldValueFromEntityState(
    'mailbox',
    tokenAddress,
    tokenState,
  );

  const tokenTypeFields =
    tokenState.fields.find((f) => f.field_name === 'token_type')?.fields ?? [];

  let origin_denom: string;
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
    metadata = await base.getMetadata({ resource: origin_denom });
  } else {
    // Synthetic
    const resourceManagerFields =
      tokenState.fields.find((f) => f.field_name === 'resource_manager')
        ?.fields ?? [];
    origin_denom =
      resourceManagerFields.find((r) => r.type_name === 'ResourceAddress')
        ?.value ?? '';
    metadata = await base.getMetadata({ resource: origin_denom });
  }

  return {
    address: tokenAddress,
    owner,
    tokenType: token_type,
    mailboxAddress,
    ismAddress,
    denom: origin_denom,
    ...metadata,
  };
}

/**
 * Gets remote routers configuration from chain.
 * Helper function for artifact readers.
 */
export async function getWarpTokenRemoteRouters(
  gateway: Readonly<GatewayApiClient>,
  tokenAddress: string,
): Promise<
  {
    receiverDomainId: number;
    receiverAddress: string;
    gas: string;
  }[]
> {
  const tokenDetails = await getRadixComponentDetails(
    gateway,
    tokenAddress,
    'HypToken',
  );

  const tokenState = getComponentState(tokenAddress, tokenDetails);

  const remote_routers_kv_address = getFieldValueFromEntityState(
    'remote_routers',
    tokenAddress,
    tokenState,
  );

  const keys = await getKeysFromKvStore(gateway, remote_routers_kv_address);

  const remoteRouters: {
    receiverDomainId: number;
    receiverAddress: string;
    gas: string;
  }[] = [];

  for (const key of keys) {
    const { entries } = await gateway.state.innerClient.keyValueStoreData({
      stateKeyValueStoreDataRequest: {
        key_value_store_address: remote_routers_kv_address,
        keys: [{ key_hex: key.raw_hex }],
      },
    });

    const rawRemoteDomain = key.programmatic_json;

    assert(
      rawRemoteDomain.kind === 'U32',
      `Expected domain id to be stored as a number on warp token at address ${tokenAddress}`,
    );

    const receiverDomainId = parseInt(rawRemoteDomain.value);

    const [entry] = entries;

    assert(
      entry,
      `Expected to find at least one entry with key ${receiverDomainId} on warp token at address ${tokenAddress}`,
    );

    const rawRouter = entry.value.programmatic_json;

    assert(
      rawRouter.kind === 'Tuple',
      `Expected router to be an object on warp token at address ${tokenAddress}`,
    );

    const routerFields = (rawRouter as EntityField).fields ?? [];

    const receiverAddress =
      routerFields.find((f) => f.field_name === 'receiver')?.value ?? '';
    const gas =
      routerFields.find((f) => f.field_name === 'destination_gas')?.value ?? '';

    remoteRouters.push({ receiverDomainId, receiverAddress, gas });
  }

  return remoteRouters;
}
