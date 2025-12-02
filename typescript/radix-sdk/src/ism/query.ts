import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { assert, ensure0x, isNullish } from '@hyperlane-xyz/utils';

import { getKeysFromKeyValueStore } from '../utils/query.js';
import { EntityDetails, EntityField, MultisigIsms } from '../utils/types.js';

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
    `Expected the provided address "${ismAddress}" to be a component`,
  );
  assert(ismDetails.state, 'Expected state to be defined');

  const fields = (ismDetails.state as EntityDetails['state']).fields;
  const validators: any[] | undefined = fields.find(
    (f) => f.field_name === 'validators',
  )?.elements;
  assert(validators, `Expected the validators field to be defined on the `);

  const threshold: string | undefined = fields.find(
    (f) => f.field_name === 'threshold',
  )?.value;
  assert(!isNullish(threshold), `Expected threshold to be defined`);

  const result = {
    address: ismAddress,
    type: (details.details as EntityDetails).blueprint_name as MultisigIsms,
    validators: validators.map((v) => ensure0x(v.hex)),
    threshold: parseInt(threshold),
  };

  return result;
}

export async function getDomainRoutingIsmConfig(
  gateway: Readonly<GatewayApiClient>,
  ismAddress: string,
): Promise<{
  address: string;
  owner: string;
  routes: {
    domainId: number;
    ismAddress: string;
  }[];
}> {
  const details =
    await gateway.state.getEntityDetailsVaultAggregated(ismAddress);

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

  const type = (details.details as EntityDetails).blueprint_name;
  assert(type === 'RoutingIsm', `ism is not a RoutingIsm, instead got ${type}`);

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
    address: ismAddress,
    owner: resourceHolders[0],
    routes,
  };
}
