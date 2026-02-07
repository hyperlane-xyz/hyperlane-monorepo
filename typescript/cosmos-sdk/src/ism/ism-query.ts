import { type QueryClient } from '@cosmjs/stargate';

import { type isTypes } from '@hyperlane-xyz/cosmos-types';
import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert } from '@hyperlane-xyz/utils';

import {
  IsmTypes as CosmosNativeIsmTypes,
  type InterchainSecurityExtension,
} from '../hyperlane/interchain_security/query.js';

/**
 * Type alias for query client with ISM extension.
 * Used throughout ISM readers to ensure type safety.
 */
export type CosmosIsmQueryClient = QueryClient & InterchainSecurityExtension;

/**
 * Query ISM type from address.
 *
 * @param query - Query client with InterchainSecurityExtension
 * @param ismAddress - Address of the ISM to query
 * @returns The AltVM ISM type
 * @throws Error if ISM not found or unknown type
 */
export async function getIsmType(
  query: CosmosIsmQueryClient,
  ismAddress: string,
): Promise<AltVM.IsmType> {
  try {
    const { ism } = await query.interchainSecurity.Ism({
      id: ismAddress,
    });
    assert(ism, `No ISM found at address ${ismAddress}`);

    // Map Cosmos ISM type URL to AltVM ISM type
    switch (ism.type_url) {
      case CosmosNativeIsmTypes.MerkleRootMultisigISM:
        return AltVM.IsmType.MERKLE_ROOT_MULTISIG;
      case CosmosNativeIsmTypes.MessageIdMultisigISM:
        return AltVM.IsmType.MESSAGE_ID_MULTISIG;
      case CosmosNativeIsmTypes.RoutingISM:
        return AltVM.IsmType.ROUTING;
      case CosmosNativeIsmTypes.NoopISM:
        return AltVM.IsmType.TEST_ISM;
      default:
        throw new Error(`Unknown Cosmos ISM type: ${ism.type_url}`);
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
 * @param query - Query client with InterchainSecurityExtension
 * @param ismAddress - Address of the NoopIsm to query
 * @returns NoopIsm configuration with address
 * @throws Error if NoopIsm not found
 */
export async function getNoopIsmConfig(
  query: CosmosIsmQueryClient,
  ismAddress: string,
): Promise<{ address: string }> {
  try {
    const { ism } = await query.interchainSecurity.DecodedIsm<isTypes.NoopISM>({
      id: ismAddress,
    });
    assert(ism, `No NoopIsm found at address ${ismAddress}`);

    return {
      address: ism.id,
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
 * @param query - Query client with InterchainSecurityExtension
 * @param ismAddress - Address of the Message ID Multisig ISM to query
 * @returns Message ID Multisig ISM configuration with address, validators, and threshold
 * @throws Error if Message ID Multisig ISM not found
 */
export async function getMessageIdMultisigIsmConfig(
  query: CosmosIsmQueryClient,
  ismAddress: string,
): Promise<{
  address: string;
  validators: string[];
  threshold: number;
}> {
  try {
    const { ism } =
      await query.interchainSecurity.DecodedIsm<isTypes.MessageIdMultisigISM>({
        id: ismAddress,
      });
    assert(ism, `No Message ID Multisig ISM found at address ${ismAddress}`);

    return {
      address: ism.id,
      validators: ism.validators,
      threshold: ism.threshold,
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
 * @param query - Query client with InterchainSecurityExtension
 * @param ismAddress - Address of the Merkle Root Multisig ISM to query
 * @returns Merkle Root Multisig ISM configuration with address, validators, and threshold
 * @throws Error if Merkle Root Multisig ISM not found
 */
export async function getMerkleRootMultisigIsmConfig(
  query: CosmosIsmQueryClient,
  ismAddress: string,
): Promise<{
  address: string;
  validators: string[];
  threshold: number;
}> {
  try {
    const { ism } =
      await query.interchainSecurity.DecodedIsm<isTypes.MerkleRootMultisigISM>({
        id: ismAddress,
      });
    assert(ism, `No Merkle Root Multisig ISM found at address ${ismAddress}`);

    return {
      address: ism.id,
      validators: ism.validators,
      threshold: ism.threshold,
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
 * @param query - Query client with InterchainSecurityExtension
 * @param ismAddress - Address of the routing ISM to query
 * @returns Routing ISM configuration with address, owner, and routes
 * @throws Error if routing ISM not found
 */
export async function getRoutingIsmConfig(
  query: Readonly<CosmosIsmQueryClient>,
  ismAddress: string,
): Promise<{
  address: string;
  owner: string;
  routes: Array<{ domainId: number; ismAddress: string }>;
}> {
  try {
    const { ism } =
      await query.interchainSecurity.DecodedIsm<isTypes.RoutingISM>({
        id: ismAddress,
      });
    assert(ism, `No routing ISM found at address ${ismAddress}`);

    return {
      address: ism.id,
      owner: ism.owner,
      routes: ism.routes.map((r) => ({
        domainId: r.domain,
        ismAddress: r.ism,
      })),
    };
  } catch (error) {
    throw new Error(
      `Failed to query routing ISM config at ${ismAddress}: ${(error as Error).message}`,
    );
  }
}
