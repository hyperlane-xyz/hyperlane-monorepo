import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { assert, ensure0x, isNullish } from '@hyperlane-xyz/utils';

import { getKeysFromKeyValueStore } from '../utils/query.js';
import {
  EntityDetails,
  EntityField,
  MultisigIsms,
  RadixIsmTypes,
} from '../utils/types.js';

function assertIsIsmType(maybeIsmType: string): maybeIsmType is RadixIsmTypes {
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
  const details =
    await gateway.state.getEntityDetailsVaultAggregated(ismAddress);
  const ismDetails = details.details;

  assert(
    ismDetails?.type === 'Component',
    `Expected the provided address "${ismAddress}" to be a radix component`,
  );

  const maybeIsmType = ismDetails.blueprint_name;
  assert(
    assertIsIsmType(maybeIsmType),
    `Expected the provided address to be an ISM but got ${maybeIsmType}`,
  );

  return maybeIsmType;
}

export async function getTestIsmConfig(
  gateway: Readonly<GatewayApiClient>,
  ismAddress: string,
): Promise<{
  type: RadixIsmTypes.NOOP_ISM;
  address: string;
}> {
  const details =
    await gateway.state.getEntityDetailsVaultAggregated(ismAddress);
  const ismDetails = details.details;

  assert(
    ismDetails?.type === 'Component',
    `Expected the provided address "${ismAddress}" to be a radix component`,
  );

  const ismType = ismDetails.blueprint_name;
  assert(
    ismType === RadixIsmTypes.NOOP_ISM,
    `Expected Ism at address ${ismAddress} to be of type ${RadixIsmTypes.NOOP_ISM}`,
  );

  return {
    address: ismType,
    type: RadixIsmTypes.NOOP_ISM,
  };
}

function assertIsMultisigIsmType(
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
  const details =
    await gateway.state.getEntityDetailsVaultAggregated(ismAddress);
  const ismDetails = details.details;

  assert(
    ismDetails?.type === 'Component',
    `Expected the provided address "${ismAddress}" to be a radix component`,
  );
  assert(ismDetails.state, 'Expected state to be defined');

  const ismType = ismDetails.blueprint_name;
  assert(
    assertIsMultisigIsmType(ismType),
    `Expected Ism at address ${ismAddress} to be of type ${RadixIsmTypes.MESSAGE_ID_MULTISIG} or ${RadixIsmTypes.MESSAGE_ID_MULTISIG}`,
  );

  const fields = (ismDetails.state as EntityDetails['state']).fields;
  const validators: any[] | undefined = fields.find(
    (f) => f.field_name === 'validators',
  )?.elements;
  assert(
    validators,
    `Expected the validators field to be defined on the ${ismType} at address ${ismAddress}`,
  );

  const threshold: string | undefined = fields.find(
    (f) => f.field_name === 'threshold',
  )?.value;
  assert(
    !isNullish(threshold),
    `Expected threshold to be defined on the ${ismType} at address ${ismAddress}`,
  );

  return {
    address: ismAddress,
    type: ismType,
    validators: validators.map((v) => ensure0x(v.hex)),
    threshold: parseInt(threshold),
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
  const details =
    await gateway.state.getEntityDetailsVaultAggregated(ismAddress);

  const ismDetails = details.details;

  assert(
    ismDetails?.type === 'Component',
    `Expected the provided address "${ismAddress}" to be a radix component`,
  );

  const ismType = ismDetails.blueprint_name;
  assert(
    ismType === RadixIsmTypes.ROUTING_ISM,
    `Expected Ism at address ${ismAddress} to be of type ${RadixIsmTypes.ROUTING_ISM}`,
  );

  const ownershipInfo = ismDetails?.role_assignments?.owner as
    | EntityDetails['role_assignments']['owner']
    | undefined;
  assert(
    ownershipInfo,
    `Expected ownership info to be defined on the ${ismType} at address ${ismAddress}`,
  );

  const ownerResource =
    ownershipInfo.rule.access_rule.proof_rule.requirement.resource;

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
  const routesKeyValueStore =
    fields.find((f) => f.field_name === 'routes')?.value ?? '';
  assert(routesKeyValueStore, `found no routes on RoutingIsm ${ismAddress}`);

  const keys = await getKeysFromKeyValueStore(gateway, routesKeyValueStore);

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

    const domainId = parseInt(
      (key.programmatic_json as EntityField)?.value ?? '0',
    );
    const ismAddress = (entries[0].value.programmatic_json as EntityField)
      .value;

    routes.push({
      domainId,
      ismAddress,
    });
  }

  return {
    type: RadixIsmTypes.ROUTING_ISM,
    address: ismAddress,
    owner: resourceHolders[0],
    routes,
  };
}
