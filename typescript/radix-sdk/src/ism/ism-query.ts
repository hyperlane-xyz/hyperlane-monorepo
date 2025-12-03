import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { assert, ensure0x } from '@hyperlane-xyz/utils';

import {
  getComponentOwner,
  getComponentState,
  getFieldElementsFromEntityState,
  getFieldValueFromEntityState,
  getKeysFromKvStore,
  getRadixComponentDetails,
} from '../utils/base-query.js';
import {
  EntityField,
  MultisigIsms,
  RadixElement,
  RadixIsmTypes,
} from '../utils/types.js';

function isIsmType(maybeIsmType: string): maybeIsmType is RadixIsmTypes {
  switch (maybeIsmType) {
    case RadixIsmTypes.MERKLE_ROOT_MULTISIG:
    case RadixIsmTypes.MESSAGE_ID_MULTISIG:
    case RadixIsmTypes.NOOP_ISM:
    case RadixIsmTypes.ROUTING_ISM:
      return true;
  }

  return false;
}

export async function getIsmType(
  gateway: Readonly<GatewayApiClient>,
  ismAddress: string,
): Promise<RadixIsmTypes> {
  const ismDetails = await getRadixComponentDetails(gateway, ismAddress, 'ISM');

  const ismType = ismDetails.blueprint_name;
  assert(
    isIsmType(ismType),
    `Expected component at address ${ismAddress} to be an ism but got ${ismType}`,
  );

  return ismType;
}

export async function getTestIsmConfig(
  gateway: Readonly<GatewayApiClient>,
  ismAddress: string,
): Promise<{
  type: RadixIsmTypes.NOOP_ISM;
  address: string;
}> {
  const ismDetails = await getRadixComponentDetails(
    gateway,
    ismAddress,
    RadixIsmTypes.NOOP_ISM,
  );

  const ismType = ismDetails.blueprint_name;
  assert(
    ismType === RadixIsmTypes.NOOP_ISM,
    `Expected ism at address ${ismAddress} to be of type ${RadixIsmTypes.NOOP_ISM} but got ${ismType}`,
  );

  return {
    address: ismAddress,
    type: RadixIsmTypes.NOOP_ISM,
  };
}

function isMultisigIsmType(
  ismType: string,
): ismType is
  | RadixIsmTypes.MERKLE_ROOT_MULTISIG
  | RadixIsmTypes.MESSAGE_ID_MULTISIG {
  return (
    ismType === RadixIsmTypes.MERKLE_ROOT_MULTISIG ||
    ismType === RadixIsmTypes.MESSAGE_ID_MULTISIG
  );
}

export async function getMultisigIsmConfig(
  gateway: Readonly<GatewayApiClient>,
  ismAddress: string,
): Promise<{
  address: string;
  type: MultisigIsms;
  threshold: number;
  validators: string[];
}> {
  const ismDetails = await getRadixComponentDetails(
    gateway,
    ismAddress,
    'MultisigISM',
  );

  const ismType = ismDetails.blueprint_name;
  assert(
    isMultisigIsmType(ismType),
    `Expected ism at address ${ismAddress} to be of type ${RadixIsmTypes.MESSAGE_ID_MULTISIG} or ${RadixIsmTypes.MERKLE_ROOT_MULTISIG} but got ${ismType}`,
  );

  const ismState = getComponentState(ismAddress, ismDetails);
  return {
    address: ismAddress,
    type: ismType,
    validators: getFieldElementsFromEntityState(
      'validators',
      ismAddress,
      ismState,
      (validators: RadixElement[]) => validators.map((v) => ensure0x(v.hex)),
    ),
    threshold: getFieldValueFromEntityState(
      'threshold',
      ismAddress,
      ismState,
      (v) => parseInt(v, 10),
    ),
  };
}

export async function getDomainRoutingIsmConfig(
  gateway: Readonly<GatewayApiClient>,
  ismAddress: string,
): Promise<{
  type: RadixIsmTypes.ROUTING_ISM;
  address: string;
  owner: string;
  routes: {
    domainId: number;
    ismAddress: string;
  }[];
}> {
  const ismDetails = await getRadixComponentDetails(
    gateway,
    ismAddress,
    RadixIsmTypes.ROUTING_ISM,
  );

  const ismType = ismDetails.blueprint_name;
  assert(
    ismType === RadixIsmTypes.ROUTING_ISM,
    `Expected ism at address ${ismAddress} to be of type ${RadixIsmTypes.ROUTING_ISM} but got ${ismType}`,
  );

  const owner = await getComponentOwner(gateway, ismAddress, ismDetails);

  const ismState = getComponentState(ismAddress, ismDetails);
  const routesKeyValueStore = getFieldValueFromEntityState(
    'routes',
    ismAddress,
    ismState,
  );

  const keys = await getKeysFromKvStore(gateway, routesKeyValueStore);

  const routes = [];
  for (const key of keys) {
    const { entries } = await gateway.state.innerClient.keyValueStoreData({
      stateKeyValueStoreDataRequest: {
        key_value_store_address: routesKeyValueStore,
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
      `Expected domain id to be stored as a number on ISM at address ${ismAddress}`,
    );
    const domainId = parseInt(rawRemoteDomain.value);

    const [entry] = entries;
    assert(
      entry,
      `Expected to find route ISM address entry for domain ${domainId} in routing ISM at address ${ismAddress}`,
    );
    const domainIsmAddress = (entry.value.programmatic_json as EntityField)
      .value;

    routes.push({
      domainId,
      ismAddress: domainIsmAddress,
    });
  }

  return {
    address: ismAddress,
    owner,
    routes,
    type: RadixIsmTypes.ROUTING_ISM,
  };
}
