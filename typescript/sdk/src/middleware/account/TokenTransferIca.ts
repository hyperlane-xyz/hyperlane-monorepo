import { BigNumber, ethers } from 'ethers';

import { InterchainAccountRouter__factory } from '@hyperlane-xyz/core';
import { Address, addressToBytes32 } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../providers/MultiProvider.js';
import { ChainName } from '../../types.js';

import { RawCallData, normalizeCalls } from './InterchainAccount.js';

/**
 * Request type for token transfer ICA relay
 */
export interface TokenTransferIcaRequest {
  txHash: string;
  chain: string;
  calls: RawCallData[];
  tokenAddress: Address;
  icaAddress: Address;
  routerAddress: Address;
}

/**
 * Response from relay endpoint
 */
export interface TokenTransferIcaResponse {
  success: boolean;
  validated?: boolean;
  executed?: boolean;
  executionTxHash?: string;
  error?: string;
}

/**
 * Compute the salt used for unauthenticated ICA address derivation from calls.
 * This matches the on-chain computation: keccak256(abi.encode(calls))
 */
export function computeTokenTransferIcaSalt(calls: RawCallData[]): string {
  const normalizedCalls = normalizeCalls(calls);
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['tuple(bytes32 to, uint256 value, bytes data)[]'],
      [
        normalizedCalls.map((call) => ({
          to: addressToBytes32(call.to),
          value: call.value || 0,
          data: call.data,
        })),
      ],
    ),
  );
}

/**
 * Compute the deterministic ICA address for unauthenticated local execution.
 * The ICA address is derived from: localDomain, owner=0x0, router=self, ism=0x0, salt=keccak256(calls)
 *
 * @param multiProvider MultiProvider instance with chain metadata
 * @param chain Chain name where the ICA will be deployed/executed
 * @param calls Array of calls to execute
 * @param routerAddress ICA router address on the chain
 * @returns The computed ICA address
 */
export async function computeTokenTransferIca(
  multiProvider: MultiProvider,
  chain: ChainName,
  calls: RawCallData[],
  routerAddress: Address,
): Promise<Address> {
  const provider = multiProvider.getProvider(chain);
  const router = InterchainAccountRouter__factory.connect(
    routerAddress,
    provider,
  );

  const salt = computeTokenTransferIcaSalt(calls);
  const localDomain = multiProvider.getDomainId(chain);

  const computedIca = await router[
    'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)'
  ](
    localDomain,
    ethers.constants.HashZero, // owner = zero (unauthenticated)
    addressToBytes32(routerAddress), // router = self
    ethers.constants.AddressZero, // ism = zero
    salt,
  );

  return computedIca.toLowerCase() as Address;
}

/**
 * Submit token transfer ICA relay request to ccip-server
 *
 * @param serverUrl Base URL of the ccip-server (e.g., http://localhost:3000)
 * @param request Token transfer ICA relay request
 * @returns Response from the relay endpoint
 */
export async function relayTokenTransferIca(
  serverUrl: string,
  request: TokenTransferIcaRequest,
): Promise<TokenTransferIcaResponse> {
  const response = await fetch(`${serverUrl}/tokenTransferIca/relay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Token transfer ICA relay failed: ${response.status} ${errorText}`,
    );
  }

  return await response.json();
}

/**
 * Helper to get ERC20 token balance
 */
export async function getErc20Balance(
  provider: ethers.providers.Provider,
  tokenAddress: Address,
  accountAddress: Address,
): Promise<BigNumber> {
  const erc20Abi = ['function balanceOf(address owner) view returns (uint256)'];
  const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, provider);
  return await tokenContract.balanceOf(accountAddress);
}
