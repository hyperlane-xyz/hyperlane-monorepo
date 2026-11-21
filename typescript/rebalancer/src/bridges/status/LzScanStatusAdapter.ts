import type { Logger } from 'pino';

import { TokenBridgeStatusAdapterType } from '../../config/types.js';
import type {
  ITokenBridgeStatusAdapter,
  MCRExecutionContext,
  MCRSettlementStatus,
  MCRStatusPollContext,
  MCRStatusRef,
} from '../../interfaces/ITokenBridgeStatusAdapter.js';
import {
  OftSettlementVerifier,
  type OftSettlementVerifierOptions,
} from '../OftSettlementVerifier.js';

export { normalizeTxHash } from '../OftSettlementVerifier.js';
export type LzScanStatusAdapterOptions = OftSettlementVerifierOptions;

/** Adapts the shared OFT proof checks to movable-collateral tracking. */
export class LzScanStatusAdapter implements ITokenBridgeStatusAdapter {
  readonly kind = TokenBridgeStatusAdapterType.LayerZeroScan;
  readonly logger: Logger;
  private readonly verifier: OftSettlementVerifier;

  constructor(options: LzScanStatusAdapterOptions) {
    this.logger = options.logger;
    this.verifier = new OftSettlementVerifier(options);
  }

  initFromReceipt(ctx: MCRExecutionContext): Promise<MCRStatusRef> {
    return this.verifier.initFromReceipt(ctx);
  }

  pollStatus(
    ref: MCRStatusRef,
    ctx: MCRStatusPollContext,
  ): Promise<MCRSettlementStatus> {
    const chain = ctx.core.multiProvider.getChainName(ctx.destination);
    return this.verifier.pollStatus(ref, {
      provider: ctx.core.multiProvider.getEthersV5Provider(chain),
      blocks: ctx.core.metadata(chain).blocks,
      blockTag: ctx.blockTag,
    });
  }
}
