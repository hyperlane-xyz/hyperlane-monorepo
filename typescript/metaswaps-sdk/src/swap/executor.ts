import { ethers } from 'ethers';
import { postCallCommitment } from '../client/ccs.js';
import {
  EvmRouteTxSchema,
  type EvmRouteTx,
  type QuoteResponse,
  type RouteApproval,
  type RouteResponse,
  type RouteTx,
} from '../client/schemas.js';
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
const PERMIT2_ABI = [
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
];
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;

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

  await ensureApproval(route, signer, srcChainId, rpcUrls);

  // If the route needs CCS coordination, register the commitment first.
  // This MUST happen before broadcasting the origin tx.
  if (route.callCommitment) {
    const { ccs } = route.callCommitment;
    await postCallCommitment(config.ccsUrl, ccs.path, ccs.body);
  }

  const executableTxs = executableEvmTxs(route);
  assert(executableTxs.length > 0, 'Route has no EVM transaction to execute');

  let tx: ethers.providers.TransactionResponse | undefined;
  for (const executableTx of executableTxs) {
    tx = await signer.sendTransaction({
      to: executableTx.to,
      data: executableTx.data,
      value: BigInt(executableTx.value),
    });
    await tx.wait(1);
  }
  assert(tx, 'No origin transaction was submitted');

  tracker.onOriginTxSent(tx.hash, provider, route, srcChainId, dstChainId);

  return tx.hash;
}

async function ensureApproval(
  route: RouteResponse,
  signer: ethers.Signer,
  chainId: number,
  rpcUrls: Record<number, string>,
): Promise<void> {
  if (route.approval) {
    await ensureRouteApproval(route.approval, signer, chainId, rpcUrls);
    return;
  }

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
  const routerAddress = route.tx ? evmTxFromRouteTx(route.tx)?.to : undefined;
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

async function ensureRouteApproval(
  approval: RouteApproval,
  signer: ethers.Signer,
  chainId: number,
  rpcUrls: Record<number, string>,
): Promise<void> {
  if (approval.kind === 'erc20') {
    await ensureErc20Allowance(
      approval.token,
      approval.spender,
      BigInt(approval.amount),
      signer,
      chainId,
      rpcUrls,
    );
    return;
  }

  assert(approval.permit2Spender, 'Permit2 approval missing permit2Spender');
  const amount = BigInt(approval.amount);
  assert(amount <= MAX_UINT160, 'Permit2 approval amount exceeds uint160');

  await ensureErc20Allowance(
    approval.token,
    approval.spender,
    amount,
    signer,
    chainId,
    rpcUrls,
  );

  const owner = await signer.getAddress();
  const rpcUrl = resolveRpcUrl(chainId, rpcUrls);
  assert(rpcUrl, `No RPC URL for chain ${chainId}`);
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl, chainId);
  const permit2 = new ethers.Contract(approval.spender, PERMIT2_ABI, provider);
  const allowance = await permit2.allowance(
    owner,
    approval.token,
    approval.permit2Spender,
  );
  const currentAmount = BigInt(allowance.amount.toString());
  const expiration = Number(allowance.expiration.toString());
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (currentAmount >= amount && expiration > nowSeconds) return;

  const permit2WithSigner = permit2.connect(signer);
  const approveTx: ethers.providers.TransactionResponse =
    await permit2WithSigner.approve(
      approval.token,
      approval.permit2Spender,
      amount.toString(),
      MAX_UINT48.toString(),
    );
  await approveTx.wait(1);
}

async function ensureErc20Allowance(
  tokenAddress: string,
  spender: string,
  amount: bigint,
  signer: ethers.Signer,
  chainId: number,
  rpcUrls: Record<number, string>,
): Promise<void> {
  const owner = await signer.getAddress();
  const rpcUrl = resolveRpcUrl(chainId, rpcUrls);
  assert(rpcUrl, `No RPC URL for chain ${chainId}`);

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl, chainId);
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const currentAllowance: ethers.BigNumber = await token.allowance(
    owner,
    spender,
  );
  if (currentAllowance.toBigInt() >= amount) return;

  const tokenWithSigner = token.connect(signer);
  const approveTx: ethers.providers.TransactionResponse =
    await tokenWithSigner.approve(spender, ethers.constants.MaxUint256);
  await approveTx.wait(1);
}

function executableEvmTxs(route: RouteResponse): EvmRouteTx[] {
  const txs = route.txs?.length ? route.txs : route.tx ? [route.tx] : [];
  return txs.map((tx) => {
    const evmTx = evmTxFromRouteTx(tx);
    assert(
      evmTx,
      `Route execution kind ${route.executionKind} returned a transaction this EVM wallet adapter cannot execute`,
    );
    return evmTx;
  });
}

function evmTxFromRouteTx(tx: RouteTx): EvmRouteTx | undefined {
  const chainTx = EvmRouteTxSchema.safeParse(tx);
  if (chainTx.success) return chainTx.data;

  if (!('transaction' in tx)) return undefined;
  const parsed = EvmRouteTxSchema.safeParse(tx.transaction);
  if (parsed.success) return parsed.data;

  if (typeof tx.transaction !== 'object' || tx.transaction === null) {
    return undefined;
  }
  const transaction = tx.transaction as Record<string, unknown>;
  const candidate = {
    to: transaction.to,
    data: stringifyTxField(transaction.data),
    value: stringifyTxField(transaction.value) ?? '0',
  };
  const normalized = EvmRouteTxSchema.safeParse(candidate);
  return normalized.success ? normalized.data : undefined;
}

function stringifyTxField(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && value !== null && '_isBigNumber' in value) {
    return (value as ethers.BigNumber).toString();
  }
  return undefined;
}
