import {
  GatewayApiClient,
  LedgerStateSelector,
  ScryptoSborValue,
  StateEntityDetailsResponseItemDetails,
} from '@radixdlt/babylon-gateway-api-sdk';

import { assert, sleep } from '@hyperlane-xyz/utils';

import { EntityDetails, RadixElement } from './types.js';

type RadixComponentDetails = Extract<
  StateEntityDetailsResponseItemDetails,
  { type: 'Component' }
>;

export function isRadixComponent(
  component: StateEntityDetailsResponseItemDetails | undefined,
): component is RadixComponentDetails {
  return component?.type === 'Component';
}

export async function getKeysFromKeyValueStore(
  gateway: Readonly<GatewayApiClient>,
  keyValueStoreAddress: string,
): Promise<ScryptoSborValue[]> {
  let cursor: string | null = null;
  let at_ledger_state: LedgerStateSelector | null = null;
  const keys = [];
  const requestLimit = 50;

  for (let i = 0; i < requestLimit; i++) {
    const { items, next_cursor, ledger_state } =
      await gateway.state.innerClient.keyValueStoreKeys({
        stateKeyValueStoreKeysRequest: {
          key_value_store_address: keyValueStoreAddress,
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
    `Failed to fetch keys from key value store ${keyValueStoreAddress}, reached request limit of ${requestLimit}`,
  );
}

export async function getComponentOwner(
  gateway: Readonly<GatewayApiClient>,
  entityAddress: string,
  entityDetails: RadixComponentDetails,
): Promise<string> {
  const ownershipInfo = entityDetails?.role_assignments?.owner as
    | EntityDetails['role_assignments']['owner']
    | undefined;
  assert(
    ownershipInfo,
    `Expected ownership info to be defined for radix component at address ${entityAddress}`,
  );

  const ownerResource =
    ownershipInfo.rule.access_rule.proof_rule.requirement.resource;

  const { items } = await gateway.extensions.getResourceHolders(ownerResource);
  const resourceHolders = [
    ...new Set(items.map((item) => item.holder_address)),
  ];

  assert(
    resourceHolders.length === 1,
    `Expected holders of resource ${ownerResource} to be one, found ${resourceHolders.length} holders instead ${resourceHolders.join(', ')}`,
  );

  return resourceHolders[0];
}

export function getComponentState(
  entityAddress: string,
  entityDetails: RadixComponentDetails,
): EntityDetails['state'] {
  assert(
    entityDetails.state,
    `Expected state to be defined for component at address ${entityAddress}`,
  );

  return entityDetails.state as EntityDetails['state'];
}

export function getFieldValueFromEntityState(
  fieldName: string,
  entityAddress: string,
  entityState: EntityDetails['state'],
): string;
export function getFieldValueFromEntityState<T>(
  fieldName: string,
  entityAddress: string,
  entityState: EntityDetails['state'],
  formatter: (value: string) => T,
): T;
export function getFieldValueFromEntityState<T>(
  fieldName: string,
  entityAddress: string,
  entityState: EntityDetails['state'],
  formatter?: (value: string) => T,
): T | string {
  const [value]: (string | undefined)[] = entityState.fields
    .filter((f) => f.field_name === fieldName)
    .map((f) =>
      f.kind === 'Enum' && f.type_name === 'Option'
        ? f.fields?.at(0)?.value
        : f.value,
    );

  assert(
    value,
    `Expected ${fieldName} field to be defined on radix component at ${entityAddress}`,
  );

  return formatter ? formatter(value) : value;
}

export function getFieldElementsFromEntityState(
  fieldName: string,
  entityAddress: string,
  entityState: EntityDetails['state'],
): RadixElement[];
export function getFieldElementsFromEntityState<T>(
  fieldName: string,
  entityAddress: string,
  entityState: EntityDetails['state'],
  formatter: (value: RadixElement[]) => T[],
): T[];
export function getFieldElementsFromEntityState<T>(
  fieldName: string,
  entityAddress: string,
  entityState: EntityDetails['state'],
  formatter?: (value: RadixElement[]) => T[],
): T[] | RadixElement[] {
  const value: EntityDetails['state']['fields'][number]['elements'] =
    entityState.fields.find((f) => f.field_name === fieldName)?.elements;
  assert(
    value,
    `Expected ${fieldName} field to be defined on radix component at ${entityAddress}`,
  );

  return formatter ? formatter(value) : value;
}
