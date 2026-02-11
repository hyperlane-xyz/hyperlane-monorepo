import { BigNumber, ethers } from 'ethers';

import { InterchainAccountRouter__factory } from '@hyperlane-xyz/core';
import {
  Address,
  addressToBytes32,
  bytes32ToAddress,
} from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../providers/MultiProvider.js';
import { ChainName } from '../../types.js';

import { RawCallData, normalizeCalls } from './InterchainAccount.js';

/**
 * Request type for token transfer ICA relay
 */
export interface TokenTransferIcaRequest {
  txHash: string;
  originChain: string;
  destinationChain: string;
  calls: RawCallData[];
  tokenAddress: Address;
  icaAddress: Address;
  sender?: Address;
  originRouterAddress?: Address;
}

/**
 * Response from relay endpoint
 */
export interface TokenTransferIcaResponse {
  success: boolean;
  validated?: boolean; // MVP: just validation
  destTxHash?: string; // Future: when we add execution
  error?: string;
}

/**
 * Compute ICA address for token transfer triggered calls
 *
 * @param multiProvider MultiProvider instance with chain metadata
 * @param originChain Origin chain name
 * @param destinationChain Destination chain name
 * @param calls Array of calls to execute on destination
 * @param sender Optional sender address (defaults to zero address for unauthenticated)
 * @param originRouterAddress Optional ICA router address (will try to get from metadata if not provided)
 * @returns The computed ICA address on the origin chain
 */
export async function computeTokenTransferIca(
  multiProvider: MultiProvider,
  originChain: ChainName,
  destinationChain: ChainName,
  calls: RawCallData[],
  sender?: Address,
  originRouterAddress?: Address,
): Promise<Address> {
  const destDomain = multiProvider.getDomainId(destinationChain);

  // Get router address
  if (!originRouterAddress) {
    const metadata = multiProvider.getChainMetadata(originChain);
    originRouterAddress = (metadata as any).interchainAccountRouter;
  }

  if (!originRouterAddress) {
    throw new Error(
      `ICA router address not found for origin chain: ${originChain}. Please provide originRouterAddress parameter.`,
    );
  }

  const originProvider = multiProvider.getProvider(originChain);
  const originRouter = InterchainAccountRouter__factory.connect(
    originRouterAddress,
    originProvider,
  );

  // Compute salt from calls
  const normalizedCalls = normalizeCalls(calls);
  const salt = ethers.utils.keccak256(
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

  // Get destination router address
  const destRouterBytes32 = await originRouter.routers(destDomain);
  const destRouterAddress = bytes32ToAddress(destRouterBytes32);

  // Get ISM address (should be IcaCallCommitmentIsm)
  const ismBytes32 = await originRouter.isms(destDomain);
  const ismAddress = bytes32ToAddress(ismBytes32);

  // Compute ICA address
  const senderAddress = sender || ethers.constants.AddressZero;
  const icaAddressBytes32 = await originRouter[
    'getRemoteInterchainAccount(address,address,address,bytes32)'
  ](senderAddress, destRouterAddress, ismAddress, salt);

  return bytes32ToAddress(icaAddressBytes32);
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
 * Monitor ICA balance changes
 *
 * @param provider Ethers provider for the chain
 * @param tokenAddress ERC20 token address
 * @param icaAddress ICA address to monitor
 * @param onBalanceChange Callback invoked when balance changes
 * @param pollIntervalMs Polling interval in milliseconds (default: 5000)
 * @returns Function to stop monitoring
 */
export function monitorIcaBalance(
  provider: ethers.providers.Provider,
  tokenAddress: Address,
  icaAddress: Address,
  onBalanceChange: (balance: BigNumber) => void,
  pollIntervalMs: number = 5000,
): () => void {
  const erc20Abi = ['function balanceOf(address owner) view returns (uint256)'];

  const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, provider);

  let lastBalance: BigNumber | null = null;

  const checkBalance = async () => {
    try {
      const currentBalance: BigNumber =
        await tokenContract.balanceOf(icaAddress);

      if (lastBalance === null || !currentBalance.eq(lastBalance)) {
        lastBalance = currentBalance;
        onBalanceChange(currentBalance);
      }
    } catch (error) {
      console.error('Error checking ICA balance:', error);
    }
  };

  // Initial check
  checkBalance();

  // Start polling
  const intervalId = setInterval(checkBalance, pollIntervalMs);

  // Return stop function
  return () => clearInterval(intervalId);
}

/**
 * Wait for a token transfer to a specific address in a transaction
 *
 * @param provider Ethers provider
 * @param txHash Transaction hash
 * @param tokenAddress Expected ERC20 token address
 * @param recipientAddress Expected recipient address
 * @returns Transfer amount if found, null otherwise
 */
export async function waitForTokenTransfer(
  provider: ethers.providers.Provider,
  txHash: string,
  tokenAddress: Address,
  recipientAddress: Address,
): Promise<BigNumber | null> {
  const TRANSFER_EVENT_SIGNATURE =
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

  const receipt = await provider.waitForTransaction(txHash);

  if (!receipt) {
    return null;
  }

  // Find Transfer event
  const transferLog = receipt.logs.find((log) => {
    try {
      return (
        log.topics[0] === TRANSFER_EVENT_SIGNATURE &&
        ethers.utils.getAddress(log.address) ===
          ethers.utils.getAddress(tokenAddress) &&
        log.topics[2] ===
          ethers.utils.hexZeroPad(recipientAddress.toLowerCase(), 32)
      );
    } catch {
      return false;
    }
  });

  if (!transferLog) {
    return null;
  }

  // Decode amount
  return BigNumber.from(transferLog.data);
}

/**
 * Helper to get ERC20 token balance
 *
 * @param provider Ethers provider
 * @param tokenAddress ERC20 token address
 * @param accountAddress Account to check balance for
 * @returns Token balance
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
