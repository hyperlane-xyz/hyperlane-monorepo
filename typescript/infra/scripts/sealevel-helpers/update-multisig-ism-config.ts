import { confirm } from '@inquirer/prompts';
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
import { readJson } from '@hyperlane-xyz/utils/fs';

import { Contexts } from '../../config/contexts.js';
import { getChain } from '../../config/registry.js';
import { chainsToSkip } from '../../src/config/chain.js';
import { DeployEnvironment } from '../../src/config/environment.js';
import { squadsConfigs } from '../../src/config/squads.js';
import {
  SQUADS_PROPOSAL_OVERHEAD,
  SvmMultisigConfigMap,
  batchInstructionsBySize,
  buildMultisigIsmInstructions,
  diffMultisigIsmConfigs,
  fetchMultisigIsmState,
  isComputeBudgetInstruction,
  loadCoreProgramIds,
  multisigIsmConfigPath,
  serializeMultisigIsmDifference,
} from '../../src/utils/sealevel.js';
import { submitProposalToSquads } from '../../src/utils/squads.js';
import { getTurnkeySealevelDeployerSigner } from '../../src/utils/turnkey.js';
import { chainIsProtocol } from '../../src/utils/utils.js';
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
 * Log MultisigIsm update transaction and optionally submit to Squads
 */
async function logAndSubmitMultisigIsmUpdateTransaction(
  chain: ChainName,
  instructions: TransactionInstruction[],
  owner: PublicKey,
  batchChainNames: string[],
  configsToUpdate: SvmMultisigConfigMap,
  mpp: MultiProtocolProvider,
  signerAdapter: SvmMultiProtocolSignerAdapter,
  batchNum: number,
  totalBatches: number,
): Promise<void> {
  const batchLabel =
    totalBatches > 1 ? ` (Batch ${batchNum}/${totalBatches})` : '';
  rootLogger.info(chalk.cyan(`\n=== Transaction${batchLabel} ===`));
  rootLogger.info(chalk.gray(`Instructions: ${instructions.length}`));
  rootLogger.info(
    chalk.gray(
      `Transaction feePayer: ${owner.toBase58()} (Squads multisig vault)`,
    ),
  );

  // Log each instruction summary
  let multisigInstructionIndex = 0;
  instructions.forEach((instruction, idx) => {
    const isComputeBudget = isComputeBudgetInstruction(instruction);

    if (isComputeBudget) {
      // Decode compute budget instruction type from first byte
      // See: https://docs.solana.com/developing/runtime-facilities/compute-budget
      const dataView = new DataView(
        instruction.data.buffer,
        instruction.data.byteOffset,
        instruction.data.byteLength,
      );
      const instructionType = dataView.getUint8(0);

      // ComputeBudget instruction types: 1 = RequestHeapFrame, 2 = SetComputeUnitLimit
      if (instructionType === 1) {
        rootLogger.info(
          chalk.gray(`Instruction ${idx}: Request heap frame (compute budget)`),
        );
      } else if (instructionType === 2) {
        rootLogger.info(
          chalk.gray(
            `Instruction ${idx}: Set compute unit limit (compute budget)`,
          ),
        );
      } else {
        rootLogger.info(
          chalk.gray(
            `Instruction ${idx}: Compute budget (type ${instructionType})`,
          ),
        );
      }
    } else {
      // MultisigIsm instruction
      const remoteChain = batchChainNames[multisigInstructionIndex];
      const config = configsToUpdate[remoteChain];
      rootLogger.info(
        chalk.gray(
          `Instruction ${idx}: Set validators and threshold for ${remoteChain} (${config.validators.length} validators, threshold ${config.threshold})`,
        ),
      );

      // Debug log instruction data hex for verification
      const dataHex = instruction.data.toString('hex');
      rootLogger.debug(chalk.gray(`    Data: ${dataHex}`));

      multisigInstructionIndex++;
    }
  });

  try {
    const connection = mpp.getSolanaWeb3Provider(chain);
    const { blockhash } = await connection.getLatestBlockhash();

    const transaction = new Transaction({
      feePayer: owner,
      blockhash,
      lastValidBlockHeight: 0,
    });

    instructions.forEach((ix) => transaction.add(ix));

    const isSolana = chain === 'solanamainnet';

    const txBase58 = bs58.encode(
      new Uint8Array(transaction.serialize({ requireAllSignatures: false })),
    );

    const message = transaction.compileMessage();
    const messageBase58 = bs58.encode(new Uint8Array(message.serialize()));

    if (isSolana) {
      rootLogger.info(
        chalk.green(`\nTransaction (base58) - for Solana Squads:\n${txBase58}`),
      );
    } else {
      rootLogger.info(
        chalk.magenta(
          `\nMessage (base58) - for alt SVM Squads UIs:\n${messageBase58}\n`,
        ),
      );
    }

    // Create descriptive memo for the proposal
    const chainNamesStr = batchChainNames.join(', ');
    const updateCount = batchChainNames.length;
    const batchSuffix =
      totalBatches > 1 ? ` [${batchNum}/${totalBatches}]` : '';
    const memo = `Update MultisigIsm validators for ${updateCount} chain${updateCount > 1 ? 's' : ''}${batchSuffix}: ${chainNamesStr}`;

    const shouldSubmitToSquads = await confirm({
      message: `Submit this proposal to Squads multisig?${batchLabel}`,
      default: true,
    });

    if (!shouldSubmitToSquads) {
      rootLogger.info(
        chalk.yellow(
          `\nSkipping Squads submission. Use the base58 ${isSolana ? 'transaction' : 'message'} above to submit manually.`,
        ),
      );
      return;
    }

    await submitProposalToSquads(chain, instructions, mpp, signerAdapter, memo);
  } catch (error) {
    rootLogger.error(chalk.red(`Failed to log/submit transaction: ${error}`));
    throw error;
  }
}

/**
 * Print update instructions and submit as batched transactions for Squads multisig
 *
 * Automatically splits instructions into multiple transactions if they exceed
 * Solana's 1232 byte transaction size limit. Each batch is submitted as a
 * separate Squads proposal.
 */
async function printAndSubmitMultisigIsmUpdates(
  chain: ChainName,
  multisigIsmProgramId: PublicKey,
  vaultPubkey: PublicKey,
  configsToUpdate: SvmMultisigConfigMap,
  mpp: MultiProtocolProvider,
  signerAdapter: SvmMultiProtocolSignerAdapter,
): Promise<number> {
  if (Object.keys(configsToUpdate).length === 0) {
    return 0;
  }

  // Build all instructions
  const allInstructions = buildMultisigIsmInstructions(
    chain,
    multisigIsmProgramId,
    vaultPubkey,
    configsToUpdate,
    mpp,
  );

  // Filter out compute budget instructions for batching purposes
  // (they're only added for alt-SVM chains and don't count as "updates")
  const multisigInstructions = allInstructions.filter(
    (ix) => !isComputeBudgetInstruction(ix),
  );
  const computeBudgetInstructions = allInstructions.filter(
    isComputeBudgetInstruction,
  );

  const updateCount = Object.keys(configsToUpdate).length;
  const budgetNote =
    computeBudgetInstructions.length === 0
      ? ' (compute budget handled by Squads UI)'
      : '';

  // Batch instructions by transaction size, accounting for Squads proposal overhead
  // Note: We only batch the MultisigIsm instructions; compute budget would be per-batch
  // but for Solana mainnet the Squads UI handles compute budget automatically
  const instructionBatches = batchInstructionsBySize(
    multisigInstructions,
    vaultPubkey,
    SQUADS_PROPOSAL_OVERHEAD,
  );
  const totalBatches = instructionBatches.length;

  rootLogger.info(
    chalk.gray(
      `[${chain}] ${updateCount} MultisigIsm updates split into ${totalBatches} transaction${totalBatches > 1 ? 's' : ''}${budgetNote}`,
    ),
  );

  // Sort chain names alphabetically (same order as buildMultisigIsmInstructions)
  const sortedChainNames = Object.keys(configsToUpdate).sort();

  // Submit each batch
  let instructionOffset = 0;
  for (let batchIdx = 0; batchIdx < instructionBatches.length; batchIdx++) {
    const batchInstructions = instructionBatches[batchIdx];
    const batchSize = batchInstructions.length;

    // Get chain names for this batch (based on instruction order)
    const batchChainNames = sortedChainNames.slice(
      instructionOffset,
      instructionOffset + batchSize,
    );
    instructionOffset += batchSize;

    await logAndSubmitMultisigIsmUpdateTransaction(
      chain,
      batchInstructions,
      vaultPubkey,
      batchChainNames,
      configsToUpdate,
      mpp,
      signerAdapter,
      batchIdx + 1,
      totalBatches,
    );
  }

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
    `Using Turnkey signer (proposal creator): ${await adapter.address()}`,
  );

  // Load configuration from file
  const configPath = multisigIsmConfigPath(environment, context, chain);
  const config: SvmMultisigConfigMap = readJson(configPath);

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

    updated = await printAndSubmitMultisigIsmUpdates(
      chain,
      multisigIsmProgramId,
      vaultPubkey,
      configsToUpdate,
      mpp,
      adapter,
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
  } = await withChains(getArgs())
    .describe('context', 'MultisigIsm context to update')
    .choices('context', [Contexts.Hyperlane, Contexts.ReleaseCandidate])
    .alias('x', 'context').argv;

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
  const creatorPublicKey = turnkeySigner.publicKey;
  rootLogger.info(
    `Proposal creator public key: ${creatorPublicKey.toBase58()}`,
  );

  rootLogger.info(
    `Configuring MultisigIsm for chains: ${chains.join(', ')} on ${environment} (context: ${context})`,
  );

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
