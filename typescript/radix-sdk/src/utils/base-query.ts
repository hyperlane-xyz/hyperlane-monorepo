import {
  GatewayApiClient,
  LedgerStateSelector,
  ScryptoSborValue,
  StateEntityDetailsResponseItemDetails,
} from '@radixdlt/babylon-gateway-api-sdk';

import { assert, isNullish, sleep } from '@hyperlane-xyz/utils';

import { EntityDetails, RadixElement } from './types.js';

type RadixComponentDetails = Extract<
  StateEntityDetailsResponseItemDetails,
  { type: 'Component' }
>;

/**
 * Fetches and validates Radix component details from the gateway.
 *
 * @param gateway - The Radix Gateway API client
 * @param entityAddress - The on-chain address of the component
 * @param componentName - Human-readable name for error messages (e.g., "mailbox", "ISM", "hook")
 *
 * @throws {Error} If the entity is not a Radix component
 */
export async function getRadixComponentDetails(
  gateway: Readonly<GatewayApiClient>,
  entityAddress: string,
  componentName: string,
): Promise<RadixComponentDetails> {
  const { details: componentDetails } =
    await gateway.state.getEntityDetailsVaultAggregated(entityAddress);

  assert(
    componentDetails?.type === 'Component',
    `Expected on chain details to be defined for radix ${componentName} at address ${entityAddress}`,
  );

  return componentDetails;
}

/**
 * Fetches all keys from a Radix key-value store.
 *
 * @param gateway - The Radix Gateway API client
 * @param keyValueStoreAddress - The on-chain address of the key-value store
 * @returns Array of all keys in the key-value store
 */
export async function getKeysFromKvStore(
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
    // Set the ledger version so that subsequent requests use the same
    // version as the first one
    if (!at_ledger_state) {
      at_ledger_state = { state_version: ledger_state.state_version };
    }
    await sleep(50);
  }

  throw new Error(
    `Failed to fetch keys from key value store ${keyValueStoreAddress}, reached request limit of ${requestLimit}`,
  );
}

/**
 * Extracts ownership information from a Radix component's details.
 *
 * @param entityAddress - The on-chain address of the component (used for error messages)
 * @param entityDetails - The component details containing role assignment information
 * @returns The ownership information including the access rule and proof requirements
 *
 * @throws {Error} If ownership information is not defined in the component details
 */
export function getComponentOwnershipInfo(
  entityAddress: string,
  entityDetails: RadixComponentDetails,
): EntityDetails['role_assignments']['owner'] {
  const ownershipInfo = entityDetails?.role_assignments?.owner as
    | EntityDetails['role_assignments']['owner']
    | undefined;
  assert(
    ownershipInfo,
    `Expected ownership info to be defined for radix component at address ${entityAddress}`,
  );

  return ownershipInfo;
}

/**
 * Extracts the owner address of a Radix component.
 *
 * Radix components use role-based access control where ownership is represented
 * by holding a specific resource. This function finds the holder of that resource.
 *
 * @param gateway - The Radix Gateway API client
 * @param entityAddress - The on-chain address of the component (used for error messages)
 * @param entityDetails - The component details containing ownership information
 * @returns The address of the component owner
 *
 * @throws {Error} If ownership info is missing or if there are multiple resource holders
 */
export async function getComponentOwner(
  gateway: Readonly<GatewayApiClient>,
  entityAddress: string,
  entityDetails: RadixComponentDetails,
): Promise<string> {
  const ownershipInfo = getComponentOwnershipInfo(entityAddress, entityDetails);

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

/**
 * Extracts the state object from Radix component details.
 *
 * @param entityAddress - The on-chain address of the component (used for error messages)
 * @param entityDetails - The component details containing the state
 * @returns The component state containing
 *
 * @throws {Error} If the state is not defined in the component details
 */
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

/**
 * Extracts a field value from a Radix component's entity state.
 *
 * Handles both regular fields and Radix Option enums. For Option enums, it automatically
 * extracts the value from the Some variant.
 *
 * @param fieldName - The name of the field to extract
 * @param entityAddress - The on-chain address of the component (used for error messages)
 * @param entityState - The component state containing the fields
 * @returns The field value as a string
 *
 * @throws {Error} If the field is not found in the state
 *
 * @overload
 * @param fieldName - The name of the field to extract
 * @param entityAddress - The on-chain address of the component (used for error messages)
 * @param entityState - The component state containing the fields
 * @param formatter - Function to transform the string value into a different type
 * @returns The formatted field value
 */
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
  const [value]: string[] | undefined = entityState.fields
    .filter((f) => f.field_name === fieldName)
    .map((f) =>
      // If the current value is an Option we need to extract
      // its value otherwise we can use the .value property
      // directly
      f.kind === 'Enum' && f.type_name === 'Option'
        ? f.fields?.at(0)?.value
        : f.value,
    );

  assert(
    !isNullish(value),
    `Expected ${fieldName} field to be defined on radix component at ${entityAddress}`,
  );

  return formatter ? formatter(value) : value;
}

/**
 * Extracts field elements (array values) from a Radix component's entity state.
 *
 * Used for fields that contain arrays of elements, such as validator lists or
 * multi-value configurations.
 *
 * @param fieldName - The name of the field to extract
 * @param entityAddress - The on-chain address of the component (used for error messages)
 * @param entityState - The component state containing the fields
 * @returns Array of RadixElement objects
 *
 * @throws {Error} If the field is not found in the state
 *
 * @overload
 * @param fieldName - The name of the field to extract
 * @param entityAddress - The on-chain address of the component (used for error messages)
 * @param entityState - The component state containing the fields
 * @param formatter - Function to transform the RadixElement array into a different type
 * @returns The formatted element array
 */
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
    !isNullish(value),
    `Expected ${fieldName} field to be defined on radix component at ${entityAddress}`,
  );

  return formatter ? formatter(value) : value;
}
