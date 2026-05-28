import type { Result } from '@ethersproject/abi';
import type {
  MetaTransactionData,
  OperationType,
} from '@safe-global/safe-core-sdk-types';
import { BigNumber, ethers } from 'ethers';

import { AnnotatedEV5Transaction, ChainName } from '@hyperlane-xyz/sdk';
import { Address, eqAddress } from '@hyperlane-xyz/utils';

import { awIcasLegacy } from '../../../config/environments/mainnet3/governance/ica/_awLegacy.js';
import { regularIcasLegacy } from '../../../config/environments/mainnet3/governance/ica/_regularLegacy.js';
import { Owner, determineGovernanceType } from '../../governance.js';
import { GovernanceType } from '../../governanceTypes.js';
export function formatFunctionFragmentArgs(
  args: Result,
  fragment: ethers.utils.FunctionFragment,
): Record<string, any> {
  const accumulator: Record<string, any> = {};
  return fragment.inputs.reduce((acc, input, index) => {
    acc[input.name] = args[index];
    return acc;
  }, accumulator);
}

export function formatDomain(
  getChainName: (domain: number) => string | undefined,
  domain: number | BigNumber,
): string {
  const domainNumber = BigNumber.isBigNumber(domain)
    ? domain.toNumber()
    : domain;
  const chainName = getChainName(domainNumber);
  return chainName ? `${domainNumber} (${chainName})` : `${domainNumber}`;
}

export function matchesFunctionSignature(
  decoded: ethers.utils.TransactionDescription,
  iface: ethers.utils.Interface,
  signature: string,
): boolean {
  try {
    return decoded.sighash === iface.getSighash(signature);
  } catch {
    return false;
  }
}

export async function getOwnerInsight(
  chain: ChainName,
  address: Address,
): Promise<string> {
  const { ownerType, governanceType } = await determineGovernanceType(
    chain,
    address,
  );
  if (ownerType !== Owner.UNKNOWN) {
    return `${address} (${governanceType.toUpperCase()} ${ownerType})`;
  }

  if (awIcasLegacy[chain] && eqAddress(address, awIcasLegacy[chain])) {
    return `${address} (${GovernanceType.AbacusWorks.toUpperCase()} ${Owner.ICA} LEGACY)`;
  }

  if (
    regularIcasLegacy[chain] &&
    eqAddress(address, regularIcasLegacy[chain])
  ) {
    return `${address} (${GovernanceType.Regular.toUpperCase()} ${Owner.ICA} LEGACY)`;
  }

  return `${address} (Unknown)`;
}

export function metaTransactionDataToEV5Transaction(
  metaTransactionData: MetaTransactionData,
): AnnotatedEV5Transaction {
  return {
    to: metaTransactionData.to,
    value: BigNumber.from(metaTransactionData.value),
    data: metaTransactionData.data,
  };
}

export function formatOperationType(
  operation: OperationType | undefined,
): string {
  switch (operation) {
    case 0:
      return 'Call';
    case 1:
      return 'Delegate Call';
    default:
      return '⚠️ Unknown ⚠️';
  }
}

const SENSITIVE_PATTERNS = [
  /https?:\/\/\S+/gi,
  /Bearer\s+\S+/gi,
  /(?:api_key|secret|token|key|password)=\S+/gi,
];

function sanitizeErrorMessage(msg: string): string {
  let sanitized = msg;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized.slice(0, 120);
}

export function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    const prefix = typeof code === 'string' ? `[${code}] ` : '';
    return `${prefix}${sanitizeErrorMessage(error.message)}`;
  }
  return 'unknown error';
}

const RECOVERABLE_NESTED_DECODE_ERROR_CODES = new Set([
  'CALL_EXCEPTION',
  'INVALID_ARGUMENT',
  'NETWORK_ERROR',
  'SERVER_ERROR',
  'TIMEOUT',
]);

export function isRecoverableNestedDecodeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const code = (error as Error & { code?: unknown }).code;
  if (
    typeof code === 'string' &&
    RECOVERABLE_NESTED_DECODE_ERROR_CODES.has(code)
  ) {
    return true;
  }

  return /no matching function|invalid sighash|data signature|no data in|failed to decode|could not decode/i.test(
    error.message,
  );
}
