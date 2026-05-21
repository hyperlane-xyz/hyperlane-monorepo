import type { Address, Hex } from 'viem';
import { isAddress, isHex } from 'viem';

import {
  ProtocolType,
  addressToBytes32,
  assert,
  isEVMLike,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { IToken } from '../token/IToken.js';
import { Token } from '../token/Token.js';
import { TokenAmount } from '../token/TokenAmount.js';
import { TOKEN_STANDARD_TO_PROVIDER_TYPE } from '../token/TokenStandard.js';
import { ChainNameOrId } from '../types.js';
import type { WarpCore } from '../warp/WarpCore.js';
import { resolveDestinationToken } from '../warp/resolveDestinationToken.js';
import { WarpTxCategory, WarpTypedTransaction } from '../warp/types.js';

import { buildExecuteCalldata, buildQuoteCalldata } from './builder.js';
import {
  Quote,
  decodeQuoteExecuteResult,
  extractQuoteTotals,
} from './codec.js';
import type { QuotedTransferProvider } from './QuotedTransferProvider.js';
import { QuotedCallsParams, TokenPullMode } from './types.js';

/** Narrow a string to viem's Address (0x + 40 hex chars). Fails fast otherwise. */
function toAddress(s: string, msg: string): Address {
  assert(isAddress(s), `${msg}: ${s}`);
  return s;
}

/** Narrow a string to viem's Hex. Fails fast otherwise. */
function toHex(s: string, msg: string): Hex {
  assert(isHex(s), `${msg}: ${s}`);
  return s;
}

/**
 * EVM implementation of `QuotedTransferProvider`. Wraps the on-chain
 * `QuotedCalls` contract: signed quotes + token pull + transferRemote + sweep
 * are encoded into a single atomic `execute()` calldata.
 *
 * The body of this class is the EVM-specific logic previously inlined in
 * `WarpCore.getQuotedCallsTransferTxs` + `WarpCore.resolveQuotedCallsParams` +
 * `WarpCore.getQuotedTransferFee`. WarpCore now dispatches through the
 * `QuotedTransferProvider` interface, with this class handling all EVM
 * concerns.
 */
export class EvmQuotedTransferProvider implements QuotedTransferProvider {
  readonly protocol = ProtocolType.Ethereum;

  constructor(private readonly params: QuotedCallsParams) {}

  /**
   * Fee-quoting eth_call. Returns structured fee data (matching
   * `getInterchainTransferFee` shape) plus the raw per-command quotes that
   * `buildQuotedTransferTxs` needs.
   */
  async getQuotedTransferFee({
    warpCore,
    originTokenAmount,
    destination,
    sender,
    recipient,
    destinationToken,
  }: {
    warpCore: WarpCore;
    originTokenAmount: TokenAmount<IToken>;
    destination: ChainNameOrId;
    sender: string;
    recipient: string;
    destinationToken?: IToken;
  }): Promise<{
    igpQuote: TokenAmount<IToken>;
    tokenFeeQuote?: TokenAmount<IToken>;
    /** Raw per-command quotes — pass via params.feeQuotes to skip re-quoting. */
    feeQuotes: Quote[][];
  }> {
    assert(isAddress(sender), `Invalid EVM sender address: ${sender}`);
    assert(isAddress(recipient), `Invalid EVM recipient address: ${recipient}`);

    const { token: originToken } = originTokenAmount;
    const originName = originToken.chainName;

    const transferParams = this.resolveExecuteParams({
      warpCore,
      originTokenAmount,
      destination,
      recipient,
      destinationToken,
    });

    const quoteTx = buildQuoteCalldata(transferParams);
    const provider = warpCore.multiProvider.getEthersV5Provider(originName);
    const quoteResult = await provider.call({
      to: quoteTx.to,
      data: quoteTx.data,
      from: sender,
    });
    const feeQuotes = decodeQuoteExecuteResult(
      toHex(quoteResult, 'quoteExecute eth_call returned non-hex result'),
    );
    const { nativeValue, tokenTotals } = extractQuoteTotals(feeQuotes);

    // For native routes, quoteTransferRemote includes the transfer amount in
    // the native quotes, so we subtract it to get the fee-only portion.
    const isNativeRoute = isZeroishAddress(transferParams.token);
    const nativeToken = Token.FromChainMetadataNativeToken(
      warpCore.multiProvider.getChainMetadata(originName),
    );
    const igpFeeOnly = isNativeRoute
      ? nativeValue - originTokenAmount.amount
      : nativeValue;
    const igpQuote = new TokenAmount(igpFeeOnly, nativeToken);

    const tokenKey = toAddress(
      transferParams.token.toLowerCase(),
      'token address lowercase narrowing failed',
    );
    assert(
      tokenTotals.size <= 1,
      `Unexpected multi-token fee quotes: ${[...tokenTotals.keys()].join(', ')}`,
    );
    let tokenFeeQuote: TokenAmount<IToken> | undefined;
    const totalTokenQuoted = tokenTotals.get(tokenKey);
    if (totalTokenQuoted != null) {
      const feeOnly = totalTokenQuoted - originTokenAmount.amount;
      assert(
        feeOnly >= 0n,
        `Token fee quote underflow: quoted ${totalTokenQuoted} < amount ${originTokenAmount.amount}`,
      );
      if (feeOnly > 0n) {
        tokenFeeQuote = new TokenAmount(feeOnly, originToken);
      }
    }

    return { igpQuote, tokenFeeQuote, feeQuotes };
  }

  async buildQuotedTransferTxs({
    warpCore,
    originTokenAmount,
    destination,
    sender,
    recipient,
    destinationToken,
  }: {
    warpCore: WarpCore;
    originTokenAmount: TokenAmount<IToken>;
    destination: ChainNameOrId;
    sender: string;
    recipient: string;
    destinationToken?: IToken;
  }): Promise<Array<WarpTypedTransaction>> {
    assert(isAddress(sender), `Invalid EVM sender address: ${sender}`);
    assert(isAddress(recipient), `Invalid EVM recipient address: ${recipient}`);

    const { token } = originTokenAmount;
    const transactions: Array<WarpTypedTransaction> = [];

    const providerType = TOKEN_STANDARD_TO_PROVIDER_TYPE[token.standard];

    const transferParams = this.resolveExecuteParams({
      warpCore,
      originTokenAmount,
      destination,
      recipient,
      destinationToken,
    });

    let feeQuotes = this.params.feeQuotes;
    if (!feeQuotes) {
      const fees = await this.getQuotedTransferFee({
        warpCore,
        originTokenAmount,
        destination,
        sender,
        recipient,
        destinationToken,
      });
      feeQuotes = fees.feeQuotes;
    }

    const { tokenTotals } = extractQuoteTotals(feeQuotes);
    const tokenKey = toAddress(
      transferParams.token.toLowerCase(),
      'token address lowercase narrowing failed',
    );
    const totalTokenNeeded = tokenTotals.get(tokenKey) ?? 0n;

    // Check approval for QuotedCalls (TransferFrom mode).
    // The spender is `this.params.address` (not the token itself), so
    // EvmHypSyntheticAdapter correctly falls through to the ERC20 allowance
    // check rather than returning false.
    if (
      this.params.tokenPullMode === TokenPullMode.TransferFrom &&
      totalTokenNeeded > 0n
    ) {
      const adapter = token.getAdapter(warpCore.multiProvider);
      const [isApproveRequired, isRevokeApprovalRequired] = await Promise.all([
        adapter.isApproveRequired(
          sender,
          this.params.address,
          totalTokenNeeded,
        ),
        adapter.isRevokeApprovalRequired(sender, this.params.address),
      ]);
      // USDT-like tokens require revoking to 0 before re-approving
      if (isApproveRequired && isRevokeApprovalRequired) {
        const revokeTxReq = await adapter.populateApproveTx({
          weiAmountOrId: 0,
          recipient: this.params.address,
        });
        transactions.push({
          category: WarpTxCategory.Revoke,
          type: providerType,
          transaction: revokeTxReq,
        } as WarpTypedTransaction); // CAST: providerType is determined at runtime from token.standard
      }
      if (isApproveRequired) {
        const approveTxReq = await adapter.populateApproveTx({
          weiAmountOrId: totalTokenNeeded,
          recipient: this.params.address,
        });
        transactions.push({
          category: WarpTxCategory.Approval,
          type: providerType,
          transaction: approveTxReq,
        } as WarpTypedTransaction); // CAST: providerType is determined at runtime from token.standard
      }
    }

    const executeTx = buildExecuteCalldata({
      ...transferParams,
      feeQuotes,
      tokenPullMode: this.params.tokenPullMode,
      permit2Data: this.params.permit2Data,
    });

    transactions.push({
      category: WarpTxCategory.Transfer,
      type: providerType,
      transaction: {
        to: executeTx.to,
        data: executeTx.data,
        value: executeTx.value.toString(),
      },
    } as WarpTypedTransaction); // CAST: providerType is determined at runtime from token.standard

    return transactions;
  }

  /**
   * Build the params struct shared by `buildQuoteCalldata` /
   * `buildExecuteCalldata`. Performs EVM/non-NFT preconditions and resolves
   * the on-chain token address + (optional) cross-collateral target router.
   */
  private resolveExecuteParams({
    warpCore,
    originTokenAmount,
    destination,
    recipient,
    destinationToken,
  }: {
    warpCore: WarpCore;
    originTokenAmount: TokenAmount<IToken>;
    destination: ChainNameOrId;
    recipient: Address;
    destinationToken?: IToken;
  }) {
    const { token, amount } = originTokenAmount;
    assert(
      isEVMLike(token.protocol),
      'QuotedCalls is only supported on EVM origins',
    );
    assert(!token.isNft(), 'QuotedCalls does not support NFT routes');

    const destinationDomainId = warpCore.multiProvider.getDomainId(destination);
    // For collateral routes, the ERC20 token is collateralAddressOrDenom.
    // For synthetic/native routes, use addressOrDenom (the router itself).
    // Only treat as native (zeroAddress) if collateral is explicitly address(0).
    const collateral = token.collateralAddressOrDenom;
    const rawTokenAddress =
      collateral && !isZeroishAddress(collateral)
        ? collateral
        : token.isNative() || token.isHypNative()
          ? '0x0000000000000000000000000000000000000000'
          : token.addressOrDenom;
    const tokenAddress = toAddress(
      rawTokenAddress,
      'token address narrowing failed',
    );

    let targetRouter: Hex | undefined;
    if (
      destinationToken &&
      warpCore.isCrossCollateralTransfer(token, destinationToken)
    ) {
      const resolved = resolveDestinationToken({
        multiProvider: warpCore.multiProvider,
        originToken: token,
        destination,
        destinationToken,
      });
      assert(
        resolved.addressOrDenom,
        'Destination token missing addressOrDenom for cross-collateral',
      );
      targetRouter = toHex(
        addressToBytes32(resolved.addressOrDenom),
        'targetRouter bytes32 narrowing failed',
      );
    }

    return {
      quotedCallsAddress: this.params.address,
      warpRoute: toAddress(
        token.addressOrDenom,
        'warpRoute address narrowing failed',
      ),
      destination: destinationDomainId,
      recipient: toHex(
        addressToBytes32(recipient),
        'recipient bytes32 narrowing failed',
      ),
      amount,
      token: tokenAddress,
      quotes: this.params.quotes,
      clientSalt: this.params.clientSalt,
      targetRouter,
    };
  }
}
