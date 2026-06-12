import { ethers } from 'ethers';
import { postCallCommitment } from '../client/ccs.js';
import type { QuoteResponse, RouteResponse } from '../client/schemas.js';
import { resolveRpcUrl } from '../utils/constants.js';
import { resolveEvmSigner } from '../wallet/adapter.js';
import type { WalletConfig } from '../wallet/types.js';
import { assert } from '../utils.js';
import type { SwapTracker } from './tracker.js';

// Minimal ERC-20 ABI fragments needed for approval.
const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

export interface ExecutorConfig {
  ccsUrl: string;
  chainRpcUrls: Record<number, string>;
}

export interface ExecutionResult {
  originTxHash: string;
  signer: ethers.Signer;
  provider: ethers.providers.Provider;
  route: RouteResponse;
  srcChainId: number;
  dstChainId: number;
}

export async function executeSwap(
  quote: QuoteResponse,
  wallet: WalletConfig,
  config: ExecutorConfig,
  tracker: SwapTracker,
): Promise<string> {
  assert(quote.routes.length > 0, 'Quote has no routes');
  const route = quote.routes[0];
  assert(route.tx, 'Route has no transaction — cannot execute');

  // Determine source chain from the first step.
  const srcChainId = route.steps[0]?.chain;
  assert(srcChainId != null, 'Cannot determine source chain from route steps');

  const dstStep = route.steps.find((s) => s.type === 'bridge');
  const dstChainId =
    dstStep?.type === 'bridge' ? dstStep.destChain : srcChainId;

  const rpcUrls = config.chainRpcUrls;
  const signer = await resolveEvmSigner(wallet, srcChainId, rpcUrls);
  const provider = signer.provider;
  assert(provider, 'Signer has no provider');

  // ERC-20 approval if needed.
  await ensureApproval(route, signer, srcChainId, rpcUrls);

  // If the route needs CCS coordination, register the commitment first.
  // This MUST happen before broadcasting the origin tx.
  if (route.callCommitment) {
    const { ccs } = route.callCommitment;
    await postCallCommitment(config.ccsUrl, ccs.path, ccs.body);
  }

  // Submit origin transaction. The engine already encodes a deadline in tx.data.
  const tx = await signer.sendTransaction({
    to: route.tx.to,
    data: route.tx.data,
    value: BigInt(route.tx.value),
  });

  tracker.onOriginTxSent(tx.hash, provider, route, srcChainId, dstChainId);

  return tx.hash;
}

async function ensureApproval(
  route: RouteResponse,
  signer: ethers.Signer,
  chainId: number,
  rpcUrls: Record<number, string>,
): Promise<void> {
  const firstStep = route.steps[0];
  if (!firstStep) return;

  // Resolve the ERC-20 token that the UniversalRouter will TRANSFER_FROM the user.
  // For swap-first routes: tokenIn. For bridge-first routes: the bridge asset.
  let tokenIn: string;
  let neededAmount: bigint;
  if (firstStep.type === 'swap') {
    tokenIn = firstStep.tokenIn;
    neededAmount = BigInt(firstStep.amountIn);
  } else if (firstStep.type === 'bridge') {
    tokenIn = firstStep.asset;
    neededAmount = BigInt(firstStep.amountIn);
  } else {
    return;
  }

  const isNative = tokenIn === '0x0000000000000000000000000000000000000000';
  if (isNative) return;

  // Router address comes from the route tx target.
  const routerAddress = route.tx?.to;
  if (!routerAddress) return;

  const owner = await signer.getAddress();
  const rpcUrl = resolveRpcUrl(chainId, rpcUrls);
  assert(rpcUrl, `No RPC URL for chain ${chainId}`);

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl, chainId);
  const token = new ethers.Contract(tokenIn, ERC20_ABI, provider);
  const currentAllowance: ethers.BigNumber = await token.allowance(
    owner,
    routerAddress,
  );

  if (currentAllowance.toBigInt() >= neededAmount) return;

  const tokenWithSigner = token.connect(signer);
  // Approve max uint256 to avoid repeated approvals.
  const approveTx: ethers.providers.TransactionResponse =
    await tokenWithSigner.approve(routerAddress, ethers.constants.MaxUint256);
  await approveTx.wait(1);
}
