import { QueryClient } from '@cosmjs/stargate';

import { assert } from '@hyperlane-xyz/utils';

import { PostDispatchExtension } from '../hyperlane/post_dispatch/query.js';

/**
 * Type alias for query client with PostDispatch extension.
 * Used throughout hook readers to ensure type safety.
 */
export type CosmosHookQueryClient = QueryClient & PostDispatchExtension;

/**
 * Query IGP hook configuration from chain.
 *
 * @param query - Query client with PostDispatchExtension
 * @param hookId - ID of the IGP hook to query
 * @returns IGP hook configuration with address, owner, and destination gas configs
 * @throws Error if IGP hook not found
 */
export async function getIgpHookConfig(
  query: CosmosHookQueryClient,
  hookId: string,
): Promise<{
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
  try {
    // Query the IGP hook itself
    const { igp } = await query.postDispatch.Igp({ id: hookId });
    assert(igp, `No IGP hook found at id ${hookId}`);

    // Query the destination gas configs
    const { destination_gas_configs } =
      await query.postDispatch.DestinationGasConfigs({
        id: igp.id,
      });

    // Map the gas configs to the expected format
    const configs: {
      [domainId: string]: {
        gasOracle: {
          tokenExchangeRate: string;
          gasPrice: string;
        };
        gasOverhead: string;
      };
    } = {};

    for (const config of destination_gas_configs) {
      configs[config.remote_domain] = {
        gasOracle: {
          tokenExchangeRate: config.gas_oracle?.token_exchange_rate ?? '0',
          gasPrice: config.gas_oracle?.gas_price ?? '0',
        },
        gasOverhead: config.gas_overhead,
      };
    }

    return {
      address: igp.id,
      owner: igp.owner,
      destinationGasConfigs: configs,
    };
  } catch (error) {
    throw new Error(
      `Failed to query IGP hook config at ${hookId}: ${(error as Error).message}`,
    );
  }
}

/**
 * Query MerkleTree hook configuration from chain.
 *
 * @param query - Query client with PostDispatchExtension
 * @param hookId - ID of the MerkleTree hook to query
 * @returns MerkleTree hook configuration with address
 * @throws Error if MerkleTree hook not found
 */
export async function getMerkleTreeHookConfig(
  query: CosmosHookQueryClient,
  hookId: string,
): Promise<{
  address: string;
}> {
  try {
    const { merkle_tree_hook } = await query.postDispatch.MerkleTreeHook({
      id: hookId,
    });
    assert(merkle_tree_hook, `No MerkleTree hook found at id ${hookId}`);

    return {
      address: merkle_tree_hook.id,
    };
  } catch (error) {
    throw new Error(
      `Failed to query MerkleTree hook config at ${hookId}: ${(error as Error).message}`,
    );
  }
}
