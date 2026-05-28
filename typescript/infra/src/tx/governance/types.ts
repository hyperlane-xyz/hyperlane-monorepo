import type {
  AnnotatedEV5Transaction,
  ChainMap,
  ChainName,
  CoreConfig,
  MultiProvider,
  TokenStandard,
  WarpCoreConfig,
} from '@hyperlane-xyz/sdk';

import type { Address } from '@hyperlane-xyz/utils';

import type { DeployEnvironment } from '../../config/deploy-environment.js';
import type { GovernanceType } from '../../governanceTypes.js';

export interface GovernTransaction extends Record<string, any> {
  chain: ChainName;
  nestedTx?: GovernTransaction;
}

export type XERC20Metadata = {
  type: TokenStandard.EvmHypXERC20 | TokenStandard.EvmHypVSXERC20;
  symbol: string;
  name: string;
  decimals: number;
};

export interface GovernanceDecoderState {
  environment: DeployEnvironment;
  multiProvider: MultiProvider;
  chainAddresses: ChainMap<Record<string, string>>;
  coreConfig: ChainMap<CoreConfig>;
  safes: ChainMap<string>;
  icas: ChainMap<string>;
  legacyIcas: ChainMap<string>;
  timelocks: ChainMap<string>;
  warpRouteIndex: ChainMap<Record<string, WarpCoreConfig['tokens'][number]>>;
  multiSendCallOnlyDeployments: Address[];
  multiSendDeployments: Address[];
  xerc20Deployments: ChainMap<Record<Address, XERC20Metadata>>;
  diagnostics: DiagnosticCollector;
  createReader(
    environment: DeployEnvironment,
    governanceType: GovernanceType,
  ): Promise<{
    read(
      chain: ChainName,
      tx: AnnotatedEV5Transaction,
    ): Promise<GovernTransaction>;
    diagnostics: DiagnosticCollector;
  }>;
}

type DiagnosticSeverity = 'fatal' | 'warning';

export interface GovernanceDecodeDiagnostic {
  severity: DiagnosticSeverity;
  info: string;
  [key: string]: unknown;
}

export class DiagnosticCollector {
  private readonly diagnostics: GovernanceDecodeDiagnostic[] = [];

  addFatal(diagnostic: Record<string, unknown> & { info: string }) {
    this.add('fatal', diagnostic);
  }

  addWarning(diagnostic: Record<string, unknown> & { info: string }) {
    this.add('warning', diagnostic);
  }

  merge(other: DiagnosticCollector) {
    this.diagnostics.push(...other.all);
  }

  get all(): GovernanceDecodeDiagnostic[] {
    return [...this.diagnostics];
  }

  get fatal(): GovernanceDecodeDiagnostic[] {
    return this.diagnostics.filter(({ severity }) => severity === 'fatal');
  }

  get warnings(): GovernanceDecodeDiagnostic[] {
    return this.diagnostics.filter(({ severity }) => severity === 'warning');
  }

  private add(
    severity: DiagnosticSeverity,
    diagnostic: Record<string, unknown> & { info: string },
  ): void {
    this.diagnostics.push({
      severity,
      ...diagnostic,
    });
  }
}

export interface GovernanceDecoderRuntime {
  read(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<GovernTransaction>;
  isOwnableTransaction(tx: AnnotatedEV5Transaction): Promise<boolean>;
  readOwnableTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<GovernTransaction>;
}

export interface DecodeContext {
  chain: ChainName;
  tx: AnnotatedEV5Transaction;
  runtime: GovernanceDecoderRuntime;
  state: GovernanceDecoderState;
}

export interface MatchedDecodeContext<TMatch> extends DecodeContext {
  match: TMatch;
}

export interface GovernanceDecoder<TMatch = true> {
  id: string;
  priority: number;
  match(
    context: DecodeContext,
  ): TMatch | undefined | Promise<TMatch | undefined>;
  decode(context: MatchedDecodeContext<TMatch>): Promise<GovernTransaction>;
}
