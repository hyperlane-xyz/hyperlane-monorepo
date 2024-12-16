import { JsonRpcProvider } from '@ethersproject/providers';
import { ethers, providers } from 'ethers';

import { Address } from '@hyperlane-xyz/utils';

enum ANVIL_RPC_METHODS {
  RESET = 'anvil_reset',
  IMPERSONATE_ACCOUNT = 'anvil_impersonateAccount',
  STOP_IMPERSONATING_ACCOUNT = 'anvil_stopImpersonatingAccount',
  SET_BALANCE = 'anvil_setBalance',
  NODE_INFO = 'anvil_nodeInfo',
}

/**
 * Resets the local node to the RPC URL provided.
 */
export const resetFork = async (provider: JsonRpcProvider, rpcUrl: string) => {
  return provider.send(ANVIL_RPC_METHODS.RESET, [
    {
      forking: {
        jsonRpcUrl: rpcUrl,
      },
    },
  ]);
};

/**
 * Impersonates an EOA for a provided address.
 * @param address the address to impersonate
 * @returns the impersonated signer
 */
export const impersonateAccount = async (
  provider: JsonRpcProvider,
  address: Address,
  balance = ethers.constants.WeiPerEther.toHexString(),
): Promise<providers.JsonRpcSigner> => {
  await provider.send(ANVIL_RPC_METHODS.IMPERSONATE_ACCOUNT, [address]);

  await provider.send(ANVIL_RPC_METHODS.SET_BALANCE, [address, balance]);

  return provider.getSigner(address);
};

/**
 * Stops account impersonation.
 * @param address the address to stop impersonating
 */
export const stopImpersonatingAccount = async (
  provider: JsonRpcProvider,
  address: Address,
) => {
  return provider.send(ANVIL_RPC_METHODS.STOP_IMPERSONATING_ACCOUNT, [address]);
};
