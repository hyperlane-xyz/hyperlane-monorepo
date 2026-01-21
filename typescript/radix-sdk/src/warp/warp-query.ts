import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { TokenType } from '@hyperlane-xyz/provider-sdk/warp';
import { assert, ensure0x } from '@hyperlane-xyz/utils';

import {
  getComponentOwner,
  getComponentState,
  getFieldHexValueFromEntityState,
  getFieldPropertyFromEntityState,
  getFieldValueFromEntityState,
  getKeysFromKvStore,
  getRadixComponentDetails,
  getResourceAddress,
  tryGetFieldValueFromEntityState,
} from '../utils/base-query.js';
import { RadixBase } from '../utils/base.js';
import {
  BaseRadixWarpTokenConfig,
  EntityDetails,
  EntityField,
  RadixCollateralWarpTokenConfig,
  RadixSyntheticWarpTokenConfig,
  RadixWarpTokenConfig,
  RadixWarpTokenType,
} from '../utils/types.js';

export function providerWarpTokenTypeFromRadixTokenType(
  tokenType: RadixWarpTokenType,
): TokenType {
  switch (tokenType) {
    case RadixWarpTokenType.COLLATERAL:
      return 'collateral';
    case RadixWarpTokenType.SYNTHETIC:
      return 'synthetic';
    default: {
      const invalidValue: never = tokenType;
      throw new Error(`Unknown warp token type: ${invalidValue}`);
    }
  }
}

export async function getRadixWarpTokenType(
  gateway: Readonly<GatewayApiClient>,
  tokenAddress: string,
): Promise<RadixWarpTokenType> {
  const { tokenType } = await getRawWarpTokenData(gateway, tokenAddress);

  return tokenType;
}

export async function getCollateralWarpTokenConfig(
  gateway: Readonly<GatewayApiClient>,
  base: Readonly<RadixBase>,
  tokenAddress: string,
): Promise<RadixCollateralWarpTokenConfig> {
  const [tokenState, baseTokenData] = await getWarpTokenConfig(
    gateway,
    tokenAddress,
  );

  assert(
    baseTokenData.type === RadixWarpTokenType.COLLATERAL,
    `Expected token at address ${tokenAddress} to be of type ${RadixWarpTokenType.COLLATERAL} but got ${baseTokenData.type}`,
  );

  const tokenTypeFields: EntityField[] = getFieldPropertyFromEntityState(
    'token_type',
    tokenAddress,
    tokenState,
    'fields',
  );
  const collateralTokenAddress = getResourceAddress(tokenAddress, {
    fields: tokenTypeFields,
  });
  const metadata = await base.getMetadata({ resource: collateralTokenAddress });

  return {
    mailbox: baseTokenData.mailbox,
    owner: baseTokenData.owner,
    token: collateralTokenAddress,
    type: RadixWarpTokenType.COLLATERAL,
    destinationGas: baseTokenData.destinationGas,
    interchainSecurityModule: baseTokenData.interchainSecurityModule,
    remoteRouters: baseTokenData.remoteRouters,
    decimals: metadata.decimals,
    name: metadata.name,
    symbol: metadata.symbol,
  };
}

export async function getSyntheticWarpTokenConfig(
  gateway: Readonly<GatewayApiClient>,
  base: Readonly<RadixBase>,
  tokenAddress: string,
): Promise<RadixSyntheticWarpTokenConfig> {
  const [tokenState, baseTokenData] = await getWarpTokenConfig(
    gateway,
    tokenAddress,
  );

  assert(
    baseTokenData.type === RadixWarpTokenType.SYNTHETIC,
    `Expected token at address ${tokenAddress} to be of type ${RadixWarpTokenType.SYNTHETIC} but got ${baseTokenData.type}`,
  );

  const resourceManagerFields =
    tokenState.fields.find((f) => f.field_name === 'resource_manager')
      ?.fields ?? [];
  const collateralTokenAddress = getResourceAddress(tokenAddress, {
    fields: resourceManagerFields,
  });
  const metadata = await base.getMetadata({ resource: collateralTokenAddress });

  return {
    mailbox: baseTokenData.mailbox,
    owner: baseTokenData.owner,
    type: RadixWarpTokenType.SYNTHETIC,
    destinationGas: baseTokenData.destinationGas,
    interchainSecurityModule: baseTokenData.interchainSecurityModule,
    remoteRouters: baseTokenData.remoteRouters,
    decimals: metadata.decimals,
    name: metadata.name,
    symbol: metadata.symbol,
  };
}

async function getRawWarpTokenData(
  gateway: Readonly<GatewayApiClient>,
  tokenAddress: string,
) {
  const tokenDetails = await getRadixComponentDetails(
    gateway,
    tokenAddress,
    'HypToken',
  );

  assert(
    tokenDetails.blueprint_name === 'HypToken',
    `Expected component at address ${tokenAddress} to be "HypToken" but got ${tokenDetails.blueprint_name}`,
  );

  const tokenState = getComponentState(tokenAddress, tokenDetails);
  const tokenType = getFieldPropertyFromEntityState(
    'token_type',
    tokenAddress,
    tokenState,
    'variant_name',
  );

  assert(
    tokenType === RadixWarpTokenType.COLLATERAL ||
      tokenType === RadixWarpTokenType.SYNTHETIC,
    `Unknown token type: ${tokenType}`,
  );

  return {
    tokenType,
    tokenDetails,
  };
}

async function getWarpTokenConfig(
  gateway: Readonly<GatewayApiClient>,
  tokenAddress: string,
): Promise<
  [EntityDetails['state'], BaseRadixWarpTokenConfig<RadixWarpTokenType>]
> {
  const { tokenDetails, tokenType } = await getRawWarpTokenData(
    gateway,
    tokenAddress,
  );

  const owner = await getComponentOwner(gateway, tokenAddress, tokenDetails);
  const tokenState = getComponentState(tokenAddress, tokenDetails);

  const ismAddress = tryGetFieldValueFromEntityState('ism', tokenState);
  const mailboxAddress = getFieldValueFromEntityState(
    'mailbox',
    tokenAddress,
    tokenState,
  );

  const { destinationGas, remoteRouters } =
    await getWarpTokenRemoteRoutersConfig(gateway, tokenAddress, tokenState);

  return [
    tokenState,
    {
      type: tokenType,
      mailbox: mailboxAddress,
      owner,
      destinationGas,
      interchainSecurityModule: ismAddress,
      remoteRouters,
    },
  ];
}

async function getWarpTokenRemoteRoutersConfig(
  gateway: Readonly<GatewayApiClient>,
  tokenAddress: string,
  tokenState: EntityDetails['state'],
): Promise<Pick<RadixWarpTokenConfig, 'destinationGas' | 'remoteRouters'>> {
  const destinationGas: RadixWarpTokenConfig['destinationGas'] = {};
  const remoteRouters: RadixWarpTokenConfig['remoteRouters'] = {};

  const remote_routers_kv_address = getFieldValueFromEntityState(
    'enrolled_routers',
    tokenAddress,
    tokenState,
  );

  const keys = await getKeysFromKvStore(gateway, remote_routers_kv_address);
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

    const domainId = parseInt(rawRemoteDomain.value);

    const [entry] = entries;
    assert(
      entry,
      `Expected to find at least one entry with key ${domainId} on warp token at address ${tokenAddress}`,
    );

    const rawRouter = entry.value.programmatic_json;
    assert(
      rawRouter.kind === 'Tuple',
      `Expected router to be an object on warp token at address ${tokenAddress}`,
    );

    const routerFields = (rawRouter as EntityField).fields ?? [];
    const remoteAddress = getFieldHexValueFromEntityState(
      'recipient',
      tokenAddress,
      {
        fields: routerFields,
      },
      ensure0x,
    );
    const gas =
      tryGetFieldValueFromEntityState('gas', { fields: routerFields }) ?? '0';

    destinationGas[domainId] = gas;
    remoteRouters[domainId] = {
      address: remoteAddress,
    };
  }

  return {
    destinationGas,
    remoteRouters,
  };
}
