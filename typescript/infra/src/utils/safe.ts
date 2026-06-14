import { JsonRpcSigner } from '@ethersproject/providers';
import { SafeMultisigTransactionListResponse } from '@safe-global/api-kit';
import Safe from '@safe-global/protocol-kit';
import {
  MetaTransactionData,
  OperationType,
  SafeTransaction,
} from '@safe-global/safe-core-sdk-types';
import chalk from 'chalk';
import { BigNumber, ethers } from 'ethers';
import { formatUnits } from 'ethers/lib/utils.js';
import { Hex, decodeFunctionData, getAddress, isHex, parseAbi } from 'viem';

import { ISafe__factory } from '@hyperlane-xyz/core';
import {
  AnnotatedEV5Transaction,
  ChainName,
  ChainNameOrId,
  MultiProvider,
  getSafe,
  getSafeService,
  normalizeSafeTxServiceUrl,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  CallData,
  assert,
  deepCopy,
  eqAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getSecretDeployerKey } from '../agents/index.js';
import { AnnotatedCallData } from '../govern/types.js';

import { getSafeApiKey } from './safeApiKey.js';

const MIN_SAFE_API_VERSION = '5.18.0';

const SAFE_API_MAX_RETRIES = 10;
const SAFE_API_MIN_DELAY_MS = 1000;
const SAFE_API_MAX_DELAY_MS = 3000;

type SafeService = ReturnType<typeof getSafeService>;
type SafeMultisigTransactionResponse = Awaited<
  ReturnType<SafeService['getTransaction']>
>;

/**
 * Retry helper for Safe API calls with random delay between 1-3 seconds.
 * Handles rate limiting (429) errors with jittered backoff.
 */
export async function retrySafeApi<T>(runner: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= SAFE_API_MAX_RETRIES; attempt++) {
    try {
      return await runner();
    } catch (error) {
      const isLastAttempt = attempt === SAFE_API_MAX_RETRIES;
      if (isLastAttempt) {
        throw error;
      }

      const delayMs =
        Math.floor(
          Math.random() * (SAFE_API_MAX_DELAY_MS - SAFE_API_MIN_DELAY_MS),
        ) + SAFE_API_MIN_DELAY_MS;

      const warningMessage = chalk.yellow(
        `Safe API call failed (attempt ${attempt}/${SAFE_API_MAX_RETRIES}), retrying in ${delayMs}ms: ${error}`,
      );
      if (attempt > SAFE_API_MAX_RETRIES - 3) {
        rootLogger.warn(warningMessage);
      } else {
        rootLogger.debug(warningMessage);
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error('Unreachable');
}

export async function getSafeAndService(
  chain: ChainName,
  multiProvider: MultiProvider,
  safeAddress: Address,
) {
  let safeService: SafeService;
  try {
    safeService = getSafeService(chain, multiProvider);
  } catch (error) {
    throw new Error(
      `Failed to initialize Safe service for chain ${chain}: ${error}`,
    );
  }

  const { version } = await retrySafeApi(() => safeService.getServiceInfo());
  const isLegacy = await isLegacySafeApi(version);
  if (isLegacy) {
    throw new Error(
      `The Safe Transaction Service API for chain "${chain}" is running an outdated (legacy) version. ` +
        `Please contact the API owner to upgrade to at least version ${MIN_SAFE_API_VERSION} or newer. ` +
        `This application requires Safe Transaction Service version ${MIN_SAFE_API_VERSION} or higher to function correctly.`,
    );
  }

  const deployerKey = await getSecretDeployerKey(
    'mainnet3',
    Contexts.Hyperlane,
    chain,
  );
  let safeSdk: Safe.default;
  try {
    safeSdk = await retrySafeApi(() =>
      getSafe(chain, multiProvider, safeAddress, deployerKey),
    );
  } catch (error) {
    throw new Error(`Failed to initialize Safe for chain ${chain}: ${error}`);
  }
  return { safeSdk, safeService };
}

export async function isLegacySafeApi(version?: string): Promise<boolean> {
  if (!version) {
    throw new Error('Version is required');
  }
  // Compare semver: legacy if < MIN_SAFE_API_VERSION
  const legacyVersion = MIN_SAFE_API_VERSION.split('.').map((v: string) =>
    parseInt(v, 10),
  );
  const versionParts = version.split('.').map((v: string) => parseInt(v, 10));
  for (let i = 0; i < legacyVersion.length; ++i) {
    const v = versionParts[i] ?? 0;
    if (v < legacyVersion[i]) return true;
    if (v > legacyVersion[i]) return false;
  }
  return false;
}

export function createSafeTransactionData(call: CallData): MetaTransactionData {
  return {
    to: call.to,
    data: call.data.toString(),
    value: call.value?.toString() || '0',
  };
}

export async function executeTx(
  chain: ChainName,
  multiProvider: MultiProvider,
  safeAddress: Address,
  safeTxHash: string,
): Promise<void> {
  const { safeSdk, safeService } = await getSafeAndService(
    chain,
    multiProvider,
    safeAddress,
  );
  const safeTransaction = await retrySafeApi(() =>
    safeService.getTransaction(safeTxHash),
  );
  if (!safeTransaction) {
    throw new Error(`Failed to fetch transaction details for ${safeTxHash}`);
  }

  // Throw if the safe doesn't have enough balance to cover the gas
  let estimate;
  try {
    estimate = await retrySafeApi(() =>
      safeService.estimateSafeTransaction(safeAddress, safeTransaction),
    );
  } catch (error) {
    throw new Error(
      `Failed to estimate gas for Safe transaction ${safeTxHash} on chain ${chain}: ${error}`,
    );
  }
  const balance = await multiProvider
    .getProvider(chain)
    .getBalance(safeAddress);
  if (balance.lt(estimate.safeTxGas)) {
    throw new Error(
      `Safe ${safeAddress} on ${chain} has insufficient balance (${balance.toString()}) for estimated gas (${
        estimate.safeTxGas
      })`,
    );
  }

  await safeSdk.executeTransaction(safeTransaction);

  rootLogger.info(
    chalk.green.bold(`Executed transaction ${safeTxHash} on ${chain}`),
  );
}

export async function createSafeTransaction(
  safeSdk: Safe.default,
  transactions: MetaTransactionData[],
  onlyCalls?: boolean,
  nonce?: number,
): Promise<SafeTransaction> {
  return safeSdk.createTransaction({
    transactions,
    onlyCalls,
    ...(nonce !== undefined ? { options: { nonce: Number(nonce) } } : {}),
  });
}

export async function proposeSafeTransaction(
  chain: ChainNameOrId,
  safeSdk: Safe.default,
  safeService: SafeService,
  safeTransaction: SafeTransaction,
  safeAddress: Address,
  signer: ethers.Signer,
): Promise<string> {
  const safeTxHash = await safeSdk.getTransactionHash(safeTransaction);
  const senderSignature = await safeSdk.signTypedData(safeTransaction);
  const senderAddress = await signer.getAddress();

  await retrySafeApi(() =>
    safeService.proposeTransaction({
      safeAddress: safeAddress,
      safeTransactionData: safeTransaction.data,
      safeTxHash,
      senderAddress,
      senderSignature: senderSignature.data,
    }),
  );

  rootLogger.info(
    chalk.green(`Proposed transaction on ${chain} with hash ${safeTxHash}`),
  );

  return safeTxHash;
}

export async function deleteAllPendingSafeTxs(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
  safeAddress: Address,
): Promise<void> {
  const safeService = getSafeService(chain, multiProvider);
  const pendingTxs: SafeMultisigTransactionListResponse['results'] = [];
  const limit = 100;
  let offset = 0;

  // Fetch all pending transactions
  while (true) {
    let page: SafeMultisigTransactionListResponse;
    try {
      page = await retrySafeApi(() =>
        safeService.getMultisigTransactions(safeAddress, {
          executed: false,
          limit,
          offset,
        }),
      );
    } catch (error) {
      rootLogger.error(
        chalk.red(`Failed to fetch pending transactions for ${safeAddress}`),
        error,
      );
      return;
    }

    pendingTxs.push(...page.results);
    if (page.results.length < limit) break;
    offset += limit;
  }

  // Delete each pending transaction
  for (const tx of pendingTxs) {
    await deleteSafeTx(chain, multiProvider, safeAddress, tx.safeTxHash);
  }

  rootLogger.info(
    `Deleted all pending transactions on ${chain} for ${safeAddress}\n`,
  );
}

export async function getSafeTx(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
  safeTxHash: string,
): Promise<SafeMultisigTransactionResponse | undefined> {
  const safeService = getSafeService(chain, multiProvider);

  try {
    return await retrySafeApi(() => safeService.getTransaction(safeTxHash));
  } catch (error) {
    rootLogger.error(
      chalk.red(
        `Failed to fetch transaction details for ${safeTxHash} after ${SAFE_API_MAX_RETRIES} attempts: ${error}`,
      ),
    );
    return;
  }
}

export async function deleteSafeTx(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
  safeAddress: Address,
  safeTxHash: string,
): Promise<void> {
  const signer = multiProvider.getSigner(chain);
  const chainId = multiProvider.getEvmChainId(chain);
  const safeService = getSafeService(chain, multiProvider);
  const { gnosisSafeTransactionServiceUrl } =
    multiProvider.getChainMetadata(chain);
  assert(
    gnosisSafeTransactionServiceUrl,
    `Missing gnosisSafeTransactionServiceUrl for chain: ${chain}`,
  );
  const txServiceUrl = normalizeSafeTxServiceUrl(
    gnosisSafeTransactionServiceUrl,
  );
  const safeApiKey = await getSafeApiKey();

  // Fetch the transaction details to get the proposer
  let txDetails;
  try {
    txDetails = await retrySafeApi(() =>
      safeService.getTransaction(safeTxHash),
    );
  } catch (error) {
    rootLogger.error(
      chalk.red(`Failed to fetch transaction details for ${safeTxHash}`),
      error,
    );
    return;
  }
  const proposer = txDetails.proposer;

  if (!proposer) {
    rootLogger.error(
      chalk.red(`No proposer found for transaction ${safeTxHash}`),
    );
    return;
  }

  // Compare proposer to signer
  const signerAddress = await signer.getAddress();
  if (!eqAddress(proposer, signerAddress)) {
    rootLogger.info(
      chalk.italic(
        `Skipping deletion of transaction ${safeTxHash} proposed by ${proposer}`,
      ),
    );
    return;
  }
  rootLogger.info(`Deleting transaction ${safeTxHash} proposed by ${proposer}`);

  try {
    // Generate the EIP-712 signature
    const totp = Math.floor(Date.now() / 1000 / 3600);
    const typedData = {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        DeleteRequest: [
          { name: 'safeTxHash', type: 'bytes32' },
          { name: 'totp', type: 'uint256' },
        ],
      },
      domain: {
        name: 'Safe Transaction Service',
        version: '1.0',
        chainId: chainId,
        verifyingContract: safeAddress,
      },
      primaryType: 'DeleteRequest',
      message: {
        safeTxHash: safeTxHash,
        totp: totp,
      },
    };

    const signature = await (signer as JsonRpcSigner)._signTypedData(
      typedData.domain,
      { DeleteRequest: typedData.types.DeleteRequest },
      typedData.message,
    );

    // API Kit exposes no transaction-delete method, so use Safe's authenticated
    // Transaction Service endpoint directly.
    const deleteUrl = `${txServiceUrl}/v2/multisig-transactions/${safeTxHash}/`;
    await retrySafeApi(async () => {
      const res = await fetch(deleteUrl, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'node-fetch',
          Authorization: `Bearer ${safeApiKey}`,
        },
        body: JSON.stringify({ safeTxHash: safeTxHash, signature: signature }),
      });

      if (res.status === 204) {
        rootLogger.info(
          chalk.green(
            `Successfully deleted transaction ${safeTxHash} on ${chain}`,
          ),
        );
        return;
      }

      // 404: already deleted (e.g. prior retry succeeded but response was lost)
      if (res.status === 404) {
        rootLogger.info(
          chalk.green(`Transaction ${safeTxHash} on ${chain} already deleted`),
        );
        return;
      }

      const errorBody = await res.text();
      throw new Error(
        `Status ${res.status} ${res.statusText}. Response body: ${errorBody}`,
      );
    });
  } catch (error) {
    rootLogger.error(
      chalk.red(`Failed to delete transaction ${safeTxHash} on ${chain}:`),
      error,
    );
  }
}

export async function getOwnerChanges(
  currentOwners: Address[],
  expectedOwners: Address[],
): Promise<{
  ownersToRemove: Address[];
  ownersToAdd: Address[];
}> {
  const ownersToRemove = currentOwners.filter(
    (owner) => !expectedOwners.some((newOwner) => eqAddress(owner, newOwner)),
  );
  const ownersToAdd = expectedOwners.filter(
    (newOwner) => !currentOwners.some((owner) => eqAddress(newOwner, owner)),
  );

  return { ownersToRemove, ownersToAdd };
}

/**
 * Sentinel value used in Safe's owner linked list.
 * From OwnerManager.sol: address internal constant SENTINEL_OWNERS = address(0x1);
 * https://github.com/safe-global/safe-core-sdk/blob/201c50ef97ff5c48661cbe71a013ad7dc2866ada/packages/protocol-kit/src/utils/constants.ts#L5
 */
const SENTINEL_OWNERS = '0x0000000000000000000000000000000000000001';

/**
 * Finds the prevOwner for a given owner in the Safe's linked list.
 * Safe stores owners in a linked list where SENTINEL_OWNERS points to the first owner,
 * and the last owner points back to SENTINEL_OWNERS.
 *
 * The owners array from getOwners() returns owners in linked list order, so:
 * - owners[0] is pointed to by SENTINEL_OWNERS
 * - owners[1] is pointed to by owners[0]
 * - etc.
 */
function findPrevOwner(owners: Address[], targetOwner: Address): Address {
  const targetIndex = owners.findIndex((owner) =>
    eqAddress(owner, targetOwner),
  );

  if (targetIndex === -1) {
    throw new Error(`Owner ${targetOwner} not found in owners list`);
  }

  // If it's the first owner, prev is the sentinel address
  if (targetIndex === 0) {
    return SENTINEL_OWNERS;
  }

  // Otherwise, prev is the owner before it in the array
  return owners[targetIndex - 1];
}

/**
 * Creates swapOwner transactions for 1-to-1 owner replacements.
 * This is more efficient and succinct than remove+add operations.
 *
 * Note: Safe owners are stored in a linked list, so we need to swap them
 * in order. When swapping consecutive owners, the prevOwner for the second
 * swap needs to reference the NEW owner from the first swap.
 *
 * We manually craft the swapOwner calldata instead of using the Safe SDK's
 * createSwapOwnerTx because the SDK calculates prevOwner based on the current
 * Safe state, not the effective state after previous swaps in the same multicall.
 */
async function createSwapOwnerTransactions(
  safeSdk: Safe.default,
  effectiveOwners: Address[],
  ownersToRemove: Address[],
  ownersToAdd: Address[],
): Promise<AnnotatedCallData[]> {
  rootLogger.info(
    chalk.magentaBright(
      `Using swapOwner for ${ownersToRemove.length} owner replacement(s)`,
    ),
  );

  // Mutate the effective owner list as we perform swaps
  // This is crucial because when swapping consecutive owners in the linked list,
  // the prevOwner for the second swap needs to reference the NEW owner from the
  // first swap (since we just modified the linked list).
  const transactions: AnnotatedCallData[] = [];

  // Get the Safe contract address
  const safeAddress = await safeSdk.getAddress();

  // Pair each old owner with the corresponding new owner
  for (let i = 0; i < ownersToRemove.length; i++) {
    const oldOwner = ownersToRemove[i];
    const newOwner = ownersToAdd[i];

    // Find the prevOwner based on the effective owners list
    const prevOwner = findPrevOwner(effectiveOwners, oldOwner);

    // Find the old owner's position in the effective owners list
    const oldOwnerIndex = effectiveOwners.findIndex((owner: Address) =>
      eqAddress(owner, oldOwner),
    );

    // Update the effective owners list to reflect this swap
    // This ensures that subsequent swaps use the correct prevOwner
    if (oldOwnerIndex !== -1) {
      effectiveOwners[oldOwnerIndex] = newOwner;
    }

    // Manually encode the swapOwner calldata with the correct prevOwner
    const data = ISafe__factory.createInterface().encodeFunctionData(
      'swapOwner',
      [prevOwner, oldOwner, newOwner],
    );

    transactions.push({
      to: safeAddress,
      data,
      value: BigNumber.from(0),
      description: `Swap safe owner ${oldOwner} with ${newOwner} (prevOwner: ${prevOwner})`,
    });
  }

  return transactions;
}

async function createRemoveOwnerTransaction(
  safeSdk: Safe.default,
  effectiveOwners: Address[],
  ownerToRemove: Address,
  newThreshold: number,
): Promise<AnnotatedCallData> {
  const safeAddress = await safeSdk.getAddress();
  const prevOwner = findPrevOwner(effectiveOwners, ownerToRemove);
  const ownerIndex = effectiveOwners.findIndex((owner: Address) =>
    eqAddress(owner, ownerToRemove),
  );

  if (ownerIndex !== -1) {
    effectiveOwners.splice(ownerIndex, 1);
  }

  const data = ISafe__factory.createInterface().encodeFunctionData(
    'removeOwner',
    [prevOwner, ownerToRemove, newThreshold],
  );

  return {
    to: safeAddress,
    data,
    value: BigNumber.from(0),
    description: `Remove safe owner ${ownerToRemove} (prevOwner: ${prevOwner}, threshold: ${newThreshold})`,
  };
}

async function createAddOwnerWithThresholdTransaction(
  safeSdk: Safe.default,
  ownerToAdd: Address,
  newThreshold: number,
): Promise<AnnotatedCallData> {
  const safeAddress = await safeSdk.getAddress();

  const data = ISafe__factory.createInterface().encodeFunctionData(
    'addOwnerWithThreshold',
    [ownerToAdd, newThreshold],
  );

  return {
    to: safeAddress,
    data,
    value: BigNumber.from(0),
    description: `Add safe owner ${ownerToAdd} (threshold: ${newThreshold})`,
  };
}

/**
 * Creates a threshold change transaction.
 */
async function createThresholdTransaction(
  safeSdk: Safe.default,
  currentThreshold: number,
  newThreshold: number,
): Promise<AnnotatedCallData> {
  rootLogger.info(
    chalk.magentaBright(
      `Threshold change ${currentThreshold} => ${newThreshold}`,
    ),
  );
  const { data: thresholdTxData } =
    await safeSdk.createChangeThresholdTx(newThreshold);
  return {
    to: thresholdTxData.to,
    data: thresholdTxData.data,
    value: BigNumber.from(thresholdTxData.value),
    description: `Change safe threshold to ${newThreshold}`,
  };
}

export async function updateSafeOwner({
  safeSdk,
  owners,
  threshold,
  proposer,
}: {
  safeSdk: Safe.default;
  owners?: Address[];
  threshold?: number;
  proposer?: Address;
}): Promise<AnnotatedCallData[]> {
  const currentThreshold = await safeSdk.getThreshold();
  const newThreshold = threshold ?? currentThreshold;

  const currentOwners = await safeSdk.getOwners();
  const expectedOwners = owners ?? currentOwners;

  const { ownersToRemove, ownersToAdd } = await getOwnerChanges(
    currentOwners,
    expectedOwners,
  );

  rootLogger.info(chalk.magentaBright('Owners to remove:', ownersToRemove));
  rootLogger.info(chalk.magentaBright('Owners to add:', ownersToAdd));

  assert(expectedOwners.length >= 1, 'Safe must have at least one owner');
  assert(
    newThreshold >= 1,
    `Safe threshold ${newThreshold} must be at least 1`,
  );
  assert(
    newThreshold <= expectedOwners.length,
    `Safe threshold ${newThreshold} exceeds owner count ${expectedOwners.length}`,
  );
  assert(
    !proposer ||
      expectedOwners.some((owner: Address) => eqAddress(owner, proposer)),
    `Proposer ${proposer} must remain a Safe owner`,
  );

  // Build a mapping of owners to their positions in the currentOwners array.
  const ownerPositions = new Map<Address, number>();
  currentOwners.forEach((owner, index) => {
    ownerPositions.set(owner, index);
  });

  // Sort ownersToRemove by their position in the currentOwners array.
  // Safe owners are stored in a linked list, and each update changes the prevOwner
  // needed for later updates in the same multisend.
  const sortedOwnersToRemove = deepCopy(ownersToRemove).sort(
    (a: Address, b: Address) => {
      return (ownerPositions.get(a) ?? 0) - (ownerPositions.get(b) ?? 0);
    },
  );

  const transactions: AnnotatedCallData[] = [];
  const effectiveOwners = deepCopy(currentOwners);
  const swapCount = Math.min(ownersToRemove.length, ownersToAdd.length);

  // Use swapOwner for the overlapping owner replacements.
  if (swapCount > 0) {
    const swapTxs = await createSwapOwnerTransactions(
      safeSdk,
      effectiveOwners,
      sortedOwnersToRemove.slice(0, swapCount),
      ownersToAdd.slice(0, swapCount),
    );
    transactions.push(...swapTxs);
  }

  const surplusOwnersToRemove = sortedOwnersToRemove.slice(swapCount);
  for (const ownerToRemove of surplusOwnersToRemove) {
    transactions.push(
      await createRemoveOwnerTransaction(
        safeSdk,
        effectiveOwners,
        ownerToRemove,
        newThreshold,
      ),
    );
  }

  const surplusOwnersToAdd = ownersToAdd.slice(swapCount);
  for (let i = 0; i < surplusOwnersToAdd.length; i++) {
    const ownerToAdd = surplusOwnersToAdd[i];
    const isLastAdd = i === surplusOwnersToAdd.length - 1;
    const addThreshold = isLastAdd ? newThreshold : currentThreshold;
    transactions.push(
      await createAddOwnerWithThresholdTransaction(
        safeSdk,
        ownerToAdd,
        addThreshold,
      ),
    );
  }

  // Handle threshold changes not already handled by removeOwner/addOwnerWithThreshold.
  if (
    currentThreshold !== newThreshold &&
    surplusOwnersToRemove.length === 0 &&
    surplusOwnersToAdd.length === 0
  ) {
    const thresholdTx = await createThresholdTransaction(
      safeSdk,
      currentThreshold,
      newThreshold,
    );
    transactions.push(thresholdTx);
  }

  return transactions;
}

type SafeStatus = {
  chain: string;
  nonce: number;
  submissionDate: string;
  shortTxHash: string;
  fullTxHash: string;
  confs: number;
  threshold: number;
  status: string;
  balance: string;
};

export enum SafeTxStatus {
  NO_CONFIRMATIONS = '🔴',
  PENDING = '🟡',
  ONE_AWAY = '🔵',
  READY_TO_EXECUTE = '🟢',
}

export async function getPendingTxsForChains(
  chains: string[],
  multiProvider: MultiProvider,
  safes: Record<string, Address>,
): Promise<SafeStatus[]> {
  const txs: SafeStatus[] = [];
  await Promise.all(
    chains.map(async (chain) => {
      if (!safes[chain]) {
        rootLogger.error(chalk.red.bold(`No safe found for ${chain}`));
        return;
      }

      if (chain === 'endurance') {
        rootLogger.info(
          chalk.gray.italic(
            `Skipping chain ${chain} as it does not have a functional safe API`,
          ),
        );
        return;
      }

      let safeSdk: Safe.default;
      let safeService: SafeService;
      try {
        ({ safeSdk, safeService } = await getSafeAndService(
          chain,
          multiProvider,
          safes[chain],
        ));
      } catch (error) {
        rootLogger.warn(
          chalk.yellow(
            `Skipping chain ${chain} as there was an error getting the safe service: ${error}`,
          ),
        );
        return;
      }

      const threshold = await safeSdk.getThreshold();

      let pendingTxs: SafeMultisigTransactionListResponse;
      rootLogger.info(
        chalk.gray.italic(
          `Fetching pending transactions for safe ${safes[chain]} on ${chain}`,
        ),
      );
      try {
        pendingTxs = await retrySafeApi(() =>
          safeService.getPendingTransactions(safes[chain]),
        );
      } catch (error) {
        rootLogger.error(
          chalk.red(
            `Failed to fetch pending transactions for safe ${safes[chain]} on ${chain} after ${SAFE_API_MAX_RETRIES} attempts: ${error}`,
          ),
        );
        return;
      }

      if (!pendingTxs || pendingTxs.results.length === 0) {
        rootLogger.info(
          chalk.gray.italic(
            `No pending transactions found for safe ${safes[chain]} on ${chain}`,
          ),
        );
        return;
      }

      const balance = await safeSdk.getBalance();
      const nativeToken = await multiProvider.getNativeToken(chain);
      const formattedBalance = formatUnits(balance, nativeToken.decimals);

      pendingTxs.results.forEach(
        ({ nonce, submissionDate, safeTxHash, confirmations }) => {
          const confs = confirmations?.length ?? 0;
          const status =
            confs >= threshold
              ? SafeTxStatus.READY_TO_EXECUTE
              : confs === 0
                ? SafeTxStatus.NO_CONFIRMATIONS
                : threshold - confs === 1
                  ? SafeTxStatus.ONE_AWAY
                  : SafeTxStatus.PENDING;

          txs.push({
            chain,
            nonce: Number(nonce),
            submissionDate: new Date(submissionDate).toDateString(),
            shortTxHash: `${safeTxHash.slice(0, 6)}...${safeTxHash.slice(-4)}`,
            fullTxHash: safeTxHash,
            confs,
            threshold,
            status,
            balance: `${Number(formattedBalance).toFixed(5)} ${
              nativeToken.symbol
            }`,
          });
        },
      );
    }),
  );
  return txs.sort(
    (a, b) => a.chain.localeCompare(b.chain) || a.nonce - b.nonce,
  );
}

export function parseSafeTx(tx: AnnotatedEV5Transaction) {
  const decoded = ISafe__factory.createInterface().parseTransaction({
    data: tx.data ?? '0x',
    value: tx.value,
  });

  return decoded;
}

// Copied from https://github.com/safe-global/safe-core-sdk/blob/201c50ef97ff5c48661cbe71a013ad7dc2866ada/packages/protocol-kit/src/utils/types.ts#L15-L17
export function asHex(hex?: string): Hex {
  return isHex(hex) ? (hex as Hex) : (`0x${hex}` as Hex);
}

// Copied from https://github.com/safe-global/safe-core-sdk/blob/201c50ef97ff5c48661cbe71a013ad7dc2866ada/packages/protocol-kit/src/utils/transactions/utils.ts#L159-L193
export function decodeMultiSendData(
  encodedData: string,
): MetaTransactionData[] {
  const decodedData = decodeFunctionData({
    abi: parseAbi([
      'function multiSend(bytes memory transactions) public payable',
    ]),
    data: asHex(encodedData),
  });

  const args = decodedData.args;
  const txs: MetaTransactionData[] = [];

  // Decode after 0x
  let index = 2;

  if (args) {
    const [transactionBytes] = args;
    while (index < transactionBytes.length) {
      // As we are decoding hex encoded bytes calldata, each byte is represented by 2 chars
      // uint8 operation, address to, value uint256, dataLength uint256

      const operation = `0x${transactionBytes.slice(index, (index += 2))}`;
      const to = `0x${transactionBytes.slice(index, (index += 40))}`;
      const value = `0x${transactionBytes.slice(index, (index += 64))}`;
      const dataLength =
        parseInt(`${transactionBytes.slice(index, (index += 64))}`, 16) * 2;
      const data = `0x${transactionBytes.slice(index, (index += dataLength))}`;

      txs.push({
        operation: Number(operation) as OperationType,
        to: getAddress(to),
        value: BigInt(value).toString(),
        data,
      });
    }
  }

  return txs;
}
