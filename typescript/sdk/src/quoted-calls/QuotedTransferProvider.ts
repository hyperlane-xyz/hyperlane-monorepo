import type { ProtocolType } from '@hyperlane-xyz/provider-sdk';

import type { IToken } from '../token/IToken.js';
import type { TokenAmount } from '../token/TokenAmount.js';
import type { ChainNameOrId } from '../types.js';
import type { WarpCore } from '../warp/WarpCore.js';
import type { WarpTypedTransaction } from '../warp/types.js';

/**
 * Protocol-agnostic abstraction over a warp transfer that consumes signed
 * offchain quotes. Each protocol provides its own implementation:
 *
 *  - EVM (`EvmQuotedTransferProvider`): builds an atomic
 *    `QuotedCalls.execute()` calldata against the on-chain wrapper contract.
 *  - Sealevel (`SealevelQuotedTransferProvider`): composes a single tx that
 *    prepends `SubmitFeeQuote` (+ optional `SubmitIgpQuote`) instructions
 *    onto the adapter's `transferRemote` / `transferRemoteTo` instructions.
 *
 * `WarpCore.getTransferRemoteTxs` invokes `buildQuotedTransferTxs` whenever a
 * provider is supplied and dispatches with a single protocol-agnostic call —
 * no per-VM branching in WarpCore itself.
 */
export interface QuotedTransferProvider {
  readonly protocol: ProtocolType;

  buildQuotedTransferTxs(args: {
    warpCore: WarpCore;
    originTokenAmount: TokenAmount<IToken>;
    destination: ChainNameOrId;
    sender: string;
    recipient: string;
    destinationToken?: IToken;
  }): Promise<Array<WarpTypedTransaction>>;
}
