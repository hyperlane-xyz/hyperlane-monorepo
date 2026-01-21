import { TronWeb } from 'tronweb';

import { assert } from '@hyperlane-xyz/utils';

import DomainRoutingIsmAbi from '../abi/DomainRoutingIsm.json' with { type: 'json' };
import IInterchainSecurityModuleAbi from '../abi/IInterchainSecurityModule.json' with { type: 'json' };
import NoopIsmAbi from '../abi/NoopIsm.json' with { type: 'json' };
import StorageMerkleRootMultisigIsmAbi from '../abi/StorageMerkleRootMultisigIsm.json' with { type: 'json' };
import StorageMessageIdMultisigIsmAbi from '../abi/StorageMessageIdMultisigIsm.json' with { type: 'json' };
import { TronIsmTypes } from '../utils/types.js';

/**
 * Type alias for query client with ISM extension.
 * Used throughout ISM readers to ensure type safety.
 */
export type TronIsmQueryClient = TronWeb;

/**
 * Query ISM type from address.
 *
 * @param query - Query client
 * @param ismAddress - Address of the ISM to query
 * @returns The AltVM ISM type
 * @throws Error if ISM not found or unknown type
 */
export async function getIsmType(
  query: TronIsmQueryClient,
  ismAddress: string,
): Promise<TronIsmTypes> {
  try {
    const contract = query.contract(
      IInterchainSecurityModuleAbi.abi,
      ismAddress,
    );

    const moduleType = Number(await contract.moduleType().call());

    switch (moduleType) {
      case 1:
        return TronIsmTypes.ROUTING_ISM;
      case 4:
        return TronIsmTypes.MERKLE_ROOT_MULTISIG;
      case 5:
        return TronIsmTypes.MESSAGE_ID_MULTISIG;
      case 6:
        return TronIsmTypes.NOOP_ISM;
      default:
        throw new Error(`Unknown ISM type for address: ${ismAddress}`);
    }
  } catch (error) {
    throw new Error(
      `Failed to query ISM type at ${ismAddress}: ${(error as Error).message}`,
    );
  }
}

/**
 * Query NoopIsm configuration.
 *
 * @param query - Query client
 * @param ismAddress - Address of the NoopIsm to query
 * @returns NoopIsm configuration with address
 * @throws Error if NoopIsm not found
 */
export async function getNoopIsmConfig(
  query: TronIsmQueryClient,
  ismAddress: string,
): Promise<{ address: string }> {
  try {
    const contract = query.contract(NoopIsmAbi.abi, ismAddress);

    const moduleType = await contract.moduleType().call();
    assert(Number(moduleType) === 6, `module type does not equal NULL_ISM`);

    return {
      address: ismAddress,
    };
  } catch (error) {
    throw new Error(
      `Failed to query NoopIsm config at ${ismAddress}: ${(error as Error).message}`,
    );
  }
}

/**
 * Query Message ID Multisig ISM configuration.
 *
 * @param query - Query client
 * @param ismAddress - Address of the Message ID Multisig ISM to query
 * @returns Message ID Multisig ISM configuration with address, validators, and threshold
 * @throws Error if Message ID Multisig ISM not found
 */
export async function getMessageIdMultisigIsmConfig(
  query: TronIsmQueryClient,
  ismAddress: string,
): Promise<{
  address: string;
  validators: string[];
  threshold: number;
}> {
  try {
    const contract = query.contract(
      StorageMessageIdMultisigIsmAbi.abi,
      ismAddress,
    );

    return {
      address: ismAddress,
      threshold: Number(await contract.threshold().call()),
      validators: await contract.validators().call(),
    };
  } catch (error) {
    throw new Error(
      `Failed to query Message ID Multisig ISM config at ${ismAddress}: ${(error as Error).message}`,
    );
  }
}

/**
 * Query Merkle Root Multisig ISM configuration.
 *
 * @param query - Query client
 * @param ismAddress - Address of the Merkle Root Multisig ISM to query
 * @returns Merkle Root Multisig ISM configuration with address, validators, and threshold
 * @throws Error if Merkle Root Multisig ISM not found
 */
export async function getMerkleRootMultisigIsmConfig(
  query: TronIsmQueryClient,
  ismAddress: string,
): Promise<{
  address: string;
  validators: string[];
  threshold: number;
}> {
  try {
    const contract = query.contract(
      StorageMerkleRootMultisigIsmAbi.abi,
      ismAddress,
    );

    return {
      address: ismAddress,
      threshold: await contract.threshold().call(),
      validators: await contract.validators().call(),
    };
  } catch (error) {
    throw new Error(
      `Failed to query Merkle Root Multisig ISM config at ${ismAddress}: ${(error as Error).message}`,
    );
  }
}

/**
 * Query routing ISM configuration.
 *
 * @param query - Query client
 * @param ismAddress - Address of the routing ISM to query
 * @returns Routing ISM configuration with address, owner, and routes
 * @throws Error if routing ISM not found
 */
export async function getRoutingIsmConfig(
  query: TronIsmQueryClient,
  ismAddress: string,
): Promise<{
  address: string;
  owner: string;
  routes: Array<{ domainId: number; ismAddress: string }>;
}> {
  try {
    const contract = query.contract(DomainRoutingIsmAbi.abi, ismAddress);

    const routes = [];

    const domainIds = await contract.domains().call();

    for (const domainId of domainIds) {
      const ismAddress = query.address.fromHex(
        await contract.module(domainId).call(),
      );
      routes.push({
        domainId: Number(domainId),
        ismAddress,
      });
    }

    return {
      address: ismAddress,
      owner: query.address.fromHex(await contract.owner().call()),
      routes,
    };
  } catch (error) {
    throw new Error(
      `Failed to query routing ISM config at ${ismAddress}: ${(error as Error).message}`,
    );
  }
}
