import {
  GatewayApiClient,
  LedgerStateSelector,
  ScryptoSborValue,
} from '@radixdlt/babylon-gateway-api-sdk';

import { sleep } from '@hyperlane-xyz/utils';

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
