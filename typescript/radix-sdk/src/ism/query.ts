import {
  GatewayApiClient,
  LedgerStateSelector,
  ScryptoSborValue,
} from '@radixdlt/babylon-gateway-api-sdk';

import { assert, ensure0x, isNullish, sleep } from '@hyperlane-xyz/utils';

import { EntityDetails, EntityField, MultisigIsms } from '../utils/types.js';

// TODO: move this to another file
export async function getKeysFromKeyValueStore(
  gateway: Readonly<GatewayApiClient>,
  key_value_store_address: string,
): Promise<ScryptoSborValue[]> {
  let cursor: string | null = null;
  let at_ledger_state: LedgerStateSelector | null = null;
  const keys = [];
  const request_limit = 50;

  for (let i = 0; i < request_limit; i++) {
    const { items, next_cursor, ledger_state } =
      await gateway.state.innerClient.keyValueStoreKeys({
        stateKeyValueStoreKeysRequest: {
          key_value_store_address,
          at_ledger_state,
          cursor,
        },
      });

    keys.push(...items.map((i) => i.key));

    if (!next_cursor) {
      return keys;
    }

    cursor = next_cursor;
    at_ledger_state = { state_version: ledger_state.state_version };
    await sleep(50);
  }

  throw new Error(
    `Failed to fetch keys from key value store ${key_value_store_address}, reached request limit of ${request_limit}`,
  );
}

export async function getMultisigIsmConfig(
  gateway: Readonly<GatewayApiClient>,
  { ismAddress }: { ismAddress: string },
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
  { ism }: { ism: string },
): Promise<{
  address: string;
  owner: string;
  routes: {
    domainId: number;
    ismAddress: string;
  }[];
}> {
  const details = await gateway.state.getEntityDetailsVaultAggregated(ism);

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
  assert(routesKeyValueStore, `found no routes on RoutingIsm ${ism}`);

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
    address: ism,
    owner: resourceHolders[0],
    routes,
  };
}
