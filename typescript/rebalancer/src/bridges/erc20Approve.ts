import { ethers } from 'ethers';
import type { Logger } from 'pino';

import { assert } from '@hyperlane-xyz/utils';

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

export interface Erc20ApprovalOptions {
  /**
   * Exact is required for dynamic, API-provided spenders. Infinite is reserved
   * for trusted, fixed contracts such as an OFT endpoint.
   */
  mode?: Erc20ApprovalMode;
  contractFactory?: Erc20ContractFactory;
}

const defaultContractFactory: Erc20ContractFactory = (address, abi, signer) =>
  new ethers.Contract(address, abi, signer);

async function revokeApproval(
  contract: ethers.Contract,
  spender: string,
  operation: string,
): Promise<void> {
  const revokeTx = await contract.approve(spender, 0);
  await waitForReceiptWithTimeout(revokeTx.wait(), {
    txHash: revokeTx.hash,
    operation,
    timeoutMs: DEFAULT_RECEIPT_TIMEOUT_MS,
    role: 'approval',
  });
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
    await revokeApproval(writeContract, spender, 'erc20 revoke approval');
  }

  const approveTx = await writeContract.approve(spender, targetAllowance);
  await waitForReceiptWithTimeout(approveTx.wait(), {
    txHash: approveTx.hash,
    operation: 'erc20 approve',
    timeoutMs: DEFAULT_RECEIPT_TIMEOUT_MS,
    role: 'approval',
  });
}

/** Revoke a nonzero ERC20 allowance and wait for a bounded receipt. */
export async function revokeErc20ApprovalIfNeeded(
  signer: ethers.Signer,
  token: string,
  spender: string,
  logger: Logger,
  options: Pick<Erc20ApprovalOptions, 'contractFactory'> = {},
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

  await revokeApproval(contract, spender, 'erc20 residue cleanup');
}

/** Queue an ERC20 revocation without relying on a potentially stale read. */
export async function revokeErc20Approval(
  signer: ethers.Signer,
  token: string,
  spender: string,
  logger: Logger,
  options: Pick<Erc20ApprovalOptions, 'contractFactory'> = {},
): Promise<void> {
  const contractFactory = options.contractFactory ?? defaultContractFactory;
  const contract = contractFactory(token, ERC20_ABI, signer);

  logger.info({ token, spender }, 'Forcing ERC20 approval revocation');
  await revokeApproval(contract, spender, 'erc20 forced cleanup');
}
