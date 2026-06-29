/**
 * Reads an existing IGP's on-chain config, then deploys a brand-new non-legacy
 * IGP with the same native oracle config + tokenOracleConfig for an ERC20 fee
 * token. Useful for upgrading a legacy IGP or adding token-fee support without
 * touching the chain's core IGP.
 *
 * After deployment, set the printed IGP address as `feeHook` in the warp route
 * config and run `hyperlane warp deploy` / `warp apply`.
 *
 * Usage (dry-run — logs computed config, does not deploy):
 *   pnpm exec tsx scripts/igp/clone-igp-with-token-oracle.ts \
 *     -e testnet4 -x hyperlane \
 *     --chain basesepolia \
 *     --existing-igp 0x28B02B97a850872C4D33C3E024fab6499ad96564 \
 *     --fee-token 0x036CbD53842c5426634e7929541eC2318f3dCF7e \
 *     --fee-token-price 1 \
 *     --fee-token-decimals 6
 *
 * Usage (deploy):
 *   ... --execute
 */

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  ChainGasOracleParams,
  ChainMap,
  EvmHookReader,
  GasPriceConfig,
  HookType,
  HyperlaneIgpDeployer,
  IgpConfig,
  getLocalStorageGasOracleConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, rootLogger } from '@hyperlane-xyz/utils';

import { ethers } from 'ethers';

import { Contexts } from '../../config/contexts.js';
import { EXCHANGE_RATE_MARGIN_PCT } from '../../src/config/gas-oracle.js';
import { mustGetChainNativeToken } from '../../src/utils/utils.js';
import { Role } from '../../src/roles.js';
import { getArgs, withChain, withContext } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function loadEnvJson<T>(environment: string, filename: string): T {
  const path = resolve(
    __dirname,
    `../../config/environments/${environment}/${filename}`,
  );
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

async function main() {
  const {
    environment,
    context = Contexts.Hyperlane,
    chain,
    existingIgp,
    feeToken,
    feeTokenPrice,
    feeTokenDecimals,
    privateKey,
    execute,
  } = await withContext(withChain(getArgs()))
    .option('existing-igp', {
      type: 'string',
      description: 'Address of the existing IGP to clone config from',
      demandOption: true,
    })
    .option('fee-token', {
      type: 'string',
      description: 'ERC20 token address to accept as fee on this chain',
      demandOption: true,
    })
    .option('fee-token-price', {
      type: 'string',
      description: 'USD price of the fee token (e.g. "1" for USDC)',
      demandOption: true,
    })
    .option('fee-token-decimals', {
      type: 'number',
      description: 'Decimal places of the fee token (e.g. 6 for USDC)',
      demandOption: true,
    })
    .option('private-key', {
      type: 'string',
      description:
        'Private key hex to use instead of GCP deployer key (useful to avoid nonce conflicts on busy shared keys)',
    })
    .option('execute', {
      type: 'boolean',
      description: 'Send transactions; omit for dry-run',
      default: false,
    }).argv;

  assert(chain, '--chain is required');
  assert(
    ethers.utils.isAddress(existingIgp),
    '--existing-igp must be a valid address',
  );
  assert(
    ethers.utils.isAddress(feeToken),
    '--fee-token must be a valid address',
  );
  assert(Number(feeTokenPrice) > 0, '--fee-token-price must be positive');
  assert(
    Number.isInteger(feeTokenDecimals) && feeTokenDecimals >= 0,
    '--fee-token-decimals must be a non-negative integer',
  );

  const envConfig = getEnvironmentConfig(environment);
  const multiProvider = await envConfig.getMultiProvider(
    context,
    Role.Deployer,
    true,
    [chain],
  );

  if (privateKey) {
    const wallet = new ethers.Wallet(privateKey);
    multiProvider.setSharedSigner(wallet);
    rootLogger.info({ address: wallet.address }, 'Using provided private key');
  }

  // ── 1. Read existing IGP config ──────────────────────────────────────────
  rootLogger.info(
    { chain, igp: existingIgp },
    'Reading existing IGP config...',
  );
  const reader = new EvmHookReader(multiProvider, chain);
  const existing = await reader.deriveIgpConfig(existingIgp);

  assert(
    existing.type === HookType.INTERCHAIN_GAS_PAYMASTER,
    `Address ${existingIgp} is not an IGP (got type ${existing.type})`,
  );

  const remoteChains = Object.keys(existing.oracleConfig ?? {});
  assert(
    remoteChains.length > 0,
    'Existing IGP has no configured remote chains',
  );

  rootLogger.info(
    {
      owner: existing.owner,
      oracleKey: existing.oracleKey,
      beneficiary: existing.beneficiary,
      igpVersion: (existing as any).igpVersion ?? 'current',
      remoteChains,
    },
    'Existing IGP config',
  );

  // ── 2. Load env gas & token prices for token oracle computation ──────────
  const gasPrices = loadEnvJson<ChainMap<GasPriceConfig>>(
    environment,
    'gasPrices.json',
  );
  const tokenPrices = loadEnvJson<ChainMap<string>>(
    environment,
    'tokenPrices.json',
  );

  const missingPriceData = remoteChains.filter(
    (c) => !gasPrices[c] || !tokenPrices[c],
  );
  assert(
    missingPriceData.length === 0,
    `Missing gasPrice or tokenPrice data in ${environment} for: ${missingPriceData.join(', ')}`,
  );

  const oracledRemotes = remoteChains;

  // ── 3. Build tokenOracleConfig ────────────────────────────────────────────
  // Substitute the ERC20 fee token as the "local native token" so the exchange
  // rate resolves to: remote-native-token priced in fee-token.
  const gasOracleParams: ChainMap<ChainGasOracleParams> = {
    [chain]: {
      gasPrice: gasPrices[chain],
      nativeToken: {
        price: feeTokenPrice,
        decimals: feeTokenDecimals,
      },
    },
  };
  for (const remote of oracledRemotes) {
    gasOracleParams[remote] = {
      gasPrice: gasPrices[remote],
      nativeToken: {
        price: tokenPrices[remote],
        decimals: mustGetChainNativeToken(remote).decimals,
      },
    };
  }

  const flooredPairs: string[] = [];
  const tokenOracleEntries = getLocalStorageGasOracleConfig({
    local: chain,
    localProtocolType: ProtocolType.Ethereum,
    gasOracleParams,
    exchangeRateMarginPct: EXCHANGE_RATE_MARGIN_PCT,
    onPrecisionFallback: ({ local, remote }) =>
      flooredPairs.push(`${local} -> ${remote}`),
  });

  if (flooredPairs.length > 0) {
    rootLogger.warn(
      { pairs: flooredPairs },
      'Exchange rate floored to 1 for these pairs (expected at low testnet prices)',
    );
  }

  rootLogger.info(
    { feeToken, config: tokenOracleEntries },
    'Computed tokenOracleConfig',
  );

  // ── 4. Assemble new IgpConfig ─────────────────────────────────────────────
  const deployerAddress = await multiProvider.getSignerAddress(chain);

  const igpConfig: IgpConfig = {
    type: HookType.INTERCHAIN_GAS_PAYMASTER,
    // Preserve ownership from the existing IGP
    owner: existing.owner,
    oracleKey: existing.oracleKey ?? existing.owner,
    beneficiary: existing.beneficiary,
    // Existing native oracle config and overhead carry over unchanged
    oracleConfig: existing.oracleConfig ?? {},
    overhead: existing.overhead ?? {},
    // New: token oracle config for the ERC20 fee token
    tokenOracleConfig: {
      [feeToken]: tokenOracleEntries,
    },
    // No igpVersion set → non-legacy (newest contract)
  };

  rootLogger.info(
    {
      chain,
      owner: igpConfig.owner,
      oracleKey: igpConfig.oracleKey,
      beneficiary: igpConfig.beneficiary,
      remoteChains: Object.keys(igpConfig.oracleConfig ?? {}),
      tokenFeeRemotes: Object.keys(tokenOracleEntries),
    },
    'New IGP config assembled',
  );

  if (!execute) {
    rootLogger.info(
      { deployer: deployerAddress },
      'Dry-run complete. Pass --execute to deploy.',
    );
    // Print the full assembled config as JSON so it can be inspected / diffed
    console.log(JSON.stringify(igpConfig, null, 2));
    return;
  }

  // ── 5. Deploy new IGP (no cached addresses → always fresh) ────────────────
  rootLogger.info({ chain, deployer: deployerAddress }, 'Deploying new IGP...');
  const deployer = new HyperlaneIgpDeployer(multiProvider);
  // Intentionally do NOT call deployer.cacheAddressesMap() so every contract
  // is deployed fresh, regardless of what's in the registry.
  const contracts = await deployer.deployContracts(chain, igpConfig);

  const igpAddress = contracts.interchainGasPaymaster.address;
  rootLogger.info({ chain, igp: igpAddress }, 'New IGP deployed');

  console.log(
    JSON.stringify(
      {
        chain,
        igp: igpAddress,
        proxyAdmin: contracts.proxyAdmin.address,
        storageGasOracle: contracts.storageGasOracle.address,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  rootLogger.error(
    { error: error instanceof Error ? error.message : String(error) },
    'Fatal error',
  );
  process.exit(1);
});
