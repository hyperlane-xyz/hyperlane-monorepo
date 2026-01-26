import { TronWeb } from 'tronweb';

import { assert } from '@hyperlane-xyz/utils';

import IPostDispatchHookAbi from '../abi/IPostDispatchHook.json' with { type: 'json' };
import InterchainGasPaymasterAbi from '../abi/InterchainGasPaymaster.json' with { type: 'json' };
import MerkleTreeHookAbi from '../abi/MerkleTreeHook.json' with { type: 'json' };
import StorageGasOracleAbi from '../abi/StorageGasOracle.json' with { type: 'json' };
import { TronHookTypes } from '../utils/types.js';

/**
 * Type alias for query client with ISM extension.
 * Used throughout ISM readers to ensure type safety.
 */
export type TronHookQueryClient = TronWeb;

export async function getHookType(
  query: TronHookQueryClient,
  hookAddress: string,
): Promise<TronHookTypes> {
  const contract = query.contract(IPostDispatchHookAbi.abi, hookAddress);

  const hookType = Number(await contract.hookType().call());

  switch (hookType) {
    case 3:
      return TronHookTypes.MERKLE_TREE;
    case 4:
      return TronHookTypes.INTERCHAIN_GAS_PAYMASTER;
    default:
      throw new Error(`Unknown Hook type for address: ${hookAddress}`);
  }
}

/**
 * Query IGP hook configuration from chain.
 *
 * @param query - Query client with PostDispatchExtension
 * @param hookId - ID of the IGP hook to query
 * @returns IGP hook configuration with address, owner, and destination gas configs
 * @throws Error if IGP hook not found
 */
export async function getIgpHookConfig(
  query: TronHookQueryClient,
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
    const igp = query.contract(InterchainGasPaymasterAbi.abi, hookId);

    const hookType = await igp.hookType().call();
    assert(
      Number(hookType) === 4,
      `hook type does not equal INTERCHAIN_GAS_PAYMASTER`,
    );

    const domainIds = await igp.domains().call();

    const destinationGasConfigs = {} as {
      [domainId: string]: {
        gasOracle: {
          tokenExchangeRate: string;
          gasPrice: string;
        };
        gasOverhead: string;
      };
    };

    for (const domainId of domainIds) {
      const c = await igp.destinationGasConfigs(domainId).call();

      const gasOracle = query.contract(
        StorageGasOracleAbi.abi,
        query.address.fromHex(c.gasOracle),
      );

      const { tokenExchangeRate, gasPrice } = await gasOracle
        .remoteGasData(domainId)
        .call();

      destinationGasConfigs[domainId.toString()] = {
        gasOracle: {
          tokenExchangeRate: tokenExchangeRate.toString(),
          gasPrice: gasPrice.toString(),
        },
        gasOverhead: c.gasOverhead.toString(),
      };
    }

    return {
      address: hookId,
      owner: query.address.fromHex(await igp.owner().call()),
      destinationGasConfigs,
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
  query: TronHookQueryClient,
  hookId: string,
): Promise<{
  address: string;
}> {
  try {
    const contract = query.contract(MerkleTreeHookAbi.abi, hookId);

    const hookType = await contract.hookType().call();
    assert(Number(hookType) === 3, `hook type does not equal MERKLE_TREE`);

    return {
      address: hookId,
    };
  } catch (error) {
    throw new Error(
      `Failed to query MerkleTree hook config at ${hookId}: ${(error as Error).message}`,
    );
  }
}
