import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import chalk from 'chalk';

import {
  ChainName,
  IsmType,
  MultiProtocolProvider,
  SvmMultiProtocolSignerAdapter,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getChain } from '../../config/registry.js';
import { chainsToSkip } from '../../src/config/chain.js';
import { DeployEnvironment } from '../../src/config/environment.js';
import { squadsConfigs } from '../../src/config/squads.js';
import {
  FIRST_REAL_INSTRUCTION_INDEX,
  SvmMultisigConfigMap,
  buildMultisigIsmInstructions,
  diffMultisigIsmConfigs,
  fetchMultisigIsmState,
  loadCoreProgramIds,
  multisigIsmConfigPath,
  serializeMultisigIsmDifference,
} from '../../src/utils/sealevel.js';
import { getTurnkeySealevelDeployerSigner } from '../../src/utils/turnkey.js';
import { chainIsProtocol, readJSONAtPath } from '../../src/utils/utils.js';
import { getArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

/**
 * Fetch on-chain MultisigIsm state for all configured domains
 */
async function fetchAllMultisigIsmStates(
  mpp: MultiProtocolProvider,
  chain: ChainName,
  multisigIsmProgramId: PublicKey,
  config: SvmMultisigConfigMap,
): Promise<SvmMultisigConfigMap> {
  const connection = mpp.getSolanaWeb3Provider(chain);
  const states: SvmMultisigConfigMap = {};

  for (const [remoteChainName] of Object.entries(config)) {
    const remoteMeta = getChain(remoteChainName);
    const remoteDomain = remoteMeta.domainId;

    const state = await fetchMultisigIsmState(
      connection,
      multisigIsmProgramId,
      remoteDomain,
    );
    if (state) {
      // Convert MultisigIsmOnChainState to SvmMultisigConfig
      states[remoteChainName] = {
        type: IsmType.MESSAGE_ID_MULTISIG,
        validators: state.validators,
        threshold: state.threshold,
      };
    }
  }

  return states;
}

/**
 * Compare expected vs actual configs and collect updates needed
 */
function analyzeConfigDifferences(
  chain: ChainName,
  config: SvmMultisigConfigMap,
  onChainStates: SvmMultisigConfigMap,
): {
  configsToUpdate: SvmMultisigConfigMap;
  matched: number;
} {
  const configsToUpdate: SvmMultisigConfigMap = {};
  let matched = 0;

  for (const [remoteChainName, expectedConfig] of Object.entries(config)) {
    const actualConfig = onChainStates[remoteChainName];
    const isMatch = diffMultisigIsmConfigs(expectedConfig, actualConfig);

    if (!isMatch) {
      rootLogger.info(
        `${remoteChainName} -> ${chain}: ${serializeMultisigIsmDifference(
          remoteChainName,
          expectedConfig,
          actualConfig,
        )}`,
      );
      configsToUpdate[remoteChainName] = expectedConfig;
    } else {
      matched++;
    }
  }

  return { configsToUpdate, matched };
}

/**
 * Log MultisigIsm update transaction for manual Squads proposal
 */
async function logMultisigIsmUpdateTransaction(
  chain: ChainName,
  instructions: TransactionInstruction[],
  owner: PublicKey,
  configsToUpdate: SvmMultisigConfigMap,
  mpp: MultiProtocolProvider,
): Promise<void> {
  rootLogger.info(chalk.cyan('\n=== Batched Transaction ==='));
  rootLogger.info(chalk.gray(`Total instructions: ${instructions.length}`));
  rootLogger.info(
    chalk.gray(
      `Transaction feePayer: ${owner.toBase58()} (Squads multisig vault)`,
    ),
  );

  // Sort chain names alphabetically (same order as buildMultisigIsmInstructions)
  const sortedChainNames = Object.keys(configsToUpdate).sort();

  // Log each instruction summary with data hex for verification
  instructions.forEach((instruction, idx) => {
    if (idx === 0) {
      rootLogger.info(
        chalk.gray(`\nInstruction ${idx}: Set compute unit limit to 1,400,000`),
      );
    } else {
      const chainIndex = idx - FIRST_REAL_INSTRUCTION_INDEX;
      const remoteChain = sortedChainNames[chainIndex];
      const config = configsToUpdate[remoteChain];
      rootLogger.info(
        chalk.gray(
          `Instruction ${idx}: Set validators and threshold for ${remoteChain} (${config.validators.length} validators, threshold ${config.threshold})`,
        ),
      );
    }

    // Debug log instruction data
    const dataHex = instruction.data.toString('hex');
    rootLogger.debug(chalk.gray(`    Data: ${dataHex}`));
  });

  // Create a transaction with ALL instructions
  try {
    const connection = mpp.getSolanaWeb3Provider(chain);
    const { blockhash } = await connection.getLatestBlockhash();

    const transaction = new Transaction({
      feePayer: owner,
      blockhash,
      lastValidBlockHeight: 0,
    });

    instructions.forEach((ix) => transaction.add(ix));

    // Serialize transaction to base58 (for Solana Squads)
    const txBase58 = bs58.encode(
      new Uint8Array(transaction.serialize({ requireAllSignatures: false })),
    );
    rootLogger.info(
      chalk.green(`\nTransaction (base58) - for Solana Squads:\n${txBase58}`),
    );

    // Serialize message to base58 (for alt SVM Squads UIs like Eclipse)
    const message = transaction.compileMessage();
    const messageBase58 = bs58.encode(new Uint8Array(message.serialize()));
    rootLogger.info(
      chalk.magenta(
        `\nMessage (base58) - for alt SVM Squads UIs:\n${messageBase58}\n`,
      ),
    );
  } catch (error) {
    rootLogger.warn(
      chalk.yellow(`Could not serialize transaction/message: ${error}`),
    );
  }
}

/**
 * Print update instructions as a single batched transaction for Squads multisig submission
 */
async function printMultisigIsmUpdates(
  chain: ChainName,
  multisigIsmProgramId: PublicKey,
  vaultPubkey: PublicKey,
  configsToUpdate: SvmMultisigConfigMap,
  mpp: MultiProtocolProvider,
): Promise<number> {
  if (Object.keys(configsToUpdate).length === 0) {
    return 0;
  }

  const instructions = buildMultisigIsmInstructions(
    multisigIsmProgramId,
    vaultPubkey,
    configsToUpdate,
    mpp,
  );

  const updateCount = Object.keys(configsToUpdate).length;
  rootLogger.debug(
    `[${chain}] Generating batched transaction with ${instructions.length} instructions (${updateCount} MultisigIsm updates + 1 compute budget)`,
  );

  // Log the batched transaction for manual Squads multisig proposal submission
  await logMultisigIsmUpdateTransaction(
    chain,
    instructions,
    vaultPubkey,
    configsToUpdate,
    mpp,
  );

  return updateCount;
}

/**
 * Process a single chain's MultisigIsm configuration
 */
async function processChain(
  environment: DeployEnvironment,
  mpp: MultiProtocolProvider,
  chain: ChainName,
  context: Contexts,
  adapter: SvmMultiProtocolSignerAdapter,
): Promise<{
  chain: string;
  updated: number;
  matched: number;
}> {
  rootLogger.debug(`Configuring MultisigIsm for ${chain} on ${environment}`);

  // Load core program IDs
  const coreProgramIds = loadCoreProgramIds(environment, chain);
  const multisigIsmProgramId = new PublicKey(
    coreProgramIds.multisig_ism_message_id,
  );

  rootLogger.debug(
    `Using MultisigIsm program ID: ${multisigIsmProgramId.toBase58()}`,
  );

  // Load Squads vault address (the multisig that will execute the transaction)
  if (!squadsConfigs[chain]) {
    throw new Error(`Squads configuration not found for chain ${chain}`);
  }
  const vaultPubkey = new PublicKey(squadsConfigs[chain].vault);
  rootLogger.debug(`Using Squads vault (multisig): ${vaultPubkey.toBase58()}`);
  rootLogger.debug(
    `Using Turnkey signer (owner/approver): ${await adapter.address()}`,
  );

  // Load configuration from file
  const configPath = multisigIsmConfigPath(environment, context, chain);
  const config: SvmMultisigConfigMap = readJSONAtPath(configPath);

  rootLogger.info(
    chalk.gray(
      `Loaded ${Object.keys(config).length} remote chain configs from ${configPath}`,
    ),
  );

  // Fetch all on-chain states
  const onChainStates = await fetchAllMultisigIsmStates(
    mpp,
    chain,
    multisigIsmProgramId,
    config,
  );

  // Analyze differences
  const { configsToUpdate, matched } = analyzeConfigDifferences(
    chain,
    config,
    onChainStates,
  );

  // Generate transaction calldata if updates needed
  let updated = 0;
  if (Object.keys(configsToUpdate).length > 0) {
    rootLogger.debug(
      `Found ${Object.keys(configsToUpdate).length} MultisigIsm configs to update for ${chain}`,
    );

    updated = await printMultisigIsmUpdates(
      chain,
      multisigIsmProgramId,
      vaultPubkey,
      configsToUpdate,
      mpp,
    );
  } else {
    rootLogger.info(`No updates needed for ${chain} - all configs match`);
  }

  return { chain, updated, matched };
}

// CLI argument parsing
async function main() {
  const {
    environment,
    chains: chainsArg,
    context = Contexts.Hyperlane,
    apply,
  } = await withChains(getArgs())
    .describe('context', 'MultisigIsm context to update')
    .choices('context', [Contexts.Hyperlane, Contexts.ReleaseCandidate])
    .alias('x', 'context')
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

  // Initialize Turnkey signer
  rootLogger.info('Initializing Turnkey signer from GCP Secret Manager...');
  const turnkeySigner = await getTurnkeySealevelDeployerSigner(environment);
  rootLogger.info(`Signer public key: ${turnkeySigner.publicKey.toBase58()}`);

  rootLogger.info(
    `Configuring MultisigIsm for chains: ${chains.join(', ')} on ${environment} (context: ${context})`,
  );

  if (!dryRun) {
    rootLogger.warn(
      chalk.yellow(
        '⚠️  WARNING: --apply flag is not yet implemented. Running in dry-run mode.',
      ),
    );
    rootLogger.warn(
      chalk.yellow(
        '    Transactions will be printed for manual Squads multisig submission.',
      ),
    );
  } else {
    rootLogger.info('Running in DRY RUN mode - no transactions will be sent');
  }

  // Process all chains sequentially (to avoid overwhelming the user with prompts)
  const mpp = await envConfig.getMultiProtocolProvider();
  const results: Array<{ chain: string; updated: number; matched: number }> =
    [];

  for (const chain of chains) {
    const signerAdapter = new SvmMultiProtocolSignerAdapter(
      chain,
      turnkeySigner,
      mpp,
    );

    try {
      const result = await processChain(
        environment,
        mpp,
        chain,
        context,
        signerAdapter,
      );
      results.push(result);
    } catch (error) {
      rootLogger.error(`Failed to process ${chain}:`, error);
      results.push({ chain, updated: 0, matched: 0 });
    }
  }

  // Print results
  console.table(results);
}

main().catch((err) => {
  rootLogger.error('Error configuring MultisigIsm:', err);
  process.exit(1);
});
