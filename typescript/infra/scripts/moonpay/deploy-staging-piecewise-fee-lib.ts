import { Wallet, constants } from 'ethers';

import { TokenRouter__factory } from '@hyperlane-xyz/core';
import {
  ChainMap,
  DEFAULT_ROUTER_KEY,
  EvmWarpModule,
  HypTokenRouterConfig,
  MultiProvider,
  TokenFeeConfigInput,
  TokenFeeType,
  TokenType,
  extractIsmAndHookFactoryAddresses,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert, eqAddress } from '@hyperlane-xyz/utils';

import { buildBscUsdtTokenFeeForTargets } from '../../config/environments/mainnet3/warp/configGetters/getUSDTCitreaMoonpayStagingWarpConfig.js';
import { DEPLOYER } from '../../config/environments/mainnet3/owners.js';
import { getChainMetadata, getEnvAddresses } from '../../config/registry.js';
import { tokens } from '../../src/config/warp.js';
import { getEnvironmentConfig } from '../core-utils.js';
import { impersonateAccount, useLocalProvider } from '../../src/utils/fork.js';

import { GCP_DEPLOYER_SECRET, resolveGcpKey } from './oqlf-lib.js';

export const STAGING_ORIGIN_CHAIN = 'bsc' as const;
export const STAGING_BSC_USDT_ROUTER =
  '0xaC9e83a1bDbC86a26aDf331785d3CaCF18963a6C';
export const STAGING_ARBITRUM_USDC_ROUTER =
  '0x9fb176528adf0bb7524ce752b2345c80ed24243f';
export const LOCAL_FORK_RPC = 'http://127.0.0.1:8545';

export const STAGING_FEE_DESTINATIONS = [
  'arbitrum',
  'base',
  'bsc',
  'citrea',
  'ethereum',
  'katana',
  'polygon',
  'solanamainnet',
] as const;

export interface StagingFeeDeploymentPlan {
  originChain: typeof STAGING_ORIGIN_CHAIN;
  router: string;
  config: HypTokenRouterConfig;
  tokenFee: TokenFeeConfigInput & {
    type: typeof TokenFeeType.CrossCollateralRoutingFee;
  };
  destinationChains: string[];
  defaultLeafCount: number;
  piecewiseLeafCount: number;
  contractDeploymentCount: number;
}

export interface StagingFeeDeploymentOptions {
  /** Omitting apply is always a zero-write dry run. */
  apply?: boolean;
  /** Execute against the local Anvil/Hardhat BSC fork at 127.0.0.1:8545. */
  fork?: boolean;
  /** Required for a live apply; must exactly match STAGING_BSC_USDT_ROUTER. */
  confirmRouter?: string;
}

export interface StagingFeeDeploymentResult {
  mode: 'dry-run' | 'fork' | 'live';
  plan: StagingFeeDeploymentPlan;
  feeRecipient?: string;
  transactionHashes?: string[];
}

export interface StagingFeeDeploymentDependencies {
  loadPlan: () => Promise<StagingFeeDeploymentPlan>;
  applyPlan: (
    plan: StagingFeeDeploymentPlan,
    options: StagingFeeDeploymentOptions,
  ) => Promise<
    Pick<StagingFeeDeploymentResult, 'feeRecipient' | 'transactionHashes'>
  >;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

/**
 * Turns the generated staging route config into an intentionally narrow
 * deployment plan. The assertions are safety rails: this script must never
 * grow from one BSC origin into a general warp-apply tool by accident.
 */
export function buildStagingFeeDeploymentPlan(
  routeConfig: ChainMap<HypTokenRouterConfig>,
  router = STAGING_BSC_USDT_ROUTER,
): StagingFeeDeploymentPlan {
  const originsWithFees = Object.entries(routeConfig)
    .filter(([, config]) => config.tokenFee !== undefined)
    .map(([chain]) => chain);
  assert(
    originsWithFees.length === 1 && originsWithFees[0] === STAGING_ORIGIN_CHAIN,
    `Expected BSC to be the only fee-bearing origin, got ${originsWithFees.join(', ') || 'none'}`,
  );

  const config = routeConfig[STAGING_ORIGIN_CHAIN];
  assert(config, 'Missing BSC staging route config');
  const tokenFee = config.tokenFee;
  assert(
    tokenFee?.type === TokenFeeType.CrossCollateralRoutingFee,
    'Expected BSC CrossCollateralRoutingFee config',
  );

  const destinationChains = Object.keys(tokenFee.feeContracts);
  assert(
    JSON.stringify(sorted(destinationChains)) ===
      JSON.stringify(sorted(STAGING_FEE_DESTINATIONS)),
    `Expected exactly the eight staging destinations, got ${destinationChains.join(', ')}`,
  );

  let defaultLeafCount = 0;
  const explicitLeaves: Array<{
    destination: string;
    routerKey: string;
    fee: TokenFeeConfigInput;
  }> = [];
  for (const [destination, leaves] of Object.entries(tokenFee.feeContracts)) {
    const defaultFee = leaves[DEFAULT_ROUTER_KEY];
    assert(
      defaultFee?.type === TokenFeeType.OffchainQuotedLinearFee,
      `Expected an OffchainQuotedLinearFee default for ${destination}`,
    );
    defaultLeafCount += 1;
    for (const [routerKey, fee] of Object.entries(leaves)) {
      if (routerKey !== DEFAULT_ROUTER_KEY) {
        explicitLeaves.push({ destination, routerKey, fee });
      }
    }
  }

  const expectedArbitrumKey = addressToBytes32(
    STAGING_ARBITRUM_USDC_ROUTER,
  ).toLowerCase();
  assert(
    explicitLeaves.length === 1 &&
      explicitLeaves[0].destination === 'arbitrum' &&
      explicitLeaves[0].routerKey.toLowerCase() === expectedArbitrumKey &&
      explicitLeaves[0].fee.type ===
        TokenFeeType.OffchainQuotedPiecewiseLinearFee,
    'Expected the Arbitrum USDC router to be the sole piecewise override',
  );

  return {
    originChain: STAGING_ORIGIN_CHAIN,
    router,
    config,
    tokenFee,
    destinationChains: sorted(destinationChains),
    defaultLeafCount,
    piecewiseLeafCount: explicitLeaves.length,
    // One routing root, one unique default leaf per destination, and the
    // Arbitrum-USDC piecewise override. EvmTokenFeeDeployer deliberately does
    // not cache same-type leaves, so all eight defaults are distinct.
    contractDeploymentCount: 1 + defaultLeafCount + explicitLeaves.length,
  };
}

/** Build the exact checked-in config without touching an RPC or loading keys. */
export async function loadStagingFeeDeploymentPlan(): Promise<StagingFeeDeploymentPlan> {
  const addresses = getEnvAddresses('mainnet3');
  const mailbox = addresses[STAGING_ORIGIN_CHAIN]?.mailbox;
  assert(mailbox, 'Missing BSC mailbox in the registry');

  // The public registry does not necessarily carry private staging routes.
  // Build with the exact same exported fee helper as the checked-in route
  // config, while guarding the already-deployed staging router constants here.
  const bscConfig = {
    type: TokenType.crossCollateral,
    token: tokens.bsc.USDT,
    mailbox,
    owner: DEPLOYER,
    scale: { numerator: 1, denominator: 1_000_000_000_000 },
    tokenFee: buildBscUsdtTokenFeeForTargets(
      STAGING_FEE_DESTINATIONS,
      STAGING_ARBITRUM_USDC_ROUTER,
    ),
  } satisfies HypTokenRouterConfig;

  return buildStagingFeeDeploymentPlan(
    { [STAGING_ORIGIN_CHAIN]: bscConfig },
    STAGING_BSC_USDT_ROUTER,
  );
}

async function createApplyMultiProvider(fork: boolean): Promise<MultiProvider> {
  if (fork) {
    const metadata = getChainMetadata();
    const bscMetadata = metadata[STAGING_ORIGIN_CHAIN];
    assert(bscMetadata, 'Missing BSC metadata');
    const multiProvider = new MultiProvider({
      ...metadata,
      [STAGING_ORIGIN_CHAIN]: {
        ...bscMetadata,
        // Keep metadata consistent with the provider override so SDK contract
        // verification is skipped on the ephemeral local fork.
        rpcUrls: [{ http: LOCAL_FORK_RPC }],
        blocks: { ...bscMetadata.blocks, confirmations: 1 },
      },
    });
    await useLocalProvider(multiProvider, STAGING_ORIGIN_CHAIN);
    const signer = await impersonateAccount(DEPLOYER, 1e18);
    multiProvider.setSigner(STAGING_ORIGIN_CHAIN, signer);
    return multiProvider;
  }

  // Secret RPC overrides and the deployer key are loaded only after --apply.
  // A default/dry-run invocation never reaches this code path.
  const registry = await getEnvironmentConfig('mainnet3').getRegistry(true, [
    STAGING_ORIGIN_CHAIN,
  ]);
  const multiProvider = new MultiProvider(await registry.getMetadata(), {
    minConfirmationTimeoutMs: 300_000,
  });
  const deployer = await resolveGcpKey(GCP_DEPLOYER_SECRET);
  const wallet = new Wallet(
    deployer.privateKey,
    multiProvider.getProvider(STAGING_ORIGIN_CHAIN),
  );
  multiProvider.setSigner(STAGING_ORIGIN_CHAIN, wallet);
  return multiProvider;
}

/**
 * Apply only the token-fee portion of the BSC router config. Calling the
 * public EvmWarpModule fee updater delegates tree deployment to
 * EvmTokenFeeModule, while avoiding every unrelated warp-route update path.
 */
export async function applyStagingFeeDeployment(
  plan: StagingFeeDeploymentPlan,
  options: StagingFeeDeploymentOptions,
): Promise<
  Pick<StagingFeeDeploymentResult, 'feeRecipient' | 'transactionHashes'>
> {
  assert(options.apply, 'Refusing to write without --apply');
  assert(
    plan.originChain === STAGING_ORIGIN_CHAIN &&
      eqAddress(plan.router, STAGING_BSC_USDT_ROUTER),
    'Deployment plan is not the guarded BSC USDT staging target',
  );
  if (!options.fork) {
    assert(
      options.confirmRouter !== undefined &&
        eqAddress(options.confirmRouter, STAGING_BSC_USDT_ROUTER),
      `Live apply requires --confirm-router ${STAGING_BSC_USDT_ROUTER}`,
    );
  }

  const multiProvider = await createApplyMultiProvider(Boolean(options.fork));
  const provider = multiProvider.getProvider(STAGING_ORIGIN_CHAIN);
  const tokenRouter = TokenRouter__factory.connect(plan.router, provider);
  const [owner, currentFeeRecipient, signerAddress] = await Promise.all([
    tokenRouter.owner(),
    tokenRouter.feeRecipient(),
    multiProvider.getSignerAddress(STAGING_ORIGIN_CHAIN),
  ]);
  assert(eqAddress(owner, DEPLOYER), `Unexpected router owner ${owner}`);
  assert(
    eqAddress(signerAddress, owner),
    `Configured signer ${signerAddress} is not router owner ${owner}`,
  );
  assert(
    eqAddress(currentFeeRecipient, constants.AddressZero),
    `Router already has feeRecipient ${currentFeeRecipient}; this one-shot deployer will not replace it`,
  );

  const module = new EvmWarpModule(multiProvider, {
    chain: STAGING_ORIGIN_CHAIN,
    config: plan.config,
    addresses: {
      deployedTokenRoute: plan.router,
      ...extractIsmAndHookFactoryAddresses(
        getEnvAddresses('mainnet3')[STAGING_ORIGIN_CHAIN],
      ),
    },
  });
  const actualConfig = await module.read();
  const expectedConfig = {
    ...actualConfig,
    tokenFee: plan.tokenFee,
  } as HypTokenRouterConfig;

  // On a clean staging router this deploys the root + nine leaves immediately
  // through EvmTokenFeeModule, then returns only the router-owner wiring call.
  const transactions = await module.createTokenFeeUpdateTxs(
    actualConfig,
    expectedConfig,
  );
  assert(
    transactions.length === 1,
    `Expected exactly one setFeeRecipient transaction, got ${transactions.length}`,
  );
  const wiringTransaction = transactions[0];
  assert(wiringTransaction, 'Missing setFeeRecipient transaction');
  const setFeeRecipientSelector =
    TokenRouter__factory.createInterface().getSighash(
      'setFeeRecipient(address)',
    );
  assert(
    wiringTransaction.to !== undefined &&
      eqAddress(wiringTransaction.to, plan.router) &&
      wiringTransaction.data !== undefined &&
      wiringTransaction.data.startsWith(setFeeRecipientSelector),
    'SDK produced a post-deployment transaction other than setFeeRecipient on the guarded BSC router',
  );
  const [plannedFeeRecipient] =
    TokenRouter__factory.createInterface().decodeFunctionData(
      'setFeeRecipient(address)',
      wiringTransaction.data,
    );
  assert(
    !eqAddress(plannedFeeRecipient, constants.AddressZero),
    'SDK planned a zero fee recipient',
  );

  const transactionHashes: string[] = [];
  for (const transaction of transactions) {
    const receipt = await multiProvider.sendTransaction(
      STAGING_ORIGIN_CHAIN,
      transaction,
    );
    transactionHashes.push(receipt.transactionHash);
  }

  const feeRecipient = await tokenRouter.feeRecipient();
  assert(
    eqAddress(feeRecipient, plannedFeeRecipient),
    `Fee recipient ${feeRecipient} does not match planned root ${plannedFeeRecipient}`,
  );
  return { feeRecipient, transactionHashes };
}

/**
 * The apply callback is not even invoked unless apply=true. This makes the
 * default path structurally incapable of deployments or transaction writes.
 */
export async function runStagingFeeDeployment(
  options: StagingFeeDeploymentOptions = {},
  dependencies: StagingFeeDeploymentDependencies = {
    loadPlan: loadStagingFeeDeploymentPlan,
    applyPlan: applyStagingFeeDeployment,
  },
): Promise<StagingFeeDeploymentResult> {
  const plan = await dependencies.loadPlan();
  if (!options.apply) return { mode: 'dry-run', plan };

  const result = await dependencies.applyPlan(plan, options);
  return {
    mode: options.fork ? 'fork' : 'live',
    plan,
    ...result,
  };
}

export function formatStagingFeeDeploymentResult(
  result: StagingFeeDeploymentResult,
): Record<string, unknown> {
  return {
    mode: result.mode,
    writesEnabled: result.mode !== 'dry-run',
    originChain: result.plan.originChain,
    router: result.plan.router,
    destinationChains: result.plan.destinationChains,
    defaultLeafCount: result.plan.defaultLeafCount,
    piecewiseLeafCount: result.plan.piecewiseLeafCount,
    contractDeploymentCount: result.plan.contractDeploymentCount,
    ...(result.feeRecipient ? { feeRecipient: result.feeRecipient } : {}),
    ...(result.transactionHashes
      ? { transactionHashes: result.transactionHashes }
      : {}),
  };
}
