/**
 * Squads transaction parser for Hyperlane operations
 * Parses VaultTransaction instructions to verify governance operations
 *
 * Similar to govern-transaction-reader.ts but for SVM/Squads multisigs
 */
import { ComputeBudgetProgram, PublicKey } from '@solana/web3.js';
import { accounts, getTransactionPda, types } from '@sqds/multisig';
import { deserializeUnchecked } from 'borsh';
import chalk from 'chalk';
import fs from 'fs';

import {
  ChainName,
  MultiProtocolProvider,
  SealevelInstructionWrapper,
  SealevelMailboxInstructionName,
  SealevelMailboxInstructionType,
  SealevelMailboxSetDefaultIsmInstruction,
  SealevelMailboxSetDefaultIsmInstructionSchema,
  SealevelMailboxTransferOwnershipInstruction,
  SealevelMailboxTransferOwnershipInstructionSchema,
  SealevelMultisigIsmInstructionName,
  SealevelMultisigIsmInstructionType,
  SealevelMultisigIsmSetValidatorsInstruction,
  SealevelMultisigIsmSetValidatorsInstructionSchema,
  SealevelMultisigIsmTransferOwnershipInstruction,
  SealevelMultisigIsmTransferOwnershipInstructionSchema,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { DeployEnvironment } from '../config/environment.js';
import {
  ErrorMessage,
  HYPERLANE_PROGRAM_DISCRIMINATOR_SIZE,
  InstructionType,
  MAILBOX_DISCRIMINATOR_SIZE,
  MAX_SOLANA_ACCOUNTS,
  MAX_SOLANA_ACCOUNT_SIZE,
  ProgramName,
  SYSTEM_PROGRAM_ID,
  SvmMultisigConfigMap,
  WarningMessage,
  formatUnknownInstructionWarning,
  formatUnknownProgramWarning,
  loadCoreProgramIds,
  multisigIsmConfigPath,
} from '../utils/sealevel.js';
import {
  SQUADS_ACCOUNT_DISCRIMINATORS,
  SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
  SquadsAccountType,
  SquadsInstructionName,
  SquadsInstructionType,
  decodePermissions,
  getSquadAndProvider,
  getSquadProposal,
} from '../utils/squads.js';

import { GovernTransaction } from './govern-transaction-reader.js';

/**
 * Parsed instruction result with human-readable information
 */
export interface ParsedInstruction {
  programId: PublicKey;
  programName: string;
  instructionType: string;
  data: any;
  accounts: PublicKey[];
  warnings: string[];
  insight?: string; // Add insight here so it's generated during parsing
}

/**
 * Squads transaction result matching GovernTransaction format
 */
export interface SquadsTransaction extends Record<string, any> {
  chain: ChainName;
  proposalPda?: string;
  transactionIndex?: number;
  multisig?: string;
  instructions?: GovernTransaction[];
}

/**
 * Format validator addresses with their aliases from defaultMultisigConfigs
 */
function formatValidatorsWithAliases(
  chain: ChainName,
  validators: string[],
): string[] {
  const config = defaultMultisigConfigs[chain];
  if (!config) {
    return validators;
  }

  // Create a map of address -> alias
  const aliasMap = new Map<string, string>();
  for (const v of config.validators) {
    aliasMap.set(v.address.toLowerCase(), v.alias);
  }

  // Format each validator with alias if available
  return validators.map((addr) => {
    const alias = aliasMap.get(addr.toLowerCase());
    return alias ? `${addr} (${alias})` : addr;
  });
}

/**
 * SquadsTransactionReader - Main class for parsing Squads proposals
 *
 * Similar to GovernTransactionReader but for SVM/Squads multisigs
 */
export class SquadsTransactionReader {
  errors: any[] = [];
  private multisigConfigs: Map<ChainName, SvmMultisigConfigMap> = new Map();

  constructor(
    readonly environment: DeployEnvironment,
    readonly mpp: MultiProtocolProvider,
  ) {}

  /**
   * Check if instruction is for Mailbox program
   */
  private isMailboxInstruction(
    programId: PublicKey,
    corePrograms: { mailbox: PublicKey },
  ): boolean {
    return programId.equals(corePrograms.mailbox);
  }

  /**
   * Read and parse a Mailbox instruction using Borsh schemas
   */
  private readMailboxInstruction(
    instructionData: Buffer,
  ): Partial<ParsedInstruction> {
    if (instructionData.length < MAILBOX_DISCRIMINATOR_SIZE) {
      return {
        instructionType: InstructionType.UNKNOWN,
        data: { error: ErrorMessage.INSTRUCTION_TOO_SHORT },
        warnings: ['Mailbox instruction data too short'],
      };
    }

    // Read discriminator to determine instruction type
    const discriminator = instructionData.readUInt32LE(0);

    try {
      switch (discriminator) {
        // Note: Parsing not implemented for the following Mailbox instructions:
        // - INIT (0): Init(Init)
        // - INBOX_PROCESS (1): InboxProcess(InboxProcess)
        // - INBOX_GET_RECIPIENT_ISM (3): InboxGetRecipientIsm(Pubkey)
        // - OUTBOX_DISPATCH (4): OutboxDispatch(OutboxDispatch)
        // - OUTBOX_GET_COUNT (5): OutboxGetCount
        // - OUTBOX_GET_LATEST_CHECKPOINT (6): OutboxGetLatestCheckpoint
        // - OUTBOX_GET_ROOT (7): OutboxGetRoot
        // - GET_OWNER (8): GetOwner
        // - CLAIM_PROTOCOL_FEES (10): ClaimProtocolFees
        // - SET_PROTOCOL_FEE_CONFIG (11): SetProtocolFeeConfig(ProtocolFee)
        case SealevelMailboxInstructionType.INBOX_SET_DEFAULT_ISM: {
          const wrapper = deserializeUnchecked(
            SealevelMailboxSetDefaultIsmInstructionSchema,
            SealevelInstructionWrapper,
            instructionData,
          );
          const instruction =
            wrapper.data as SealevelMailboxSetDefaultIsmInstruction;
          const ismAddress = instruction.newIsmPubkey.toBase58();

          return {
            instructionType: SealevelMailboxInstructionName[discriminator],
            data: {
              newDefaultIsm: ismAddress,
            },
            insight: `Set default ISM to ${ismAddress}`,
            warnings: [],
          };
        }

        case SealevelMailboxInstructionType.TRANSFER_OWNERSHIP: {
          const wrapper = deserializeUnchecked(
            SealevelMailboxTransferOwnershipInstructionSchema,
            SealevelInstructionWrapper,
            instructionData,
          );
          const instruction =
            wrapper.data as SealevelMailboxTransferOwnershipInstruction;

          if (instruction.newOwnerPubkey) {
            const newOwnerAddress = instruction.newOwnerPubkey.toBase58();
            return {
              instructionType: SealevelMailboxInstructionName[discriminator],
              data: {
                newOwner: newOwnerAddress,
              },
              insight: `Transfer ownership to ${newOwnerAddress}`,
              warnings: [WarningMessage.OWNERSHIP_TRANSFER],
            };
          }

          return {
            instructionType: SealevelMailboxInstructionName[discriminator],
            data: { newOwner: null },
            insight: 'Renounce ownership',
            warnings: [WarningMessage.OWNERSHIP_RENUNCIATION],
          };
        }

        default:
          return {
            instructionType: `Unknown (discriminator: ${discriminator})`,
            data: { rawData: instructionData.toString('hex') },
            warnings: [
              formatUnknownInstructionWarning('Mailbox', discriminator),
            ],
          };
      }
    } catch (error) {
      return {
        instructionType: InstructionType.UNKNOWN,
        data: {
          error: `Failed to deserialize: ${error}`,
          rawData: instructionData.toString('hex'),
        },
        warnings: [`Borsh deserialization failed: ${error}`],
      };
    }
  }

  /**
   * Check if instruction is for MultisigIsm program
   */
  private isMultisigIsmInstruction(
    programId: PublicKey,
    corePrograms: { multisigIsmMessageId: PublicKey },
  ): boolean {
    return programId.equals(corePrograms.multisigIsmMessageId);
  }

  /**
   * Read and parse a MultisigIsm instruction using Borsh schemas
   *
   * Note: MultisigIsm instructions MUST have an 8-byte program discriminator prefix
   * that must be handled before Borsh deserialization.
   */
  private readMultisigIsmInstruction(
    chain: ChainName,
    instructionData: Buffer,
  ): Partial<ParsedInstruction> {
    const minLength = HYPERLANE_PROGRAM_DISCRIMINATOR_SIZE + 1; // 8 bytes program discriminator + at least 1 byte for enum
    if (instructionData.length < minLength) {
      return {
        instructionType: InstructionType.UNKNOWN,
        data: { error: ErrorMessage.INSTRUCTION_TOO_SHORT },
        warnings: [ErrorMessage.INVALID_MULTISIG_ISM_DATA],
      };
    }

    // Skip 8-byte program discriminator, read enum discriminator
    const discriminator = instructionData[HYPERLANE_PROGRAM_DISCRIMINATOR_SIZE];

    // Prepare buffer for Borsh deserialization (skip program discriminator)
    const borshData = instructionData.subarray(
      HYPERLANE_PROGRAM_DISCRIMINATOR_SIZE,
    );

    try {
      switch (discriminator) {
        // Note: Parsing not implemented for the following MultisigIsm instructions:
        // - INIT (0): Initialize
        // - GET_OWNER (2): GetOwner
        case SealevelMultisigIsmInstructionType.SET_VALIDATORS_AND_THRESHOLD: {
          const wrapper = deserializeUnchecked(
            SealevelMultisigIsmSetValidatorsInstructionSchema,
            SealevelInstructionWrapper,
            borshData,
          );
          const instruction =
            wrapper.data as SealevelMultisigIsmSetValidatorsInstruction;

          const remoteChain = this.mpp.tryGetChainName(instruction.domain);
          const chainInfo = remoteChain
            ? `${remoteChain} (${instruction.domain})`
            : `${instruction.domain}`;

          const validatorCount = instruction.validators.length;
          const insight = `Set ${validatorCount} validator${validatorCount > 1 ? 's' : ''} with threshold ${instruction.threshold} for ${chainInfo}`;

          return {
            instructionType: SealevelMultisigIsmInstructionName[discriminator],
            data: {
              domain: instruction.domain,
              threshold: instruction.threshold,
              validatorCount,
              validators: instruction.validatorAddresses,
            },
            insight,
            warnings: [],
          };
        }

        case SealevelMultisigIsmInstructionType.TRANSFER_OWNERSHIP: {
          const wrapper = deserializeUnchecked(
            SealevelMultisigIsmTransferOwnershipInstructionSchema,
            SealevelInstructionWrapper,
            borshData,
          );
          const instruction =
            wrapper.data as SealevelMultisigIsmTransferOwnershipInstruction;

          if (instruction.newOwnerPubkey) {
            const newOwnerAddress = instruction.newOwnerPubkey.toBase58();
            return {
              instructionType:
                SealevelMultisigIsmInstructionName[discriminator],
              data: {
                newOwner: newOwnerAddress,
              },
              insight: `Transfer ownership to ${newOwnerAddress}`,
              warnings: [WarningMessage.OWNERSHIP_TRANSFER],
            };
          }

          return {
            instructionType: SealevelMultisigIsmInstructionName[discriminator],
            data: { newOwner: null },
            insight: 'Renounce ownership',
            warnings: [WarningMessage.OWNERSHIP_RENUNCIATION],
          };
        }

        default:
          return {
            instructionType: `Unknown (discriminator: ${discriminator})`,
            data: { rawData: instructionData.toString('hex') },
            warnings: [
              formatUnknownInstructionWarning('MultisigIsm', discriminator),
            ],
          };
      }
    } catch (error) {
      return {
        instructionType: InstructionType.UNKNOWN,
        data: {
          error: `Failed to deserialize: ${error}`,
          rawData: instructionData.toString('hex'),
        },
        warnings: [`Borsh deserialization failed: ${error}`],
      };
    }
  }

  /**
   * Fetch proposal data from chain
   */
  private async fetchProposalData(
    chain: ChainName,
    transactionIndex: number,
  ): Promise<{
    proposal: accounts.Proposal;
    proposalPda: PublicKey;
    multisigPda: PublicKey;
    programId: PublicKey;
  }> {
    const proposalData = await getSquadProposal(
      chain,
      this.mpp,
      transactionIndex,
    );
    if (!proposalData) {
      const error = `Proposal ${transactionIndex} not found on ${chain}`;
      this.errors.push({ chain, transactionIndex, error });
      throw new Error(error);
    }

    const { proposal, proposalPda } = proposalData;
    const { multisigPda, programId } = await getSquadAndProvider(
      chain,
      this.mpp,
    );

    return { proposal, proposalPda, multisigPda, programId };
  }

  /**
   * Fetch transaction account info
   */
  private async fetchTransactionAccount(
    chain: ChainName,
    transactionIndex: number,
    transactionPda: PublicKey,
  ): Promise<any> {
    const { svmProvider } = await getSquadAndProvider(chain, this.mpp);
    const accountInfo = await svmProvider.getAccountInfo(transactionPda);

    if (!accountInfo) {
      throw new Error(
        `Transaction account not found at ${transactionPda.toBase58()}`,
      );
    }

    rootLogger.debug(
      chalk.gray(`Transaction account size: ${accountInfo.data.length} bytes`),
    );

    // Validate account size is reasonable (max ~10KB for a Solana transaction)
    if (accountInfo.data.length > MAX_SOLANA_ACCOUNT_SIZE) {
      rootLogger.warn(
        chalk.yellow(
          `Transaction account is unusually large: ${accountInfo.data.length} bytes`,
        ),
      );
    }

    return accountInfo;
  }

  /**
   * Parse instructions from a VaultTransaction
   */
  private parseVaultInstructions(
    chain: ChainName,
    vaultTransaction: accounts.VaultTransaction,
  ): { instructions: ParsedInstruction[]; warnings: string[] } {
    const coreProgramIds = loadCoreProgramIds(this.environment, chain);
    const corePrograms = {
      mailbox: new PublicKey(coreProgramIds.mailbox),
      validatorAnnounce: new PublicKey(coreProgramIds.validator_announce),
      multisigIsmMessageId: new PublicKey(
        coreProgramIds.multisig_ism_message_id,
      ),
      igpProgramId: new PublicKey(coreProgramIds.igp_program_id),
    };

    const parsedInstructions: ParsedInstruction[] = [];
    const warnings: string[] = [];
    const accountKeys = vaultTransaction.message.accountKeys;
    const computeBudgetProgramId = ComputeBudgetProgram.programId;

    // Parse all instructions, skipping compute budget setup instructions
    for (const [
      idx,
      instruction,
    ] of vaultTransaction.message.instructions.entries()) {
      try {
        // Validate programIdIndex
        if (
          instruction.programIdIndex >= accountKeys.length ||
          instruction.programIdIndex < 0
        ) {
          throw new Error(
            `Invalid programIdIndex: ${instruction.programIdIndex}. Account keys length: ${accountKeys.length}`,
          );
        }

        // Validate accountIndexes
        if (
          !instruction.accountIndexes ||
          instruction.accountIndexes.length > MAX_SOLANA_ACCOUNTS
        ) {
          throw new Error(
            `Invalid accountIndexes: length ${instruction.accountIndexes?.length ?? 'undefined'}`,
          );
        }

        const programId = accountKeys[instruction.programIdIndex];
        if (!programId) {
          throw new Error(
            `Program ID not found at index ${instruction.programIdIndex}`,
          );
        }

        // Skip compute budget instructions (setup, not program logic)
        if (programId.equals(computeBudgetProgramId)) {
          rootLogger.debug(
            chalk.gray(`Skipping compute budget instruction at index ${idx}`),
          );
          continue;
        }

        const instructionData = Buffer.from(instruction.data);

        // Map account indexes to account keys
        const accounts: PublicKey[] = [];
        for (let i = 0; i < instruction.accountIndexes.length; i++) {
          const accountIdx = instruction.accountIndexes[i];
          if (accountIdx < accountKeys.length) {
            const key = accountKeys[accountIdx];
            if (key) {
              accounts.push(key);
            }
          }
        }

        // Parse based on program type using if/return pattern
        let parsed: Partial<ParsedInstruction>;
        let programName: string;

        if (this.isMailboxInstruction(programId, corePrograms)) {
          programName = ProgramName.MAILBOX;
          parsed = this.readMailboxInstruction(instructionData);
          parsedInstructions.push({
            programId,
            programName,
            instructionType: parsed.instructionType || InstructionType.UNKNOWN,
            data: parsed.data || {},
            accounts,
            warnings: parsed.warnings || [],
            insight: parsed.insight,
          });
          warnings.push(...(parsed.warnings || []));
          continue;
        }

        if (this.isMultisigIsmInstruction(programId, corePrograms)) {
          programName = ProgramName.MULTISIG_ISM;
          parsed = this.readMultisigIsmInstruction(chain, instructionData);
          parsedInstructions.push({
            programId,
            programName,
            instructionType: parsed.instructionType || InstructionType.UNKNOWN,
            data: parsed.data || {},
            accounts,
            warnings: parsed.warnings || [],
            insight: parsed.insight,
          });
          warnings.push(...(parsed.warnings || []));
          continue;
        }

        if (programId.equals(SYSTEM_PROGRAM_ID)) {
          programName = ProgramName.SYSTEM_PROGRAM;
          parsedInstructions.push({
            programId,
            programName,
            instructionType: InstructionType.SYSTEM_CALL,
            data: {},
            accounts,
            warnings: [],
          });
          continue;
        }

        // Unknown program - add warning
        programName = ProgramName.UNKNOWN;
        const unknownWarnings = [
          formatUnknownProgramWarning(programId.toBase58()),
          'This instruction could not be verified!',
        ];
        parsedInstructions.push({
          programId,
          programName,
          instructionType: InstructionType.UNKNOWN,
          data: {
            programId: programId.toBase58(),
            rawData: instructionData.toString('hex'),
          },
          accounts,
          warnings: unknownWarnings,
        });
        warnings.push(...unknownWarnings);
      } catch (error) {
        const errorMsg = `Instruction ${idx}: ${error}`;
        rootLogger.error(chalk.red(`Failed to parse instruction: ${errorMsg}`));
        warnings.push(`Failed to parse instruction: ${errorMsg}`);

        // Create a placeholder parsed instruction for failed parsing
        parsedInstructions.push({
          programId: new PublicKey('11111111111111111111111111111111'),
          programName: ProgramName.UNKNOWN,
          instructionType: InstructionType.PARSE_FAILED,
          data: { error: String(error) },
          accounts: [],
          warnings: [`Failed to parse: ${error}`],
        });
      }
    }

    return { instructions: parsedInstructions, warnings };
  }

  /**
   * Check if transaction account is a ConfigTransaction
   */
  private isConfigTransaction(accountData: Buffer): boolean {
    const discriminator = accountData.subarray(
      0,
      SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
    );
    return discriminator.equals(
      SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
    );
  }

  /**
   * Read and format a ConfigTransaction
   */
  private async readConfigTransaction(
    chain: ChainName,
    proposalData: {
      proposal: accounts.Proposal;
      proposalPda: PublicKey;
      multisigPda: PublicKey;
    },
    accountInfo: any,
  ): Promise<SquadsTransaction> {
    rootLogger.info(
      chalk.gray(
        `${chain} proposal ${proposalData.proposal.transactionIndex}: ConfigTransaction (parsing multisig configuration changes)`,
      ),
    );

    const [configTx] = accounts.ConfigTransaction.fromAccountInfo(
      accountInfo,
      0,
    );

    const instructions: GovernTransaction[] = [];
    for (const action of configTx.actions) {
      const instruction = this.formatConfigAction(chain, action);
      if (instruction) {
        instructions.push(instruction);
      }
    }

    return {
      chain,
      proposalPda: proposalData.proposalPda.toBase58(),
      transactionIndex: Number(proposalData.proposal.transactionIndex),
      multisig: proposalData.multisigPda.toBase58(),
      instructions,
    };
  }

  /**
   * Check if transaction account is a VaultTransaction
   */
  private isVaultTransaction(accountData: Buffer): boolean {
    const discriminator = accountData.subarray(
      0,
      SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
    );
    return discriminator.equals(
      SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.VAULT],
    );
  }

  /**
   * Read and format a VaultTransaction
   */
  private async readVaultTransaction(
    chain: ChainName,
    transactionIndex: number,
    proposalData: {
      proposal: accounts.Proposal;
      proposalPda: PublicKey;
      multisigPda: PublicKey;
    },
    transactionPda: PublicKey,
  ): Promise<SquadsTransaction> {
    const { svmProvider } = await getSquadAndProvider(chain, this.mpp);

    let vaultTransaction: accounts.VaultTransaction;
    try {
      vaultTransaction = await accounts.VaultTransaction.fromAccountAddress(
        // @ts-ignore - Connection type mismatch
        svmProvider,
        transactionPda,
      );
    } catch (error) {
      if (
        error instanceof RangeError &&
        error.message.includes('out of range')
      ) {
        const errorMsg = `VaultTransaction at ${transactionPda.toBase58()} has incompatible structure (likely different Squads V4 version). This chain may require Squads SDK update.`;
        rootLogger.warn(chalk.yellow(errorMsg));
        this.errors.push({ chain, transactionIndex, error: errorMsg });
        throw new Error(errorMsg);
      }

      const errorMsg = `Failed to fetch VaultTransaction at ${transactionPda.toBase58()}: ${error}`;
      rootLogger.error(chalk.red(errorMsg));
      this.errors.push({ chain, transactionIndex, error: errorMsg });
      throw new Error(errorMsg);
    }

    const { instructions: parsedInstructions, warnings } =
      this.parseVaultInstructions(chain, vaultTransaction);

    if (warnings.length > 0) {
      this.errors.push({ chain, transactionIndex, warnings });
    }

    return {
      chain,
      proposalPda: proposalData.proposalPda.toBase58(),
      transactionIndex: Number(proposalData.proposal.transactionIndex),
      multisig: proposalData.multisigPda.toBase58(),
      instructions: parsedInstructions.map((inst) =>
        this.formatInstruction(chain, inst),
      ),
    };
  }

  /**
   * Read and parse a Squads proposal
   *
   * @param chain - Chain name
   * @param transactionIndex - Proposal transaction index
   * @returns SquadsTransaction formatted for output
   */
  async read(
    chain: ChainName,
    transactionIndex: number,
  ): Promise<SquadsTransaction> {
    try {
      // Fetch proposal and related PDAs
      const proposalData = await this.fetchProposalData(
        chain,
        transactionIndex,
      );

      // Get transaction PDA
      const [transactionPda] = getTransactionPda({
        multisigPda: proposalData.multisigPda,
        index: BigInt(proposalData.proposal.transactionIndex.toString()),
        programId: proposalData.programId,
      });

      // Fetch transaction account
      const accountInfo = await this.fetchTransactionAccount(
        chain,
        transactionIndex,
        transactionPda,
      );

      // Check transaction type and delegate to appropriate handler
      if (this.isConfigTransaction(accountInfo.data)) {
        return this.readConfigTransaction(chain, proposalData, accountInfo);
      }

      // Warn if unknown transaction type
      if (!this.isVaultTransaction(accountInfo.data)) {
        const discriminator = accountInfo.data.slice(
          0,
          SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
        );
        rootLogger.warn(
          chalk.yellow(
            `Unknown transaction discriminator: ${discriminator.toString()}. Expected VaultTransaction or ConfigTransaction`,
          ),
        );
      }

      // Handle as VaultTransaction
      return this.readVaultTransaction(
        chain,
        transactionIndex,
        proposalData,
        transactionPda,
      );
    } catch (error) {
      this.errors.push({ chain, transactionIndex, error: String(error) });
      throw error;
    }
  }

  /**
   * Load multisig config for a chain
   */
  private loadMultisigConfig(chain: ChainName): SvmMultisigConfigMap | null {
    if (this.multisigConfigs.has(chain)) {
      return this.multisigConfigs.get(chain)!;
    }

    try {
      const configPath = multisigIsmConfigPath(
        this.environment,
        Contexts.Hyperlane,
        chain,
      );
      if (!fs.existsSync(configPath)) {
        rootLogger.warn(
          chalk.yellow(`No multisig config found at ${configPath}`),
        );
        return null;
      }

      const config = JSON.parse(
        fs.readFileSync(configPath, 'utf-8'),
      ) as SvmMultisigConfigMap;
      this.multisigConfigs.set(chain, config);
      return config;
    } catch (error) {
      rootLogger.warn(
        chalk.yellow(`Failed to load multisig config for ${chain}: ${error}`),
      );
      return null;
    }
  }

  /**
   * Verify if the parsed configuration matches the expected config
   */
  private verifyConfiguration(
    originChain: ChainName,
    remoteDomain: number,
    threshold: number,
    validators: string[],
  ): { matches: boolean; issues: string[] } {
    const issues: string[] = [];
    const remoteChain = this.mpp.tryGetChainName(remoteDomain);

    if (!remoteChain) {
      issues.push(`Unknown domain ${remoteDomain}`);
      return { matches: false, issues };
    }

    const config = this.loadMultisigConfig(originChain);
    if (!config) {
      issues.push(`No expected config found for ${originChain}`);
      return { matches: false, issues };
    }

    const expectedConfig = config[remoteChain];
    if (!expectedConfig) {
      issues.push(
        `No expected config for route ${originChain} -> ${remoteChain}`,
      );
      return { matches: false, issues };
    }

    // Check threshold
    if (expectedConfig.threshold !== threshold) {
      issues.push(
        `Threshold mismatch: expected ${expectedConfig.threshold}, got ${threshold}`,
      );
    }

    // Check validator count
    if (expectedConfig.validators.length !== validators.length) {
      issues.push(
        `Validator count mismatch: expected ${expectedConfig.validators.length}, got ${validators.length}`,
      );
    }

    // Check validators match (normalize to lowercase for comparison)
    const expectedValidatorsSet = new Set(
      expectedConfig.validators.map((v) => v.toLowerCase()),
    );
    const actualValidatorsSet = new Set(validators.map((v) => v.toLowerCase()));

    const missingValidators = expectedConfig.validators.filter(
      (v) => !actualValidatorsSet.has(v.toLowerCase()),
    );
    const unexpectedValidators = validators.filter(
      (v) => !expectedValidatorsSet.has(v.toLowerCase()),
    );

    if (missingValidators.length > 0) {
      issues.push(`Missing validators: ${missingValidators.join(', ')}`);
    }

    if (unexpectedValidators.length > 0) {
      issues.push(`Unexpected validators: ${unexpectedValidators.join(', ')}`);
    }

    return { matches: issues.length === 0, issues };
  }

  /**
   * Format a ConfigAction as a GovernTransaction for display
   */
  private formatConfigAction(
    chain: ChainName,
    action: types.ConfigAction,
  ): GovernTransaction | null {
    let type: string;
    let args: Record<string, any>;
    let insight: string;

    if (types.isConfigActionAddMember(action)) {
      const member = action.newMember.key.toBase58();
      const permissionsMask = action.newMember.permissions.mask;
      const permissionsStr = decodePermissions(permissionsMask);

      type = SquadsInstructionName[SquadsInstructionType.ADD_MEMBER];
      args = {
        member: member,
        permissions: {
          mask: permissionsMask,
          decoded: permissionsStr,
        },
      };
      insight = `Add member ${member} with ${permissionsStr} permissions`;
    } else if (types.isConfigActionRemoveMember(action)) {
      const member = action.oldMember.toBase58();
      type = SquadsInstructionName[SquadsInstructionType.REMOVE_MEMBER];
      args = {
        member: member,
      };
      insight = `Remove member ${member}`;
    } else if (types.isConfigActionChangeThreshold(action)) {
      type = SquadsInstructionName[SquadsInstructionType.CHANGE_THRESHOLD];
      args = {
        threshold: action.newThreshold,
      };
      insight = `Change threshold to ${action.newThreshold}`;
    } else if (types.isConfigActionSetTimeLock(action)) {
      type = 'SetTimeLock';
      args = {
        timeLock: action.newTimeLock,
      };
      insight = `Set time lock to ${action.newTimeLock}s`;
    } else if (types.isConfigActionAddSpendingLimit(action)) {
      type = 'AddSpendingLimit';
      args = {
        vaultIndex: action.vaultIndex,
        mint: action.mint.toBase58(),
        amount: action.amount.toString(),
        members: action.members.map((m) => m.toBase58()),
        destinations: action.destinations.map((d) => d.toBase58()),
      };
      insight = `Add spending limit for vault ${action.vaultIndex}`;
    } else if (types.isConfigActionRemoveSpendingLimit(action)) {
      type = 'RemoveSpendingLimit';
      args = {
        spendingLimit: action.spendingLimit.toBase58(),
      };
      insight = `Remove spending limit ${action.spendingLimit.toBase58()}`;
    } else {
      // Unknown action type
      return null;
    }

    return {
      chain,
      to: 'Squads Multisig Configuration',
      type,
      args,
      insight,
    };
  }

  /**
   * Format a single instruction as a GovernTransaction
   */
  private formatInstruction(
    chain: ChainName,
    inst: ParsedInstruction,
  ): GovernTransaction {
    const to = `${inst.programName} (${inst.programId.toBase58()})`;
    const insight = inst.insight || `${inst.instructionType} instruction`;

    // Base transaction
    const tx: GovernTransaction = {
      chain,
      to,
      type: inst.instructionType,
      insight,
    };

    // Add args for important instructions
    switch (inst.instructionType) {
      case SealevelMultisigIsmInstructionName[
        SealevelMultisigIsmInstructionType.SET_VALIDATORS_AND_THRESHOLD
      ]: {
        // Get remote chain for aliases
        const remoteChain = this.mpp.tryGetChainName(inst.data.domain);

        // Format validators with aliases for display
        const validatorsWithAliases = remoteChain
          ? formatValidatorsWithAliases(remoteChain, inst.data.validators)
          : inst.data.validators;

        tx.args = {
          domain: inst.data.domain,
          threshold: inst.data.threshold,
          validators: validatorsWithAliases, // Display with aliases
        };

        // Verify configuration matches expected values (using plain validators)
        const verification = this.verifyConfiguration(
          chain,
          inst.data.domain,
          inst.data.threshold,
          inst.data.validators, // Use plain validators for verification
        );

        const chainInfo = remoteChain
          ? `${remoteChain} (${inst.data.domain})`
          : `${inst.data.domain}`;

        if (verification.matches) {
          tx.insight = `✅ matches expected config for ${chainInfo}`;
        } else {
          tx.insight = `❌ fatal mismatch: ${verification.issues.join(', ')}`;
          // Add warning
          if (!inst.warnings) {
            inst.warnings = [];
          }
          inst.warnings.push(
            `Configuration mismatch for ${chainInfo}: ${verification.issues.join(', ')}`,
          );
        }
        break;
      }

      case SealevelMailboxInstructionName[
        SealevelMailboxInstructionType.INBOX_SET_DEFAULT_ISM
      ]: {
        tx.args = {
          module: inst.data.newDefaultIsm,
        };
        break;
      }

      case SealevelMailboxInstructionName[
        SealevelMailboxInstructionType.TRANSFER_OWNERSHIP
      ]:
      case SealevelMultisigIsmInstructionName[
        SealevelMultisigIsmInstructionType.TRANSFER_OWNERSHIP
      ]: {
        tx.args = {
          newOwner: inst.data.newOwner || null,
        };
        break;
      }

      case SquadsInstructionName[SquadsInstructionType.ADD_MEMBER]: {
        // Decode permissions bitmask into human-readable string
        const permissionsStr = decodePermissions(inst.data.permissions.mask);

        tx.args = {
          member: inst.data.newMember,
          permissions: {
            mask: inst.data.permissions.mask,
            decoded: permissionsStr,
          },
        };

        // Update insight to include decoded permissions
        tx.insight = `${inst.insight} with ${permissionsStr} permissions`;
        break;
      }

      case SquadsInstructionName[SquadsInstructionType.REMOVE_MEMBER]: {
        tx.args = {
          member: inst.data.memberToRemove,
        };
        break;
      }

      case SquadsInstructionName[SquadsInstructionType.CHANGE_THRESHOLD]: {
        tx.args = {
          newThreshold: inst.data.newThreshold,
        };
        break;
      }
    }

    return tx;
  }
}
