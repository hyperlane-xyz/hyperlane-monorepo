import { constants, ethers } from 'ethers';

import {
  BaseFee__factory,
  CrossCollateralRoutingFee__factory,
  OffchainQuotedPiecewiseLinearFee__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import {
  EvmWarpModule,
  HypTokenRouterConfig,
  MultiProvider,
  OnchainTokenFeeType,
  TokenFeeConfigInput,
  TokenFeeType,
  TokenType,
  extractIsmAndHookFactoryAddresses,
} from '@hyperlane-xyz/sdk';
import { assert, eqAddress } from '@hyperlane-xyz/utils';

import { awIcas } from '../../config/environments/mainnet3/governance/ica/aw.js';
import { warpFeesIcas } from '../../config/environments/mainnet3/governance/ica/warpFees.js';
import {
  BSC_PIECEWISE_USDC_DESTINATIONS,
  buildBscUsdtProductionTokenFee,
} from '../../config/environments/mainnet3/warp/configGetters/getUSDTCitreaMoonpayWarpConfig.js';
import { WarpRouteIds } from '../../config/environments/mainnet3/warp/warpIds.js';
import {
  getChainMetadata,
  getEnvAddresses,
  getRegistry,
} from '../../config/registry.js';
import { tokens } from '../../src/config/warp.js';
import { impersonateAccount, useLocalProvider } from '../../src/utils/fork.js';

import { LOCAL_FORK_RPC } from './deploy-staging-piecewise-fee-lib.js';

export const PRODUCTION_BSC_USDT_ROUTER =
  '0x050dcc964BCA53eF1A98A2347995cabC73cE25b9';
export const PRODUCTION_BSC_EXISTING_FEE_ROOT =
  '0x4c61a80406ee56DC3F1B92872895fD6Be7850741';

export interface ProductionPiecewiseForkPlan {
  originChain: 'bsc';
  router: string;
  expectedFeeRoot: string;
  feeOwner: string;
  config: HypTokenRouterConfig;
  tokenFee: TokenFeeConfigInput & {
    type: typeof TokenFeeType.CrossCollateralRoutingFee;
  };
  piecewiseDestinations: string[];
  piecewiseLeafCount: number;
}

export interface ProductionPiecewiseForkResult {
  mode: 'dry-run' | 'fork';
  plan: ProductionPiecewiseForkPlan;
  transactionHashes?: string[];
  piecewiseLeaves?: Record<string, string>;
}

export interface ProductionPiecewiseForkDependencies {
  loadPlan(): Promise<ProductionPiecewiseForkPlan>;
  applyPlan(
    plan: ProductionPiecewiseForkPlan,
  ): Promise<
    Pick<ProductionPiecewiseForkResult, 'transactionHashes' | 'piecewiseLeaves'>
  >;
}

export function buildProductionPiecewiseForkPlan(
  config: HypTokenRouterConfig,
  router = PRODUCTION_BSC_USDT_ROUTER,
): ProductionPiecewiseForkPlan {
  const tokenFee = config.tokenFee;
  assert(
    tokenFee?.type === TokenFeeType.CrossCollateralRoutingFee,
    'Expected the production BSC CrossCollateralRoutingFee config',
  );

  const piecewiseDestinations: string[] = [];
  let piecewiseLeafCount = 0;
  for (const [destination, leaves] of Object.entries(tokenFee.feeContracts)) {
    const count = Object.values(leaves).filter(
      ({ type }) => type === TokenFeeType.OffchainQuotedPiecewiseLinearFee,
    ).length;
    if (count > 0) piecewiseDestinations.push(destination);
    piecewiseLeafCount += count;
  }
  piecewiseDestinations.sort();
  const expectedDestinations = [...BSC_PIECEWISE_USDC_DESTINATIONS].sort();
  assert(
    JSON.stringify(piecewiseDestinations) ===
      JSON.stringify(expectedDestinations) &&
      piecewiseLeafCount === expectedDestinations.length,
    `Expected one piecewise USDC leaf for each remote destination, got ${piecewiseDestinations.join(', ')}`,
  );

  return {
    originChain: 'bsc',
    router,
    expectedFeeRoot: PRODUCTION_BSC_EXISTING_FEE_ROOT,
    feeOwner: warpFeesIcas.bsc,
    config,
    tokenFee,
    piecewiseDestinations,
    piecewiseLeafCount,
  };
}

/** Build the exact checked-in production BSC fee config without an RPC. */
export async function loadProductionPiecewiseForkPlan(): Promise<ProductionPiecewiseForkPlan> {
  const route = getRegistry().getWarpRoute(WarpRouteIds.USDTCitreaMoonpay);
  const bscToken = route?.tokens.find(({ chainName }) => chainName === 'bsc');
  assert(
    bscToken?.addressOrDenom &&
      eqAddress(bscToken.addressOrDenom, PRODUCTION_BSC_USDT_ROUTER),
    `Production USDT/moonpay BSC router must be ${PRODUCTION_BSC_USDT_ROUTER}`,
  );
  const mailbox = getEnvAddresses('mainnet3').bsc?.mailbox;
  assert(mailbox, 'Missing BSC mailbox');

  const config = {
    type: TokenType.crossCollateral,
    token: tokens.bsc.USDT,
    mailbox,
    owner: awIcas.bsc,
    scale: { numerator: 1, denominator: 1_000_000_000_000 },
    tokenFee: buildBscUsdtProductionTokenFee(),
  } satisfies HypTokenRouterConfig;
  return buildProductionPiecewiseForkPlan(config, bscToken.addressOrDenom);
}

function valuesEqual(
  actual: readonly ethers.BigNumberish[],
  expected: readonly ethers.BigNumberish[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) =>
      ethers.BigNumber.from(value).eq(expected[index]),
    )
  );
}

/**
 * Apply the production token-fee diff only to a local BSC fork. There is no
 * live branch in this function: the fee-owner ICA is impersonated locally.
 */
export async function applyProductionPiecewiseFork(
  plan: ProductionPiecewiseForkPlan,
): Promise<
  Pick<ProductionPiecewiseForkResult, 'transactionHashes' | 'piecewiseLeaves'>
> {
  const metadata = getChainMetadata();
  const bscMetadata = metadata.bsc;
  assert(bscMetadata, 'Missing BSC metadata');
  const multiProvider = new MultiProvider({
    ...metadata,
    bsc: {
      ...bscMetadata,
      rpcUrls: [{ http: LOCAL_FORK_RPC }],
      blocks: { ...bscMetadata.blocks, confirmations: 1 },
    },
  });
  await useLocalProvider(multiProvider, 'bsc');
  const feeOwner = await impersonateAccount(plan.feeOwner, 1e18);
  multiProvider.setSigner('bsc', feeOwner);

  const provider = multiProvider.getProvider('bsc');
  const router = TokenRouter__factory.connect(plan.router, provider);
  const currentRoot = await router.feeRecipient();
  assert(
    eqAddress(currentRoot, plan.expectedFeeRoot),
    `Production fork fee root ${currentRoot} != guarded snapshot ${plan.expectedFeeRoot}`,
  );
  assert(
    eqAddress(
      await CrossCollateralRoutingFee__factory.connect(
        currentRoot,
        provider,
      ).owner(),
      plan.feeOwner,
    ),
    'Guarded production fee root owner changed',
  );

  const module = new EvmWarpModule(multiProvider, {
    chain: 'bsc',
    config: plan.config,
    addresses: {
      deployedTokenRoute: plan.router,
      ...extractIsmAndHookFactoryAddresses(getEnvAddresses('mainnet3').bsc),
    },
  });
  const actualConfig = await module.read();
  const transactions = await module.createTokenFeeUpdateTxs(actualConfig, {
    ...actualConfig,
    tokenFee: plan.tokenFee,
  } as HypTokenRouterConfig);
  assert(transactions.length > 0, 'Expected production fork fee updates');
  assert(
    transactions.every(
      ({ to }) => to !== undefined && eqAddress(to, currentRoot),
    ),
    'Production fork update planned a write outside the existing fee root',
  );

  const transactionHashes: string[] = [];
  for (const transaction of transactions) {
    const receipt = await multiProvider.sendTransaction('bsc', transaction);
    transactionHashes.push(receipt.transactionHash);
  }
  assert(
    eqAddress(await router.feeRecipient(), currentRoot),
    'Production fork unexpectedly replaced the router fee root',
  );

  const root = CrossCollateralRoutingFee__factory.connect(
    currentRoot,
    provider,
  );
  const piecewiseLeaves: Record<string, string> = {};
  for (const destination of plan.piecewiseDestinations) {
    const destinationLeaves = plan.tokenFee.feeContracts[destination];
    const piecewiseEntry = Object.entries(destinationLeaves).find(
      ([, fee]) => fee.type === TokenFeeType.OffchainQuotedPiecewiseLinearFee,
    );
    assert(piecewiseEntry, `Missing planned piecewise leaf for ${destination}`);
    const [targetRouter, expected] = piecewiseEntry;
    assert(
      expected.type === TokenFeeType.OffchainQuotedPiecewiseLinearFee,
      `Wrong planned type for ${destination}`,
    );
    const leafAddress = await root.feeContracts(
      multiProvider.getDomainId(destination),
      targetRouter,
    );
    assert(
      leafAddress !== constants.AddressZero,
      `Missing fork piecewise leaf for ${destination}`,
    );
    assert(
      (await BaseFee__factory.connect(leafAddress, provider).feeType()) ===
        OnchainTokenFeeType.OffchainQuotedPiecewiseLinearFee,
      `Wrong fork leaf type for ${destination}`,
    );
    const leaf = OffchainQuotedPiecewiseLinearFee__factory.connect(
      leafAddress,
      provider,
    );
    const fallback = await leaf.getFallbackCurve();
    assert(
      eqAddress(await leaf.owner(), plan.feeOwner) &&
        eqAddress(await leaf.token(), tokens.bsc.USDT) &&
        (await leaf.maxBands()) === expected.maxBands &&
        valuesEqual(fallback.breakpoints, []) &&
        valuesEqual(fallback.marginalBpsX1e4, [30_000]),
      `Fork leaf validation failed for ${destination}`,
    );
    piecewiseLeaves[destination] = leafAddress;
  }
  assert(
    new Set(Object.values(piecewiseLeaves).map((value) => value.toLowerCase()))
      .size === plan.piecewiseLeafCount,
    'Production fork reused a piecewise contract across lanes',
  );

  return { transactionHashes, piecewiseLeaves };
}

export async function runProductionPiecewiseFork(
  options: { apply?: boolean; fork?: boolean } = {},
  dependencies: ProductionPiecewiseForkDependencies = {
    loadPlan: loadProductionPiecewiseForkPlan,
    applyPlan: applyProductionPiecewiseFork,
  },
): Promise<ProductionPiecewiseForkResult> {
  const plan = await dependencies.loadPlan();
  if (!options.apply) return { mode: 'dry-run', plan };
  assert(options.fork, 'Production writes are forbidden; use --apply --fork');
  return { mode: 'fork', plan, ...(await dependencies.applyPlan(plan)) };
}

export function formatProductionPiecewiseForkResult(
  result: ProductionPiecewiseForkResult,
): Record<string, unknown> {
  return {
    mode: result.mode,
    writesEnabled: result.mode === 'fork',
    liveWritesSupported: false,
    originChain: result.plan.originChain,
    router: result.plan.router,
    expectedFeeRoot: result.plan.expectedFeeRoot,
    feeOwner: result.plan.feeOwner,
    piecewiseDestinations: result.plan.piecewiseDestinations,
    piecewiseLeafCount: result.plan.piecewiseLeafCount,
    ...(result.transactionHashes
      ? { transactionHashes: result.transactionHashes }
      : {}),
    ...(result.piecewiseLeaves
      ? { piecewiseLeaves: result.piecewiseLeaves }
      : {}),
  };
}
