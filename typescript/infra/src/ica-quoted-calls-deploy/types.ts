import type { BigNumber } from 'ethers';

import type { ChainAddresses } from '@hyperlane-xyz/registry';
import type {
  ChainMap,
  ChainName,
  ContractVerificationInput,
  ContractVerifier,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import type { Address, Logger } from '@hyperlane-xyz/utils';

import type { IcaExportStore, RegistryBefore } from './export.js';

// First package version whose ICA router and QuotedCalls quote and dispatch
// ERC20 fee-token calls consistently. The checkout is the 12.2.0 release for
// both contracts, so every build reporting 12.2.0 or later contains the fix.
export const PAIR_VERSION = '12.2.0';

// Matches the COMMIT_TX_GAS_USAGE of the deployed production routers.
export const COMMIT_TX_GAS_USAGE = 50_000;

// Expected spend is padded because fees move between planning and sending.
export const COST_MARGIN_PERCENT = 130;

export const IcaOutcome = {
  Skipped: 'skipped',
  UpToDate: 'up-to-date',
  Planned: 'planned',
  Applied: 'applied',
  InsufficientFunds: 'insufficient-funds',
  Error: 'error',
} as const;
export type IcaOutcome = (typeof IcaOutcome)[keyof typeof IcaOutcome];

export const SkipReason = {
  NotStandardEvm: 'not-standard-evm',
  NoMailbox: 'no-mailbox',
} as const;
export type SkipReason = (typeof SkipReason)[keyof typeof SkipReason];

export const Adoption = {
  Adopt: 'adopt',
  Deploy: 'deploy',
} as const;
export type Adoption = (typeof Adoption)[keyof typeof Adoption];

export const ContractKind = {
  Router: 'router',
  QuotedCalls: 'quotedCalls',
} as const;
export type ContractKind = (typeof ContractKind)[keyof typeof ContractKind];

export const CandidateSource = {
  Registry: 'registry',
  Export: 'export',
  Pending: 'pending',
} as const;
export type CandidateSource =
  (typeof CandidateSource)[keyof typeof CandidateSource];

export interface PeerDomain {
  chain: ChainName;
  domainId: number;
}

export interface RouterCandidate {
  address: Address;
  source: CandidateSource;
  version: string;
  owner: Address;
  mailbox: Address;
  hook: Address;
}

export interface QuotedCallsCandidate {
  address: Address;
  source: CandidateSource;
  version: string;
  permit2: Address;
}

export interface Rejection {
  address: Address;
  source: CandidateSource;
  reason: string;
}

export type Selection<Candidate> =
  | { kind: typeof Adoption.Adopt; candidate: Candidate }
  | { kind: typeof Adoption.Deploy; rejected: Rejection[] };

export interface ShadowHook {
  address: Address;
  problem?: string;
}

export interface FeeToken {
  symbol: string;
  address: Address;
}

export interface TokenAllowance {
  token: FeeToken;
  spender: Address;
  allowance: BigNumber;
}

export interface Fees {
  gasPrice: BigNumber;
  maxFeePerGas: BigNumber;
}

export interface GasStep {
  name: string;
  gas: BigNumber;
  l1Fee: BigNumber;
}

export interface FundsReport {
  balance: BigNumber;
  expected: BigNumber;
  worstCase: BigNumber;
  required: BigNumber;
  shortfall: BigNumber;
  steps: GasStep[];
  l1FeeUnavailable: boolean;
}

export interface WiringPlan {
  setHook?: Address;
  approvals: TokenAllowance[];
  enroll: Array<{ peer: PeerDomain; router: Address }>;
  awaiting: ChainName[];
  conflicts: string[];
  transferOwnershipTo?: Address;
  notes: string[];
}

export interface DeployedState {
  address?: Address;
  action: Adoption;
  version?: string;
  deployed?: boolean;
}

export interface ChainResult {
  chain: ChainName;
  outcome: IcaOutcome;
  skipReason?: SkipReason;
  detail?: string;
  signer?: Address;
  owner?: Address;
  router?: DeployedState;
  quotedCalls?: DeployedState;
  rejected: Rejection[];
  hook?: Address;
  funds?: FundsReport;
  gasSymbol?: string;
  wiring?: WiringPlan;
  enrolledPeers: ChainName[];
  approved: string[];
  registryKeysWritten: string[];
  registryBefore?: RegistryBefore;
  pending: string[];
  notes: string[];
  problems: string[];
}

export interface IcaPersistence {
  exportStore: IcaExportStore;
  writeRegistryAddresses(chain: ChainName, addresses: ChainAddresses): void;
  writeVerificationInputs(
    chain: ChainName,
    inputs: ContractVerificationInput[],
  ): Promise<void>;
}

export interface IcaContext {
  apply: boolean;
  multiProvider: MultiProvider;
  chains: ChainName[];
  chainAddresses: ChainMap<ChainAddresses>;
  // Signer address for read-only planning; with --apply the connected signer is used.
  planningSigner: Address;
  owner?: Address;
  feeTokens: ChainMap<FeeToken[]>;
  persist: IcaPersistence;
  writeRegistry: boolean;
  contractVerifier?: ContractVerifier;
  readShadowHook: (chain: ChainName) => Promise<Address | undefined>;
  redact: (text: string) => string;
  concurrency: number;
  logger: Logger;
  now: () => string;
}
