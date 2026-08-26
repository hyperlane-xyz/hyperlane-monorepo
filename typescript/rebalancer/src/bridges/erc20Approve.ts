import { ethers } from 'ethers';
import type { Logger } from 'pino';

import { submitEvmLikeTransaction } from '@hyperlane-xyz/sdk';
import {
  TransactionSubmissionError,
  type TransactionSubmissionState,
  assert,
} from '@hyperlane-xyz/utils';

import type { BridgeExecutionOptions } from '../interfaces/IExternalBridge.js';

import {
  DEFAULT_RECEIPT_TIMEOUT_MS,
  waitForReceiptWithTimeout,
} from '../utils/receiptTimeout.js';

const ERC20_ABI = [
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
];

export enum Erc20ApprovalMode {
  Exact = 'exact',
  Infinite = 'infinite',
}

export type Erc20ContractFactory = (
  address: string,
  abi: string[],
  signer: ethers.Signer,
) => ethers.Contract;

export interface Erc20ApprovalOptions extends Pick<
  BridgeExecutionOptions,
  'onApproval'
> {
  /**
   * Exact is required for dynamic, API-provided spenders. Infinite is reserved
   * for trusted, fixed contracts such as an OFT endpoint.
   */
  mode?: Erc20ApprovalMode;
  contractFactory?: Erc20ContractFactory;
}

const defaultContractFactory: Erc20ContractFactory = (address, abi, signer) =>
  new ethers.Contract(address, abi, signer);

export class Erc20ApprovalError extends TransactionSubmissionError {
  constructor(
    cause: unknown,
    state: TransactionSubmissionState,
    hash: string | undefined,
    readonly token?: string,
    readonly spender?: string,
  ) {
    super(cause, state, hash);
    this.name = 'Erc20ApprovalError';
  }
}

async function sendApproval(
  contract: ethers.Contract,
  spender: string,
  amount: ethers.BigNumberish,
  operation: string,
  options: Pick<Erc20ApprovalOptions, 'onApproval'>,
): Promise<void> {
  let txHash: string | undefined;
  try {
    assert(
      contract.provider && contract.signer,
      'ERC20 approval signer requires a provider',
    );
    const request = await contract.populateTransaction.approve(spender, amount);
    const observe = options.onApproval;
    const tx = await submitEvmLikeTransaction(
      contract.signer,
      request,
      observe
        ? {
            onSubmissionAttempt: (hash) =>
              observe({ txHash: hash, token: contract.address, spender }),
            onSubmitted: (hash) =>
              observe({ txHash: hash, token: contract.address, spender }),
          }
        : undefined,
    );
    txHash = tx.hash;
    await waitForReceiptWithTimeout(tx, {
      txHash,
      operation,
      timeoutMs: DEFAULT_RECEIPT_TIMEOUT_MS,
      role: 'approval',
    });
    await observe?.(undefined);
  } catch (error) {
    const state =
      error instanceof TransactionSubmissionError
        ? error.submissionState
        : txHash
          ? 'submitted'
          : 'not_submitted';
    throw new Erc20ApprovalError(
      error,
      state,
      txHash ??
        (error instanceof TransactionSubmissionError
          ? error.txHash
          : undefined),
      contract.address,
      spender,
    );
  }
}

async function revokeApproval(
  contract: ethers.Contract,
  spender: string,
  operation: string,
  options: Pick<Erc20ApprovalOptions, 'onApproval'>,
): Promise<void> {
  await sendApproval(contract, spender, 0, operation, options);
}

/** Set an ERC20 allowance to the exact requested target when it differs. */
export async function approveErc20IfNeeded(
  signer: ethers.Signer,
  token: string,
  spender: string,
  amount: bigint,
  logger: Logger,
  options: Erc20ApprovalOptions = {},
): Promise<void> {
  assert(amount > 0n, 'ERC20 approval amount must be positive');

  const contractFactory = options.contractFactory ?? defaultContractFactory;
  const mode = options.mode ?? Erc20ApprovalMode.Exact;
  const readContract = contractFactory(token, ERC20_ABI, signer);
  const ownerAddress = await signer.getAddress();
  const currentAllowance: ethers.BigNumber = await readContract.allowance(
    ownerAddress,
    spender,
  );
  const requiredAllowance = ethers.BigNumber.from(amount.toString());
  const targetAllowance =
    mode === Erc20ApprovalMode.Infinite
      ? ethers.constants.MaxUint256
      : requiredAllowance;

  if (currentAllowance.eq(targetAllowance)) return;

  const writeContract = contractFactory(token, ERC20_ABI, signer);

  logger.info(
    {
      token,
      spender,
      approvalMode: mode,
      currentAllowance: currentAllowance.toString(),
      targetAllowance: targetAllowance.toString(),
    },
    'Refreshing ERC20 approval',
  );

  if (!currentAllowance.isZero()) {
    await revokeApproval(
      writeContract,
      spender,
      'erc20 revoke approval',
      options,
    );
  }

  await sendApproval(
    writeContract,
    spender,
    targetAllowance,
    'erc20 approve',
    options,
  );
}

/** Revoke a nonzero ERC20 allowance and wait for a bounded receipt. */
export async function revokeErc20ApprovalIfNeeded(
  signer: ethers.Signer,
  token: string,
  spender: string,
  logger: Logger,
  options: Pick<Erc20ApprovalOptions, 'contractFactory' | 'onApproval'> = {},
): Promise<void> {
  const contractFactory = options.contractFactory ?? defaultContractFactory;
  const contract = contractFactory(token, ERC20_ABI, signer);
  const ownerAddress = await signer.getAddress();
  const currentAllowance: ethers.BigNumber = await contract.allowance(
    ownerAddress,
    spender,
  );

  if (currentAllowance.isZero()) return;

  logger.info(
    {
      token,
      spender,
      currentAllowance: currentAllowance.toString(),
    },
    'Revoking ERC20 approval residue',
  );

  await revokeApproval(contract, spender, 'erc20 residue cleanup', options);
}

/** Queue an ERC20 revocation without relying on a potentially stale read. */
export async function revokeErc20Approval(
  signer: ethers.Signer,
  token: string,
  spender: string,
  logger: Logger,
  options: Pick<Erc20ApprovalOptions, 'contractFactory' | 'onApproval'> = {},
): Promise<void> {
  const contractFactory = options.contractFactory ?? defaultContractFactory;
  const contract = contractFactory(token, ERC20_ABI, signer);

  logger.info({ token, spender }, 'Forcing ERC20 approval revocation');
  await revokeApproval(contract, spender, 'erc20 forced cleanup', options);
}
