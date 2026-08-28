import type { providers } from 'ethers';
import type { Logger } from 'pino';

import type { ChainName, MultiProtocolCore } from '@hyperlane-xyz/sdk';
import type { Address, Domain } from '@hyperlane-xyz/utils';

export interface MCRExecutionContext {
  origin: ChainName;
  destination: ChainName;
  originDomain: Domain;
  destinationDomain: Domain;
  bridge: string;
  sourceEid?: number;
  destinationEid?: number;
  sourceOft?: Address;
  destinationOft?: Address;
  destinationRecipient?: Address;
  sourceTokenDecimals?: number;
  destinationTokenDecimals?: number;
  minimumDestinationAmount?: bigint;
  receipt: providers.TransactionReceipt;
}

/** Adapter-owned, JSON-serializable settlement cursor stored on an action. */
export interface MCRStatusRef {
  provider: string;
  kind: string;
  data: Record<string, unknown>;
}

export type MCRSettlementStatus =
  | { status: 'pending'; substatus?: string; ref?: MCRStatusRef }
  | {
      status: 'complete';
      receivingTxHash?: string;
      ref?: MCRStatusRef;
    }
  | { status: 'failed'; error?: string; ref?: MCRStatusRef }
  | { status: 'not_found'; ref?: MCRStatusRef };

export interface MCRStatusPollContext {
  core: MultiProtocolCore;
  destination: Domain;
  blockTag?: string | number;
}

/** Verifies destination settlement for one movable-collateral bridge kind. */
export interface ITokenBridgeStatusAdapter {
  readonly kind: string;
  readonly logger: Logger;

  initFromReceipt(ctx: MCRExecutionContext): Promise<MCRStatusRef | null>;

  pollStatus(
    ref: MCRStatusRef,
    ctx: MCRStatusPollContext,
  ): Promise<MCRSettlementStatus>;
}

export type StatusAdaptersByKind = Map<string, ITokenBridgeStatusAdapter>;
