import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { deserializeUnchecked } from 'borsh';

import {
  ChainMap,
  ChainName,
  MultiProtocolProvider,
  SealevelAccountDataWrapper,
  SealevelGasOracle,
  SealevelGasOracleConfig,
  SealevelGasOracleType,
  SealevelGasOverheadConfig,
  SealevelIgpAdapter,
  SealevelIgpData,
  SealevelIgpDataSchema,
  SealevelIgpProgramAdapter,
  SealevelOverheadIgpAdapter,
  SealevelOverheadIgpData,
  SealevelOverheadIgpDataSchema,
  SealevelRemoteGasData,
} from '@hyperlane-xyz/sdk';
import { Domain, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { getChain } from '../../config/registry.js';
import { getSecretRpcEndpoints } from '../../src/agents/index.js';
import { chainsToSkip } from '../../src/config/chain.js';
import { DeployEnvironment } from '../../src/config/environment.js';
import type { GasOracleConfigWithOverhead } from '../../src/config/gas-oracle.js';
import {
  ZERO_SALT,
  buildAndSendTransaction,
  calculatePercentDifference,
  formatRemoteGasData,
  loadCoreProgramIds,
  serializeGasOracleDifference,
  svmGasOracleConfigPath,
} from '../../src/utils/sealevel.js';
import { chainIsProtocol, readJSONAtPath } from '../../src/utils/utils.js';
import { getArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

/**
 * Fetch and deserialize account states
 */
async function fetchAccountStates(
  connection: Connection,
  igpAccountPda: PublicKey,
  overheadIgpAccountPda: PublicKey,
): Promise<{
  igpAccountData: SealevelIgpData;
  overheadIgpAccountData: SealevelOverheadIgpData;
}> {
  // Fetch current account states
  const igpAccountInfo = await connection.getAccountInfo(igpAccountPda);
  if (!igpAccountInfo) {
    throw new Error(`IGP account not found at ${igpAccountPda.toBase58()}`);
  }

  const overheadIgpAccountInfo = await connection.getAccountInfo(
    overheadIgpAccountPda,
  );
  if (!overheadIgpAccountInfo) {
    throw new Error(
      `Overhead IGP account not found at ${overheadIgpAccountPda.toBase58()}`,
    );
  }

  const igpAccountData = deserializeUnchecked(
    SealevelIgpDataSchema,
    SealevelAccountDataWrapper,
    igpAccountInfo.data,
  ).data as SealevelIgpData;

  const overheadIgpAccountData = deserializeUnchecked(
    SealevelOverheadIgpDataSchema,
    SealevelAccountDataWrapper,
    overheadIgpAccountInfo.data,
  ).data as SealevelOverheadIgpData;

  rootLogger.debug(
    `Current IGP account has ${igpAccountData.gas_oracles.size} gas oracles configured`,
  );
  rootLogger.debug(
    `Current Overhead IGP account has ${overheadIgpAccountData.gas_overheads.size} overheads configured`,
  );

  return { igpAccountData, overheadIgpAccountData };
}

/**
 * Remove gas oracles not in the config
 */
async function removeUnusedGasOracles(
  connection: Connection,
  igpAccountData: SealevelIgpData,
  allConfigDomainIds: Set<Domain>,
  igpAdapter: SealevelIgpAdapter,
  igpAccountPda: PublicKey,
  signerKeypair: Keypair,
  chain: ChainName,
  dryRun: boolean,
): Promise<number> {
  let oraclesRemoved = 0;

  for (const [remoteDomain] of igpAccountData.gas_oracles) {
    if (!allConfigDomainIds.has(remoteDomain)) {
      rootLogger.debug(
        `Removing gas oracle for remote domain ${remoteDomain} (not in config)`,
      );

      const config = new SealevelGasOracleConfig(remoteDomain, null);
      const instruction = igpAdapter.createSetGasOracleConfigsInstruction(
        igpAccountPda,
        signerKeypair.publicKey,
        [config],
      );

      oraclesRemoved++;
      if (!dryRun) {
        const tx = await buildAndSendTransaction(
          connection,
          [instruction],
          signerKeypair,
          chain,
        );
        rootLogger.info(`Removed gas oracle for domain ${remoteDomain}: ${tx}`);
      } else {
        rootLogger.info(`Would remove gas oracle for domain ${remoteDomain}`);
      }
    }
  }

  return oraclesRemoved;
}

/**
 * Remove gas overheads not in the config
 */
async function removeUnusedGasOverheads(
  connection: Connection,
  overheadIgpAccountData: SealevelOverheadIgpData,
  allConfigDomainIds: Set<Domain>,
  overheadIgpAdapter: SealevelOverheadIgpAdapter,
  overheadIgpAccountPda: PublicKey,
  signerKeypair: Keypair,
  chain: ChainName,
  dryRun: boolean,
): Promise<number> {
  let overheadsRemoved = 0;

  for (const [remoteDomain] of overheadIgpAccountData.gas_overheads) {
    if (!allConfigDomainIds.has(remoteDomain)) {
      rootLogger.debug(
        `Removing gas overhead for remote domain ${remoteDomain} (not in config)`,
      );

      const config = new SealevelGasOverheadConfig(remoteDomain, null);
      const instruction =
        overheadIgpAdapter.createSetDestinationGasOverheadsInstruction(
          overheadIgpAccountPda,
          signerKeypair.publicKey,
          [config],
        );

      overheadsRemoved++;
      if (!dryRun) {
        const tx = await buildAndSendTransaction(
          connection,
          [instruction],
          signerKeypair,
          chain,
        );
        rootLogger.info(
          `Removed gas overhead for domain ${remoteDomain}: ${tx}`,
        );
      } else {
        rootLogger.info(`Would remove gas overhead for domain ${remoteDomain}`);
      }
    }
  }

  return overheadsRemoved;
}

/**
 * Update gas oracles based on config
 */
async function updateGasOracles(
  mpp: MultiProtocolProvider,
  connection: Connection,
  gasOracleConfig: ChainMap<ChainMap<GasOracleConfigWithOverhead>>,
  chain: ChainName,
  igpAccountData: SealevelIgpData,
  igpAdapter: SealevelIgpAdapter,
  programId: PublicKey,
  igpAccountPda: PublicKey,
  signerKeypair: Keypair,
  dryRun: boolean,
): Promise<{ oraclesUpdated: number; oraclesMatched: number }> {
  let oraclesUpdated = 0;
  let oraclesMatched = 0;

  for (const [remoteChain, config] of Object.entries(gasOracleConfig[chain])) {
    const remoteMeta = getChain(remoteChain);
    const remoteDomain = remoteMeta.domainId;

    // Check if gas oracle needs updating
    const currentGasOracle = igpAccountData.gas_oracles.get(remoteDomain);
    const remoteGasData = new SealevelRemoteGasData({
      token_exchange_rate: BigInt(config.oracleConfig.tokenExchangeRate),
      gas_price: BigInt(config.oracleConfig.gasPrice),
      token_decimals: config.oracleConfig.tokenDecimals!,
    });

    const comparisonResult = igpAdapter.gasOracleMatches(
      currentGasOracle,
      remoteGasData,
    );

    const needsGasOracleUpdate = !comparisonResult.matches;

    if (needsGasOracleUpdate) {
      oraclesUpdated++;

      // Log the gas oracle config with diff if we have the actual values
      if (comparisonResult.actual) {
        rootLogger.info(
          `${chain} -> ${remoteChain}: ${serializeGasOracleDifference(comparisonResult.actual, remoteGasData, calculatePercentDifference)}`,
        );
      } else {
        rootLogger.info(
          `${chain} -> ${remoteChain}: ${formatRemoteGasData(remoteGasData)} (new)`,
        );
      }

      const gasOracle = new SealevelGasOracle({
        type: SealevelGasOracleType.RemoteGasData,
        data: remoteGasData,
      });
      const gasOracleConfig = new SealevelGasOracleConfig(
        remoteDomain,
        gasOracle,
      );

      const instruction = igpAdapter.createSetGasOracleConfigsInstruction(
        igpAccountPda,
        signerKeypair.publicKey,
        [gasOracleConfig],
      );

      if (!dryRun) {
        const tx = await buildAndSendTransaction(
          connection,
          [instruction],
          signerKeypair,
          chain,
        );
        rootLogger.info(`  Transaction: ${tx}`);
      }
    } else {
      oraclesMatched++;
    }

    // Always show example gas cost for this route (like EVM deployer does)
    const overheadForExample = config.overhead ?? 200_000;
    const exampleRemoteGas = overheadForExample + 50_000;
    const exampleCostLamports =
      (remoteGasData.token_exchange_rate *
        remoteGasData.gas_price *
        BigInt(exampleRemoteGas)) /
      10n ** 19n; // TOKEN_EXCHANGE_RATE_SCALE

    const { decimals, symbol } = mpp.getChainMetadata(chain).nativeToken!;
    const exampleCost = (Number(exampleCostLamports) / 10 ** decimals).toFixed(
      5,
    );
    rootLogger.info(
      `${chain} -> ${remoteChain}: ${exampleRemoteGas} remote gas cost: ${exampleCost} ${symbol}`,
    );
  }
  return { oraclesUpdated, oraclesMatched };
}
/**
 * Update gas overheads based on config
 */
async function updateGasOverheads(
  connection: Connection,
  gasOracleConfig: ChainMap<ChainMap<GasOracleConfigWithOverhead>>,
  chain: ChainName,
  overheadIgpAccountData: SealevelOverheadIgpData,
  overheadIgpAdapter: SealevelOverheadIgpAdapter,
  overheadIgpAccountPda: PublicKey,
  signerKeypair: Keypair,
  dryRun: boolean,
): Promise<{ overheadsUpdated: number; overheadsMatched: number }> {
  let overheadsUpdated = 0;
  let overheadsMatched = 0;

  for (const [remoteChain, config] of Object.entries(gasOracleConfig[chain])) {
    const remoteMeta = getChain(remoteChain);
    const remoteDomain = remoteMeta.domainId;

    // Check if gas overhead needs updating
    const currentOverhead =
      overheadIgpAccountData.gas_overheads.get(remoteDomain);
    // Ensure targetOverhead is properly converted to BigInt, handling number or string inputs
    const targetOverhead = config.overhead
      ? typeof config.overhead === 'bigint'
        ? config.overhead
        : BigInt(config.overhead)
      : null;

    // Ensure BigInt comparison works for overheads
    const needsOverheadUpdate =
      targetOverhead !== null &&
      (currentOverhead === undefined ||
        (typeof currentOverhead === 'bigint'
          ? currentOverhead
          : BigInt(currentOverhead)) !==
          (typeof targetOverhead === 'bigint'
            ? targetOverhead
            : BigInt(targetOverhead)));

    if (needsOverheadUpdate && targetOverhead !== null) {
      overheadsUpdated++;

      if (currentOverhead === undefined) {
        rootLogger.info(
          `${chain} -> ${remoteChain}: Setting gas overhead to ${targetOverhead} (new)`,
        );
      } else {
        // Ensure both values are BigInt for the arithmetic
        const currentBigInt =
          typeof currentOverhead === 'bigint'
            ? currentOverhead
            : BigInt(currentOverhead);
        const targetBigInt =
          typeof targetOverhead === 'bigint'
            ? targetOverhead
            : BigInt(targetOverhead);
        const diff = targetBigInt - currentBigInt;
        const sign = diff >= 0n ? '+' : '';
        rootLogger.info(
          `${chain} -> ${remoteChain}: Updating gas overhead from ${currentOverhead} to ${targetOverhead} (${sign}${diff})`,
        );
      }

      const overheadConfig = new SealevelGasOverheadConfig(
        remoteDomain,
        targetOverhead,
      );
      const instruction =
        overheadIgpAdapter.createSetDestinationGasOverheadsInstruction(
          overheadIgpAccountPda,
          signerKeypair.publicKey,
          [overheadConfig],
        );

      if (!dryRun) {
        const tx = await buildAndSendTransaction(
          connection,
          [instruction],
          signerKeypair,
          chain,
        );
        rootLogger.info(`  Transaction: ${tx}`);
      }
    } else if (targetOverhead !== null) {
      overheadsMatched++;
    }
  }

  return { overheadsUpdated, overheadsMatched };
}

/**
 * Process a single chain's IGP configuration
 */
async function processChain(
  environment: DeployEnvironment,
  mpp: MultiProtocolProvider,
  chain: ChainName,
  keyPath: string,
  dryRun: boolean,
): Promise<{
  chain: string;
  oraclesRemoved: number;
  overheadsRemoved: number;
  oraclesUpdated: number;
  overheadsUpdated: number;
  oraclesMatched: number;
  overheadsMatched: number;
}> {
  rootLogger.debug(`Configuring IGP for ${chain} on ${environment}`);

  // Load configuration and setup
  const gasOracleConfig: ChainMap<ChainMap<GasOracleConfigWithOverhead>> =
    readJSONAtPath(svmGasOracleConfigPath(environment));

  // Guard against missing chain configuration to prevent mass removals
  if (!gasOracleConfig[chain]) {
    throw new Error(
      `No gas oracle configuration found for chain '${chain}' in environment '${environment}'. ` +
        `This would cause all existing gas oracles and overheads to be removed. ` +
        `Please ensure the chain is configured in ${svmGasOracleConfigPath(environment)}`,
    );
  }

  const coreProgramIds = loadCoreProgramIds(environment, chain);
  const programId = new PublicKey(coreProgramIds.igp_program_id);
  rootLogger.debug(`Using IGP program ID: ${programId.toBase58()}`);

  // Load keypair
  const keypairData = readJSONAtPath(keyPath);
  const signerKeypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
  rootLogger.debug(`Using signer: ${signerKeypair.publicKey.toBase58()}`);

  // Setup connection and derive PDAs
  const rpcs = await getSecretRpcEndpoints(environment, chain);
  const connection = new Connection(rpcs[0], 'confirmed');

  const igpAccountPda = SealevelIgpProgramAdapter.deriveIgpAccountPda(
    programId,
    ZERO_SALT,
  );
  const overheadIgpAccountPda =
    SealevelIgpProgramAdapter.deriveOverheadIgpAccountPda(programId, ZERO_SALT);

  rootLogger.debug(`IGP Account: ${igpAccountPda.toBase58()}`);
  rootLogger.debug(`Overhead IGP Account: ${overheadIgpAccountPda.toBase58()}`);

  // Create adapters and fetch account states
  const igpAdapter = new SealevelIgpAdapter(chain, mpp, {
    igp: igpAccountPda.toBase58(),
    programId: programId.toBase58(),
  });

  const overheadIgpAdapter = new SealevelOverheadIgpAdapter(chain, mpp, {
    overheadIgp: overheadIgpAccountPda.toBase58(),
    programId: programId.toBase58(),
  });

  const { igpAccountData, overheadIgpAccountData } = await fetchAccountStates(
    connection,
    igpAccountPda,
    overheadIgpAccountPda,
  );

  // Get domain IDs for all configured chains
  const allConfigDomainIds = new Set<number>();
  for (const remoteChain of Object.keys(gasOracleConfig[chain])) {
    const remoteMeta = getChain(remoteChain);
    allConfigDomainIds.add(remoteMeta.domainId);
  }

  // Execute operations
  const oraclesRemoved = await removeUnusedGasOracles(
    connection,
    igpAccountData,
    allConfigDomainIds,
    igpAdapter,
    igpAccountPda,
    signerKeypair,
    chain,
    dryRun,
  );

  const overheadsRemoved = await removeUnusedGasOverheads(
    connection,
    overheadIgpAccountData,
    allConfigDomainIds,
    overheadIgpAdapter,
    overheadIgpAccountPda,
    signerKeypair,
    chain,
    dryRun,
  );

  const { oraclesUpdated, oraclesMatched } = await updateGasOracles(
    mpp,
    connection,
    gasOracleConfig,
    chain,
    igpAccountData,
    igpAdapter,
    programId,
    igpAccountPda,
    signerKeypair,
    dryRun,
  );

  const { overheadsUpdated, overheadsMatched } = await updateGasOverheads(
    connection,
    gasOracleConfig,
    chain,
    overheadIgpAccountData,
    overheadIgpAdapter,
    overheadIgpAccountPda,
    signerKeypair,
    dryRun,
  );

  return {
    chain,
    oraclesRemoved,
    overheadsRemoved,
    oraclesUpdated,
    overheadsUpdated,
    oraclesMatched,
    overheadsMatched,
  };
}

// CLI argument parsing
async function main() {
  const {
    environment,
    chains: chainsArg,
    keyPath,
    apply,
  } = await withChains(getArgs())
    .option('keyPath', {
      type: 'string',
      description: 'Path to Solana keypair JSON file',
      demandOption: true,
      alias: 'k',
    })
    .option('apply', {
      type: 'boolean',
      description: 'Apply changes on-chain (default is dry-run mode)',
      default: false,
    }).argv;

  const dryRun = !apply;

  // Compute default chains based on environment
  const envConfig = getEnvironmentConfig(environment);
  const chains =
    !chainsArg || chainsArg.length === 0
      ? envConfig.supportedChainNames.filter(
          (chain) =>
            chainIsProtocol(chain, ProtocolType.Sealevel) &&
            !chainsToSkip.includes(chain),
        )
      : chainsArg;

  rootLogger.info(
    `Configuring IGP for chains: ${chains.join(', ')} on ${environment}`,
  );
  if (dryRun) {
    rootLogger.info('Running in DRY RUN mode - no transactions will be sent');
  }

  // Process all chains in parallel
  const mpp = await envConfig.getMultiProtocolProvider();
  const results = await Promise.all(
    chains.map((chain) =>
      processChain(environment, mpp, chain, keyPath, dryRun),
    ),
  );

  // Print results in a table format
  console.table(results);
}

main().catch((err) => {
  rootLogger.error('Error configuring IGP:', err);
  process.exit(1);
});
