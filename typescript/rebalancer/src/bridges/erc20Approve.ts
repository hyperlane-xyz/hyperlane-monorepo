import { ethers } from 'ethers';
import type { Logger } from 'pino';

import {
  DEFAULT_RECEIPT_TIMEOUT_MS,
  waitForReceiptWithTimeout,
} from '../utils/receiptTimeout.js';
import { computeBufferedApprovalAmount } from '../utils/erc20Approval.js';

const ERC20_ABI = [
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function decimals() external view returns (uint8)',
];

export type Erc20ContractFactory = (
  address: string,
  abi: string[],
  signer: ethers.Signer,
) => ethers.Contract;

const defaultContractFactory: Erc20ContractFactory = (address, abi, signer) =>
  new ethers.Contract(address, abi, signer);

/** Ensure the signer has enough ERC20 allowance for the spender. */
export async function approveErc20IfNeeded(
  signer: ethers.Signer,
  token: string,
  spender: string,
  amount: bigint,
  logger: Logger,
  contractFactory: Erc20ContractFactory = defaultContractFactory,
  infinite = false,
): Promise<void> {
  const readContract = contractFactory(token, ERC20_ABI, signer);
  const ownerAddress = await signer.getAddress();
  const currentAllowance: ethers.BigNumber = await readContract.allowance(
    ownerAddress,
    spender,
  );
  const requiredAllowance = ethers.BigNumber.from(amount.toString());
  if (currentAllowance.gte(requiredAllowance)) return;

  let targetAllowance: ethers.BigNumber;
  if (infinite) {
    targetAllowance = ethers.constants.MaxUint256;
  } else {
    const decimals = await readContract.decimals();
    targetAllowance = ethers.BigNumber.from(
      computeBufferedApprovalAmount(amount, Number(decimals)).toString(),
    );
  }

  const writeContract = contractFactory(token, ERC20_ABI, signer);

  logger.info(
    {
      token,
      spender,
      currentAllowance: currentAllowance.toString(),
      requiredAllowance: requiredAllowance.toString(),
      targetAllowance: targetAllowance.toString(),
    },
    'Refreshing ERC20 approval',
  );

  if (!currentAllowance.isZero()) {
    const revokeTx = await writeContract.approve(spender, 0);
    await waitForReceiptWithTimeout(revokeTx.wait(), {
      txHash: revokeTx.hash,
      operation: 'erc20 revoke approval',
      timeoutMs: DEFAULT_RECEIPT_TIMEOUT_MS,
      role: 'approval',
    });
  }

  const approveTx = await writeContract.approve(spender, targetAllowance);
  await waitForReceiptWithTimeout(approveTx.wait(), {
    txHash: approveTx.hash,
    operation: 'erc20 approve',
    timeoutMs: DEFAULT_RECEIPT_TIMEOUT_MS,
    role: 'approval',
  });
}
