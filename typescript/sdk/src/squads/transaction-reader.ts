import { AccountInfo, ComputeBudgetProgram, PublicKey } from '@solana/web3.js';
import { accounts, getTransactionPda, types } from '@sqds/multisig';
import { deserializeUnchecked } from 'borsh';

import { ProtocolType, assert, rootLogger } from '@hyperlane-xyz/utils';

import { defaultMultisigConfigs } from '../consts/multisigIsm.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { ChainName } from '../types.js';
import {
  SealevelMultisigIsmInstructionName,
  SealevelMultisigIsmInstructionType,
  SealevelMultisigIsmSetValidatorsInstruction,
  SealevelMultisigIsmSetValidatorsInstructionSchema,
  SealevelMultisigIsmTransferOwnershipInstruction,
  SealevelMultisigIsmTransferOwnershipInstructionSchema,
} from '../ism/serialization.js';
import {
  SealevelMailboxInstructionName,
  SealevelMailboxInstructionType,
  SealevelMailboxSetDefaultIsmInstruction,
  SealevelMailboxSetDefaultIsmInstructionSchema,
  SealevelMailboxTransferOwnershipInstruction,
  SealevelMailboxTransferOwnershipInstructionSchema,
} from '../mailbox/serialization.js';
import {
  SealevelEnrollRemoteRouterInstruction,
  SealevelEnrollRemoteRouterInstructionSchema,
  SealevelEnrollRemoteRoutersInstruction,
  SealevelEnrollRemoteRoutersInstructionSchema,
  SealevelHypTokenInstruction,
  SealevelHypTokenInstructionName,
  SealevelHypTokenTransferOwnershipInstruction,
  SealevelHypTokenTransferOwnershipInstructionSchema,
  SealevelSetDestinationGasConfigsInstruction,
  SealevelSetDestinationGasConfigsInstructionSchema,
  SealevelSetInterchainGasPaymasterInstruction,
  SealevelSetInterchainGasPaymasterInstructionSchema,
  SealevelSetInterchainSecurityModuleInstruction,
  SealevelSetInterchainSecurityModuleInstructionSchema,
} from '../token/adapters/serialization.js';
import { SealevelInstructionWrapper } from '../utils/sealevelSerialization.js';
import { WarpCoreConfig } from '../warp/types.js';

import {
  SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
  SquadsInstructionName,
  SquadsInstructionType,
  decodePermissions,
  getSquadProposalAccount,
  isConfigTransaction,
  isVaultTransaction,
  parseSquadProposalTransactionIndex,
} from './utils.js';
import { stringifyUnknownSquadsError } from './error-format.js';
import { toSquadsProvider } from './provider.js';
import { assertValidTransactionIndexInput } from './validation.js';

export const HYPERLANE_PROGRAM_DISCRIMINATOR_SIZE = 8;
export const MAILBOX_DISCRIMINATOR_SIZE = 1;
export const MAX_SOLANA_ACCOUNTS = 256;
export const MAX_SOLANA_ACCOUNT_SIZE = 10240;
export const SYSTEM_PROGRAM_ID = new PublicKey(
  '11111111111111111111111111111111',
);

export enum ProgramName {
  MAILBOX = 'Mailbox',
  MULTISIG_ISM = 'MultisigIsmMessageId',
  WARP_ROUTE = 'WarpRoute',
  SYSTEM_PROGRAM = 'System Program',
  UNKNOWN = 'Unknown',
}

export enum InstructionType {
  UNKNOWN = 'Unknown',
  SYSTEM_CALL = 'System Call',
  PARSE_FAILED = 'Parse Failed',
}

export enum ErrorMessage {
  INSTRUCTION_TOO_SHORT = 'Instruction data too short',
  INVALID_MULTISIG_ISM_DATA = 'Invalid MultisigIsm instruction data',
}

export enum WarningMessage {
  OWNERSHIP_TRANSFER = '⚠️  OWNERSHIP TRANSFER DETECTED',
  OWNERSHIP_RENUNCIATION = '⚠️  OWNERSHIP RENUNCIATION DETECTED',
}

export function formatUnknownProgramWarning(programId: string): string {
  return `⚠️  UNKNOWN PROGRAM: ${programId}`;
}

export function formatUnknownInstructionWarning(
  programName: string,
  discriminator: number,
): string {
  return `Unknown ${programName} instruction (discriminator: ${discriminator})`;
}

export type SvmMultisigConfigMap = Partial<
  Record<
    ChainName,
    {
      threshold: number;
      validators: readonly string[];
    }
  >
>;

export interface SquadsCoreProgramIds {
  mailbox: string;
  multisig_ism_message_id: string;
}

export interface SquadsTransactionReaderOptions {
  resolveCoreProgramIds: (chain: ChainName) => SquadsCoreProgramIds;
  resolveExpectedMultisigConfig?: (
    chain: ChainName,
  ) => SvmMultisigConfigMap | null;
}

export interface SquadsGovernTransaction extends Record<string, unknown> {
  chain: ChainName;
  nestedTx?: SquadsGovernTransaction;
}

export interface ParsedInstruction {
  programId: PublicKey;
  programName: string;
  instructionType: string;
  data: Record<string, unknown>;
  accounts: PublicKey[];
  warnings: string[];
  insight?: string;
}

export interface SquadsTransaction extends Record<string, unknown> {
  chain: ChainName;
  proposalPda?: string;
  transactionIndex?: number;
  multisig?: string;
  instructions?: SquadsGovernTransaction[];
}

type SolanaWeb3Provider = ReturnType<
  MultiProtocolProvider['getSolanaWeb3Provider']
>;

function formatValidatorsWithAliases(
  chain: ChainName,
  validators: readonly string[],
): string[] {
  const config = defaultMultisigConfigs[chain];
  if (!config) return [...validators];

  const aliasMap = new Map<string, string>();
  for (const validator of config.validators) {
    aliasMap.set(validator.address.toLowerCase(), validator.alias);
  }

  return validators.map((address) => {
    const alias = aliasMap.get(address.toLowerCase());
    return alias ? `${address} (${alias})` : address;
  });
}

interface WarpRouteMetadata {
  symbol: string;
  name: string;
  routeName: string;
}

type MultisigSetValidatorsData = {
  domain: number;
  threshold: number;
  validators: readonly string[];
};

type MailboxSetDefaultIsmData = {
  newDefaultIsm: string;
};

type OwnershipTransferData = {
  newOwner?: string | null;
};

type SquadsAddMemberData = {
  newMember: string;
  permissions: {
    mask: number;
  };
};

type SquadsRemoveMemberData = {
  memberToRemove: string;
};

type SquadsChangeThresholdData = {
  newThreshold: number;
};

type WarpEnrollRemoteRouterData = {
  chainName?: string;
  domain: number;
  router?: string | null;
};

type WarpEnrollRemoteRoutersData = {
  routers?: Array<{
    chainName?: string;
    domain: number;
    router?: string | null;
  }>;
};

type WarpSetDestinationGasConfigsData = {
  configs?: Array<{
    chainName?: string;
    domain: number;
    gas?: { toString(): string } | number | string | null;
  }>;
};

type WarpSetIsmData = {
  ism?: string | null;
};

type WarpSetIgpData = {
  igp?: Record<string, unknown> | null;
};

export class SquadsTransactionReader {
  errors: Array<Record<string, unknown>> = [];
  private multisigConfigs: Map<ChainName, SvmMultisigConfigMap | null> =
    new Map();
  readonly warpRouteIndex: Map<ChainName, Map<string, WarpRouteMetadata>> =
    new Map();

  constructor(
    readonly mpp: MultiProtocolProvider,
    private readonly options: SquadsTransactionReaderOptions,
  ) {}

  async init(warpRoutes: Record<string, WarpCoreConfig>): Promise<void> {
    for (const [routeName, warpRoute] of Object.entries(warpRoutes)) {
      for (const token of Object.values(warpRoute.tokens)) {
        const chainProtocol = this.mpp.tryGetProtocol(token.chainName);
        if (chainProtocol !== ProtocolType.Sealevel) continue;

        const address = token.addressOrDenom?.toLowerCase();
        if (!address) continue;

        if (!this.warpRouteIndex.has(token.chainName)) {
          this.warpRouteIndex.set(token.chainName, new Map());
        }

        this.warpRouteIndex.get(token.chainName)!.set(address, {
          symbol: token.symbol ?? 'Unknown',
          name: token.name ?? 'Unknown',
          routeName,
        });
      }
    }
  }

  private isWarpRouteProgram(
    chain: ChainName,
    programId: PublicKey,
  ): WarpRouteMetadata | undefined {
    return this.warpRouteIndex
      .get(chain)
      ?.get(programId.toBase58().toLowerCase());
  }

  private readWarpRouteInstruction(
    chain: ChainName,
    instructionData: Buffer,
    metadata: WarpRouteMetadata,
  ): Partial<ParsedInstruction> {
    const minLength = HYPERLANE_PROGRAM_DISCRIMINATOR_SIZE + 1;
    if (instructionData.length < minLength) {
      return {
        instructionType: 'WarpRouteInstruction',
        data: { routeName: metadata.routeName, symbol: metadata.symbol },
        insight: `${metadata.symbol} warp route instruction (data too short)`,
        warnings: [],
      };
    }

    const discriminator = instructionData[HYPERLANE_PROGRAM_DISCRIMINATOR_SIZE];
    const borshData = instructionData.subarray(
      HYPERLANE_PROGRAM_DISCRIMINATOR_SIZE,
    );

    try {
      switch (discriminator) {
        case SealevelHypTokenInstruction.EnrollRemoteRouter: {
          const wrapper = deserializeUnchecked(
            SealevelEnrollRemoteRouterInstructionSchema,
            SealevelInstructionWrapper,
            borshData,
          );
          const instruction =
            wrapper.data as SealevelEnrollRemoteRouterInstruction;
          const domain = instruction.config.domain;
          const chainName = this.mpp.tryGetChainName(domain);
          const router = instruction.config.routerAddress;
          const chainInfo = chainName
            ? `${chainName} (${domain})`
            : `${domain}`;

          return {
            instructionType:
              SealevelHypTokenInstructionName[
                SealevelHypTokenInstruction.EnrollRemoteRouter
              ],
            data: { domain, chainName, router },
            insight: router
              ? `Enroll remote router for ${chainInfo}: ${router}`
              : `Unenroll remote router for ${chainInfo}`,
            warnings: [],
          };
        }

        case SealevelHypTokenInstruction.EnrollRemoteRouters: {
          const wrapper = deserializeUnchecked(
            SealevelEnrollRemoteRoutersInstructionSchema,
            SealevelInstructionWrapper,
            borshData,
          );
          const instruction =
            wrapper.data as SealevelEnrollRemoteRoutersInstruction;
          const routers = instruction.configs.map((config) => ({
            domain: config.domain,
            chainName: this.mpp.tryGetChainName(config.domain) ?? undefined,
            router: config.routerAddress,
          }));

          return {
            instructionType:
              SealevelHypTokenInstructionName[
                SealevelHypTokenInstruction.EnrollRemoteRouters
              ],
            data: { count: routers.length, routers },
            insight: `Enroll ${routers.length} remote router(s)`,
            warnings: [],
          };
        }

        case SealevelHypTokenInstruction.SetDestinationGasConfigs: {
          const wrapper = deserializeUnchecked(
            SealevelSetDestinationGasConfigsInstructionSchema,
            SealevelInstructionWrapper,
            borshData,
          );
          const instruction =
            wrapper.data as SealevelSetDestinationGasConfigsInstruction;
          const configs = instruction.configs.map((config) => ({
            domain: config.domain,
            chainName: this.mpp.tryGetChainName(config.domain) ?? undefined,
            gas: config.gas,
          }));

          return {
            instructionType:
              SealevelHypTokenInstructionName[
                SealevelHypTokenInstruction.SetDestinationGasConfigs
              ],
            data: { count: configs.length, configs },
            insight: `Set destination gas for ${configs.length} chain(s)`,
            warnings: [],
          };
        }

        case SealevelHypTokenInstruction.SetInterchainSecurityModule: {
          const wrapper = deserializeUnchecked(
            SealevelSetInterchainSecurityModuleInstructionSchema,
            SealevelInstructionWrapper,
            borshData,
          );
          const instruction =
            wrapper.data as SealevelSetInterchainSecurityModuleInstruction;
          const ism = instruction.ismPubkey?.toBase58() ?? null;

          return {
            instructionType:
              SealevelHypTokenInstructionName[
                SealevelHypTokenInstruction.SetInterchainSecurityModule
              ],
            data: { ism },
            insight: ism ? `Set ISM to ${ism}` : 'Clear ISM (use default)',
            warnings: [],
          };
        }

        case SealevelHypTokenInstruction.SetInterchainGasPaymaster: {
          const wrapper = deserializeUnchecked(
            SealevelSetInterchainGasPaymasterInstructionSchema,
            SealevelInstructionWrapper,
            borshData,
          );
          const instruction =
            wrapper.data as SealevelSetInterchainGasPaymasterInstruction;
          const igpConfig = instruction.igpConfig;
          const igp = igpConfig
            ? {
                program: igpConfig.programIdPubkey?.toBase58() ?? '',
                type: igpConfig.igpTypeName,
                account: igpConfig.igpAccountPubkey?.toBase58() ?? '',
              }
            : null;

          return {
            instructionType:
              SealevelHypTokenInstructionName[
                SealevelHypTokenInstruction.SetInterchainGasPaymaster
              ],
            data: { igp },
            insight: igp
              ? `Set IGP to ${igp.program} (${igp.type})`
              : 'Clear IGP',
            warnings: [],
          };
        }

        case SealevelHypTokenInstruction.TransferOwnership: {
          const wrapper = deserializeUnchecked(
            SealevelHypTokenTransferOwnershipInstructionSchema,
            SealevelInstructionWrapper,
            borshData,
          );
          const instruction =
            wrapper.data as SealevelHypTokenTransferOwnershipInstruction;
          const newOwner = instruction.newOwnerPubkey?.toBase58() ?? null;

          return {
            instructionType:
              SealevelHypTokenInstructionName[
                SealevelHypTokenInstruction.TransferOwnership
              ],
            data: { newOwner },
            insight: newOwner
              ? `Transfer ownership to ${newOwner}`
              : 'Renounce ownership',
            warnings: newOwner
              ? [WarningMessage.OWNERSHIP_TRANSFER]
              : [WarningMessage.OWNERSHIP_RENUNCIATION],
          };
        }

        default:
          return {
            instructionType:
              SealevelHypTokenInstructionName[
                discriminator as SealevelHypTokenInstruction
              ] ?? `Unknown (${discriminator})`,
            data: {
              routeName: metadata.routeName,
              symbol: metadata.symbol,
              rawData: instructionData.toString('hex'),
            },
            insight: `${metadata.symbol} warp route instruction (${metadata.routeName})`,
            warnings: [],
          };
      }
    } catch (error) {
      const formattedError = stringifyUnknownSquadsError(error);
      return {
        instructionType: 'WarpRouteInstruction',
        data: {
          routeName: metadata.routeName,
          symbol: metadata.symbol,
          error: `Failed to deserialize: ${formattedError}`,
        },
        insight: `${metadata.symbol} warp route instruction (parse error)`,
        warnings: [`Borsh deserialization failed: ${formattedError}`],
      };
    }
  }

  private isMailboxInstruction(
    programId: PublicKey,
    corePrograms: { mailbox: PublicKey },
  ): boolean {
    return programId.equals(corePrograms.mailbox);
  }

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

    const discriminator = instructionData[0];

    try {
      switch (discriminator) {
        case SealevelMailboxInstructionType.INBOX_SET_DEFAULT_ISM: {
          const wrapper = deserializeUnchecked(
            SealevelMailboxSetDefaultIsmInstructionSchema,
            SealevelInstructionWrapper,
            instructionData,
          );
          const instruction =
            wrapper.data as SealevelMailboxSetDefaultIsmInstruction;

          return {
            instructionType: SealevelMailboxInstructionName[discriminator],
            data: { newDefaultIsm: instruction.newIsmPubkey.toBase58() },
            insight: `Set default ISM to ${instruction.newIsmPubkey.toBase58()}`,
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
            return {
              instructionType: SealevelMailboxInstructionName[discriminator],
              data: { newOwner: instruction.newOwnerPubkey.toBase58() },
              insight: `Transfer ownership to ${instruction.newOwnerPubkey.toBase58()}`,
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
      const formattedError = stringifyUnknownSquadsError(error);
      return {
        instructionType: InstructionType.UNKNOWN,
        data: {
          error: `Failed to deserialize: ${formattedError}`,
          rawData: instructionData.toString('hex'),
        },
        warnings: [`Borsh deserialization failed: ${formattedError}`],
      };
    }
  }

  private isMultisigIsmInstruction(
    programId: PublicKey,
    corePrograms: { multisigIsmMessageId: PublicKey },
  ): boolean {
    return programId.equals(corePrograms.multisigIsmMessageId);
  }

  private readMultisigIsmInstruction(
    chain: ChainName,
    instructionData: Buffer,
  ): Partial<ParsedInstruction> {
    const minLength = HYPERLANE_PROGRAM_DISCRIMINATOR_SIZE + 1;
    if (instructionData.length < minLength) {
      return {
        instructionType: InstructionType.UNKNOWN,
        data: { error: ErrorMessage.INSTRUCTION_TOO_SHORT },
        warnings: [ErrorMessage.INVALID_MULTISIG_ISM_DATA],
      };
    }

    const discriminator = instructionData[HYPERLANE_PROGRAM_DISCRIMINATOR_SIZE];
    const borshData = instructionData.subarray(
      HYPERLANE_PROGRAM_DISCRIMINATOR_SIZE,
    );

    try {
      switch (discriminator) {
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

          return {
            instructionType: SealevelMultisigIsmInstructionName[discriminator],
            data: {
              domain: instruction.domain,
              threshold: instruction.threshold,
              validatorCount: instruction.validators.length,
              validators: instruction.validatorAddresses,
            },
            insight: `Set ${instruction.validators.length} validator(s) with threshold ${instruction.threshold} for ${chainInfo}`,
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
            return {
              instructionType:
                SealevelMultisigIsmInstructionName[discriminator],
              data: { newOwner: instruction.newOwnerPubkey.toBase58() },
              insight: `Transfer ownership to ${instruction.newOwnerPubkey.toBase58()}`,
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
      const formattedError = stringifyUnknownSquadsError(error);
      return {
        instructionType: InstructionType.UNKNOWN,
        data: {
          error: `Failed to deserialize: ${formattedError}`,
          rawData: instructionData.toString('hex'),
        },
        warnings: [`Borsh deserialization failed: ${formattedError}`],
      };
    }
  }

  private async fetchProposalData(
    chain: ChainName,
    transactionIndex: number,
    svmProvider: SolanaWeb3Provider,
  ): Promise<{
    proposal: accounts.Proposal;
    proposalPda: PublicKey;
    multisigPda: PublicKey;
    programId: PublicKey;
  }> {
    const proposalData = await getSquadProposalAccount(
      chain,
      this.mpp,
      transactionIndex,
      svmProvider,
    );
    if (!proposalData) {
      const error = `Proposal ${transactionIndex} not found on ${chain}`;
      throw new Error(error);
    }

    const { proposal, proposalPda, multisigPda, programId } = proposalData;

    return { proposal, proposalPda, multisigPda, programId };
  }

  private async fetchTransactionAccount(
    chain: ChainName,
    transactionIndex: number,
    transactionPda: PublicKey,
    svmProvider: SolanaWeb3Provider,
  ) {
    const accountInfo = await svmProvider.getAccountInfo(transactionPda);

    if (!accountInfo) {
      throw new Error(
        `Transaction account not found at ${transactionPda.toBase58()} on ${chain}`,
      );
    }

    if (accountInfo.data.length > MAX_SOLANA_ACCOUNT_SIZE) {
      rootLogger.warn(
        `Transaction account is unusually large: ${accountInfo.data.length} bytes`,
      );
    }

    return accountInfo;
  }

  private async resolveAddressLookupTables(
    chain: ChainName,
    vaultTransaction: accounts.VaultTransaction,
    svmProvider: SolanaWeb3Provider,
  ): Promise<PublicKey[]> {
    const accountKeys = [...vaultTransaction.message.accountKeys];
    const lookups = vaultTransaction.message.addressTableLookups;

    if (!lookups || lookups.length === 0) return accountKeys;

    for (const lookup of lookups) {
      try {
        const lookupTableAccount = await svmProvider.getAccountInfo(
          lookup.accountKey,
        );
        if (!lookupTableAccount) continue;

        const data = lookupTableAccount.data;
        const LOOKUP_TABLE_META_SIZE = 56;
        const addresses: PublicKey[] = [];

        for (let i = LOOKUP_TABLE_META_SIZE; i < data.length; i += 32) {
          const addressBytes = data.slice(i, i + 32);
          if (addressBytes.length === 32) {
            addresses.push(new PublicKey(addressBytes));
          }
        }

        for (const idx of lookup.writableIndexes) {
          if (idx < addresses.length) accountKeys.push(addresses[idx]);
        }
        for (const idx of lookup.readonlyIndexes) {
          if (idx < addresses.length) accountKeys.push(addresses[idx]);
        }
      } catch (error) {
        const formattedError = stringifyUnknownSquadsError(error);
        rootLogger.warn(
          `Failed to resolve address lookup table ${lookup.accountKey.toBase58()} on ${chain}: ${formattedError}`,
        );
      }
    }

    return accountKeys;
  }

  private async parseVaultInstructions(
    chain: ChainName,
    vaultTransaction: accounts.VaultTransaction,
    svmProvider: SolanaWeb3Provider,
  ): Promise<{ instructions: ParsedInstruction[]; warnings: string[] }> {
    const coreProgramIds = this.options.resolveCoreProgramIds(chain);
    const corePrograms = {
      mailbox: new PublicKey(coreProgramIds.mailbox),
      multisigIsmMessageId: new PublicKey(
        coreProgramIds.multisig_ism_message_id,
      ),
    };

    const parsedInstructions: ParsedInstruction[] = [];
    const warnings: string[] = [];
    const accountKeys = await this.resolveAddressLookupTables(
      chain,
      vaultTransaction,
      svmProvider,
    );
    const computeBudgetProgramId = ComputeBudgetProgram.programId;

    for (const [
      idx,
      instruction,
    ] of vaultTransaction.message.instructions.entries()) {
      try {
        if (
          instruction.programIdIndex >= accountKeys.length ||
          instruction.programIdIndex < 0
        ) {
          throw new Error(
            `Invalid programIdIndex: ${instruction.programIdIndex}. Account keys length: ${accountKeys.length}`,
          );
        }

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

        if (programId.equals(computeBudgetProgramId)) continue;

        const instructionData = Buffer.from(instruction.data);
        const accounts: PublicKey[] = [];
        for (const accountIdx of instruction.accountIndexes) {
          if (accountIdx < accountKeys.length) {
            const key = accountKeys[accountIdx];
            if (key) accounts.push(key);
          }
        }

        if (this.isMailboxInstruction(programId, corePrograms)) {
          const parsed = this.readMailboxInstruction(instructionData);
          parsedInstructions.push({
            programId,
            programName: ProgramName.MAILBOX,
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
          const parsed = this.readMultisigIsmInstruction(
            chain,
            instructionData,
          );
          parsedInstructions.push({
            programId,
            programName: ProgramName.MULTISIG_ISM,
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
          parsedInstructions.push({
            programId,
            programName: ProgramName.SYSTEM_PROGRAM,
            instructionType: InstructionType.SYSTEM_CALL,
            data: {},
            accounts,
            warnings: [],
          });
          continue;
        }

        const warpRouteMetadata = this.isWarpRouteProgram(chain, programId);
        if (warpRouteMetadata) {
          const parsed = this.readWarpRouteInstruction(
            chain,
            instructionData,
            warpRouteMetadata,
          );
          parsedInstructions.push({
            programId,
            programName: ProgramName.WARP_ROUTE,
            instructionType: parsed.instructionType || 'WarpRouteInstruction',
            data: {
              routeName: warpRouteMetadata.routeName,
              symbol: warpRouteMetadata.symbol,
              ...parsed.data,
            },
            accounts,
            warnings: parsed.warnings || [],
            insight: parsed.insight,
          });
          warnings.push(...(parsed.warnings || []));
          continue;
        }

        const unknownWarnings = [
          formatUnknownProgramWarning(programId.toBase58()),
          'This instruction could not be verified!',
        ];
        parsedInstructions.push({
          programId,
          programName: ProgramName.UNKNOWN,
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
        const formattedError = stringifyUnknownSquadsError(error);
        const errorMsg = `Instruction ${idx}: ${formattedError}`;
        warnings.push(`Failed to parse instruction: ${errorMsg}`);
        parsedInstructions.push({
          programId: SYSTEM_PROGRAM_ID,
          programName: ProgramName.UNKNOWN,
          instructionType: InstructionType.PARSE_FAILED,
          data: { error: formattedError },
          accounts: [],
          warnings: [`Failed to parse: ${formattedError}`],
        });
      }
    }

    return { instructions: parsedInstructions, warnings };
  }

  private async readConfigTransaction(
    chain: ChainName,
    transactionIndex: number,
    proposalData: {
      proposal: accounts.Proposal;
      proposalPda: PublicKey;
      multisigPda: PublicKey;
    },
    accountInfo: AccountInfo<Buffer>,
  ): Promise<SquadsTransaction> {
    const [configTx] = accounts.ConfigTransaction.fromAccountInfo(
      accountInfo,
      0,
    );
    const instructions: SquadsGovernTransaction[] = [];
    for (const action of configTx.actions) {
      const instruction = this.formatConfigAction(chain, action);
      if (instruction) instructions.push(instruction);
    }

    return {
      chain,
      proposalPda: proposalData.proposalPda.toBase58(),
      transactionIndex,
      multisig: proposalData.multisigPda.toBase58(),
      instructions,
    };
  }

  private async readVaultTransaction(
    chain: ChainName,
    transactionIndex: number,
    svmProvider: SolanaWeb3Provider,
    proposalData: {
      proposal: accounts.Proposal;
      proposalPda: PublicKey;
      multisigPda: PublicKey;
    },
    transactionPda: PublicKey,
  ): Promise<SquadsTransaction> {
    const squadsProvider = toSquadsProvider(svmProvider);

    let vaultTransaction: accounts.VaultTransaction;
    try {
      vaultTransaction = await accounts.VaultTransaction.fromAccountAddress(
        squadsProvider,
        transactionPda,
      );
    } catch (error) {
      const errorMsg = `Failed to fetch VaultTransaction at ${transactionPda.toBase58()}: ${stringifyUnknownSquadsError(error)}`;
      throw new Error(errorMsg);
    }

    const { instructions: parsedInstructions, warnings } =
      await this.parseVaultInstructions(chain, vaultTransaction, svmProvider);

    if (warnings.length > 0) {
      this.errors.push({ chain, transactionIndex, warnings });
    }

    return {
      chain,
      proposalPda: proposalData.proposalPda.toBase58(),
      transactionIndex,
      multisig: proposalData.multisigPda.toBase58(),
      instructions: parsedInstructions.map((inst) =>
        this.formatInstruction(chain, inst),
      ),
    };
  }

  async read(
    chain: ChainName,
    transactionIndex: number,
  ): Promise<SquadsTransaction> {
    assertValidTransactionIndexInput(transactionIndex, chain);

    try {
      const svmProvider = this.mpp.getSolanaWeb3Provider(chain);
      const proposalData = await this.fetchProposalData(
        chain,
        transactionIndex,
        svmProvider,
      );
      const proposalTransactionIndex = parseSquadProposalTransactionIndex(
        proposalData.proposal,
      );
      assert(
        proposalTransactionIndex === transactionIndex,
        `Expected proposal index ${transactionIndex} for ${chain}, got ${proposalTransactionIndex}`,
      );

      const [transactionPda] = getTransactionPda({
        multisigPda: proposalData.multisigPda,
        index: BigInt(transactionIndex),
        programId: proposalData.programId,
      });

      const accountInfo = await this.fetchTransactionAccount(
        chain,
        transactionIndex,
        transactionPda,
        svmProvider,
      );

      if (isConfigTransaction(accountInfo.data)) {
        return await this.readConfigTransaction(
          chain,
          transactionIndex,
          proposalData,
          accountInfo,
        );
      }

      if (!isVaultTransaction(accountInfo.data)) {
        const discriminator = accountInfo.data.slice(
          0,
          SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
        );
        rootLogger.warn(
          `Unknown transaction discriminator: ${discriminator.toString()}. Expected VaultTransaction or ConfigTransaction`,
        );
      }

      return await this.readVaultTransaction(
        chain,
        transactionIndex,
        svmProvider,
        proposalData,
        transactionPda,
      );
    } catch (error) {
      this.errors.push({
        chain,
        transactionIndex,
        error: stringifyUnknownSquadsError(error),
      });
      throw error;
    }
  }

  private loadMultisigConfig(chain: ChainName): SvmMultisigConfigMap | null {
    if (this.multisigConfigs.has(chain)) {
      return this.multisigConfigs.get(chain) ?? null;
    }

    if (!this.options.resolveExpectedMultisigConfig) {
      this.multisigConfigs.set(chain, null);
      return null;
    }

    try {
      const config = this.options.resolveExpectedMultisigConfig(chain);
      this.multisigConfigs.set(chain, config);
      return config;
    } catch (error) {
      rootLogger.warn(
        `Failed to load multisig config for ${chain}: ${stringifyUnknownSquadsError(error)}`,
      );
      this.multisigConfigs.set(chain, null);
      return null;
    }
  }

  private verifyConfiguration(
    originChain: ChainName,
    remoteDomain: number,
    threshold: number,
    validators: readonly string[],
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

    if (expectedConfig.threshold !== threshold) {
      issues.push(
        `Threshold mismatch: expected ${expectedConfig.threshold}, got ${threshold}`,
      );
    }

    if (expectedConfig.validators.length !== validators.length) {
      issues.push(
        `Validator count mismatch: expected ${expectedConfig.validators.length}, got ${validators.length}`,
      );
    }

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

  private formatConfigAction(
    chain: ChainName,
    action: types.ConfigAction,
  ): SquadsGovernTransaction | null {
    let type: string;
    let args: Record<string, unknown>;
    let insight: string;

    if (types.isConfigActionAddMember(action)) {
      const member = action.newMember.key.toBase58();
      const permissionsMask = action.newMember.permissions.mask;
      const permissionsStr = decodePermissions(permissionsMask);

      type = SquadsInstructionName[SquadsInstructionType.ADD_MEMBER];
      args = {
        member,
        permissions: { mask: permissionsMask, decoded: permissionsStr },
      };
      insight = `Add member ${member} with ${permissionsStr} permissions`;
    } else if (types.isConfigActionRemoveMember(action)) {
      const member = action.oldMember.toBase58();
      type = SquadsInstructionName[SquadsInstructionType.REMOVE_MEMBER];
      args = { member };
      insight = `Remove member ${member}`;
    } else if (types.isConfigActionChangeThreshold(action)) {
      type = SquadsInstructionName[SquadsInstructionType.CHANGE_THRESHOLD];
      args = { threshold: action.newThreshold };
      insight = `Change threshold to ${action.newThreshold}`;
    } else if (types.isConfigActionSetTimeLock(action)) {
      type = 'SetTimeLock';
      args = { timeLock: action.newTimeLock };
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
      args = { spendingLimit: action.spendingLimit.toBase58() };
      insight = `Remove spending limit ${action.spendingLimit.toBase58()}`;
    } else {
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

  private formatInstruction(
    chain: ChainName,
    inst: ParsedInstruction,
  ): SquadsGovernTransaction {
    const to = `${inst.programName} (${inst.programId.toBase58()})`;
    const tx: SquadsGovernTransaction = {
      chain,
      to,
      type: inst.instructionType,
      insight: inst.insight || `${inst.instructionType} instruction`,
    };

    switch (inst.instructionType) {
      case SealevelMultisigIsmInstructionName[
        SealevelMultisigIsmInstructionType.SET_VALIDATORS_AND_THRESHOLD
      ]: {
        const data = inst.data as MultisigSetValidatorsData;
        const remoteChain = this.mpp.tryGetChainName(data.domain);
        const validatorsWithAliases = remoteChain
          ? formatValidatorsWithAliases(remoteChain, data.validators)
          : data.validators;

        tx.args = {
          domain: data.domain,
          threshold: data.threshold,
          validators: validatorsWithAliases,
        };

        const verification = this.verifyConfiguration(
          chain,
          data.domain,
          data.threshold,
          data.validators,
        );

        const chainInfo = remoteChain
          ? `${remoteChain} (${data.domain})`
          : `${data.domain}`;

        tx.insight = verification.matches
          ? `✅ matches expected config for ${chainInfo}`
          : `❌ fatal mismatch: ${verification.issues.join(', ')}`;
        break;
      }

      case SealevelMailboxInstructionName[
        SealevelMailboxInstructionType.INBOX_SET_DEFAULT_ISM
      ]: {
        const data = inst.data as MailboxSetDefaultIsmData;
        tx.args = { module: data.newDefaultIsm };
        break;
      }

      case SealevelMailboxInstructionName[
        SealevelMailboxInstructionType.TRANSFER_OWNERSHIP
      ]:
      case SealevelMultisigIsmInstructionName[
        SealevelMultisigIsmInstructionType.TRANSFER_OWNERSHIP
      ]: {
        const data = inst.data as OwnershipTransferData;
        tx.args = { newOwner: data.newOwner || null };
        break;
      }

      case SquadsInstructionName[SquadsInstructionType.ADD_MEMBER]: {
        const data = inst.data as SquadsAddMemberData;
        tx.args = {
          member: data.newMember,
          permissions: {
            mask: data.permissions.mask,
            decoded: decodePermissions(data.permissions.mask),
          },
        };
        break;
      }

      case SquadsInstructionName[SquadsInstructionType.REMOVE_MEMBER]: {
        const data = inst.data as SquadsRemoveMemberData;
        tx.args = { member: data.memberToRemove };
        break;
      }

      case SquadsInstructionName[SquadsInstructionType.CHANGE_THRESHOLD]: {
        const data = inst.data as SquadsChangeThresholdData;
        tx.args = { newThreshold: data.newThreshold };
        break;
      }

      case SealevelHypTokenInstructionName[
        SealevelHypTokenInstruction.EnrollRemoteRouter
      ]: {
        const data = inst.data as WarpEnrollRemoteRouterData;
        const chainName = data.chainName || `domain ${data.domain}`;
        tx.args = { [chainName]: data.router || 'unenrolled' };
        break;
      }

      case SealevelHypTokenInstructionName[
        SealevelHypTokenInstruction.EnrollRemoteRouters
      ]: {
        const data = inst.data as WarpEnrollRemoteRoutersData;
        const routers: Record<string, string> = {};
        if (data.routers && Array.isArray(data.routers)) {
          for (const router of data.routers) {
            const key = router.chainName || `domain ${router.domain}`;
            routers[key] = router.router || 'unenrolled';
          }
        }
        tx.args = routers;
        break;
      }

      case SealevelHypTokenInstructionName[
        SealevelHypTokenInstruction.SetDestinationGasConfigs
      ]: {
        const data = inst.data as WarpSetDestinationGasConfigsData;
        const gasConfigs: Record<string, string> = {};
        if (data.configs && Array.isArray(data.configs)) {
          for (const config of data.configs) {
            const key = config.chainName || `domain ${config.domain}`;
            gasConfigs[key] = config.gas?.toString() ?? 'unset';
          }
        }
        tx.args = gasConfigs;
        break;
      }

      case SealevelHypTokenInstructionName[
        SealevelHypTokenInstruction.SetInterchainSecurityModule
      ]: {
        const data = inst.data as WarpSetIsmData;
        tx.args = { ism: data.ism || null };
        break;
      }

      case SealevelHypTokenInstructionName[
        SealevelHypTokenInstruction.SetInterchainGasPaymaster
      ]: {
        const data = inst.data as WarpSetIgpData;
        tx.args = data.igp || { igp: null };
        break;
      }

      case SealevelHypTokenInstructionName[
        SealevelHypTokenInstruction.TransferOwnership
      ]: {
        const data = inst.data as OwnershipTransferData;
        tx.args = { newOwner: data.newOwner || null };
        break;
      }
    }

    return tx;
  }
}
