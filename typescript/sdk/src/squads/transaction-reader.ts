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
import {
  isGenericObjectStringifiedValue,
  normalizeStringifiedSquadsError,
  stringifyUnknownSquadsError,
} from './error-format.js';
import { toSquadsProvider } from './provider.js';
import { assertValidTransactionIndexInput } from './validation.js';
import { resolveSquadsChainName, type SquadsChainName } from './config.js';
import {
  inspectArrayValue,
  inspectBufferValue,
  inspectInstanceOf,
  inspectObjectEntries,
  inspectPropertyValue,
  inspectPromiseLikeThenValue,
} from './inspection.js';

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

const UNREADABLE_VALUE_TYPE = '[unreadable value type]';
const VALID_PROTOCOL_TYPES = new Set(Object.values(ProtocolType));

function getErrorMessageFromErrorInstance(error: unknown): string | undefined {
  const { matches: errorIsErrorInstance, readFailed: errorInstanceReadFailed } =
    inspectInstanceOf(error, Error);
  if (errorInstanceReadFailed || !errorIsErrorInstance) {
    return undefined;
  }

  const { propertyValue: message, readError: messageReadError } =
    inspectPropertyValue(error, 'message');
  if (messageReadError) {
    return undefined;
  }
  return normalizeStringifiedSquadsError(message);
}

function getUnknownValueTypeName(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  const { isArray, readFailed } = inspectArrayValue(value);
  if (readFailed) {
    return UNREADABLE_VALUE_TYPE;
  }
  if (isArray) {
    return 'array';
  }
  return typeof value;
}

function readPropertyOrThrow(value: unknown, property: PropertyKey): unknown {
  const { propertyValue, readError } = inspectPropertyValue(value, property);
  if (readError) {
    throw readError;
  }
  return propertyValue;
}

function assertNonEmptyStringValue(value: unknown, label: string): string {
  const valueType = getUnknownValueTypeName(value);
  assert(
    typeof value === 'string',
    `Expected ${label} to be a string, got ${valueType}`,
  );
  const normalizedValue = value.trim();
  assert(
    normalizedValue.length > 0,
    `Expected ${label} to be a non-empty string, got empty string`,
  );
  return normalizedValue;
}

function assertInstructionDiscriminator(discriminator: unknown): number {
  const discriminatorType = getUnknownValueTypeName(discriminator);
  assert(
    typeof discriminator === 'number' &&
      Number.isInteger(discriminator) &&
      Number.isSafeInteger(discriminator) &&
      discriminator >= 0 &&
      discriminator <= 255,
    `Expected discriminator to be a non-negative safe integer in byte range [0, 255], got ${typeof discriminator === 'number' ? discriminator : discriminatorType}`,
  );
  return discriminator;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function formatIntegerValidationValue(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isNaN(value) ? 'NaN' : `${value}`;
  }
  return getUnknownValueTypeName(value);
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  const { isArray, readFailed } = inspectArrayValue(value);
  return typeof value === 'object' && value !== null && !readFailed && !isArray;
}

function parseCoreProgramId(
  programId: string,
  chain: SquadsChainName,
  label: string,
): PublicKey {
  try {
    return new PublicKey(programId);
  } catch (error) {
    throw new Error(
      `Invalid ${label} for ${chain}: ${stringifyUnknownSquadsError(error)}`,
    );
  }
}

function normalizeValidatorSet(validators: unknown): string[] | null {
  const { isArray: validatorsAreArray, readFailed: validatorsReadFailed } =
    inspectArrayValue(validators);
  if (validatorsReadFailed || !validatorsAreArray) {
    return null;
  }

  const normalizedValidatorsInput = validators as readonly unknown[];
  const normalizedValidators: string[] = [];
  for (const validator of normalizedValidatorsInput) {
    if (typeof validator !== 'string') {
      return null;
    }

    const normalizedValidator = validator.trim();
    if (normalizedValidator.length === 0) {
      return null;
    }

    normalizedValidators.push(normalizedValidator);
  }

  return normalizedValidators;
}

function findDuplicateValidator(validators: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const validator of validators) {
    const normalizedValidator = validator.toLowerCase();
    if (seen.has(normalizedValidator)) {
      return validator;
    }
    seen.add(normalizedValidator);
  }
  return null;
}

export function formatUnknownProgramWarning(programId: unknown): string {
  const normalizedProgramId = assertNonEmptyStringValue(
    programId,
    'program id',
  );
  return `⚠️  UNKNOWN PROGRAM: ${normalizedProgramId}`;
}

export function formatUnknownInstructionWarning(
  programName: unknown,
  discriminator: unknown,
): string {
  const normalizedProgramName = assertNonEmptyStringValue(
    programName,
    'program name',
  );
  const normalizedDiscriminator = assertInstructionDiscriminator(discriminator);
  return `Unknown ${normalizedProgramName} instruction (discriminator: ${normalizedDiscriminator})`;
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
  let validatorsValue: unknown;
  try {
    validatorsValue = readPropertyOrThrow(config, 'validators');
  } catch (error) {
    rootLogger.warn(
      `Failed to read default multisig validators for ${chain}: ${stringifyUnknownSquadsError(error)}`,
    );
    return [...validators];
  }
  const { isArray: validatorsAreArray, readFailed: validatorsReadFailed } =
    inspectArrayValue(validatorsValue);
  if (validatorsReadFailed || !validatorsAreArray) {
    rootLogger.warn(
      `Malformed default multisig validators for ${chain}: expected array, got ${getUnknownValueTypeName(validatorsValue)}`,
    );
    return [...validators];
  }

  for (const [index, validator] of (
    validatorsValue as readonly unknown[]
  ).entries()) {
    if (!isRecordObject(validator)) {
      rootLogger.warn(
        `Skipping malformed default multisig validator at index ${index} for ${chain}: expected object, got ${getUnknownValueTypeName(
          validator,
        )}`,
      );
      continue;
    }
    let addressValue: unknown;
    let aliasValue: unknown;
    try {
      addressValue = readPropertyOrThrow(validator, 'address');
      aliasValue = readPropertyOrThrow(validator, 'alias');
    } catch (error) {
      rootLogger.warn(
        `Failed to read default multisig validator fields at index ${index} for ${chain}: ${stringifyUnknownSquadsError(error)}`,
      );
      continue;
    }
    if (typeof addressValue !== 'string' || typeof aliasValue !== 'string') {
      rootLogger.warn(
        `Skipping malformed default multisig validator fields at index ${index} for ${chain}: expected string address/alias, got ${getUnknownValueTypeName(
          addressValue,
        )}/${getUnknownValueTypeName(aliasValue)}`,
      );
      continue;
    }
    aliasMap.set(addressValue.toLowerCase(), aliasValue);
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
  private multisigConfigs: Map<SquadsChainName, SvmMultisigConfigMap | null> =
    new Map();
  readonly warpRouteIndex: Map<ChainName, Map<string, WarpRouteMetadata>> =
    new Map();

  constructor(
    readonly mpp: unknown,
    private readonly options: SquadsTransactionReaderOptions,
  ) {}

  async init(warpRoutes: unknown): Promise<void> {
    assert(
      isRecordObject(warpRoutes),
      `Expected warp routes to be an object, got ${getUnknownValueTypeName(warpRoutes)}`,
    );

    const { entries: warpRouteEntries, readError: warpRouteEntriesReadError } =
      inspectObjectEntries(warpRoutes);
    if (warpRouteEntriesReadError) {
      throw new Error(
        `Failed to read warp routes entries: ${stringifyUnknownSquadsError(warpRouteEntriesReadError)}`,
      );
    }

    for (const [routeName, warpRoute] of warpRouteEntries) {
      const { propertyValue: routeTokens, readError: routeTokensReadError } =
        inspectPropertyValue(warpRoute, 'tokens');
      if (routeTokensReadError) {
        rootLogger.warn(
          `Failed to read warp route tokens for ${routeName}: ${stringifyUnknownSquadsError(routeTokensReadError)}`,
        );
        continue;
      }

      const {
        isArray: routeTokensAreArray,
        readFailed: routeTokensReadFailed,
      } = inspectArrayValue(routeTokens);
      if (routeTokensReadFailed || !routeTokensAreArray) {
        rootLogger.warn(
          `Skipping malformed warp route tokens for ${routeName}: expected array, got ${getUnknownValueTypeName(routeTokens)}`,
        );
        continue;
      }
      const normalizedRouteTokens = routeTokens as readonly unknown[];

      const {
        propertyValue: routeTokensLengthValue,
        readError: routeTokensLengthReadError,
      } = inspectPropertyValue(normalizedRouteTokens, 'length');
      if (routeTokensLengthReadError) {
        rootLogger.warn(
          `Failed to read warp route tokens length for ${routeName}: ${stringifyUnknownSquadsError(routeTokensLengthReadError)}`,
        );
        continue;
      }

      if (
        typeof routeTokensLengthValue !== 'number' ||
        !Number.isSafeInteger(routeTokensLengthValue) ||
        routeTokensLengthValue < 0
      ) {
        rootLogger.warn(
          `Skipping malformed warp route tokens for ${routeName}: expected non-negative safe integer length, got ${formatIntegerValidationValue(routeTokensLengthValue)}`,
        );
        continue;
      }

      for (
        let tokenIndex = 0;
        tokenIndex < routeTokensLengthValue;
        tokenIndex += 1
      ) {
        const { propertyValue: token, readError: tokenReadError } =
          inspectPropertyValue(normalizedRouteTokens, tokenIndex);
        if (tokenReadError) {
          rootLogger.warn(
            `Failed to read warp route token at index ${tokenIndex} for ${routeName}: ${stringifyUnknownSquadsError(tokenReadError)}`,
          );
          continue;
        }
        this.indexWarpRouteToken(routeName, token);
      }
    }
  }

  private indexWarpRouteToken(routeName: string, token: unknown): void {
    if (!isRecordObject(token)) {
      rootLogger.warn(
        `Skipping malformed warp route token for ${routeName}: expected object, got ${getUnknownValueTypeName(token)}`,
      );
      return;
    }

    const { propertyValue: chainNameValue, readError: chainNameReadError } =
      inspectPropertyValue(token, 'chainName');
    if (chainNameReadError) {
      rootLogger.warn(
        `Failed to read warp route token chain for ${routeName}: ${stringifyUnknownSquadsError(chainNameReadError)}`,
      );
      return;
    }

    if (typeof chainNameValue !== 'string') {
      rootLogger.warn(
        `Skipping malformed warp route token chain for ${routeName}: expected string, got ${getUnknownValueTypeName(chainNameValue)}`,
      );
      return;
    }

    const normalizedChainName = chainNameValue.trim();
    if (normalizedChainName.length === 0) {
      rootLogger.warn(
        `Skipping malformed warp route token chain for ${routeName}: expected non-empty string`,
      );
      return;
    }

    let chainProtocol: unknown;
    try {
      chainProtocol = this.resolveProtocolTypeForWarpRoute(
        routeName,
        normalizedChainName,
      );
    } catch (error) {
      const errorMessage = getErrorMessageFromErrorInstance(error);
      rootLogger.warn(
        errorMessage
          ? errorMessage
          : `Failed to resolve protocol for warp route ${routeName} on ${normalizedChainName}: ${stringifyUnknownSquadsError(error)}`,
      );
      return;
    }
    if (chainProtocol !== ProtocolType.Sealevel) {
      return;
    }

    const { propertyValue: addressOrDenom, readError: addressReadError } =
      inspectPropertyValue(token, 'addressOrDenom');
    if (addressReadError) {
      rootLogger.warn(
        `Failed to read warp route token address for ${routeName} on ${normalizedChainName}: ${stringifyUnknownSquadsError(addressReadError)}`,
      );
      return;
    }

    if (typeof addressOrDenom !== 'string') {
      if (typeof addressOrDenom !== 'undefined' && addressOrDenom !== null) {
        rootLogger.warn(
          `Skipping malformed warp route token address for ${routeName} on ${normalizedChainName}: expected string, got ${getUnknownValueTypeName(addressOrDenom)}`,
        );
      }
      return;
    }

    const address = addressOrDenom.trim().toLowerCase();
    if (!address) {
      return;
    }

    const { propertyValue: symbolValue, readError: symbolReadError } =
      inspectPropertyValue(token, 'symbol');
    if (symbolReadError) {
      rootLogger.warn(
        `Failed to read warp route token symbol for ${routeName} on ${normalizedChainName}: ${stringifyUnknownSquadsError(symbolReadError)}`,
      );
    }
    const symbol =
      typeof symbolValue === 'string' && symbolValue.trim().length > 0
        ? symbolValue.trim()
        : 'Unknown';

    const { propertyValue: nameValue, readError: nameReadError } =
      inspectPropertyValue(token, 'name');
    if (nameReadError) {
      rootLogger.warn(
        `Failed to read warp route token name for ${routeName} on ${normalizedChainName}: ${stringifyUnknownSquadsError(nameReadError)}`,
      );
    }
    const name =
      typeof nameValue === 'string' && nameValue.trim().length > 0
        ? nameValue.trim()
        : 'Unknown';

    const chainName = normalizedChainName as ChainName;
    if (!this.warpRouteIndex.has(chainName)) {
      this.warpRouteIndex.set(chainName, new Map());
    }

    this.warpRouteIndex.get(chainName)!.set(address, {
      symbol,
      name,
      routeName,
    });
  }

  private resolveProtocolTypeForWarpRoute(
    routeName: string,
    chain: string,
  ): ProtocolType | null {
    const { propertyValue: tryGetProtocolValue, readError: protocolReadError } =
      inspectPropertyValue(this.mpp, 'tryGetProtocol');
    if (protocolReadError) {
      throw new Error(
        `Failed to read tryGetProtocol for warp route ${routeName} on ${chain}: ${stringifyUnknownSquadsError(protocolReadError)}`,
      );
    }

    assert(
      typeof tryGetProtocolValue === 'function',
      `Invalid multi protocol provider for warp route ${routeName} on ${chain}: expected tryGetProtocol function, got ${getUnknownValueTypeName(tryGetProtocolValue)}`,
    );

    let protocol: unknown;
    try {
      protocol = tryGetProtocolValue.call(this.mpp, chain);
    } catch (error) {
      throw new Error(
        `Failed to resolve protocol for warp route ${routeName} on ${chain}: ${stringifyUnknownSquadsError(error)}`,
      );
    }

    const protocolType = getUnknownValueTypeName(protocol);
    if (protocolType === UNREADABLE_VALUE_TYPE) {
      throw new Error(
        `Invalid protocol for warp route ${routeName} on ${chain}: expected ProtocolType value, got ${protocolType}`,
      );
    }

    const { thenValue, readError: thenReadError } =
      inspectPromiseLikeThenValue(protocol);
    if (thenReadError) {
      throw new Error(
        `Failed to inspect protocol for warp route ${routeName} on ${chain}: failed to read promise-like then field (${stringifyUnknownSquadsError(thenReadError)})`,
      );
    }
    assert(
      typeof thenValue !== 'function',
      `Invalid protocol for warp route ${routeName} on ${chain}: expected synchronous ProtocolType value, got promise-like value`,
    );

    const protocolDisplayValue =
      typeof protocol === 'string'
        ? protocol
        : getUnknownValueTypeName(protocol);
    assert(
      protocol === null ||
        (typeof protocol === 'string' &&
          VALID_PROTOCOL_TYPES.has(protocol as ProtocolType)),
      `Invalid protocol for warp route ${routeName} on ${chain}: expected ProtocolType or null, got ${protocolDisplayValue}`,
    );

    return protocol as ProtocolType | null;
  }

  private isWarpRouteProgram(
    chain: ChainName,
    programId: PublicKey,
  ): WarpRouteMetadata | undefined {
    let programIdBase58: unknown;
    try {
      programIdBase58 = programId.toBase58();
    } catch (error) {
      rootLogger.warn(
        `Failed to stringify warp route program id on ${chain}: ${stringifyUnknownSquadsError(error)}`,
      );
      return undefined;
    }

    const normalizedProgramId =
      this.normalizeOptionalNonEmptyString(programIdBase58);
    if (!normalizedProgramId) {
      rootLogger.warn(
        `Malformed warp route program id on ${chain}: expected non-empty base58 string`,
      );
      return undefined;
    }
    if (isGenericObjectStringifiedValue(normalizedProgramId)) {
      rootLogger.warn(
        `Malformed warp route program id on ${chain}: received generic object label`,
      );
      return undefined;
    }

    const chainIndex = this.warpRouteIndex.get(chain);
    if (!chainIndex) {
      return undefined;
    }
    return chainIndex.get(normalizedProgramId.toLowerCase());
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
          const instruction = readPropertyOrThrow(
            wrapper,
            'data',
          ) as SealevelEnrollRemoteRouterInstruction;
          const configValue = readPropertyOrThrow(instruction, 'config');
          const domain = readPropertyOrThrow(configValue, 'domain');
          const domainForDisplay = formatIntegerValidationValue(domain);
          const chainName =
            this.tryResolveRemoteChainNameForDisplay(domain) ?? undefined;
          const router = readPropertyOrThrow(configValue, 'routerAddress');
          const chainInfo = chainName
            ? `${chainName} (${domainForDisplay})`
            : domainForDisplay;

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
          const instruction = readPropertyOrThrow(
            wrapper,
            'data',
          ) as SealevelEnrollRemoteRoutersInstruction;
          const configsValue = readPropertyOrThrow(instruction, 'configs');
          const { isArray: configsAreArray, readFailed: configsReadFailed } =
            inspectArrayValue(configsValue);
          assert(
            !configsReadFailed && configsAreArray,
            `Malformed warp route router configs on ${chain}: expected array, got ${getUnknownValueTypeName(configsValue)}`,
          );
          const routers = (configsValue as readonly unknown[]).map((config) => {
            const domain = readPropertyOrThrow(config, 'domain');
            return {
              domain,
              chainName:
                this.tryResolveRemoteChainNameForDisplay(domain) ?? undefined,
              router: readPropertyOrThrow(config, 'routerAddress'),
            };
          });

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
          const instruction = readPropertyOrThrow(
            wrapper,
            'data',
          ) as SealevelSetDestinationGasConfigsInstruction;
          const configsValue = readPropertyOrThrow(instruction, 'configs');
          const { isArray: configsAreArray, readFailed: configsReadFailed } =
            inspectArrayValue(configsValue);
          assert(
            !configsReadFailed && configsAreArray,
            `Malformed warp route gas configs on ${chain}: expected array, got ${getUnknownValueTypeName(configsValue)}`,
          );
          const configs = (configsValue as readonly unknown[]).map((config) => {
            const domain = readPropertyOrThrow(config, 'domain');
            return {
              domain,
              chainName:
                this.tryResolveRemoteChainNameForDisplay(domain) ?? undefined,
              gas: readPropertyOrThrow(config, 'gas'),
            };
          });

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
          const instruction = readPropertyOrThrow(
            wrapper,
            'data',
          ) as SealevelSetInterchainSecurityModuleInstruction;
          const ismPubkeyValue = readPropertyOrThrow(instruction, 'ismPubkey');
          const ism = ismPubkeyValue
            ? this.formatAddressLikeForDisplay(
                chain,
                'warp ISM pubkey',
                ismPubkeyValue,
              )
            : null;

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
          const instruction = readPropertyOrThrow(
            wrapper,
            'data',
          ) as SealevelSetInterchainGasPaymasterInstruction;
          const igpConfig = readPropertyOrThrow(instruction, 'igpConfig');
          const programIdPubkeyValue = igpConfig
            ? readPropertyOrThrow(igpConfig, 'programIdPubkey')
            : undefined;
          const igpTypeNameValue = igpConfig
            ? readPropertyOrThrow(igpConfig, 'igpTypeName')
            : undefined;
          const igpAccountPubkeyValue = igpConfig
            ? readPropertyOrThrow(igpConfig, 'igpAccountPubkey')
            : undefined;
          const igp = igpConfig
            ? {
                program: programIdPubkeyValue
                  ? this.formatAddressLikeForDisplay(
                      chain,
                      'warp IGP program pubkey',
                      programIdPubkeyValue,
                    )
                  : '',
                type: igpTypeNameValue,
                account: igpAccountPubkeyValue
                  ? this.formatAddressLikeForDisplay(
                      chain,
                      'warp IGP account pubkey',
                      igpAccountPubkeyValue,
                    )
                  : '',
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
          const instruction = readPropertyOrThrow(
            wrapper,
            'data',
          ) as SealevelHypTokenTransferOwnershipInstruction;
          const newOwnerPubkeyValue = readPropertyOrThrow(
            instruction,
            'newOwnerPubkey',
          );
          const newOwner = newOwnerPubkeyValue
            ? this.formatAddressLikeForDisplay(
                chain,
                'warp ownership target',
                newOwnerPubkeyValue,
              )
            : null;

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
    chain: ChainName,
    programId: PublicKey,
    corePrograms: { mailbox: PublicKey },
  ): boolean {
    return this.isProgramIdEqual(
      chain,
      'mailbox',
      programId,
      corePrograms.mailbox,
    );
  }

  private readMailboxInstruction(
    chain: ChainName,
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
          const instruction = readPropertyOrThrow(
            wrapper,
            'data',
          ) as SealevelMailboxSetDefaultIsmInstruction;
          const newIsmPubkeyValue = readPropertyOrThrow(
            instruction,
            'newIsmPubkey',
          );
          const newDefaultIsm = this.formatAddressLikeForDisplay(
            chain,
            'mailbox default ISM',
            newIsmPubkeyValue,
          );

          return {
            instructionType: SealevelMailboxInstructionName[discriminator],
            data: { newDefaultIsm },
            insight: `Set default ISM to ${newDefaultIsm}`,
            warnings: [],
          };
        }

        case SealevelMailboxInstructionType.TRANSFER_OWNERSHIP: {
          const wrapper = deserializeUnchecked(
            SealevelMailboxTransferOwnershipInstructionSchema,
            SealevelInstructionWrapper,
            instructionData,
          );
          const instruction = readPropertyOrThrow(
            wrapper,
            'data',
          ) as SealevelMailboxTransferOwnershipInstruction;
          const newOwnerPubkeyValue = readPropertyOrThrow(
            instruction,
            'newOwnerPubkey',
          );

          if (newOwnerPubkeyValue) {
            const newOwner = this.formatAddressLikeForDisplay(
              chain,
              'mailbox ownership target',
              newOwnerPubkeyValue,
            );
            return {
              instructionType: SealevelMailboxInstructionName[discriminator],
              data: { newOwner },
              insight: `Transfer ownership to ${newOwner}`,
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
    chain: ChainName,
    programId: PublicKey,
    corePrograms: { multisigIsmMessageId: PublicKey },
  ): boolean {
    return this.isProgramIdEqual(
      chain,
      'multisig_ism_message_id',
      programId,
      corePrograms.multisigIsmMessageId,
    );
  }

  private isProgramIdEqual(
    chain: ChainName,
    label: string,
    programId: PublicKey,
    expectedProgramId: PublicKey,
  ): boolean {
    try {
      return programId.equals(expectedProgramId);
    } catch (error) {
      rootLogger.warn(
        `Failed to compare ${label} program id on ${chain}: ${stringifyUnknownSquadsError(error)}`,
      );
      return false;
    }
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
          const instruction = readPropertyOrThrow(
            wrapper,
            'data',
          ) as SealevelMultisigIsmSetValidatorsInstruction;
          const domainValue = readPropertyOrThrow(instruction, 'domain');
          const thresholdValue = readPropertyOrThrow(instruction, 'threshold');
          const validatorsValue = readPropertyOrThrow(
            instruction,
            'validators',
          );
          const {
            propertyValue: validatorCountValue,
            readError: validatorCountReadError,
          } = inspectPropertyValue(validatorsValue, 'length');
          if (validatorCountReadError) {
            throw validatorCountReadError;
          }
          const validatorAddressesValue = readPropertyOrThrow(
            instruction,
            'validatorAddresses',
          );
          const remoteDomainForDisplay =
            formatIntegerValidationValue(domainValue);
          const remoteChain =
            this.tryResolveRemoteChainNameForDisplay(domainValue);
          const chainInfo = remoteChain
            ? `${remoteChain} (${remoteDomainForDisplay})`
            : remoteDomainForDisplay;

          return {
            instructionType: SealevelMultisigIsmInstructionName[discriminator],
            data: {
              domain: domainValue,
              threshold: thresholdValue,
              validatorCount: validatorCountValue,
              validators: validatorAddressesValue,
            },
            insight: `Set ${formatIntegerValidationValue(
              validatorCountValue,
            )} validator(s) with threshold ${formatIntegerValidationValue(
              thresholdValue,
            )} for ${chainInfo}`,
            warnings: [],
          };
        }

        case SealevelMultisigIsmInstructionType.TRANSFER_OWNERSHIP: {
          const wrapper = deserializeUnchecked(
            SealevelMultisigIsmTransferOwnershipInstructionSchema,
            SealevelInstructionWrapper,
            borshData,
          );
          const instruction = readPropertyOrThrow(
            wrapper,
            'data',
          ) as SealevelMultisigIsmTransferOwnershipInstruction;
          const newOwnerPubkeyValue = readPropertyOrThrow(
            instruction,
            'newOwnerPubkey',
          );

          if (newOwnerPubkeyValue) {
            const newOwner = this.formatAddressLikeForDisplay(
              chain,
              'multisig ISM ownership target',
              newOwnerPubkeyValue,
            );
            return {
              instructionType:
                SealevelMultisigIsmInstructionName[discriminator],
              data: { newOwner },
              insight: `Transfer ownership to ${newOwner}`,
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
    chain: SquadsChainName,
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

  private getSolanaWeb3ProviderForRead(
    chain: SquadsChainName,
  ): SolanaWeb3Provider {
    let getSolanaWeb3ProviderValue: unknown;
    try {
      getSolanaWeb3ProviderValue = (
        this.mpp as { getSolanaWeb3Provider?: unknown }
      ).getSolanaWeb3Provider;
    } catch (error) {
      throw new Error(
        `Failed to read getSolanaWeb3Provider for ${chain}: ${stringifyUnknownSquadsError(error)}`,
      );
    }

    assert(
      typeof getSolanaWeb3ProviderValue === 'function',
      `Invalid multi protocol provider for ${chain}: expected getSolanaWeb3Provider function, got ${getUnknownValueTypeName(getSolanaWeb3ProviderValue)}`,
    );

    let svmProvider: unknown;
    try {
      svmProvider = getSolanaWeb3ProviderValue.call(this.mpp, chain);
    } catch (error) {
      throw new Error(
        `Failed to resolve solana provider for ${chain}: ${stringifyUnknownSquadsError(error)}`,
      );
    }
    const { isArray: providerIsArray, readFailed: providerReadFailed } =
      inspectArrayValue(svmProvider);
    assert(
      typeof svmProvider === 'object' &&
        svmProvider !== null &&
        !providerReadFailed &&
        !providerIsArray,
      `Invalid solana provider for ${chain}: expected object, got ${getUnknownValueTypeName(svmProvider)}`,
    );

    const { thenValue, readError: thenReadError } =
      inspectPromiseLikeThenValue(svmProvider);
    if (thenReadError) {
      throw new Error(
        `Failed to inspect solana provider for ${chain}: failed to read promise-like then field (${stringifyUnknownSquadsError(thenReadError)})`,
      );
    }
    assert(
      typeof thenValue !== 'function',
      `Invalid solana provider for ${chain}: expected synchronous provider, got promise-like value`,
    );

    const {
      propertyValue: getAccountInfoValue,
      readError: getAccountInfoReadError,
    } = inspectPropertyValue(svmProvider, 'getAccountInfo');
    if (getAccountInfoReadError) {
      throw new Error(
        `Failed to read getAccountInfo for ${chain}: ${stringifyUnknownSquadsError(getAccountInfoReadError)}`,
      );
    }

    assert(
      typeof getAccountInfoValue === 'function',
      `Invalid solana provider for ${chain}: expected getAccountInfo function, got ${getUnknownValueTypeName(getAccountInfoValue)}`,
    );

    return svmProvider as SolanaWeb3Provider;
  }

  private async fetchTransactionAccount(
    chain: SquadsChainName,
    transactionIndex: number,
    transactionPda: PublicKey,
    svmProvider: SolanaWeb3Provider,
  ): Promise<{ accountInfo: { data?: unknown }; accountData: Buffer }> {
    const accountInfo = await this.fetchAccountInfoForReader(
      chain,
      transactionPda,
      'transaction account',
      svmProvider,
    );

    if (!accountInfo) {
      const transactionPdaForDisplay = this.formatAddressLikeForDisplay(
        chain,
        'transaction PDA',
        transactionPda,
      );
      throw new Error(
        `Transaction account not found at ${transactionPdaForDisplay} on ${chain}`,
      );
    }

    const accountData = this.readTransactionAccountData(
      chain,
      'transaction account',
      accountInfo,
    );

    if (accountData.length > MAX_SOLANA_ACCOUNT_SIZE) {
      rootLogger.warn(
        `Transaction account is unusually large: ${accountData.length} bytes`,
      );
    }

    return { accountInfo, accountData };
  }

  private async fetchAccountInfoForReader(
    chain: SquadsChainName,
    address: unknown,
    label: string,
    svmProvider: SolanaWeb3Provider,
  ): Promise<unknown> {
    const {
      matches: addressIsPublicKey,
      readFailed: addressReadFailedDuringInstanceCheck,
    } = inspectInstanceOf(address, PublicKey);
    assert(
      !addressReadFailedDuringInstanceCheck && addressIsPublicKey,
      `Expected ${label} address on ${chain} to be a PublicKey, got ${getUnknownValueTypeName(address)}`,
    );

    const {
      propertyValue: getAccountInfoValue,
      readError: getAccountInfoReadError,
    } = inspectPropertyValue(svmProvider, 'getAccountInfo');
    if (getAccountInfoReadError) {
      throw new Error(
        `Failed to read getAccountInfo for ${chain}: ${stringifyUnknownSquadsError(getAccountInfoReadError)}`,
      );
    }

    assert(
      typeof getAccountInfoValue === 'function',
      `Invalid solana provider for ${chain}: expected getAccountInfo function, got ${getUnknownValueTypeName(getAccountInfoValue)}`,
    );

    const addressForDisplay = this.formatAddressLikeForDisplay(
      chain,
      `${label} address`,
      address,
    );

    try {
      return await getAccountInfoValue.call(svmProvider, address);
    } catch (error) {
      throw new Error(
        `Failed to fetch ${label} ${addressForDisplay} on ${chain}: ${stringifyUnknownSquadsError(error)}`,
      );
    }
  }

  private async resolveAddressLookupTables(
    chain: SquadsChainName,
    vaultTransaction: accounts.VaultTransaction,
    svmProvider: SolanaWeb3Provider,
  ): Promise<PublicKey[]> {
    const accountKeysValue = this.readVaultTransactionField(
      chain,
      'vault message account keys',
      () =>
        readPropertyOrThrow(
          readPropertyOrThrow(vaultTransaction, 'message'),
          'accountKeys',
        ),
      [],
    );
    const { isArray: accountKeysAreArray, readFailed: accountKeysReadFailed } =
      inspectArrayValue(accountKeysValue);
    if (accountKeysReadFailed || !accountKeysAreArray) {
      rootLogger.warn(
        `Malformed vault account keys on ${chain}: expected array, got ${getUnknownValueTypeName(accountKeysValue)}`,
      );
      return [];
    }
    const accountKeys = this.normalizeVaultArrayField(
      chain,
      'vault account keys',
      accountKeysValue as readonly unknown[],
    ) as PublicKey[];
    const lookupsValue = this.readVaultTransactionField(
      chain,
      'vault address lookup tables',
      () =>
        readPropertyOrThrow(
          readPropertyOrThrow(vaultTransaction, 'message'),
          'addressTableLookups',
        ),
      [],
    );
    const { isArray: lookupsAreArray, readFailed: lookupsReadFailed } =
      inspectArrayValue(lookupsValue);
    if (lookupsReadFailed || !lookupsAreArray) {
      rootLogger.warn(
        `Malformed vault address lookup tables on ${chain}: expected array, got ${getUnknownValueTypeName(lookupsValue)}`,
      );
      return accountKeys;
    }
    const lookups = this.normalizeVaultArrayField(
      chain,
      'vault address lookup tables',
      lookupsValue as readonly unknown[],
    );

    if (!lookups || lookups.length === 0) return accountKeys;

    for (const lookup of lookups) {
      const lookupAccountKeyValue = this.readVaultTransactionField(
        chain,
        'lookup table account key',
        () => readPropertyOrThrow(lookup, 'accountKey'),
        undefined,
      );
      try {
        const lookupTableAccount = await this.fetchAccountInfoForReader(
          chain,
          lookupAccountKeyValue,
          'lookup table account',
          svmProvider,
        );
        if (!lookupTableAccount) continue;

        const writableIndexesValue = this.readVaultTransactionField(
          chain,
          'lookup table writable indexes',
          () => readPropertyOrThrow(lookup, 'writableIndexes'),
          [],
        );
        const readonlyIndexesValue = this.readVaultTransactionField(
          chain,
          'lookup table readonly indexes',
          () => readPropertyOrThrow(lookup, 'readonlyIndexes'),
          [],
        );
        const {
          isArray: writableIndexesAreArray,
          readFailed: writableIndexesReadFailed,
        } = inspectArrayValue(writableIndexesValue);
        const writableIndexes =
          !writableIndexesReadFailed && writableIndexesAreArray
            ? this.normalizeVaultArrayField(
                chain,
                'lookup table writable indexes',
                writableIndexesValue as readonly unknown[],
              )
            : [];
        const {
          isArray: readonlyIndexesAreArray,
          readFailed: readonlyIndexesReadFailed,
        } = inspectArrayValue(readonlyIndexesValue);
        const readonlyIndexes =
          !readonlyIndexesReadFailed && readonlyIndexesAreArray
            ? this.normalizeVaultArrayField(
                chain,
                'lookup table readonly indexes',
                readonlyIndexesValue as readonly unknown[],
              )
            : [];

        const data = this.readTransactionAccountData(
          chain,
          'lookup table account',
          lookupTableAccount as { data?: unknown },
        );
        const LOOKUP_TABLE_META_SIZE = 56;
        const addresses: PublicKey[] = [];

        for (let i = LOOKUP_TABLE_META_SIZE; i < data.length; i += 32) {
          const addressBytes = data.slice(i, i + 32);
          if (addressBytes.length === 32) {
            addresses.push(new PublicKey(addressBytes));
          }
        }

        for (const idx of writableIndexes) {
          if (
            typeof idx === 'number' &&
            Number.isInteger(idx) &&
            idx >= 0 &&
            idx < addresses.length
          ) {
            accountKeys.push(addresses[idx]);
          }
        }
        for (const idx of readonlyIndexes) {
          if (
            typeof idx === 'number' &&
            Number.isInteger(idx) &&
            idx >= 0 &&
            idx < addresses.length
          ) {
            accountKeys.push(addresses[idx]);
          }
        }
      } catch (error) {
        const formattedError = stringifyUnknownSquadsError(error);
        const lookupTableAddress = this.formatProgramIdForDisplay(
          lookupAccountKeyValue,
        );
        rootLogger.warn(
          `Failed to resolve address lookup table ${lookupTableAddress} on ${chain}: ${formattedError}`,
        );
      }
    }

    return accountKeys;
  }

  private async parseVaultInstructions(
    chain: SquadsChainName,
    vaultTransaction: accounts.VaultTransaction,
    svmProvider: SolanaWeb3Provider,
  ): Promise<{ instructions: ParsedInstruction[]; warnings: string[] }> {
    const corePrograms = this.resolveCorePrograms(chain);

    const parsedInstructions: ParsedInstruction[] = [];
    const warnings: string[] = [];
    const accountKeys = await this.resolveAddressLookupTables(
      chain,
      vaultTransaction,
      svmProvider,
    );
    const instructionsValue = this.readVaultTransactionField(
      chain,
      'vault instructions',
      () =>
        readPropertyOrThrow(
          readPropertyOrThrow(vaultTransaction, 'message'),
          'instructions',
        ),
      [],
    );
    const {
      isArray: instructionsAreArray,
      readFailed: instructionsReadFailed,
    } = inspectArrayValue(instructionsValue);
    if (instructionsReadFailed || !instructionsAreArray) {
      const warning = `Malformed vault instructions on ${chain}: expected array, got ${getUnknownValueTypeName(instructionsValue)}`;
      warnings.push(warning);
      return { instructions: parsedInstructions, warnings };
    }
    const instructions = this.normalizeVaultArrayField(
      chain,
      'vault instructions',
      instructionsValue as readonly unknown[],
    );
    const computeBudgetProgramId = ComputeBudgetProgram.programId;

    for (const [idx, instruction] of instructions.entries()) {
      try {
        const programIdIndexValue = this.readVaultInstructionField(
          chain,
          idx,
          'program id index',
          () => readPropertyOrThrow(instruction, 'programIdIndex'),
          -1,
        );
        const programIdIndex =
          typeof programIdIndexValue === 'number' &&
          Number.isInteger(programIdIndexValue)
            ? programIdIndexValue
            : -1;
        if (programIdIndex >= accountKeys.length || programIdIndex < 0) {
          throw new Error(
            `Invalid programIdIndex: ${formatIntegerValidationValue(
              programIdIndexValue,
            )}. Account keys length: ${accountKeys.length}`,
          );
        }

        const accountIndexesValue = this.readVaultInstructionField(
          chain,
          idx,
          'account indexes',
          () => readPropertyOrThrow(instruction, 'accountIndexes'),
          [],
        );
        const {
          isArray: accountIndexesAreArray,
          readFailed: accountIndexesReadFailed,
        } = inspectArrayValue(accountIndexesValue);
        if (accountIndexesReadFailed || !accountIndexesAreArray) {
          const warning = `Malformed instruction account indexes on ${chain} at ${idx}: expected array, got ${getUnknownValueTypeName(accountIndexesValue)}`;
          rootLogger.warn(warning);
          warnings.push(warning);
        }
        const accountIndexes =
          !accountIndexesReadFailed && accountIndexesAreArray
            ? this.normalizeVaultArrayField(
                chain,
                `instruction account indexes at ${idx}`,
                accountIndexesValue as readonly unknown[],
              )
            : [];

        if (accountIndexes.length > MAX_SOLANA_ACCOUNTS) {
          throw new Error(
            `Invalid accountIndexes: length ${accountIndexes.length}`,
          );
        }

        const programId = accountKeys[programIdIndex];
        if (!programId) {
          throw new Error(`Program ID not found at index ${programIdIndex}`);
        }

        if (
          this.isProgramIdEqual(
            chain,
            'compute-budget',
            programId,
            computeBudgetProgramId,
          )
        ) {
          continue;
        }

        const instructionDataValue = this.readVaultInstructionField(
          chain,
          idx,
          'instruction data',
          () => readPropertyOrThrow(instruction, 'data'),
          Buffer.alloc(0),
        );
        const instructionData = this.normalizeInstructionDataForParse(
          chain,
          idx,
          instructionDataValue,
          warnings,
        );
        const accounts: PublicKey[] = [];
        for (const accountIdxValue of accountIndexes) {
          if (
            typeof accountIdxValue !== 'number' ||
            !Number.isInteger(accountIdxValue) ||
            accountIdxValue < 0
          ) {
            continue;
          }
          if (accountIdxValue < accountKeys.length) {
            const key = accountKeys[accountIdxValue];
            if (key) accounts.push(key);
          }
        }

        if (this.isMailboxInstruction(chain, programId, corePrograms)) {
          const parsed = this.readMailboxInstruction(chain, instructionData);
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

        if (this.isMultisigIsmInstruction(chain, programId, corePrograms)) {
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

        if (
          this.isProgramIdEqual(chain, 'system', programId, SYSTEM_PROGRAM_ID)
        ) {
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

        const formattedUnknownProgramId =
          this.formatProgramIdForDisplay(programId);
        const unknownWarnings = [
          formatUnknownProgramWarning(formattedUnknownProgramId),
          'This instruction could not be verified!',
        ];
        parsedInstructions.push({
          programId,
          programName: ProgramName.UNKNOWN,
          instructionType: InstructionType.UNKNOWN,
          data: {
            programId: formattedUnknownProgramId,
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

  private readVaultTransactionField(
    chain: SquadsChainName,
    label: string,
    readValue: () => unknown,
    fallbackValue: unknown,
  ): unknown {
    try {
      return readValue();
    } catch (error) {
      rootLogger.warn(
        `Failed to read ${label} on ${chain}: ${stringifyUnknownSquadsError(error)}`,
      );
      return fallbackValue;
    }
  }

  private readVaultInstructionField(
    chain: SquadsChainName,
    instructionIndex: number,
    label: string,
    readValue: () => unknown,
    fallbackValue: unknown,
  ): unknown {
    try {
      return readValue();
    } catch (error) {
      rootLogger.warn(
        `Failed to read instruction ${instructionIndex} ${label} on ${chain}: ${stringifyUnknownSquadsError(error)}`,
      );
      return fallbackValue;
    }
  }

  private normalizeInstructionDataForParse(
    chain: SquadsChainName,
    instructionIndex: number,
    value: unknown,
    warnings: string[],
  ): Buffer {
    const { isBuffer: valueIsBuffer, readFailed: valueBufferReadFailed } =
      inspectBufferValue(value);
    if (!valueBufferReadFailed && valueIsBuffer) {
      return Buffer.from(value as Buffer);
    }
    const {
      matches: valueIsUint8Array,
      readFailed: valueUint8ArrayReadFailed,
    } = inspectInstanceOf(value, Uint8Array);
    if (!valueUint8ArrayReadFailed && valueIsUint8Array) {
      return Buffer.from(value as Uint8Array);
    }
    const {
      matches: valueIsArrayBuffer,
      readFailed: valueArrayBufferReadFailed,
    } = inspectInstanceOf(value, ArrayBuffer);
    if (!valueArrayBufferReadFailed && valueIsArrayBuffer) {
      return Buffer.from(new Uint8Array(value as ArrayBuffer));
    }
    const { isArray: valueIsArray, readFailed: valueReadFailed } =
      inspectArrayValue(value);
    if (!valueReadFailed && valueIsArray) {
      try {
        return Buffer.from(value as readonly number[]);
      } catch (error) {
        const warning = `Failed to normalize instruction ${instructionIndex} data on ${chain}: ${stringifyUnknownSquadsError(error)}`;
        rootLogger.warn(warning);
        warnings.push(warning);
        return Buffer.alloc(0);
      }
    }

    const warning = `Malformed instruction ${instructionIndex} data on ${chain}: expected bytes, got ${getUnknownValueTypeName(value)}`;
    rootLogger.warn(warning);
    warnings.push(warning);
    return Buffer.alloc(0);
  }

  private normalizeVaultArrayField(
    chain: SquadsChainName,
    label: string,
    values: readonly unknown[],
  ): unknown[] {
    try {
      return Array.from(values);
    } catch (error) {
      rootLogger.warn(
        `Failed to normalize ${label} on ${chain}: ${stringifyUnknownSquadsError(error)}`,
      );
      return [];
    }
  }

  private resolveCorePrograms(chain: SquadsChainName): {
    mailbox: PublicKey;
    multisigIsmMessageId: PublicKey;
  } {
    const {
      propertyValue: resolveCoreProgramIds,
      readError: resolveCoreProgramIdsReadError,
    } = inspectPropertyValue(this.options, 'resolveCoreProgramIds');
    if (resolveCoreProgramIdsReadError) {
      throw new Error(
        `Failed to access core program resolver for ${chain}: ${stringifyUnknownSquadsError(resolveCoreProgramIdsReadError)}`,
      );
    }

    assert(
      typeof resolveCoreProgramIds === 'function',
      `Invalid core program resolver for ${chain}: expected function, got ${getUnknownValueTypeName(
        resolveCoreProgramIds,
      )}`,
    );

    let coreProgramIds: unknown;
    try {
      coreProgramIds = resolveCoreProgramIds(chain);
    } catch (error) {
      throw new Error(
        `Failed to resolve core program ids for ${chain}: ${stringifyUnknownSquadsError(error)}`,
      );
    }

    const coreProgramIdsType = getUnknownValueTypeName(coreProgramIds);
    assert(
      isRecordObject(coreProgramIds),
      `Invalid core program ids for ${chain}: expected object, got ${coreProgramIdsType}`,
    );

    const { thenValue, readError: thenReadError } =
      inspectPromiseLikeThenValue(coreProgramIds);
    assert(
      !thenReadError,
      `Failed to inspect core program ids for ${chain}: failed to read promise-like then field (${stringifyUnknownSquadsError(
        thenReadError,
      )})`,
    );
    assert(
      typeof thenValue !== 'function',
      `Invalid core program ids for ${chain}: expected synchronous object result, got promise-like value`,
    );

    const {
      propertyValue: mailboxProgramIdValue,
      readError: mailboxProgramIdReadError,
    } = inspectPropertyValue(coreProgramIds, 'mailbox');
    if (mailboxProgramIdReadError) {
      throw new Error(
        `Failed to read mailbox program id for ${chain}: ${stringifyUnknownSquadsError(mailboxProgramIdReadError)}`,
      );
    }
    const mailboxProgramId = assertNonEmptyStringValue(
      mailboxProgramIdValue,
      `mailbox program id for ${chain}`,
    );

    const {
      propertyValue: multisigIsmMessageIdProgramIdValue,
      readError: multisigIsmMessageIdProgramIdReadError,
    } = inspectPropertyValue(coreProgramIds, 'multisig_ism_message_id');
    if (multisigIsmMessageIdProgramIdReadError) {
      throw new Error(
        `Failed to read multisig_ism_message_id program id for ${chain}: ${stringifyUnknownSquadsError(multisigIsmMessageIdProgramIdReadError)}`,
      );
    }
    const multisigIsmMessageIdProgramId = assertNonEmptyStringValue(
      multisigIsmMessageIdProgramIdValue,
      `multisig_ism_message_id program id for ${chain}`,
    );

    return {
      mailbox: parseCoreProgramId(
        mailboxProgramId,
        chain,
        'mailbox program id',
      ),
      multisigIsmMessageId: parseCoreProgramId(
        multisigIsmMessageIdProgramId,
        chain,
        'multisig_ism_message_id program id',
      ),
    };
  }

  private async readConfigTransaction(
    chain: SquadsChainName,
    transactionIndex: number,
    proposalData: {
      proposal: accounts.Proposal;
      proposalPda: PublicKey;
      multisigPda: PublicKey;
    },
    accountInfo: AccountInfo<Buffer>,
  ): Promise<SquadsTransaction> {
    const configTx = this.decodeConfigTransactionForRead(
      chain,
      transactionIndex,
      accountInfo,
    );

    const instructions: SquadsGovernTransaction[] = [];
    let actions: unknown;
    const { propertyValue: actionsValue, readError: actionsReadError } =
      inspectPropertyValue(configTx, 'actions');
    if (actionsReadError) {
      rootLogger.warn(
        `Failed to read config actions for ${chain} at index ${transactionIndex}: ${stringifyUnknownSquadsError(actionsReadError)}`,
      );
      actions = [];
    } else {
      actions = actionsValue;
    }

    const { isArray: actionsAreArray, readFailed: actionsReadFailed } =
      inspectArrayValue(actions);
    if (actionsReadFailed || !actionsAreArray) {
      rootLogger.warn(
        `Malformed config actions for ${chain} at index ${transactionIndex}: expected array, got ${getUnknownValueTypeName(actions)}`,
      );
      actions = [];
    }

    const normalizedActions: unknown[] =
      !actionsReadFailed && actionsAreArray
        ? this.normalizeVaultArrayField(
            chain,
            `config actions at ${transactionIndex}`,
            actions as readonly unknown[],
          )
        : [];
    for (const action of normalizedActions) {
      const instruction = this.formatConfigAction(
        chain,
        action as types.ConfigAction,
      );
      if (instruction) instructions.push(instruction);
    }

    const proposalPdaValue = this.readProposalDataField(
      chain,
      'proposal PDA',
      () => readPropertyOrThrow(proposalData, 'proposalPda'),
      undefined,
    );
    const multisigPdaValue = this.readProposalDataField(
      chain,
      'multisig PDA',
      () => readPropertyOrThrow(proposalData, 'multisigPda'),
      undefined,
    );

    return {
      chain,
      proposalPda: this.formatAddressLikeForDisplay(
        chain,
        'proposal PDA',
        proposalPdaValue,
      ),
      transactionIndex,
      multisig: this.formatAddressLikeForDisplay(
        chain,
        'multisig PDA',
        multisigPdaValue,
      ),
      instructions,
    };
  }

  private decodeConfigTransactionForRead(
    chain: SquadsChainName,
    transactionIndex: number,
    accountInfo: AccountInfo<Buffer>,
  ): unknown {
    let fromAccountInfoValue: unknown;
    try {
      fromAccountInfoValue = (
        accounts.ConfigTransaction as { fromAccountInfo?: unknown }
      ).fromAccountInfo;
    } catch (error) {
      throw new Error(
        `Failed to read ConfigTransaction decoder for ${chain} at index ${transactionIndex}: ${stringifyUnknownSquadsError(error)}`,
      );
    }

    assert(
      typeof fromAccountInfoValue === 'function',
      `Invalid ConfigTransaction decoder for ${chain} at index ${transactionIndex}: expected fromAccountInfo function, got ${getUnknownValueTypeName(fromAccountInfoValue)}`,
    );

    try {
      const [configTx] = fromAccountInfoValue.call(
        accounts.ConfigTransaction,
        accountInfo,
        0,
      );
      return configTx;
    } catch (error) {
      throw new Error(
        `Failed to decode ConfigTransaction for ${chain} at index ${transactionIndex}: ${stringifyUnknownSquadsError(error)}`,
      );
    }
  }

  private async readVaultTransaction(
    chain: SquadsChainName,
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
    const vaultTransaction = await this.fetchVaultTransactionForRead(
      chain,
      transactionPda,
      squadsProvider,
    );

    const { instructions: parsedInstructions, warnings } =
      await this.parseVaultInstructions(chain, vaultTransaction, svmProvider);

    if (warnings.length > 0) {
      this.errors.push({ chain, transactionIndex, warnings });
    }

    const proposalPdaValue = this.readProposalDataField(
      chain,
      'proposal PDA',
      () => readPropertyOrThrow(proposalData, 'proposalPda'),
      undefined,
    );
    const multisigPdaValue = this.readProposalDataField(
      chain,
      'multisig PDA',
      () => readPropertyOrThrow(proposalData, 'multisigPda'),
      undefined,
    );

    return {
      chain,
      proposalPda: this.formatAddressLikeForDisplay(
        chain,
        'proposal PDA',
        proposalPdaValue,
      ),
      transactionIndex,
      multisig: this.formatAddressLikeForDisplay(
        chain,
        'multisig PDA',
        multisigPdaValue,
      ),
      instructions: parsedInstructions.map((inst) =>
        this.formatInstruction(chain, inst),
      ),
    };
  }

  private async fetchVaultTransactionForRead(
    chain: SquadsChainName,
    transactionPda: PublicKey,
    squadsProvider: ReturnType<typeof toSquadsProvider>,
  ): Promise<accounts.VaultTransaction> {
    let fromAccountAddressValue: unknown;
    try {
      fromAccountAddressValue = (
        accounts.VaultTransaction as { fromAccountAddress?: unknown }
      ).fromAccountAddress;
    } catch (error) {
      throw new Error(
        `Failed to read VaultTransaction account loader for ${chain}: ${stringifyUnknownSquadsError(error)}`,
      );
    }

    assert(
      typeof fromAccountAddressValue === 'function',
      `Invalid VaultTransaction account loader for ${chain}: expected fromAccountAddress function, got ${getUnknownValueTypeName(fromAccountAddressValue)}`,
    );

    try {
      return await fromAccountAddressValue.call(
        accounts.VaultTransaction,
        squadsProvider,
        transactionPda,
      );
    } catch (error) {
      const transactionPdaForDisplay = this.formatAddressLikeForDisplay(
        chain,
        'vault transaction PDA',
        transactionPda,
      );
      const errorMsg = `Failed to fetch VaultTransaction at ${transactionPdaForDisplay}: ${stringifyUnknownSquadsError(error)}`;
      throw new Error(errorMsg);
    }
  }

  private deriveTransactionPdaForRead(
    chain: SquadsChainName,
    transactionIndex: number,
    proposalData: {
      multisigPda: PublicKey;
      programId: PublicKey;
    },
  ): PublicKey {
    const { propertyValue: multisigPdaValue, readError: multisigPdaReadError } =
      inspectPropertyValue(proposalData, 'multisigPda');
    if (multisigPdaReadError) {
      throw new Error(
        `Failed to read proposal multisig PDA for ${chain} at index ${transactionIndex}: ${stringifyUnknownSquadsError(multisigPdaReadError)}`,
      );
    }
    const {
      matches: multisigPdaIsPublicKey,
      readFailed: multisigPdaReadFailedDuringInstanceCheck,
    } = inspectInstanceOf(multisigPdaValue, PublicKey);
    assert(
      !multisigPdaReadFailedDuringInstanceCheck && multisigPdaIsPublicKey,
      `Malformed proposal multisig PDA for ${chain} at index ${transactionIndex}: expected PublicKey, got ${getUnknownValueTypeName(multisigPdaValue)}`,
    );
    const normalizedMultisigPda = multisigPdaValue as PublicKey;

    const { propertyValue: programIdValue, readError: programIdReadError } =
      inspectPropertyValue(proposalData, 'programId');
    if (programIdReadError) {
      throw new Error(
        `Failed to read proposal program id for ${chain} at index ${transactionIndex}: ${stringifyUnknownSquadsError(programIdReadError)}`,
      );
    }
    const {
      matches: programIdIsPublicKey,
      readFailed: programIdReadFailedDuringInstanceCheck,
    } = inspectInstanceOf(programIdValue, PublicKey);
    assert(
      !programIdReadFailedDuringInstanceCheck && programIdIsPublicKey,
      `Malformed proposal program id for ${chain} at index ${transactionIndex}: expected PublicKey, got ${getUnknownValueTypeName(programIdValue)}`,
    );
    const normalizedProgramId = programIdValue as PublicKey;

    let transactionPdaTuple: unknown;
    try {
      transactionPdaTuple = getTransactionPda({
        multisigPda: normalizedMultisigPda,
        index: BigInt(transactionIndex),
        programId: normalizedProgramId,
      });
    } catch (error) {
      throw new Error(
        `Failed to derive transaction PDA for ${chain} at index ${transactionIndex}: ${stringifyUnknownSquadsError(error)}`,
      );
    }

    const {
      isArray: transactionPdaTupleIsArray,
      readFailed: transactionPdaTupleReadFailed,
    } = inspectArrayValue(transactionPdaTuple);
    assert(
      !transactionPdaTupleReadFailed && transactionPdaTupleIsArray,
      `Malformed transaction PDA derivation for ${chain} at index ${transactionIndex}: expected non-empty tuple result`,
    );

    const normalizedTransactionPdaTuple =
      transactionPdaTuple as readonly unknown[];
    const {
      propertyValue: transactionPdaTupleLengthValue,
      readError: transactionPdaTupleLengthReadError,
    } = inspectPropertyValue(normalizedTransactionPdaTuple, 'length');
    if (transactionPdaTupleLengthReadError) {
      throw new Error(
        `Failed to read transaction PDA tuple length for ${chain} at index ${transactionIndex}: ${stringifyUnknownSquadsError(transactionPdaTupleLengthReadError)}`,
      );
    }
    assert(
      typeof transactionPdaTupleLengthValue === 'number' &&
        Number.isSafeInteger(transactionPdaTupleLengthValue) &&
        transactionPdaTupleLengthValue > 0,
      `Malformed transaction PDA derivation for ${chain} at index ${transactionIndex}: expected non-empty tuple result`,
    );

    const {
      propertyValue: transactionPda,
      readError: transactionPdaReadError,
    } = inspectPropertyValue(normalizedTransactionPdaTuple, 0);
    if (transactionPdaReadError) {
      throw new Error(
        `Failed to read transaction PDA tuple entry for ${chain} at index ${transactionIndex}: ${stringifyUnknownSquadsError(transactionPdaReadError)}`,
      );
    }
    const {
      matches: transactionPdaIsPublicKey,
      readFailed: transactionPdaReadFailedDuringInstanceCheck,
    } = inspectInstanceOf(transactionPda, PublicKey);
    assert(
      !transactionPdaReadFailedDuringInstanceCheck && transactionPdaIsPublicKey,
      `Malformed transaction PDA derivation for ${chain} at index ${transactionIndex}: expected PublicKey at tuple index 0, got ${getUnknownValueTypeName(transactionPda)}`,
    );

    return transactionPda as PublicKey;
  }

  async read(
    chain: unknown,
    transactionIndex: unknown,
  ): Promise<SquadsTransaction> {
    const normalizedChain = resolveSquadsChainName(chain);
    const normalizedTransactionIndex = assertValidTransactionIndexInput(
      transactionIndex,
      normalizedChain,
    );

    try {
      const svmProvider = this.getSolanaWeb3ProviderForRead(normalizedChain);
      const proposalData = await this.fetchProposalData(
        normalizedChain,
        normalizedTransactionIndex,
        svmProvider,
      );
      const proposalTransactionIndex = parseSquadProposalTransactionIndex(
        proposalData.proposal,
      );
      assert(
        proposalTransactionIndex === normalizedTransactionIndex,
        `Expected proposal index ${normalizedTransactionIndex} for ${normalizedChain}, got ${proposalTransactionIndex}`,
      );

      const transactionPda = this.deriveTransactionPdaForRead(
        normalizedChain,
        normalizedTransactionIndex,
        proposalData,
      );

      const fetchedTransactionAccount = await this.fetchTransactionAccount(
        normalizedChain,
        normalizedTransactionIndex,
        transactionPda,
        svmProvider,
      );
      const { accountInfo, accountData } =
        this.normalizeFetchedTransactionAccount(
          normalizedChain,
          fetchedTransactionAccount,
        );

      if (isConfigTransaction(accountData)) {
        return await this.readConfigTransaction(
          normalizedChain,
          normalizedTransactionIndex,
          proposalData,
          accountInfo,
        );
      }

      if (!isVaultTransaction(accountData)) {
        const discriminator = accountData.slice(
          0,
          SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
        );
        rootLogger.warn(
          `Unknown transaction discriminator: ${discriminator.toString()}. Expected VaultTransaction or ConfigTransaction`,
        );
      }

      return await this.readVaultTransaction(
        normalizedChain,
        normalizedTransactionIndex,
        svmProvider,
        proposalData,
        transactionPda,
      );
    } catch (error) {
      this.errors.push({
        chain: normalizedChain,
        transactionIndex: normalizedTransactionIndex,
        error: stringifyUnknownSquadsError(error),
      });
      throw error;
    }
  }

  private normalizeFetchedTransactionAccount(
    chain: SquadsChainName,
    fetchedTransactionAccount: unknown,
  ): {
    accountInfo: AccountInfo<Buffer<ArrayBufferLike>>;
    accountData: Buffer;
  } {
    if (
      !fetchedTransactionAccount ||
      (typeof fetchedTransactionAccount !== 'object' &&
        typeof fetchedTransactionAccount !== 'function')
    ) {
      throw new Error(
        `Malformed fetched transaction account on ${chain}: expected object, got ${getUnknownValueTypeName(fetchedTransactionAccount)}`,
      );
    }

    let accountInfoValue: unknown = fetchedTransactionAccount;
    let accountDataValue: unknown;
    const fetchedAccountRecord = fetchedTransactionAccount as {
      accountInfo?: unknown;
      accountData?: unknown;
    };
    try {
      if ('accountInfo' in fetchedAccountRecord) {
        accountInfoValue = fetchedAccountRecord.accountInfo;
      }
    } catch (error) {
      throw new Error(
        `Failed to read fetched transaction account info on ${chain}: ${stringifyUnknownSquadsError(error)}`,
      );
    }
    try {
      if ('accountData' in fetchedAccountRecord) {
        accountDataValue = fetchedAccountRecord.accountData;
      }
    } catch (error) {
      throw new Error(
        `Failed to read fetched transaction account bytes on ${chain}: ${stringifyUnknownSquadsError(error)}`,
      );
    }

    if (
      !accountInfoValue ||
      (typeof accountInfoValue !== 'object' &&
        typeof accountInfoValue !== 'function')
    ) {
      throw new Error(
        `Malformed fetched transaction account info on ${chain}: expected object, got ${getUnknownValueTypeName(accountInfoValue)}`,
      );
    }

    const accountInfo = accountInfoValue as AccountInfo<
      Buffer<ArrayBufferLike>
    >;
    const accountData =
      typeof accountDataValue === 'undefined'
        ? this.readTransactionAccountData(
            chain,
            'transaction account',
            accountInfo,
          )
        : this.readTransactionAccountData(
            chain,
            'fetched transaction account',
            {
              data: accountDataValue,
            },
          );

    return { accountInfo, accountData };
  }

  private loadMultisigConfig(
    chain: SquadsChainName,
  ): SvmMultisigConfigMap | null {
    if (this.multisigConfigs.has(chain)) {
      return this.multisigConfigs.get(chain) ?? null;
    }

    const {
      propertyValue: resolveExpectedMultisigConfig,
      readError: resolveExpectedMultisigConfigReadError,
    } = inspectPropertyValue(this.options, 'resolveExpectedMultisigConfig');
    if (resolveExpectedMultisigConfigReadError) {
      rootLogger.warn(
        `Failed to load multisig config resolver for ${chain}: ${stringifyUnknownSquadsError(resolveExpectedMultisigConfigReadError)}`,
      );
      this.multisigConfigs.set(chain, null);
      return null;
    }

    if (!resolveExpectedMultisigConfig) {
      this.multisigConfigs.set(chain, null);
      return null;
    }
    if (typeof resolveExpectedMultisigConfig !== 'function') {
      rootLogger.warn(
        `Invalid multisig config resolver for ${chain}: expected function, got ${getUnknownValueTypeName(resolveExpectedMultisigConfig)}`,
      );
      this.multisigConfigs.set(chain, null);
      return null;
    }

    try {
      const config = resolveExpectedMultisigConfig(chain);
      const configType = getUnknownValueTypeName(config);
      if (!isRecordObject(config) && configType === UNREADABLE_VALUE_TYPE) {
        rootLogger.warn(
          `Invalid expected multisig config for ${chain}: expected object, got ${configType}`,
        );
        this.multisigConfigs.set(chain, null);
        return null;
      }

      const { thenValue, readError: thenReadError } =
        inspectPromiseLikeThenValue(config);
      if (thenReadError) {
        rootLogger.warn(
          `Failed to inspect expected multisig config for ${chain}: failed to read promise-like then field (${stringifyUnknownSquadsError(thenReadError)})`,
        );
        this.multisigConfigs.set(chain, null);
        return null;
      }
      if (typeof thenValue === 'function') {
        rootLogger.warn(
          `Invalid expected multisig config for ${chain}: expected synchronous object result, got promise-like value`,
        );
        this.multisigConfigs.set(chain, null);
        return null;
      }
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

  private resolveChainNameForDomain(
    remoteDomain: number,
    label: 'chain' | 'chain alias',
  ): unknown {
    const {
      propertyValue: tryGetChainNameValue,
      readError: tryGetChainNameReadError,
    } = inspectPropertyValue(this.mpp, 'tryGetChainName');
    if (tryGetChainNameReadError) {
      throw new Error(
        `Failed to read tryGetChainName for domain ${remoteDomain}: ${stringifyUnknownSquadsError(tryGetChainNameReadError)}`,
      );
    }

    assert(
      typeof tryGetChainNameValue === 'function',
      `Invalid multi protocol provider for domain ${remoteDomain}: expected tryGetChainName function, got ${getUnknownValueTypeName(tryGetChainNameValue)}`,
    );

    let remoteChain: unknown;
    try {
      remoteChain = tryGetChainNameValue.call(this.mpp, remoteDomain);
    } catch (error) {
      throw new Error(
        `Failed to resolve ${label} for domain ${remoteDomain}: ${stringifyUnknownSquadsError(error)}`,
      );
    }

    const remoteChainType = getUnknownValueTypeName(remoteChain);
    if (remoteChainType === UNREADABLE_VALUE_TYPE) {
      throw new Error(
        `Malformed resolved ${label} for domain ${remoteDomain}: expected string, got ${remoteChainType}`,
      );
    }

    const { thenValue, readError: thenReadError } =
      inspectPromiseLikeThenValue(remoteChain);
    if (thenReadError) {
      throw new Error(
        `Failed to inspect resolved ${label} for domain ${remoteDomain}: failed to read promise-like then field (${stringifyUnknownSquadsError(thenReadError)})`,
      );
    }
    assert(
      typeof thenValue !== 'function',
      `Invalid resolved ${label} for domain ${remoteDomain}: expected synchronous string result, got promise-like value`,
    );

    return remoteChain;
  }

  private verifyConfiguration(
    originChain: SquadsChainName,
    remoteDomain: unknown,
    threshold: unknown,
    validators: unknown,
  ): { matches: boolean; issues: string[] } {
    const issues: string[] = [];
    if (!isNonNegativeSafeInteger(remoteDomain)) {
      issues.push(
        `Malformed remote domain for ${originChain}: expected non-negative safe integer, got ${formatIntegerValidationValue(remoteDomain)}`,
      );
      return { matches: false, issues };
    }

    let remoteChain: unknown;
    try {
      remoteChain = this.resolveChainNameForDomain(remoteDomain, 'chain');
    } catch (error) {
      const errorMessage = getErrorMessageFromErrorInstance(error);
      issues.push(
        errorMessage
          ? errorMessage
          : `Failed to resolve chain for domain ${remoteDomain}: ${stringifyUnknownSquadsError(error)}`,
      );
      return { matches: false, issues };
    }

    if (remoteChain === null || typeof remoteChain === 'undefined') {
      issues.push(`Unknown domain ${remoteDomain}`);
      return { matches: false, issues };
    }

    let normalizedRemoteChain: string;
    try {
      normalizedRemoteChain = assertNonEmptyStringValue(
        remoteChain,
        `resolved chain name for domain ${remoteDomain}`,
      );
    } catch (error) {
      issues.push(
        `Malformed chain resolution for domain ${remoteDomain}: ${stringifyUnknownSquadsError(error)}`,
      );
      return { matches: false, issues };
    }

    if (!isPositiveSafeInteger(threshold)) {
      issues.push(
        `Malformed validator threshold for route ${originChain} -> ${normalizedRemoteChain}: threshold must be a positive safe integer, got ${formatIntegerValidationValue(threshold)}`,
      );
      return { matches: false, issues };
    }

    const config = this.loadMultisigConfig(originChain);
    if (!config) {
      issues.push(`No expected config found for ${originChain}`);
      return { matches: false, issues };
    }

    if (!isRecordObject(config)) {
      issues.push(
        `Malformed expected config for ${originChain}: expected route map object`,
      );
      return { matches: false, issues };
    }

    const route = `${originChain} -> ${normalizedRemoteChain}`;
    const {
      propertyValue: expectedConfig,
      readError: expectedConfigReadError,
    } = inspectPropertyValue(config, normalizedRemoteChain);
    if (expectedConfigReadError) {
      issues.push(
        `Malformed expected config for route ${route}: failed to read route entry (${stringifyUnknownSquadsError(expectedConfigReadError)})`,
      );
      return { matches: false, issues };
    }

    if (expectedConfig === null || typeof expectedConfig === 'undefined') {
      issues.push(`No expected config for route ${route}`);
      return { matches: false, issues };
    }

    if (!isRecordObject(expectedConfig)) {
      issues.push(
        `Malformed expected config for route ${route}: expected route entry object`,
      );
      return { matches: false, issues };
    }

    const {
      propertyValue: expectedThreshold,
      readError: expectedThresholdReadError,
    } = inspectPropertyValue(expectedConfig, 'threshold');
    if (expectedThresholdReadError) {
      issues.push(
        `Malformed expected config for route ${route}: failed to read threshold (${stringifyUnknownSquadsError(expectedThresholdReadError)})`,
      );
      return { matches: false, issues };
    }

    if (!isPositiveSafeInteger(expectedThreshold)) {
      issues.push(
        `Malformed expected config for route ${route}: threshold must be a positive safe integer`,
      );
      return { matches: false, issues };
    }

    const {
      propertyValue: expectedValidators,
      readError: expectedValidatorsReadError,
    } = inspectPropertyValue(expectedConfig, 'validators');
    if (expectedValidatorsReadError) {
      issues.push(
        `Malformed expected config for route ${route}: failed to read validators (${stringifyUnknownSquadsError(expectedValidatorsReadError)})`,
      );
      return { matches: false, issues };
    }

    let normalizedExpectedValidators: string[] | null;
    try {
      normalizedExpectedValidators = normalizeValidatorSet(expectedValidators);
    } catch (error) {
      issues.push(
        `Malformed expected config for route ${route}: failed to read validators (${stringifyUnknownSquadsError(error)})`,
      );
      return { matches: false, issues };
    }
    if (!normalizedExpectedValidators) {
      issues.push(
        `Malformed expected config for route ${route}: validators must be an array of non-empty strings`,
      );
      return { matches: false, issues };
    }
    const duplicateExpectedValidator = findDuplicateValidator(
      normalizedExpectedValidators,
    );
    if (duplicateExpectedValidator) {
      issues.push(
        `Malformed expected config for route ${route}: validators must be unique (duplicate: ${duplicateExpectedValidator})`,
      );
      return { matches: false, issues };
    }

    let normalizedActualValidators: string[] | null;
    try {
      normalizedActualValidators = normalizeValidatorSet(validators);
    } catch (error) {
      issues.push(
        `Malformed validator set for route ${route}: failed to read validators (${stringifyUnknownSquadsError(error)})`,
      );
      return { matches: false, issues };
    }
    if (!normalizedActualValidators) {
      issues.push(
        `Malformed validator set for route ${route}: validators must be an array of non-empty strings`,
      );
      return { matches: false, issues };
    }
    const duplicateActualValidator = findDuplicateValidator(
      normalizedActualValidators,
    );
    if (duplicateActualValidator) {
      issues.push(
        `Malformed validator set for route ${route}: validators must be unique (duplicate: ${duplicateActualValidator})`,
      );
      return { matches: false, issues };
    }

    if (expectedThreshold !== threshold) {
      issues.push(
        `Threshold mismatch: expected ${expectedThreshold}, got ${threshold}`,
      );
    }

    if (
      normalizedExpectedValidators.length !== normalizedActualValidators.length
    ) {
      issues.push(
        `Validator count mismatch: expected ${normalizedExpectedValidators.length}, got ${normalizedActualValidators.length}`,
      );
    }

    const expectedValidatorsSet = new Set(
      normalizedExpectedValidators.map((v) => v.toLowerCase()),
    );
    const actualValidatorsSet = new Set(
      normalizedActualValidators.map((v) => v.toLowerCase()),
    );

    const missingValidators = normalizedExpectedValidators.filter(
      (v) => !actualValidatorsSet.has(v.toLowerCase()),
    );
    const unexpectedValidators = normalizedActualValidators.filter(
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
    chain: SquadsChainName,
    action: types.ConfigAction,
  ): SquadsGovernTransaction | null {
    try {
      let type: string;
      let args: Record<string, unknown>;
      let insight: string;

      if (types.isConfigActionAddMember(action)) {
        const newMemberValue = this.readConfigActionField(
          chain,
          'config action add-member payload',
          () => readPropertyOrThrow(action, 'newMember'),
          undefined,
        );
        const memberKeyValue = isRecordObject(newMemberValue)
          ? this.readConfigActionField(
              chain,
              'config action member key',
              () => readPropertyOrThrow(newMemberValue, 'key'),
              undefined,
            )
          : undefined;
        const member = this.formatAddressLikeForDisplay(
          chain,
          'config action member key',
          memberKeyValue,
        );

        const permissionsValue = isRecordObject(newMemberValue)
          ? this.readConfigActionField(
              chain,
              'config action member permissions',
              () => readPropertyOrThrow(newMemberValue, 'permissions'),
              undefined,
            )
          : undefined;
        const permissionsMask = isRecordObject(permissionsValue)
          ? this.readConfigActionField(
              chain,
              'config action member permissions mask',
              () => readPropertyOrThrow(permissionsValue, 'mask'),
              undefined,
            )
          : undefined;
        let permissionsStr = 'Unknown';
        if (typeof permissionsMask !== 'undefined') {
          try {
            permissionsStr = decodePermissions(permissionsMask);
          } catch (error) {
            rootLogger.warn(
              `Failed to decode config-action permissions on ${chain}: ${stringifyUnknownSquadsError(error)}`,
            );
          }
        }

        type = SquadsInstructionName[SquadsInstructionType.ADD_MEMBER];
        args = {
          member,
          permissions: {
            mask:
              typeof permissionsMask === 'undefined' ? null : permissionsMask,
            decoded: permissionsStr,
          },
        };
        insight = `Add member ${member} with ${permissionsStr} permissions`;
      } else if (types.isConfigActionRemoveMember(action)) {
        const oldMemberValue = this.readConfigActionField(
          chain,
          'config action removed member',
          () => readPropertyOrThrow(action, 'oldMember'),
          undefined,
        );
        const member = this.formatAddressLikeForDisplay(
          chain,
          'config action removed member',
          oldMemberValue,
        );
        type = SquadsInstructionName[SquadsInstructionType.REMOVE_MEMBER];
        args = { member };
        insight = `Remove member ${member}`;
      } else if (types.isConfigActionChangeThreshold(action)) {
        const thresholdValue = this.readConfigActionField(
          chain,
          'config action threshold',
          () => readPropertyOrThrow(action, 'newThreshold'),
          null,
        );
        type = SquadsInstructionName[SquadsInstructionType.CHANGE_THRESHOLD];
        args = { threshold: thresholdValue };
        insight = `Change threshold to ${formatIntegerValidationValue(thresholdValue)}`;
      } else if (types.isConfigActionSetTimeLock(action)) {
        const timeLockValue = this.readConfigActionField(
          chain,
          'config action time lock',
          () => readPropertyOrThrow(action, 'newTimeLock'),
          null,
        );
        type = 'SetTimeLock';
        args = { timeLock: timeLockValue };
        insight = `Set time lock to ${formatIntegerValidationValue(timeLockValue)}s`;
      } else if (types.isConfigActionAddSpendingLimit(action)) {
        let amountValue = '[invalid amount]';
        try {
          const amountCandidate = readPropertyOrThrow(action, 'amount');
          if (
            amountCandidate === null ||
            typeof amountCandidate === 'undefined'
          ) {
            throw new Error(
              `Expected config-action spending-limit amount on ${chain} to be defined`,
            );
          }
          amountValue = String(amountCandidate);
        } catch (error) {
          rootLogger.warn(
            `Failed to stringify config-action spending-limit amount on ${chain}: ${stringifyUnknownSquadsError(error)}`,
          );
        }

        const mintValue = this.readConfigActionField(
          chain,
          'config action spending-limit mint',
          () => readPropertyOrThrow(action, 'mint'),
          undefined,
        );
        const membersValue = this.readConfigActionField(
          chain,
          'config action spending-limit members',
          () => readPropertyOrThrow(action, 'members'),
          [],
        );
        const destinationsValue = this.readConfigActionField(
          chain,
          'config action spending-limit destinations',
          () => readPropertyOrThrow(action, 'destinations'),
          [],
        );
        const vaultIndexValue = this.readConfigActionField(
          chain,
          'config action spending-limit vault index',
          () => readPropertyOrThrow(action, 'vaultIndex'),
          null,
        );

        type = 'AddSpendingLimit';
        args = {
          vaultIndex: vaultIndexValue,
          mint: this.formatAddressLikeForDisplay(
            chain,
            'config action spending-limit mint',
            mintValue,
          ),
          amount: amountValue,
          members: this.formatAddressLikeListForDisplay(
            chain,
            'config action spending-limit members',
            membersValue,
          ),
          destinations: this.formatAddressLikeListForDisplay(
            chain,
            'config action spending-limit destinations',
            destinationsValue,
          ),
        };
        insight = `Add spending limit for vault ${formatIntegerValidationValue(vaultIndexValue)}`;
      } else if (types.isConfigActionRemoveSpendingLimit(action)) {
        const spendingLimitValue = this.readConfigActionField(
          chain,
          'config action spending-limit address',
          () => readPropertyOrThrow(action, 'spendingLimit'),
          undefined,
        );
        type = 'RemoveSpendingLimit';
        const spendingLimit = this.formatAddressLikeForDisplay(
          chain,
          'config action spending-limit address',
          spendingLimitValue,
        );
        args = { spendingLimit };
        insight = `Remove spending limit ${spendingLimit}`;
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
    } catch (error) {
      rootLogger.warn(
        `Failed to format config action on ${chain}: ${stringifyUnknownSquadsError(error)}`,
      );
      return null;
    }
  }

  private readConfigActionField(
    chain: SquadsChainName,
    label: string,
    readValue: () => unknown,
    fallbackValue: unknown,
  ): unknown {
    try {
      return readValue();
    } catch (error) {
      rootLogger.warn(
        `Failed to read ${label} on ${chain}: ${stringifyUnknownSquadsError(error)}`,
      );
      return fallbackValue;
    }
  }

  private readProposalDataField(
    chain: SquadsChainName,
    label: string,
    readValue: () => unknown,
    fallbackValue: unknown,
  ): unknown {
    try {
      return readValue();
    } catch (error) {
      rootLogger.warn(
        `Failed to read ${label} on ${chain}: ${stringifyUnknownSquadsError(error)}`,
      );
      return fallbackValue;
    }
  }

  private readTransactionAccountData(
    chain: SquadsChainName,
    label: string,
    accountInfo: { data?: unknown },
  ): Buffer {
    const { propertyValue: dataValue, readError: dataReadError } =
      inspectPropertyValue(accountInfo, 'data');
    if (dataReadError) {
      throw new Error(
        `Failed to read ${label} data on ${chain}: ${stringifyUnknownSquadsError(dataReadError)}`,
      );
    }

    const {
      isBuffer: dataValueIsBuffer,
      readFailed: dataValueBufferReadFailed,
    } = inspectBufferValue(dataValue);
    if (!dataValueBufferReadFailed && dataValueIsBuffer) {
      return dataValue as Buffer;
    }
    const {
      matches: dataValueIsUint8Array,
      readFailed: dataValueUint8ArrayReadFailed,
    } = inspectInstanceOf(dataValue, Uint8Array);
    if (!dataValueUint8ArrayReadFailed && dataValueIsUint8Array) {
      return Buffer.from(dataValue as Uint8Array);
    }

    throw new Error(
      `Malformed ${label} data on ${chain}: expected bytes, got ${getUnknownValueTypeName(dataValue)}`,
    );
  }

  private tryResolveRemoteChainNameForDisplay(
    remoteDomain: unknown,
  ): string | null {
    if (!isNonNegativeSafeInteger(remoteDomain)) {
      return null;
    }

    let remoteChain: unknown;
    try {
      remoteChain = this.resolveChainNameForDomain(remoteDomain, 'chain alias');
    } catch (error) {
      const errorMessage = getErrorMessageFromErrorInstance(error);
      rootLogger.warn(
        errorMessage
          ? errorMessage
          : `Failed to resolve chain alias for domain ${remoteDomain}: ${stringifyUnknownSquadsError(error)}`,
      );
      return null;
    }

    if (remoteChain === null || typeof remoteChain === 'undefined') {
      return null;
    }

    try {
      return assertNonEmptyStringValue(
        remoteChain,
        `resolved chain alias for domain ${remoteDomain}`,
      );
    } catch (error) {
      rootLogger.warn(
        `Malformed chain alias for domain ${remoteDomain}: ${stringifyUnknownSquadsError(error)}`,
      );
      return null;
    }
  }

  private normalizeValidatorsForDisplay(
    chain: SquadsChainName,
    remoteDomainForDisplay: string,
    validators: unknown,
  ): string[] {
    try {
      const normalizedValidators = normalizeValidatorSet(validators);
      if (!normalizedValidators) {
        rootLogger.warn(
          `Malformed validator display set for ${chain} domain ${remoteDomainForDisplay}: expected array of non-empty strings`,
        );
        return [];
      }
      return normalizedValidators;
    } catch (error) {
      rootLogger.warn(
        `Failed to normalize validator display set for ${chain} domain ${remoteDomainForDisplay}: ${stringifyUnknownSquadsError(error)}`,
      );
      return [];
    }
  }

  private getWarpDisplayKey(chainName: unknown, domain: unknown): string {
    if (typeof chainName === 'string') {
      const normalizedChainName = chainName.trim();
      if (normalizedChainName.length > 0) {
        return normalizedChainName;
      }
    }
    return `domain ${formatIntegerValidationValue(domain)}`;
  }

  private normalizeWarpRouterValueForDisplay(router: unknown): string {
    if (typeof router !== 'string') {
      return 'unenrolled';
    }
    const normalizedRouter = router.trim();
    return normalizedRouter.length > 0 ? normalizedRouter : 'unenrolled';
  }

  private normalizeWarpGasValueForDisplay(gas: unknown): string {
    if (typeof gas === 'undefined' || gas === null) {
      return 'unset';
    }
    if (typeof gas === 'number' || typeof gas === 'bigint') {
      return `${gas}`;
    }
    if (typeof gas === 'string') {
      const normalizedGas = gas.trim();
      return normalizedGas.length > 0 ? normalizedGas : 'unset';
    }

    try {
      const normalizedGas = String(gas).trim();
      return normalizedGas.length > 0 ? normalizedGas : 'unset';
    } catch {
      return 'unset';
    }
  }

  private normalizeOptionalNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalizedValue = value.trim();
    return normalizedValue.length > 0 ? normalizedValue : null;
  }

  private formatAddressLikeForDisplay(
    chain: ChainName,
    label: string,
    value: unknown,
  ): string {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
      rootLogger.warn(
        `Malformed ${label} on ${chain}: expected object with toBase58()`,
      );
      return '[invalid address]';
    }

    let toBase58Value: unknown;
    const { propertyValue: toBase58Candidate, readError: toBase58ReadError } =
      inspectPropertyValue(value, 'toBase58');
    if (toBase58ReadError) {
      rootLogger.warn(
        `Failed to read ${label} toBase58 on ${chain}: ${stringifyUnknownSquadsError(toBase58ReadError)}`,
      );
      return '[invalid address]';
    }
    toBase58Value = toBase58Candidate;

    if (typeof toBase58Value !== 'function') {
      rootLogger.warn(
        `Malformed ${label} on ${chain}: missing toBase58() function`,
      );
      return '[invalid address]';
    }

    try {
      const normalizedValue = this.normalizeOptionalNonEmptyString(
        toBase58Value.call(value),
      );
      if (
        normalizedValue &&
        !isGenericObjectStringifiedValue(normalizedValue)
      ) {
        return normalizedValue;
      }
      if (normalizedValue && isGenericObjectStringifiedValue(normalizedValue)) {
        rootLogger.warn(
          `Malformed ${label} on ${chain}: toBase58() returned generic object label`,
        );
        return '[invalid address]';
      }
      rootLogger.warn(
        `Malformed ${label} on ${chain}: toBase58() returned empty value`,
      );
      return '[invalid address]';
    } catch (error) {
      rootLogger.warn(
        `Failed to format ${label} on ${chain}: ${stringifyUnknownSquadsError(error)}`,
      );
      return '[invalid address]';
    }
  }

  private formatAddressLikeListForDisplay(
    chain: ChainName,
    label: string,
    values: unknown,
  ): string[] {
    const { isArray: valuesAreArray, readFailed: valuesReadFailed } =
      inspectArrayValue(values);
    if (valuesReadFailed || !valuesAreArray) {
      rootLogger.warn(
        `Malformed ${label} on ${chain}: expected array, got ${getUnknownValueTypeName(values)}`,
      );
      return [];
    }
    try {
      return Array.from(values as readonly unknown[], (value, index) =>
        this.formatAddressLikeForDisplay(chain, `${label}[${index}]`, value),
      );
    } catch (error) {
      rootLogger.warn(
        `Failed to normalize ${label} on ${chain}: ${stringifyUnknownSquadsError(error)}`,
      );
      return [];
    }
  }

  private formatProgramIdForDisplay(programId: unknown): string {
    if (
      !programId ||
      (typeof programId !== 'object' && typeof programId !== 'function')
    ) {
      return '[invalid program id]';
    }

    const { propertyValue: toBase58Value, readError: toBase58ReadError } =
      inspectPropertyValue(programId, 'toBase58');
    if (toBase58ReadError) {
      return '[invalid program id]';
    }

    if (typeof toBase58Value !== 'function') {
      return '[invalid program id]';
    }

    try {
      const displayValue = toBase58Value.call(programId);
      const normalizedDisplayValue =
        this.normalizeOptionalNonEmptyString(displayValue);
      if (!normalizedDisplayValue) {
        return '[invalid program id]';
      }
      if (isGenericObjectStringifiedValue(normalizedDisplayValue)) {
        return '[invalid program id]';
      }
      return normalizedDisplayValue;
    } catch {
      return '[invalid program id]';
    }
  }

  private formatInstruction(
    chain: SquadsChainName,
    inst: ParsedInstruction,
  ): SquadsGovernTransaction {
    const instructionTypeValue = this.readParsedInstructionField(
      chain,
      'instruction type',
      () => readPropertyOrThrow(inst, 'instructionType'),
      undefined,
    );
    const programNameValue = this.readParsedInstructionField(
      chain,
      'instruction program name',
      () => readPropertyOrThrow(inst, 'programName'),
      undefined,
    );
    const programIdValue = this.readParsedInstructionField(
      chain,
      'instruction program id',
      () => readPropertyOrThrow(inst, 'programId'),
      undefined,
    );
    const insightValue = this.readParsedInstructionField(
      chain,
      'instruction insight',
      () => readPropertyOrThrow(inst, 'insight'),
      undefined,
    );
    const dataValue = this.readParsedInstructionField(
      chain,
      'instruction data',
      () => readPropertyOrThrow(inst, 'data'),
      undefined,
    );

    const instructionTypeForDisplay =
      this.normalizeOptionalNonEmptyString(instructionTypeValue) ??
      InstructionType.UNKNOWN;
    const programNameForDisplay =
      this.normalizeOptionalNonEmptyString(programNameValue) ??
      ProgramName.UNKNOWN;
    const to = `${programNameForDisplay} (${this.formatProgramIdForDisplay(programIdValue)})`;
    const normalizedInsight =
      this.normalizeOptionalNonEmptyString(insightValue);
    const tx: SquadsGovernTransaction = {
      chain,
      to,
      type: instructionTypeForDisplay,
      insight: normalizedInsight ?? `${instructionTypeForDisplay} instruction`,
    };

    switch (instructionTypeForDisplay) {
      case SealevelMultisigIsmInstructionName[
        SealevelMultisigIsmInstructionType.SET_VALIDATORS_AND_THRESHOLD
      ]: {
        const data = dataValue as MultisigSetValidatorsData;
        const domainValue = this.readProposalDataField(
          chain,
          'multisig domain',
          () => readPropertyOrThrow(data, 'domain'),
          undefined,
        );
        const thresholdValue = this.readProposalDataField(
          chain,
          'multisig threshold',
          () => readPropertyOrThrow(data, 'threshold'),
          undefined,
        );
        const validatorsValue = this.readProposalDataField(
          chain,
          'multisig validators',
          () => readPropertyOrThrow(data, 'validators'),
          undefined,
        );

        const remoteDomainForDisplay =
          formatIntegerValidationValue(domainValue);
        const validatorsForDisplay = this.normalizeValidatorsForDisplay(
          chain,
          remoteDomainForDisplay,
          validatorsValue,
        );
        const remoteChain =
          this.tryResolveRemoteChainNameForDisplay(domainValue);
        const validatorsWithAliases = remoteChain
          ? formatValidatorsWithAliases(remoteChain, validatorsForDisplay)
          : validatorsForDisplay;

        tx.args = {
          domain: domainValue,
          threshold: thresholdValue,
          validators: validatorsWithAliases,
        };

        const verification = this.verifyConfiguration(
          chain,
          domainValue,
          thresholdValue,
          validatorsValue,
        );

        const chainInfo = remoteChain
          ? `${remoteChain} (${remoteDomainForDisplay})`
          : remoteDomainForDisplay;

        tx.insight = verification.matches
          ? `✅ matches expected config for ${chainInfo}`
          : `❌ fatal mismatch: ${verification.issues.join(', ')}`;
        break;
      }

      case SealevelMailboxInstructionName[
        SealevelMailboxInstructionType.INBOX_SET_DEFAULT_ISM
      ]: {
        const data = dataValue as MailboxSetDefaultIsmData;
        const moduleValue = this.readProposalDataField(
          chain,
          'mailbox default ISM',
          () => readPropertyOrThrow(data, 'newDefaultIsm'),
          null,
        );
        tx.args = {
          module: this.normalizeOptionalNonEmptyString(moduleValue),
        };
        break;
      }

      case SealevelMailboxInstructionName[
        SealevelMailboxInstructionType.TRANSFER_OWNERSHIP
      ]:
      case SealevelMultisigIsmInstructionName[
        SealevelMultisigIsmInstructionType.TRANSFER_OWNERSHIP
      ]: {
        const data = dataValue as OwnershipTransferData;
        const newOwnerValue = this.readProposalDataField(
          chain,
          'ownership transfer target',
          () => readPropertyOrThrow(data, 'newOwner'),
          undefined,
        );
        tx.args = {
          newOwner: this.normalizeOptionalNonEmptyString(newOwnerValue),
        };
        break;
      }

      case SquadsInstructionName[SquadsInstructionType.ADD_MEMBER]: {
        const data = dataValue as SquadsAddMemberData;
        const memberValue = this.readProposalDataField(
          chain,
          'squads add-member target',
          () => readPropertyOrThrow(data, 'newMember'),
          undefined,
        );
        const permissionsValue = this.readProposalDataField(
          chain,
          'squads add-member permissions',
          () => readPropertyOrThrow(data, 'permissions'),
          undefined,
        );
        let permissionsMaskValue: unknown;
        if (isRecordObject(permissionsValue)) {
          const { propertyValue, readError } = inspectPropertyValue(
            permissionsValue,
            'mask',
          );
          if (readError) {
            rootLogger.warn(
              `Failed to read squads add-member permission mask on ${chain}: ${stringifyUnknownSquadsError(readError)}`,
            );
            permissionsMaskValue = undefined;
          } else {
            permissionsMaskValue = propertyValue;
          }
        } else {
          permissionsMaskValue = undefined;
        }
        let decodedPermissions = 'Unknown';
        if (typeof permissionsMaskValue !== 'undefined') {
          try {
            decodedPermissions = decodePermissions(permissionsMaskValue);
          } catch (error) {
            rootLogger.warn(
              `Failed to decode squads add-member permissions on ${chain}: ${stringifyUnknownSquadsError(error)}`,
            );
          }
        }
        tx.args = {
          member: this.normalizeOptionalNonEmptyString(memberValue),
          permissions: {
            mask:
              typeof permissionsMaskValue === 'undefined'
                ? null
                : permissionsMaskValue,
            decoded: decodedPermissions,
          },
        };
        break;
      }

      case SquadsInstructionName[SquadsInstructionType.REMOVE_MEMBER]: {
        const data = dataValue as SquadsRemoveMemberData;
        const memberValue = this.readProposalDataField(
          chain,
          'squads remove-member target',
          () => readPropertyOrThrow(data, 'memberToRemove'),
          undefined,
        );
        tx.args = { member: this.normalizeOptionalNonEmptyString(memberValue) };
        break;
      }

      case SquadsInstructionName[SquadsInstructionType.CHANGE_THRESHOLD]: {
        const data = dataValue as SquadsChangeThresholdData;
        const thresholdValue = this.readProposalDataField(
          chain,
          'squads threshold change',
          () => readPropertyOrThrow(data, 'newThreshold'),
          undefined,
        );
        tx.args = {
          newThreshold:
            typeof thresholdValue === 'number' ? thresholdValue : null,
        };
        break;
      }

      case SealevelHypTokenInstructionName[
        SealevelHypTokenInstruction.EnrollRemoteRouter
      ]: {
        const data = dataValue as WarpEnrollRemoteRouterData;
        const domainValue = this.readProposalDataField(
          chain,
          'warp enroll-router domain',
          () => readPropertyOrThrow(data, 'domain'),
          undefined,
        );
        const chainNameValue = this.readProposalDataField(
          chain,
          'warp enroll-router chain alias',
          () => readPropertyOrThrow(data, 'chainName'),
          undefined,
        );
        const routerValue = this.readProposalDataField(
          chain,
          'warp enroll-router router',
          () => readPropertyOrThrow(data, 'router'),
          undefined,
        );

        tx.args = {
          [this.getWarpDisplayKey(chainNameValue, domainValue)]:
            this.normalizeWarpRouterValueForDisplay(routerValue),
        };
        break;
      }

      case SealevelHypTokenInstructionName[
        SealevelHypTokenInstruction.EnrollRemoteRouters
      ]: {
        const data = dataValue as WarpEnrollRemoteRoutersData;
        const routers: Record<string, string> = {};
        const routersCandidate = this.readProposalDataField(
          chain,
          'warp enroll-routers configs',
          () => readPropertyOrThrow(data, 'routers'),
          undefined,
        );
        const { isArray: routersAreArray, readFailed: routersReadFailed } =
          inspectArrayValue(routersCandidate);
        const normalizedRouters =
          !routersReadFailed && routersAreArray
            ? this.normalizeVaultArrayField(
                chain,
                'warp enroll-routers configs',
                routersCandidate as readonly unknown[],
              )
            : [];
        for (const [index, router] of normalizedRouters.entries()) {
          if (!isRecordObject(router)) {
            rootLogger.warn(
              `Skipping malformed warp enroll-router config at index ${index} on ${chain}: expected object, got ${getUnknownValueTypeName(router)}`,
            );
            continue;
          }

          const {
            propertyValue: chainNameValue,
            readError: chainNameReadError,
          } = inspectPropertyValue(router, 'chainName');
          if (chainNameReadError) {
            rootLogger.warn(
              `Failed to read warp enroll-router chain alias at index ${index} on ${chain}: ${stringifyUnknownSquadsError(chainNameReadError)}`,
            );
            continue;
          }

          const { propertyValue: domainValue, readError: domainReadError } =
            inspectPropertyValue(router, 'domain');
          if (domainReadError) {
            rootLogger.warn(
              `Failed to read warp enroll-router domain at index ${index} on ${chain}: ${stringifyUnknownSquadsError(domainReadError)}`,
            );
            continue;
          }

          const { propertyValue: routerValue, readError: routerReadError } =
            inspectPropertyValue(router, 'router');
          if (routerReadError) {
            rootLogger.warn(
              `Failed to read warp enroll-router address at index ${index} on ${chain}: ${stringifyUnknownSquadsError(routerReadError)}`,
            );
            continue;
          }

          routers[this.getWarpDisplayKey(chainNameValue, domainValue)] =
            this.normalizeWarpRouterValueForDisplay(routerValue);
        }
        tx.args = routers;
        break;
      }

      case SealevelHypTokenInstructionName[
        SealevelHypTokenInstruction.SetDestinationGasConfigs
      ]: {
        const data = dataValue as WarpSetDestinationGasConfigsData;
        const gasConfigs: Record<string, string> = {};
        const configsCandidate = this.readProposalDataField(
          chain,
          'warp gas configs',
          () => readPropertyOrThrow(data, 'configs'),
          undefined,
        );

        const { isArray: configsAreArray, readFailed: configsReadFailed } =
          inspectArrayValue(configsCandidate);
        const normalizedGasConfigs =
          !configsReadFailed && configsAreArray
            ? this.normalizeVaultArrayField(
                chain,
                'warp gas configs',
                configsCandidate as readonly unknown[],
              )
            : [];
        for (const [index, config] of normalizedGasConfigs.entries()) {
          if (!isRecordObject(config)) {
            rootLogger.warn(
              `Skipping malformed warp gas config at index ${index} on ${chain}: expected object, got ${getUnknownValueTypeName(config)}`,
            );
            continue;
          }

          const {
            propertyValue: chainNameValue,
            readError: chainNameReadError,
          } = inspectPropertyValue(config, 'chainName');
          if (chainNameReadError) {
            rootLogger.warn(
              `Failed to read warp gas chain alias at index ${index} on ${chain}: ${stringifyUnknownSquadsError(chainNameReadError)}`,
            );
            continue;
          }

          const { propertyValue: domainValue, readError: domainReadError } =
            inspectPropertyValue(config, 'domain');
          if (domainReadError) {
            rootLogger.warn(
              `Failed to read warp gas domain at index ${index} on ${chain}: ${stringifyUnknownSquadsError(domainReadError)}`,
            );
            continue;
          }

          const { propertyValue: gasValue, readError: gasReadError } =
            inspectPropertyValue(config, 'gas');
          if (gasReadError) {
            rootLogger.warn(
              `Failed to read warp gas value at index ${index} on ${chain}: ${stringifyUnknownSquadsError(gasReadError)}`,
            );
            continue;
          }

          gasConfigs[this.getWarpDisplayKey(chainNameValue, domainValue)] =
            this.normalizeWarpGasValueForDisplay(gasValue);
        }
        tx.args = gasConfigs;
        break;
      }

      case SealevelHypTokenInstructionName[
        SealevelHypTokenInstruction.SetInterchainSecurityModule
      ]: {
        const data = dataValue as WarpSetIsmData;
        const ismValue = this.readProposalDataField(
          chain,
          'warp ISM value',
          () => readPropertyOrThrow(data, 'ism'),
          undefined,
        );
        tx.args = { ism: this.normalizeOptionalNonEmptyString(ismValue) };
        break;
      }

      case SealevelHypTokenInstructionName[
        SealevelHypTokenInstruction.SetInterchainGasPaymaster
      ]: {
        const data = dataValue as WarpSetIgpData;
        const igpValue = this.readProposalDataField(
          chain,
          'warp IGP value',
          () => readPropertyOrThrow(data, 'igp'),
          undefined,
        );
        tx.args = isRecordObject(igpValue) ? igpValue : { igp: null };
        break;
      }

      case SealevelHypTokenInstructionName[
        SealevelHypTokenInstruction.TransferOwnership
      ]: {
        const data = dataValue as OwnershipTransferData;
        const newOwnerValue = this.readProposalDataField(
          chain,
          'warp ownership transfer target',
          () => readPropertyOrThrow(data, 'newOwner'),
          undefined,
        );
        tx.args = {
          newOwner: this.normalizeOptionalNonEmptyString(newOwnerValue),
        };
        break;
      }
    }

    return tx;
  }

  private readParsedInstructionField(
    chain: SquadsChainName,
    label: string,
    readValue: () => unknown,
    fallbackValue: unknown,
  ): unknown {
    try {
      return readValue();
    } catch (error) {
      rootLogger.warn(
        `Failed to read ${label} on ${chain}: ${stringifyUnknownSquadsError(error)}`,
      );
      return fallbackValue;
    }
  }
}
