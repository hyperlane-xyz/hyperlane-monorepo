import { providers } from 'ethers';

import { Address, isValidAddressEvm, rootLogger } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';

import { ENV } from './env.js';

const logger = rootLogger.child({ module: 'fork-utils' });

const ENDPOINT_PREFIX = 'http';
const DEFAULT_ANVIL_ENDPOINT = 'http://127.0.0.1:8545';

export enum ANVIL_RPC_METHODS {
  RESET = 'anvil_reset',
  IMPERSONATE_ACCOUNT = 'anvil_impersonateAccount',
  STOP_IMPERSONATING_ACCOUNT = 'anvil_stopImpersonatingAccount',
  NODE_INFO = 'anvil_nodeInfo',
}

/**
 * Resets the local node to it's original state (anvil [31337] at block zero).
 */
export const resetFork = async () => {
  logger.info(`Resetting forked network...`);

  const provider = getLocalProvider();
  await provider.send(ANVIL_RPC_METHODS.RESET, [
    {
      forking: {
        jsonRpcUrl: DEFAULT_ANVIL_ENDPOINT,
      },
    },
  ]);

  logger.info(`✅ Successfully reset forked network`);
};

/**
 * Forks a chain onto the local node at the latest block of the forked network.
 * @param multiProvider the multiProvider with which to fork the network
 * @param chain the network to fork
 */
export const setFork = async (
  multiProvider: MultiProvider,
  chain: ChainName | number,
) => {
  logger.info(`Forking ${chain} for dry-run...`);

  const provider = getLocalProvider();
  const currentChainMetadata = multiProvider.metadata[chain];

  await provider.send(ANVIL_RPC_METHODS.RESET, [
    {
      forking: {
        jsonRpcUrl: currentChainMetadata.rpcUrls[0].http,
      },
    },
  ]);

  multiProvider.setProvider(chain, provider);

  logger.info(`✅ Successfully forked ${chain} for dry-run`);
};

/**
 * Impersonates an EOA for a provided address.
 * @param address the address to impersonate
 * @returns the impersonated signer
 */
export const impersonateAccount = async (
  address: Address,
): Promise<providers.JsonRpcSigner> => {
  logger.info(`Impersonating account (${address})...`);

  const provider = getLocalProvider();
  await provider.send(ANVIL_RPC_METHODS.IMPERSONATE_ACCOUNT, [address]);

  logger.info(`✅ Successfully impersonated account (${address})`);

  return provider.getSigner(address);
};

/**
 * Stops account impersonation.
 * @param address the address to stop impersonating
 */
export const stopImpersonatingAccount = async (address: Address) => {
  logger.info(`Stopping account impersonation for address (${address})...`);

  if (isValidAddressEvm(address))
    throw new Error(
      `Cannot stop account impersonation: invalid address format: ${address}`,
    );

  const provider = getLocalProvider();
  await provider.send(ANVIL_RPC_METHODS.STOP_IMPERSONATING_ACCOUNT, [
    address.substring(2),
  ]);

  logger.info(
    `✅ Successfully stopped account impersonation for address (${address})`,
  );
};

/**
 * Retrieves a local provider. Defaults to DEFAULT_ANVIL_ENDPOINT.
 * @param urlOverride custom URL to overried the default endpoint
 * @returns a local JSON-RPC provider
 */
export const getLocalProvider = (
  urlOverride?: string,
): providers.JsonRpcProvider => {
  let envUrl;
  if (ENV.ANVIL_IP_ADDR && ENV.ANVIL_PORT)
    envUrl = `${ENDPOINT_PREFIX}${ENV.ANVIL_IP_ADDR}:${ENV.ANVIL_PORT}`;

  if (urlOverride && !urlOverride.startsWith(ENDPOINT_PREFIX)) {
    logger.warn(
      `⚠️ Provided URL override (${urlOverride}) does not begin with ${ENDPOINT_PREFIX}. Defaulting to ${
        envUrl ?? DEFAULT_ANVIL_ENDPOINT
      }`,
    );
    urlOverride = undefined;
  }

  const url = urlOverride ?? envUrl ?? DEFAULT_ANVIL_ENDPOINT;

  return new providers.JsonRpcProvider(url);
};
