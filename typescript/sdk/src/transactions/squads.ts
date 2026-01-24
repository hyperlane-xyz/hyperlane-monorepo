/**
 * Squads transaction parser for Hyperlane operations
 * Parses VaultTransaction instructions to verify governance operations
 */
import { ComputeBudgetProgram, PublicKey } from '@solana/web3.js';
import { accounts, getProposalPda, getTransactionPda, types } from '@sqds/multisig';
import { deserializeUnchecked } from 'borsh';

import { ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { defaultMultisigConfigs } from '../consts/multisigIsm.js';
import {
  SealevelMailboxInstructionName,
  SealevelMailboxInstructionType,
  SealevelMailboxSetDefaultIsmInstruction,
  SealevelMailboxSetDefaultIsmInstructionSchema,
  SealevelMailboxTransferOwnershipInstruction,
  SealevelMailboxTransferOwnershipInstructionSchema,
} from '../mailbox/serialization.js';
import {
  SealevelMultisigIsmInstructionName,
  SealevelMultisigIsmInstructionType,
  SealevelMultisigIsmSetValidatorsInstruction,
  SealevelMultisigIsmSetValidatorsInstructionSchema,
  SealevelMultisigIsmTransferOwnershipInstruction,
  SealevelMultisigIsmTransferOwnershipInstructionSchema,
} from '../ism/serialization.js';
import { IsmType, MultisigIsmConfig } from '../ism/types.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { ChainMap, ChainName } from '../types.js';
import { SealevelInstructionWrapper } from '../utils/sealevelSerialization.js';
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
import { WarpCoreConfig } from '../warp/types.js';

// ============================================================================
// Squads V4 constants and types
// ============================================================================

/**
 * Squads V4 instruction discriminator size (8-byte Anchor discriminator)
 */
export const SQUADS_DISCRIMINATOR_SIZE = 8;

/**
 * Squads V4 account discriminator size (8-byte Anchor discriminator)
 */
export const SQUADS_ACCOUNT_DISCRIMINATOR_SIZE = 8;

export type SquadProposalStatus = {
  chain: string;
  nonce: number;
  status: string;
  shortTxHash: string;
  fullTxHash: string;
  approvals: number;
  rejections: number;
  cancellations: number;
  threshold: number;
  balance: string;
  submissionDate: string;
};

export enum SquadTxStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  ONE_AWAY = 'ONE_AWAY',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  EXECUTING = 'EXECUTING',
  EXECUTED = 'EXECUTED',
  CANCELLED = 'CANCELLED',
  STALE = 'STALE',
}

export const SquadsProposalStatus = {
  Draft: 'Draft',
  Active: 'Active',
  Rejected: 'Rejected',
  Approved: 'Approved',
  Executing: 'Executing',
  Executed: 'Executed',
  Cancelled: 'Cancelled',
} as const satisfies Record<accounts.Proposal['status']['__kind'], string>;
export type SquadsProposalStatus =
  (typeof SquadsProposalStatus)[keyof typeof SquadsProposalStatus];

export function getSquadTxStatus(
  statusKind: SquadsProposalStatus,
  approvals: number,
  threshold: number,
  transactionIndex: number,
  staleTransactionIndex: number,
): string {
  // Check if transaction is stale before checking other statuses
  // Only return stale if it hasn't been executed
  if (
    transactionIndex < staleTransactionIndex &&
    statusKind !== SquadsProposalStatus.Executed
  ) {
    return SquadTxStatus.STALE;
  }

  switch (statusKind) {
    case SquadsProposalStatus.Draft:
      return SquadTxStatus.DRAFT;
    case SquadsProposalStatus.Active:
      return approvals >= threshold
        ? SquadTxStatus.APPROVED
        : threshold - approvals === 1
          ? SquadTxStatus.ONE_AWAY
          : SquadTxStatus.ACTIVE;
    case SquadsProposalStatus.Rejected:
      return SquadTxStatus.REJECTED;
    case SquadsProposalStatus.Approved:
      return SquadTxStatus.APPROVED;
    case SquadsProposalStatus.Executing:
      return SquadTxStatus.EXECUTING;
    case SquadsProposalStatus.Executed:
      return SquadTxStatus.EXECUTED;
    case SquadsProposalStatus.Cancelled:
      return SquadTxStatus.CANCELLED;
    default:
      return 'UNKNOWN';
  }
}

export enum SquadsAccountType {
  VAULT = 0,
  CONFIG = 1,
}

export enum SquadsInstructionType {
  ADD_MEMBER = 0,
  REMOVE_MEMBER = 1,
  CHANGE_THRESHOLD = 2,
}

export const SquadsInstructionName: Record<SquadsInstructionType, string> = {
  [SquadsInstructionType.ADD_MEMBER]: 'AddMember',
  [SquadsInstructionType.REMOVE_MEMBER]: 'RemoveMember',
  [SquadsInstructionType.CHANGE_THRESHOLD]: 'ChangeThreshold',
};

/**
 * Squads V4 account discriminators (Anchor 8-byte discriminators)
 * From Squads V4 SDK - first 8 bytes of SHA256 hash of "account:account_name"
 */
export const SQUADS_ACCOUNT_DISCRIMINATORS: Record<
  SquadsAccountType,
  Uint8Array
> = {
  [SquadsAccountType.VAULT]: new Uint8Array([
    168, 250, 162, 100, 81, 14, 162, 207,
  ]),
  [SquadsAccountType.CONFIG]: new Uint8Array([
    94, 8, 4, 35, 113, 139, 139, 112,
  ]),
};

/**
 * Squads V4 Permission flags (bitmask)
 * From Squads documentation: https://docs.squads.so/main/development-guides/v4-sdk
 */
export enum SquadsPermission {
  PROPOSER = 1,
  VOTER = 2,
  EXECUTOR = 4,
  ALL_PERMISSIONS = 7,
}

export function decodePermissions(mask: number): string {
  const permissions: string[] = [];
  if (mask & SquadsPermission.PROPOSER) permissions.push('Proposer');
  if (mask & SquadsPermission.VOTER) permissions.push('Voter');
  if (mask & SquadsPermission.EXECUTOR) permissions.push('Executor');

  return permissions.length > 0 ? permissions.join(', ') : 'None';
}

// ============================================================================
// Sealevel parsing constants
// ============================================================================

export const MAILBOX_DISCRIMINATOR_SIZE = 4;
export const HYPERLANE_PROGRAM_DISCRIMINATOR_SIZE = 8;
export const MAX_SOLANA_ACCOUNTS = 256;
export const MAX_SOLANA_ACCOUNT_SIZE = 10240;

export const SYSTEM_PROGRAM_ID = new PublicKey(
  '11111111111111111111111111111111',
);

export enum ProgramName {
  MAILBOX = 'Mailbox',
  MULTISIG_ISM = 'MultisigIsmMessageId',
  WARP_ROUTE = 'WarpRoute',
  SQUADS_V4 = 'SquadsV4',
  SYSTEM_PROGRAM = 'SystemProgram',
  COMPUTE_BUDGET = 'ComputeBudgetProgram',
  UNKNOWN = 'Unknown',
}

export enum InstructionType {
  UNKNOWN = 'Unknown',
  SYSTEM_CALL = 'SystemProgramCall',
  COMPUTE_BUDGET = 'ComputeBudget',
  PARSE_FAILED = 'ParseFailed',
}

export enum ErrorMessage {
  INVALID_INSTRUCTION_LENGTH = 'Invalid instruction data length',
  INSTRUCTION_TOO_SHORT = 'Instruction data too short',
  INVALID_MULTISIG_ISM_DATA = 'Invalid MultisigIsm instruction data',
  INVALID_SQUADS_DATA = 'Invalid Squads instruction data',
}

export enum WarningMessage {
  OWNERSHIP_TRANSFER = 'OWNERSHIP_TRANSFER',
  OWNERSHIP_RENUNCIATION = 'OWNERSHIP_RENUNCIATION',
  UNKNOWN_SQUADS_INSTRUCTION = 'UNKNOWN_SQUADS_INSTRUCTION',
}

export function formatUnknownProgramWarning(programId: string): string {
  return `UNKNOWN_PROGRAM: ${programId}`;
}

export function formatUnknownInstructionWarning(
  programType: string,
  discriminator: number,
): string {
  return `Unknown ${programType} instruction: ${discriminator}`;
}

// ============================================================================
// Config types
// ============================================================================

export type SquadsConfig = {
  programId: string;
  multisigPda: string;
  vault?: string;
};

export type SquadsConfigMap = ChainMap<SquadsConfig>;

export type SquadsKeys = {
  programId: PublicKey;
  multisigPda: PublicKey;
  vault?: PublicKey;
};

export type SvmMultisigConfig = Omit<MultisigIsmConfig, 'type'> & {
  type: typeof IsmType.MESSAGE_ID_MULTISIG;
};

export type SvmMultisigConfigMap = ChainMap<SvmMultisigConfig>;

export type SvmCoreProgramIds = {
  mailbox?: string;
  validatorAnnounce?: string;
  multisigIsmMessageId?: string;
  igpProgramId?: string;
  igpAccount?: string;
  overheadIgpAccount?: string;
  // snake_case compatibility
  validator_announce?: string;
  multisig_ism_message_id?: string;
  igp_program_id?: string;
  igp_account?: string;
  overhead_igp_account?: string;
};

export function getSquadsKeys(
  chainName: ChainName,
  configs: SquadsConfigMap,
): SquadsKeys {
  const config = configs[chainName];
  if (!config) {
    throw new Error(`Squads config not found on chain ${chainName}`);
  }
  return {
    multisigPda: new PublicKey(config.multisigPda),
    programId: new PublicKey(config.programId),
    ...(config.vault ? { vault: new PublicKey(config.vault) } : {}),
  };
}

export async function getSquadAndProvider(
  chain: ChainName,
  mpp: MultiProtocolProvider,
  configs: SquadsConfigMap,
) {
  const svmProvider = mpp.getSolanaWeb3Provider(chain);
  const { multisigPda, programId } = getSquadsKeys(chain, configs);

  return { svmProvider, multisigPda, programId };
}

export async function getSquadProposal(
  chain: ChainName,
  mpp: MultiProtocolProvider,
  configs: SquadsConfigMap,
  transactionIndex: number,
): Promise<
  | {
      proposal: accounts.Proposal;
      multisig: accounts.Multisig;
      proposalPda: PublicKey;
    }
  | undefined
> {
  try {
    const { svmProvider, multisigPda, programId } = await getSquadAndProvider(
      chain,
      mpp,
      configs,
    );

    // Fetch the deserialized Multisig account
    const multisig = await accounts.Multisig.fromAccountAddress(
      // @ts-ignore
      svmProvider,
      multisigPda,
    );

    // Get the proposal PDA
    const [proposalPda] = getProposalPda({
      multisigPda,
      transactionIndex: BigInt(transactionIndex),
      programId,
    });

    // Fetch the proposal account
    const proposal = await accounts.Proposal.fromAccountAddress(
      // @ts-ignore
      svmProvider,
      proposalPda,
    );

    return { proposal, multisig, proposalPda };
  } catch (error) {
    rootLogger.warn(
      `Failed to fetch proposal ${transactionIndex} on ${chain}: ${error}`,
    );
    return undefined;
  }
}

export function isVaultTransaction(accountData: Buffer): boolean {
  const discriminator = accountData.subarray(
    0,
    SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
  );
  return discriminator.equals(
    SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.VAULT],
  );
}

export function isConfigTransaction(accountData: Buffer): boolean {
  const discriminator = accountData.subarray(
    0,
    SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
  );
  return discriminator.equals(
    SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
  );
}

export async function getTransactionType(
  chain: ChainName,
  mpp: MultiProtocolProvider,
  configs: SquadsConfigMap,
  transactionIndex: number,
): Promise<SquadsAccountType> {
  const { svmProvider, multisigPda, programId } = await getSquadAndProvider(
    chain,
    mpp,
    configs,
  );

  const [transactionPda] = getTransactionPda({
    multisigPda,
    index: BigInt(transactionIndex),
    programId,
  });

  const accountInfo = await svmProvider.getAccountInfo(transactionPda);
  if (!accountInfo) {
    throw new Error(
      `Transaction account not found at ${transactionPda.toBase58()}`,
    );
  }

  if (isVaultTransaction(accountInfo.data)) {
    return SquadsAccountType.VAULT;
  } else if (isConfigTransaction(accountInfo.data)) {
    return SquadsAccountType.CONFIG;
  } else {
    const discriminator = accountInfo.data.subarray(
      0,
      SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
    );
    throw new Error(
      `Unknown transaction type with discriminator: [${Array.from(discriminator).join(', ')}]. Expected VaultTransaction or ConfigTransaction.`,
    );
  }
}

// ============================================================================
// Parsing output types
// ============================================================================

export interface ParsedInstruction {
  programId: PublicKey;
  programName: string;
  instructionType: string;
  data: any;
  accounts: PublicKey[];
  warnings: string[];
  insight?: string;
}

export interface GovernTransaction extends Record<string, any> {
  chain: ChainName;
  nestedTx?: GovernTransaction;
}

export interface SquadsTransaction extends Record<string, any> {
  chain: ChainName;
  proposalPda?: string;
  transactionIndex?: number;
  multisig?: string;
  instructions?: GovernTransaction[];
}

export type SquadsTransactionReaderOptions = {
  mpp: MultiProtocolProvider;
  squadsConfigByChain: SquadsConfigMap;
  coreProgramIdsByChain?: ChainMap<SvmCoreProgramIds>;
  expectedMultisigConfigsByChain?: ChainMap<SvmMultisigConfigMap>;
};

// ============================================================================
// SquadsTransactionReader
// ============================================================================

/**
 * SquadsTransactionReader - Main class for parsing Squads proposals
 */
export class SquadsTransactionReader {
  errors: any[] = [];
  private multisigConfigs: Map<ChainName, SvmMultisigConfigMap> = new Map();

  /**
   * Index of known warp route program IDs by chain
   * Maps chain -> lowercase program ID -> metadata
   */
  readonly warpRouteIndex: Map<ChainName, Map<string, WarpRouteMetadata>> =
    new Map();

  constructor(readonly options: SquadsTransactionReaderOptions) {}

  private get mpp() {
    return this.options.mpp;
  }

  /**
   * Initialize the reader with warp routes from the registry
   * Call this before parsing transactions
   */
  async init(warpRoutes: Record<string, WarpCoreConfig>): Promise<void> {
    for (const [routeName, warpRoute] of Object.entries(warpRoutes)) {
      for (const token of Object.values(warpRoute.tokens)) {
        // Only index Sealevel chains
        const chainProtocol = this.mpp.tryGetProtocol(token.chainName);
        if (chainProtocol !== ProtocolType.Sealevel) {
          continue;
        }

        const address = token.addressOrDenom?.toLowerCase();
        if (!address) {
          continue;
        }

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

    rootLogger.debug(
      `Indexed ${Array.from(this.warpRouteIndex.values()).reduce((sum, map) => sum + map.size, 0)} Sealevel warp routes`,
    );
  }

  /**
   * Check if a program ID is a known warp route
   */
  private isWarpRouteProgram(
    chain: ChainName,
    programId: PublicKey,
  ): WarpRouteMetadata | undefined {
    const chainIndex = this.warpRouteIndex.get(chain);
    if (!chainIndex) {
      return undefined;
    }
    return chainIndex.get(programId.toBase58().toLowerCase());
  }

  /**
   * Parse a warp route instruction using Borsh schemas
   * Instructions have 8-byte program discriminator + 1-byte enum discriminator + data
   */
  private readWarpRouteInstruction(
    chain: ChainName,
    instructionData: Buffer,
    metadata: WarpRouteMetadata,
  ): Partial<ParsedInstruction> {
    const minLength = HYPERLANE_PROGRAM_DISCRIMINATOR_SIZE + 1;
    if (instructionData.length < minLength) {
      return {
        instructionType: 'WarpRouteInstruction',
        data: {
          routeName: metadata.routeName,
          symbol: metadata.symbol,
          error: 'Instruction data too short',
        },
        insight: `${metadata.symbol} warp route instruction (data too short)`,
        warnings: [],
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
        case SealevelHypTokenInstruction.EnrollRemoteRouter: {
          const wrapper = deserializeUnchecked(
            SealevelEnrollRemoteRouterInstructionSchema,
            SealevelInstructionWrapper,
            borshData,
          );
          const instruction =
            wrapper.data as SealevelEnrollRemoteRouterInstruction;
          const config = instruction.config;
          const domain = config.domain;
          const chainName = this.mpp.tryGetChainName(domain);
          const router = config.routerAddress;
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
          const count = routers.length;
          const routerSummary = routers
            .map((r) => r.chainName ?? `domain ${r.domain}`)
            .join(', ');

          return {
            instructionType:
              SealevelHypTokenInstructionName[
                SealevelHypTokenInstruction.EnrollRemoteRouters
              ],
            data: { count, routers },
            insight: `Enroll ${count} remote router(s): ${routerSummary}`,
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
          const count = configs.length;
          const configSummary = configs
            .map(
              (c) =>
                `${c.chainName ?? `domain ${c.domain}`}: ${c.gas?.toString() ?? 'unset'}`,
            )
            .join(', ');

          return {
            instructionType:
              SealevelHypTokenInstructionName[
                SealevelHypTokenInstruction.SetDestinationGasConfigs
              ],
            data: { count, configs },
            insight: `Set destination gas for ${count} chain(s): ${configSummary}`,
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

        case SealevelHypTokenInstruction.Init:
        case SealevelHypTokenInstruction.TransferRemote:
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
            insight: `${metadata.symbol} ${SealevelHypTokenInstructionName[discriminator as SealevelHypTokenInstruction] ?? 'unknown'} instruction (${metadata.routeName})`,
            warnings: [],
          };
      }
    } catch (error) {
      return {
        instructionType: 'WarpRouteInstruction',
        data: {
          routeName: metadata.routeName,
          symbol: metadata.symbol,
          error: `Failed to deserialize: ${error}`,
          rawData: instructionData.toString('hex'),
        },
        insight: `${metadata.symbol} warp route instruction (parse error)`,
        warnings: [`Borsh deserialization failed: ${error}`],
      };
    }
  }

  private isMailboxInstruction(
    programId: PublicKey,
    mailbox?: PublicKey,
  ): boolean {
    return !!mailbox && programId.equals(mailbox);
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

    // Read discriminator to determine instruction type
    const discriminator = instructionData.readUInt32LE(0);

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

  private isMultisigIsmInstruction(
    programId: PublicKey,
    multisigIsmMessageId?: PublicKey,
  ): boolean {
    return !!multisigIsmMessageId && programId.equals(multisigIsmMessageId);
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

    // Skip 8-byte program discriminator, read enum discriminator
    const discriminator = instructionData[HYPERLANE_PROGRAM_DISCRIMINATOR_SIZE];

    // Prepare buffer for Borsh deserialization (skip program discriminator)
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
      this.options.squadsConfigByChain,
      transactionIndex,
    );
    if (!proposalData) {
      const error = `Proposal ${transactionIndex} not found on ${chain}`;
      this.errors.push({ chain, transactionIndex, error });
      throw new Error(error);
    }

    const { proposal, proposalPda } = proposalData;
    const { multisigPda, programId } = getSquadsKeys(
      chain,
      this.options.squadsConfigByChain,
    );

    return { proposal, proposalPda, multisigPda, programId };
  }

  private async fetchTransactionAccount(
    chain: ChainName,
    transactionIndex: number,
    transactionPda: PublicKey,
  ): Promise<any> {
    const { svmProvider } = await getSquadAndProvider(
      chain,
      this.mpp,
      this.options.squadsConfigByChain,
    );
    const accountInfo = await svmProvider.getAccountInfo(transactionPda);

    if (!accountInfo) {
      throw new Error(
        `Transaction account not found at ${transactionPda.toBase58()}`,
      );
    }

    rootLogger.debug(
      `Transaction account size: ${accountInfo.data.length} bytes`,
    );

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
  ): Promise<PublicKey[]> {
    const { svmProvider } = await getSquadAndProvider(
      chain,
      this.mpp,
      this.options.squadsConfigByChain,
    );
    const accountKeys = [...vaultTransaction.message.accountKeys];
    const lookups = vaultTransaction.message.addressTableLookups;

    if (!lookups || lookups.length === 0) {
      return accountKeys;
    }

    for (const lookup of lookups) {
      try {
        const lookupTableAccount = await svmProvider.getAccountInfo(
          lookup.accountKey,
        );
        if (!lookupTableAccount) {
          rootLogger.warn(
            `Address lookup table ${lookup.accountKey.toBase58()} not found`,
          );
          continue;
        }

        const data = lookupTableAccount.data;
        const LOOKUP_TABLE_META_SIZE = 56;
        const addresses: PublicKey[] = [];

        for (let i = LOOKUP_TABLE_META_SIZE; i < data.length; i += 32) {
          const addressBytes = data.slice(i, i + 32);
          if (addressBytes.length === 32) {
            addresses.push(new PublicKey(addressBytes));
          }
        }

        // Add writable addresses first, then readonly
        for (const idx of lookup.writableIndexes) {
          if (idx < addresses.length) {
            accountKeys.push(addresses[idx]);
          }
        }
        for (const idx of lookup.readonlyIndexes) {
          if (idx < addresses.length) {
            accountKeys.push(addresses[idx]);
          }
        }
      } catch (error) {
        rootLogger.warn(
          `Failed to resolve address lookup table ${lookup.accountKey.toBase58()}: ${error}`,
        );
      }
    }

    return accountKeys;
  }

  private resolveCorePrograms(chain: ChainName): {
    mailbox?: PublicKey;
    multisigIsmMessageId?: PublicKey;
  } {
    const corePrograms = this.options.coreProgramIdsByChain?.[chain];
    if (!corePrograms) {
      return {};
    }

    const mailbox = corePrograms.mailbox;
    const multisigIsm =
      corePrograms.multisigIsmMessageId ?? corePrograms.multisig_ism_message_id;

    return {
      ...(mailbox ? { mailbox: new PublicKey(mailbox) } : {}),
      ...(multisigIsm ? { multisigIsmMessageId: new PublicKey(multisigIsm) } : {}),
    };
  }

  private async parseVaultInstructions(
    chain: ChainName,
    vaultTransaction: accounts.VaultTransaction,
  ): Promise<{ instructions: ParsedInstruction[]; warnings: string[] }> {
    const corePrograms = this.resolveCorePrograms(chain);

    const parsedInstructions: ParsedInstruction[] = [];
    const warnings: string[] = [];

    const accountKeys = await this.resolveAddressLookupTables(
      chain,
      vaultTransaction,
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

        if (programId.equals(computeBudgetProgramId)) {
          rootLogger.debug(
            `Skipping compute budget instruction at index ${idx}`,
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

        let parsed: Partial<ParsedInstruction>;
        let programName: string;

        if (this.isMailboxInstruction(programId, corePrograms.mailbox)) {
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

        if (
          this.isMultisigIsmInstruction(
            programId,
            corePrograms.multisigIsmMessageId,
          )
        ) {
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

        const warpRouteMetadata = this.isWarpRouteProgram(chain, programId);
        if (warpRouteMetadata) {
          programName = ProgramName.WARP_ROUTE;
          const parsed = this.readWarpRouteInstruction(
            chain,
            instructionData,
            warpRouteMetadata,
          );
          parsedInstructions.push({
            programId,
            programName,
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

        programName = ProgramName.UNKNOWN;
        const unknownWarnings = [
          formatUnknownProgramWarning(programId.toBase58()),
          'Instruction could not be verified',
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
        rootLogger.error(`Failed to parse instruction: ${errorMsg}`);
        warnings.push(`Failed to parse instruction: ${errorMsg}`);

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
      `${chain} proposal ${proposalData.proposal.transactionIndex}: ConfigTransaction (parsing multisig configuration changes)`,
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
    const { svmProvider } = await getSquadAndProvider(
      chain,
      this.mpp,
      this.options.squadsConfigByChain,
    );

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
        rootLogger.warn(errorMsg);
        this.errors.push({ chain, transactionIndex, error: errorMsg });
        throw new Error(errorMsg);
      }

      const errorMsg = `Failed to fetch VaultTransaction at ${transactionPda.toBase58()}: ${error}`;
      rootLogger.error(errorMsg);
      this.errors.push({ chain, transactionIndex, error: errorMsg });
      throw new Error(errorMsg);
    }

    const { instructions: parsedInstructions, warnings } =
      await this.parseVaultInstructions(chain, vaultTransaction);

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

  async read(
    chain: ChainName,
    transactionIndex: number,
  ): Promise<SquadsTransaction> {
    try {
      const proposalData = await this.fetchProposalData(
        chain,
        transactionIndex,
      );

      const [transactionPda] = getTransactionPda({
        multisigPda: proposalData.multisigPda,
        index: BigInt(proposalData.proposal.transactionIndex.toString()),
        programId: proposalData.programId,
      });

      const accountInfo = await this.fetchTransactionAccount(
        chain,
        transactionIndex,
        transactionPda,
      );

      if (isConfigTransaction(accountInfo.data)) {
        return this.readConfigTransaction(chain, proposalData, accountInfo);
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

  private loadMultisigConfig(chain: ChainName): SvmMultisigConfigMap | null {
    if (this.multisigConfigs.has(chain)) {
      return this.multisigConfigs.get(chain)!;
    }

    const config = this.options.expectedMultisigConfigsByChain?.[chain];
    if (!config) {
      return null;
    }

    this.multisigConfigs.set(chain, config);
    return config;
  }

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
      return { matches: true, issues: [] };
    }

    const expectedConfig = config[remoteChain];
    if (!expectedConfig) {
      issues.push(`No expected config for route ${originChain} -> ${remoteChain}`);
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
  ): GovernTransaction {
    const to = `${inst.programName} (${inst.programId.toBase58()})`;
    const insight = inst.insight || `${inst.instructionType} instruction`;

    const tx: GovernTransaction = {
      chain,
      to,
      type: inst.instructionType,
      insight,
    };

    switch (inst.instructionType) {
      case SealevelMultisigIsmInstructionName[
        SealevelMultisigIsmInstructionType.SET_VALIDATORS_AND_THRESHOLD
      ]: {
        const remoteChain = this.mpp.tryGetChainName(inst.data.domain);

        const validatorsWithAliases = remoteChain
          ? formatValidatorsWithAliases(remoteChain, inst.data.validators)
          : inst.data.validators;

        tx.args = {
          domain: inst.data.domain,
          threshold: inst.data.threshold,
          validators: validatorsWithAliases,
        };

        const verification = this.verifyConfiguration(
          chain,
          inst.data.domain,
          inst.data.threshold,
          inst.data.validators,
        );

        const chainInfo = remoteChain
          ? `${remoteChain} (${inst.data.domain})`
          : `${inst.data.domain}`;

        if (verification.matches) {
          tx.insight = `OK: matches expected config for ${chainInfo}`;
        } else {
          tx.insight = `MISMATCH: ${verification.issues.join(', ')}`;
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
        const permissionsStr = decodePermissions(inst.data.permissions.mask);

        tx.args = {
          member: inst.data.newMember,
          permissions: {
            mask: inst.data.permissions.mask,
            decoded: permissionsStr,
          },
        };

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

      case SealevelHypTokenInstructionName[
        SealevelHypTokenInstruction.EnrollRemoteRouter
      ]: {
        const chainName = inst.data.chainName || `domain ${inst.data.domain}`;
        tx.args = {
          [chainName]: inst.data.router || 'unenrolled',
        };
        break;
      }

      case SealevelHypTokenInstructionName[
        SealevelHypTokenInstruction.EnrollRemoteRouters
      ]: {
        const routers: Record<string, string> = {};
        if (inst.data.routers && Array.isArray(inst.data.routers)) {
          for (const r of inst.data.routers) {
            const key = r.chainName || `domain ${r.domain}`;
            routers[key] = r.router || 'unenrolled';
          }
        }
        tx.args = routers;
        break;
      }

      case SealevelHypTokenInstructionName[
        SealevelHypTokenInstruction.SetDestinationGasConfigs
      ]: {
        const gasConfigs: Record<string, string> = {};
        if (inst.data.configs && Array.isArray(inst.data.configs)) {
          for (const c of inst.data.configs) {
            const key = c.chainName || `domain ${c.domain}`;
            gasConfigs[key] = c.gas?.toString() ?? 'unset';
          }
        }
        tx.args = gasConfigs;
        break;
      }

      case SealevelHypTokenInstructionName[
        SealevelHypTokenInstruction.SetInterchainSecurityModule
      ]: {
        tx.args = {
          ism: inst.data.ism || null,
        };
        break;
      }

      case SealevelHypTokenInstructionName[
        SealevelHypTokenInstruction.SetInterchainGasPaymaster
      ]: {
        tx.args = inst.data.igp || { igp: null };
        break;
      }

      case SealevelHypTokenInstructionName[
        SealevelHypTokenInstruction.TransferOwnership
      ]: {
        tx.args = {
          newOwner: inst.data.newOwner || null,
        };
        break;
      }
    }

    return tx;
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

type WarpRouteMetadata = {
  symbol: string;
  name: string;
  routeName: string;
};

function formatValidatorsWithAliases(
  chain: ChainName,
  validators: string[],
): string[] {
  const config = defaultMultisigConfigs[chain];
  if (!config) {
    return validators;
  }

  const aliasMap = new Map<string, string>();
  for (const v of config.validators) {
    aliasMap.set(v.address.toLowerCase(), v.alias);
  }

  return validators.map((addr) => {
    const alias = aliasMap.get(addr.toLowerCase());
    return alias ? `${addr} (${alias})` : addr;
  });
}
