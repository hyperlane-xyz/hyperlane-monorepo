import { Logger } from 'pino';

import {
  Address,
  HexString,
  Numberish,
  ProtocolType,
  addressToBytes32,
  assert,
  convertDecimalsToIntegerString,
  convertToProtocolAddress,
  convertToScaledAmount,
  isEVMLike,
  isValidAddress,
  isZeroishAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';
import { Keypair } from '@solana/web3.js';

import type { MultiProviderAdapter } from '../providers/MultiProviderAdapter.js';
import { ProviderType } from '../providers/ProviderType.js';
import {
  TransactionFeeEstimate,
  estimateTransactionFeeEthersV5ForGasUnits,
} from '../providers/transactionFeeEstimators.js';
import { IToken } from '../token/IToken.js';
import { Token } from '../token/Token.js';
import { TokenAmount } from '../token/TokenAmount.js';
import { parseTokenConnectionId } from '../token/TokenConnection.js';
import { tokenIdentifiersEqual } from '../token/TokenMetadata.js';
import {
  LOCKBOX_STANDARDS,
  MINT_LIMITED_STANDARDS,
  TOKEN_COLLATERALIZED_STANDARDS,
  TOKEN_STANDARD_TO_PROVIDER_TYPE,
  TokenStandard,
} from '../token/TokenStandard.js';
import {
  EVM_TRANSFER_REMOTE_GAS_ESTIMATE,
  EvmHypCollateralFiatAdapter,
  EvmHypXERC20LockboxAdapter,
} from '../token/adapters/EvmTokenAdapter.js';
import {
  IHypXERC20Adapter,
  InterchainGasQuote,
  isHypCrossCollateralAdapter,
} from '../token/adapters/ITokenAdapter.js';
import {
  buildExecuteCalldata,
  buildQuoteCalldata,
} from '../quoted-calls/builder.js';
import type { Quote } from '../quoted-calls/codec.js';
import {
  decodeQuoteExecuteResult,
  extractQuoteTotals,
} from '../quoted-calls/codec.js';
import type { QuotedCallsParams } from '../quoted-calls/types.js';
import { TokenPullMode } from '../quoted-calls/types.js';
import { ChainName, ChainNameOrId } from '../types.js';

import {
  FeeConstantConfig,
  RouteBlacklist,
  WarpCoreConfigSchema,
  WarpCoreFeeEstimate,
  WarpTxCategory,
  WarpTypedTransaction,
} from './types.js';

export interface WarpCoreOptions {
  logger?: Logger;
  localFeeConstants?: FeeConstantConfig;
  interchainFeeConstants?: FeeConstantConfig;
  routeBlacklist?: RouteBlacklist;
}

export class WarpCore {
  public readonly multiProvider: MultiProviderAdapter<{ mailbox?: Address }>;
  public readonly tokens: Token[];
  public readonly localFeeConstants: FeeConstantConfig;
  public readonly interchainFeeConstants: FeeConstantConfig;
  public readonly routeBlacklist: RouteBlacklist;
  public readonly logger: Logger;

  constructor(
    multiProvider: MultiProviderAdapter<{ mailbox?: Address }>,
    tokens: Token[],
    options?: WarpCoreOptions,
  ) {
    this.multiProvider = multiProvider;
    this.tokens = tokens;
    this.localFeeConstants = options?.localFeeConstants || [];
    this.interchainFeeConstants = options?.interchainFeeConstants || [];
    this.routeBlacklist = options?.routeBlacklist || [];
    this.logger =
      options?.logger ||
      rootLogger.child({
        module: 'WarpCore',
      });
  }

  /**
   * Takes the serialized representation of a warp config and returns a WarpCore instance
   * @param multiProvider the MultiProviderAdapter containing chain metadata
   * @param config the config object of type WarpCoreConfig
   */
  static FromConfig(
    multiProvider: MultiProviderAdapter<{ mailbox?: Address }>,
    config: unknown,
  ): WarpCore {
    const parsedConfig = WarpCoreConfigSchema.parse(config);
    const tokens = parsedConfig.tokens.map(
      (token) =>
        new Token({
          ...token,
          addressOrDenom: token.addressOrDenom || '',
          connections: undefined,
        }),
    );

    parsedConfig.tokens.forEach((config, i) => {
      for (const connection of config.connections || []) {
        const token1 = tokens[i];
        assert(token1, `Token config missing at index ${i}`);
        const { chainName, addressOrDenom } = parseTokenConnectionId(
          connection.token,
        );
        const token2 = tokens.find(
          (token) =>
            token.chainName === chainName &&
            tokenIdentifiersEqual(token.addressOrDenom, addressOrDenom) &&
            (!token1.warpRouteId || token.warpRouteId === token1.warpRouteId),
        );
        assert(
          token2,
          `Connected token not found: ${chainName} ${addressOrDenom}`,
        );
        token1.addConnection({
          ...connection,
          token: token2,
        });
      }
    });

    return new WarpCore(multiProvider, tokens, parsedConfig.options);
  }

  /**
   * Queries the token router for an interchain gas quote (i.e. IGP fee).
   * and for token fee quote if it exists.
   * Sender is only required for Sealevel origins.
   */
  async getInterchainTransferFee({
    originTokenAmount,
    destination,
    sender,
    recipient,
    destinationToken,
  }: {
    originTokenAmount: TokenAmount<IToken>;
    destination: ChainNameOrId;
    sender?: Address;
    recipient: Address;
    destinationToken?: IToken;
  }): Promise<{
    igpQuote: TokenAmount<IToken>;
    tokenFeeQuote?: TokenAmount<IToken>;
  }> {
    this.logger.debug(`Fetching interchain transfer quote to ${destination}`);
    const { amount, token: originToken } = originTokenAmount;
    const originName = originToken.chainName;
    const destinationName = this.multiProvider.getChainName(destination);

    let gasAmount: bigint;
    let gasAddressOrDenom: string | undefined;
    let feeAmount: bigint | undefined;
    let feeTokenAddress: string | undefined;
    // Check constant quotes first
    const defaultQuote = this.interchainFeeConstants.find(
      (q) => q.origin === originName && q.destination === destinationName,
    );
    if (defaultQuote) {
      gasAmount = BigInt(defaultQuote.amount.toString());
      gasAddressOrDenom = defaultQuote.addressOrDenom;
    } else {
      // Otherwise, compute IGP quote via the adapter
      let quote: InterchainGasQuote;
      const destinationDomainId = this.multiProvider.getDomainId(destination);
      if (this.isCrossCollateralTransfer(originToken, destinationToken)) {
        const resolvedDestinationToken = this.resolveDestinationToken({
          originToken,
          destination,
          destinationToken,
        });
        assert(
          resolvedDestinationToken.addressOrDenom,
          'Destination token missing addressOrDenom',
        );
        const crossCollateralAdapter = originToken.getHypAdapter(
          this.multiProvider,
          destinationName,
        );
        assert(
          isHypCrossCollateralAdapter(crossCollateralAdapter),
          'Adapter does not implement IHypCrossCollateralAdapter',
        );
        quote = await crossCollateralAdapter.quoteTransferRemoteToGas({
          destination: destinationDomainId,
          recipient,
          amount,
          targetRouter: resolvedDestinationToken.addressOrDenom,
          sender,
        });
      } else {
        const hypAdapter = originToken.getHypAdapter(
          this.multiProvider,
          destinationName,
        );
        quote = await hypAdapter.quoteTransferRemoteGas({
          destination: destinationDomainId,
          sender,
          customHook: originToken.igpTokenAddressOrDenom,
          recipient,
          amount,
        });
      }
      gasAmount = BigInt(quote.igpQuote.amount);
      gasAddressOrDenom = quote.igpQuote.addressOrDenom;
      feeAmount = quote.tokenFeeQuote?.amount;
      feeTokenAddress = quote.tokenFeeQuote?.addressOrDenom;
    }

    let igpToken: Token;
    if (!gasAddressOrDenom || isZeroishAddress(gasAddressOrDenom)) {
      // An empty/undefined addressOrDenom indicates the native token
      igpToken = Token.FromChainMetadataNativeToken(
        this.multiProvider.getChainMetadata(originName),
      );
    } else {
      const searchResult = this.findToken(originName, gasAddressOrDenom);
      assert(searchResult, `Fee token ${gasAddressOrDenom} is unknown`);
      igpToken = searchResult;
    }

    let feeTokenAmount: TokenAmount<IToken> | undefined;
    if (feeAmount) {
      // empty address or zero address is native route
      if (!feeTokenAddress || isZeroishAddress(feeTokenAddress)) {
        const nativeToken = Token.FromChainMetadataNativeToken(
          this.multiProvider.getChainMetadata(originName),
        );
        feeTokenAmount = new TokenAmount(feeAmount, nativeToken);
      } else {
        // for non-native routes, fees will be in the current route token
        feeTokenAmount = new TokenAmount(feeAmount, originToken);
      }
    }

    this.logger.debug(
      `Quoted interchain transfer fee: ${gasAmount} ${igpToken.symbol}`,
    );
    return {
      igpQuote: new TokenAmount(gasAmount, igpToken),
      tokenFeeQuote: feeTokenAmount,
    };
  }

  /**
   * Simulates a transfer to estimate 'local' gas fees on the origin chain
   */
  async getLocalTransferFee({
    originToken,
    destination,
    sender,
    senderPubKey,
    interchainFee,
    tokenFeeQuote,
    destinationToken,
  }: {
    originToken: IToken;
    destination: ChainNameOrId;
    sender: Address;
    senderPubKey?: HexString;
    interchainFee?: TokenAmount<IToken>;
    tokenFeeQuote?: TokenAmount<IToken>;
    destinationToken?: IToken;
  }): Promise<TransactionFeeEstimate> {
    this.logger.debug(`Estimating local transfer gas to ${destination}`);
    const originMetadata = this.multiProvider.getChainMetadata(
      originToken.chainName,
    );
    const destinationMetadata =
      this.multiProvider.getChainMetadata(destination);

    // Check constant quotes first
    const defaultQuote = this.localFeeConstants.find(
      (q) =>
        q.origin === originMetadata.name &&
        q.destination === destinationMetadata.name,
    );
    if (defaultQuote) {
      return { gasUnits: 0, gasPrice: 0, fee: Number(defaultQuote.amount) };
    }

    // Form transactions to estimate local gas with
    const recipient = convertToProtocolAddress(
      sender,
      destinationMetadata.protocol,
      destinationMetadata.bech32Prefix,
    );
    // Use a small but viable amount for gas estimation. Must survive on-chain
    // decimal truncation (e.g. 18→6 decimals) to avoid reverts like
    // "HypNativeMinter: destination amount < 1". Compute minimum as
    // 10^(originDecimals - destDecimals) so destination gets exactly 1 unit.
    const destToken = originToken.getConnectionForChain(
      destinationMetadata.name,
    )?.token;
    const decimalDiff = destToken
      ? Math.max(0, originToken.decimals - destToken.decimals)
      : 0;
    const gasEstimationAmount = BigInt(10) ** BigInt(decimalDiff);
    const txs = await this.getTransferRemoteTxs({
      originTokenAmount: originToken.amount(gasEstimationAmount),
      destination,
      sender,
      recipient,
      interchainFee,
      tokenFeeQuote,
      destinationToken,
    });

    // Starknet does not support gas estimation without starknet account
    if (originToken.protocol === ProtocolType.Starknet) {
      return { gasUnits: 0n, gasPrice: 0n, fee: 0n };
    }

    // Typically the transfers require a single transaction
    if (txs.length === 1) {
      try {
        return this.multiProvider.estimateTransactionFee({
          chainNameOrId: originMetadata.name,
          transaction: txs[0],
          sender,
          senderPubKey,
        });
      } catch (error) {
        this.logger.error(
          `Failed to estimate local gas fee for ${originToken.symbol} transfer`,
          error,
        );
        throw new Error('Gas estimation failed, balance may be insufficient', {
          cause: error,
        });
      }
    }
    // On ethereum, sometimes 2 txs are required (one approve, one transferRemote)
    else if (txs.length >= 2 && isEVMLike(originToken.protocol)) {
      const provider = this.multiProvider.getEthersV5Provider(
        originMetadata.name,
      );
      // We use a hard-coded const as an estimate for the transferRemote because we
      // cannot reliably simulate the tx when an approval tx is required first
      return estimateTransactionFeeEthersV5ForGasUnits({
        provider,
        gasUnits: EVM_TRANSFER_REMOTE_GAS_ESTIMATE,
      });
    } else {
      throw new Error('Cannot estimate local gas for multiple transactions');
    }
  }

  /**
   * Similar to getLocalTransferFee in that it estimates local gas fees
   * but it also resolves the native token and returns a TokenAmount
   * @todo: rename to getLocalTransferFee for consistency (requires breaking change)
   */
  async getLocalTransferFeeAmount({
    originToken,
    destination,
    sender,
    senderPubKey,
    interchainFee,
    tokenFeeQuote,
    destinationToken,
  }: {
    originToken: IToken;
    destination: ChainNameOrId;
    sender: Address;
    senderPubKey?: HexString;
    interchainFee?: TokenAmount<IToken>;
    tokenFeeQuote?: TokenAmount<IToken>;
    destinationToken?: IToken;
  }): Promise<TokenAmount<IToken>> {
    const originMetadata = this.multiProvider.getChainMetadata(
      originToken.chainName,
    );
    // If there's no native token, we can't represent local gas
    if (!originMetadata.nativeToken)
      throw new Error(`No native token found for ${originMetadata.name}`);

    this.logger.debug(
      `Using native token ${originMetadata.nativeToken.symbol} for local gas fee`,
    );

    const localFee = await this.getLocalTransferFee({
      originToken,
      destination,
      sender,
      senderPubKey,
      interchainFee,
      tokenFeeQuote,
      destinationToken,
    });

    // Get the local gas token. This assumes the chain's native token will pay for local gas
    // This will need to be smarter if more complex scenarios on Cosmos are supported
    const localGasToken = Token.FromChainMetadataNativeToken(originMetadata);
    return localGasToken.amount(localFee.fee);
  }

  /**
   * Gets a list of populated transactions required to transfer a token to a remote chain
   * Typically just 1 transaction but sometimes more, like when an approval is required first
   */
  async getTransferRemoteTxs({
    originTokenAmount,
    destination,
    sender,
    recipient,
    interchainFee,
    tokenFeeQuote,
    destinationToken,
    quotedCalls,
  }: {
    originTokenAmount: TokenAmount<IToken>;
    destination: ChainNameOrId;
    sender: Address;
    recipient: Address;
    interchainFee?: TokenAmount<IToken>;
    tokenFeeQuote?: TokenAmount<IToken>;
    destinationToken?: IToken;
    /** When provided, builds an atomic QuotedCalls.execute() tx instead of separate approve+transfer */
    quotedCalls?: QuotedCallsParams;
  }): Promise<Array<WarpTypedTransaction>> {
    // QuotedCalls atomic path — single execute() tx with quotes + token pull + transfer + sweep
    if (quotedCalls) {
      return this.getQuotedCallsTransferTxs({
        originTokenAmount,
        destination,
        sender,
        recipient,
        quotedCalls,
        destinationToken,
        feeQuotes: quotedCalls.feeQuotes,
      });
    }

    // Check if this is a CrossCollateralRouter transfer
    if (
      destinationToken &&
      this.isCrossCollateralTransfer(originTokenAmount.token, destinationToken)
    ) {
      return this.getCrossCollateralTransferTxs({
        originTokenAmount,
        destination,
        sender,
        recipient,
        destinationToken,
      });
    }

    // Standard warp route transfer
    const transactions: Array<WarpTypedTransaction> = [];

    const { token, amount } = originTokenAmount;
    const destinationName = this.multiProvider.getChainName(destination);
    const destinationDomainId = this.multiProvider.getDomainId(destination);
    const providerType = TOKEN_STANDARD_TO_PROVIDER_TYPE[token.standard];
    const hypAdapter = token.getHypAdapter(this.multiProvider, destinationName);

    if (!interchainFee || !tokenFeeQuote) {
      const transferFee = await this.getInterchainTransferFee({
        originTokenAmount,
        destination,
        sender,
        recipient,
        destinationToken,
      });
      interchainFee = transferFee.igpQuote;
      tokenFeeQuote = transferFee.tokenFeeQuote;
    }
    const interchainGas: InterchainGasQuote = {
      igpQuote: {
        amount: interchainFee.amount,
        addressOrDenom: interchainFee.token.addressOrDenom,
      },
      tokenFeeQuote: tokenFeeQuote && {
        amount: tokenFeeQuote.amount,
        addressOrDenom: tokenFeeQuote.token.addressOrDenom,
      },
    };

    const [isApproveRequired, isRevokeApprovalRequired] = await Promise.all([
      this.isApproveRequired({
        originTokenAmount,
        owner: sender,
      }),
      hypAdapter.isRevokeApprovalRequired(
        sender,
        originTokenAmount.token.addressOrDenom,
      ),
    ]);

    const preTransferRemoteTxs: [Numberish, WarpTxCategory][] = [];
    // if the approval is required and the current allowance is not 0 we reset
    // the allowance before setting the right approval as some tokens don't allow
    // to override an already existing allowance. USDT is one of these tokens
    // see: https://etherscan.io/token/0xdac17f958d2ee523a2206206994597c13d831ec7#code#L205
    if (isApproveRequired && isRevokeApprovalRequired) {
      preTransferRemoteTxs.push([0, WarpTxCategory.Revoke]);
    }

    if (isApproveRequired) {
      // feeQuote is required to be approved for routes that have fees set
      const feeQuote = tokenFeeQuote?.amount ?? 0n;
      const amountToApprove = amount + feeQuote;
      preTransferRemoteTxs.push([
        amountToApprove.toString(),
        WarpTxCategory.Approval,
      ]);
    }

    for (const [approveAmount, txCategory] of preTransferRemoteTxs) {
      this.logger.info(
        `${txCategory} required for transfer of ${token.symbol}`,
      );
      const approveTxReq = await hypAdapter.populateApproveTx({
        weiAmountOrId: approveAmount,
        recipient: token.addressOrDenom,
        interchainGas,
      });
      this.logger.debug(`${txCategory} tx for ${token.symbol} populated`);

      const approveTx = {
        category: txCategory,
        type: providerType,
        transaction: approveTxReq,
      } as WarpTypedTransaction;
      transactions.push(approveTx);
    }

    // if the interchain fee is of protocol starknet we also have
    // to approve the transfer of this fee token
    if (interchainFee.token.protocol === ProtocolType.Starknet) {
      const interchainFeeAdapter = interchainFee.token.getAdapter(
        this.multiProvider,
      );
      const isRequired = await interchainFeeAdapter.isApproveRequired(
        sender,
        token.addressOrDenom,
        interchainFee.amount,
      );
      this.logger.debug(
        `Approval is${isRequired ? '' : ' not'} required for interchain fee of ${
          interchainFee.token.symbol
        }`,
      );

      if (isRequired) {
        const txCategory = WarpTxCategory.Approval;

        this.logger.info(
          `${txCategory} required for transfer of ${interchainFee.token.symbol}`,
        );
        const approveTxReq = await interchainFeeAdapter.populateApproveTx({
          weiAmountOrId: interchainFee.amount,
          recipient: token.addressOrDenom,
        });
        this.logger.debug(
          `${txCategory} tx for ${interchainFee.token.symbol} populated`,
        );
        const approveTx = {
          category: txCategory,
          type: providerType,
          transaction: approveTxReq,
        } as WarpTypedTransaction;
        transactions.push(approveTx);
      }
    }
    const extraSignerKeypairs =
      providerType === ProviderType.SolanaWeb3
        ? [Keypair.generate()]
        : undefined;
    const transferTxReq = await hypAdapter.populateTransferRemoteTx({
      weiAmountOrId: amount.toString(),
      destination: destinationDomainId,
      fromAccountOwner: sender,
      recipient,
      interchainGas,
      customHook: token.igpTokenAddressOrDenom,
      extraSigners: extraSignerKeypairs,
    });

    this.logger.debug(`Remote transfer tx for ${token.symbol} populated`);

    const transferTx = {
      category: WarpTxCategory.Transfer,
      type: providerType,
      transaction: transferTxReq,
      ...(extraSignerKeypairs && { extraSigners: extraSignerKeypairs }),
    } as WarpTypedTransaction;
    transactions.push(transferTx);

    return transactions;
  }

  /**
   * Check if this is a CrossCollateralRouter transfer.
   * Returns true if both tokens are CrossCollateralRouter tokens.
   */
  protected isCrossCollateralTransfer(
    originToken: IToken,
    destinationToken?: IToken,
  ): destinationToken is IToken {
    if (!destinationToken) return false;
    return (
      originToken.isCrossCollateralToken() &&
      destinationToken.isCrossCollateralToken()
    );
  }

  /**
   * Executes a CrossCollateralRouter transfer between different collateral routers.
   * Uses transferRemoteTo for both same-chain and cross-chain transfers.
   * Same-chain: calls handle() directly on target router (atomic, no relay needed).
   */
  protected async getCrossCollateralTransferTxs({
    originTokenAmount,
    destination,
    sender,
    recipient,
    destinationToken,
  }: {
    originTokenAmount: TokenAmount<IToken>;
    destination: ChainNameOrId;
    sender: Address;
    recipient: Address;
    destinationToken: IToken;
  }): Promise<Array<WarpTypedTransaction>> {
    const transactions: Array<WarpTypedTransaction> = [];
    const { token: originToken, amount } = originTokenAmount;
    const destinationName = this.multiProvider.getChainName(destination);
    const resolvedDestinationToken = this.resolveDestinationToken({
      originToken,
      destination,
      destinationToken,
    });

    assert(
      originToken.collateralAddressOrDenom,
      'Origin token missing collateralAddressOrDenom',
    );
    assert(
      resolvedDestinationToken.addressOrDenom,
      'Destination token missing addressOrDenom',
    );

    const providerType = TOKEN_STANDARD_TO_PROVIDER_TYPE[originToken.standard];

    const adapter = originToken.getHypAdapter(
      this.multiProvider,
      destinationName,
    );
    assert(
      isHypCrossCollateralAdapter(adapter),
      'Adapter does not implement IHypCrossCollateralAdapter',
    );

    const transferQuote = await adapter.quoteTransferRemoteToGas({
      destination: this.multiProvider.getDomainId(destination),
      recipient,
      amount,
      targetRouter: resolvedDestinationToken.addressOrDenom,
      sender,
    });
    assert(
      !transferQuote.igpQuote.addressOrDenom ||
        isZeroishAddress(transferQuote.igpQuote.addressOrDenom),
      `CrossCollateralRouter transferRemoteTo requires native IGP fee; got ${transferQuote.igpQuote.addressOrDenom}`,
    );
    const tokenFeeAmount = transferQuote.tokenFeeQuote?.amount ?? 0n;
    const totalDebit = amount + tokenFeeAmount;

    const [isApproveRequired, isRevokeApprovalRequired] = await Promise.all([
      adapter.isApproveRequired(sender, originToken.addressOrDenom, totalDebit),
      adapter.isRevokeApprovalRequired(sender, originToken.addressOrDenom),
    ]);

    if (isApproveRequired && isRevokeApprovalRequired) {
      const revokeTxReq = await adapter.populateApproveTx({
        weiAmountOrId: 0,
        recipient: originToken.addressOrDenom,
      });
      transactions.push({
        category: WarpTxCategory.Revoke,
        type: providerType,
        transaction: revokeTxReq,
      } as WarpTypedTransaction);
    }

    if (isApproveRequired) {
      const approveTxReq = await adapter.populateApproveTx({
        weiAmountOrId: totalDebit,
        recipient: originToken.addressOrDenom,
      });
      transactions.push({
        category: WarpTxCategory.Approval,
        type: providerType,
        transaction: approveTxReq,
      } as WarpTypedTransaction);
    }

    // transferRemoteTo works for both same-chain and cross-chain.
    // Same-chain: calls handle() directly on target router (atomic, no relay needed).
    const destinationDomainId = this.multiProvider.getDomainId(destination);

    const originDomainId = this.multiProvider.getDomainId(
      originToken.chainName,
    );
    const isLocalTransfer = destinationDomainId === originDomainId;
    const extraSignerKeypairs =
      providerType === ProviderType.SolanaWeb3 && !isLocalTransfer
        ? [Keypair.generate()]
        : undefined;
    const txReq = await adapter.populateTransferRemoteToTx({
      destination: destinationDomainId,
      recipient,
      amount,
      targetRouter: resolvedDestinationToken.addressOrDenom,
      interchainGas: transferQuote,
      fromAccountOwner: sender,
      extraSigners: extraSignerKeypairs,
    });
    transactions.push({
      category: WarpTxCategory.Transfer,
      type: providerType,
      transaction: txReq,
      ...(extraSignerKeypairs && { extraSigners: extraSignerKeypairs }),
    } as WarpTypedTransaction);

    return transactions;
  }

  /**
   * Resolve common params for QuotedCalls operations.
   */
  protected resolveQuotedCallsParams({
    originTokenAmount,
    destination,
    recipient,
    quotedCalls,
    destinationToken,
  }: {
    originTokenAmount: TokenAmount<IToken>;
    destination: ChainNameOrId;
    recipient: Address;
    quotedCalls: QuotedCallsParams;
    destinationToken?: IToken;
  }) {
    const { token, amount } = originTokenAmount;
    assert(
      isEVMLike(token.protocol),
      'QuotedCalls is only supported on EVM origins',
    );
    assert(!token.isNft(), 'QuotedCalls does not support NFT routes');

    const destinationDomainId = this.multiProvider.getDomainId(destination);
    // For collateral routes, the ERC20 token is collateralAddressOrDenom.
    // For synthetic/native routes, use addressOrDenom (the router itself).
    // Only treat as native (zeroAddress) if collateral is explicitly address(0).
    const collateral = token.collateralAddressOrDenom;
    const tokenAddress = (
      collateral && !isZeroishAddress(collateral)
        ? collateral
        : token.isNative()
          ? '0x0000000000000000000000000000000000000000'
          : token.addressOrDenom
    ) as `0x${string}`;

    let targetRouter: `0x${string}` | undefined;
    if (
      destinationToken &&
      this.isCrossCollateralTransfer(token, destinationToken)
    ) {
      const resolved = this.resolveDestinationToken({
        originToken: token,
        destination,
        destinationToken,
      });
      assert(
        resolved.addressOrDenom,
        'Destination token missing addressOrDenom for cross-collateral',
      );
      targetRouter = addressToBytes32(resolved.addressOrDenom) as `0x${string}`;
    }

    return {
      quotedCallsAddress: quotedCalls.address,
      warpRoute: token.addressOrDenom as `0x${string}`,
      destination: destinationDomainId,
      recipient: addressToBytes32(recipient) as `0x${string}`,
      amount,
      token: tokenAddress,
      quotes: quotedCalls.quotes,
      clientSalt: quotedCalls.clientSalt,
      targetRouter,
    };
  }

  /**
   * Quote fees for a QuotedCalls transfer via quoteExecute eth_call.
   * Returns structured fee data (like getInterchainTransferFee) plus
   * the raw Quote[][] needed to build the execute tx.
   */
  async getQuotedTransferFee({
    originTokenAmount,
    destination,
    sender,
    recipient,
    quotedCalls,
    destinationToken,
  }: {
    originTokenAmount: TokenAmount<IToken>;
    destination: ChainNameOrId;
    sender: Address;
    recipient: Address;
    quotedCalls: QuotedCallsParams;
    destinationToken?: IToken;
  }): Promise<{
    igpQuote: TokenAmount<IToken>;
    tokenFeeQuote?: TokenAmount<IToken>;
    /** Raw per-command quotes — pass to getTransferRemoteTxs */
    feeQuotes: Quote[][];
  }> {
    const { token: originToken } = originTokenAmount;
    const originName = originToken.chainName;

    const transferParams = this.resolveQuotedCallsParams({
      originTokenAmount,
      destination,
      recipient,
      quotedCalls,
      destinationToken,
    });

    const quoteTx = buildQuoteCalldata(transferParams);
    const provider = this.multiProvider.getEthersV5Provider(originName);
    const quoteResult = await provider.call({
      to: quoteTx.to,
      data: quoteTx.data,
      from: sender,
    });
    const feeQuotes = decodeQuoteExecuteResult(quoteResult as `0x${string}`);
    const { nativeValue, tokenTotals } = extractQuoteTotals(feeQuotes);

    // Build structured fee amounts matching getInterchainTransferFee return shape.
    // For native routes, quoteTransferRemote includes the transfer amount in
    // the native quotes, so we subtract it to get the fee-only portion.
    const isNativeRoute = isZeroishAddress(transferParams.token);
    const nativeToken = Token.FromChainMetadataNativeToken(
      this.multiProvider.getChainMetadata(originName),
    );
    const igpFeeOnly = isNativeRoute
      ? nativeValue - originTokenAmount.amount
      : nativeValue;
    const igpQuote = new TokenAmount(igpFeeOnly, nativeToken);

    // Token fees = total ERC20 quoted minus the transfer amount
    // sumQuotesByToken normalizes keys to lowercase
    const tokenKey = transferParams.token.toLowerCase() as `0x${string}`;
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

  /**
   * Build transactions for a QuotedCalls atomic transfer.
   * Returns [approval (if needed), execute] transactions.
   *
   * @param feeQuotes Raw Quote[][] from getQuotedTransferFee.
   *   If not provided, calls quoteExecute internally.
   */
  protected async getQuotedCallsTransferTxs({
    originTokenAmount,
    destination,
    sender,
    recipient,
    quotedCalls,
    destinationToken,
    feeQuotes,
  }: {
    originTokenAmount: TokenAmount<IToken>;
    destination: ChainNameOrId;
    sender: Address;
    recipient: Address;
    quotedCalls: QuotedCallsParams;
    destinationToken?: IToken;
    feeQuotes?: Quote[][];
  }): Promise<Array<WarpTypedTransaction>> {
    const { token } = originTokenAmount;
    const transactions: Array<WarpTypedTransaction> = [];

    const providerType = TOKEN_STANDARD_TO_PROVIDER_TYPE[token.standard];

    const transferParams = this.resolveQuotedCallsParams({
      originTokenAmount,
      destination,
      recipient,
      quotedCalls,
      destinationToken,
    });

    // Get fee quotes if not provided
    if (!feeQuotes) {
      const fees = await this.getQuotedTransferFee({
        originTokenAmount,
        destination,
        sender,
        recipient,
        quotedCalls,
        destinationToken,
      });
      feeQuotes = fees.feeQuotes;
    }

    const { tokenTotals } = extractQuoteTotals(feeQuotes);
    const totalTokenNeeded =
      tokenTotals.get(transferParams.token.toLowerCase() as `0x${string}`) ??
      0n;

    // Check approval for QuotedCalls (TransferFrom mode).
    // The spender is quotedCalls.address (not the token itself), so
    // EvmHypSyntheticAdapter correctly falls through to the ERC20 allowance
    // check rather than returning false.
    if (
      quotedCalls.tokenPullMode === TokenPullMode.TransferFrom &&
      totalTokenNeeded > 0n
    ) {
      const adapter = token.getAdapter(this.multiProvider);
      const [isApproveRequired, isRevokeApprovalRequired] = await Promise.all([
        adapter.isApproveRequired(
          sender,
          quotedCalls.address,
          totalTokenNeeded,
        ),
        adapter.isRevokeApprovalRequired(sender, quotedCalls.address),
      ]);
      // USDT-like tokens require revoking to 0 before re-approving
      if (isApproveRequired && isRevokeApprovalRequired) {
        const revokeTxReq = await adapter.populateApproveTx({
          weiAmountOrId: 0,
          recipient: quotedCalls.address,
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
          recipient: quotedCalls.address,
        });
        transactions.push({
          category: WarpTxCategory.Approval,
          type: providerType,
          transaction: approveTxReq,
        } as WarpTypedTransaction); // CAST: providerType is determined at runtime from token.standard
      }
    }

    // Build execute tx with exact fee amounts
    const executeTx = buildExecuteCalldata({
      ...transferParams,
      feeQuotes,
      tokenPullMode: quotedCalls.tokenPullMode,
      permit2Data: quotedCalls.permit2Data,
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
   * Fetch local and interchain fee estimates for a remote transfer
   */
  async estimateTransferRemoteFees({
    originTokenAmount,
    destination,
    recipient,
    sender,
    senderPubKey,
    destinationToken,
  }: {
    originTokenAmount: TokenAmount<IToken>;
    destination: ChainNameOrId;
    recipient: Address;
    sender: Address;
    senderPubKey?: HexString;
    destinationToken?: IToken;
  }): Promise<WarpCoreFeeEstimate> {
    this.logger.debug('Fetching remote transfer fee estimates');

    const { token: originToken } = originTokenAmount;

    // Handle CrossCollateralRouter fee estimation
    if (this.isCrossCollateralTransfer(originToken, destinationToken)) {
      return this.estimateCrossCollateralFees({
        originTokenAmount,
        destination,
        destinationToken,
        recipient,
        sender,
        senderPubKey,
      });
    }

    // First get interchain gas quote (aka IGP quote)
    // Start with this because it's used in the local fee estimation
    const { igpQuote, tokenFeeQuote } = await this.getInterchainTransferFee({
      originTokenAmount,
      destination,
      sender,
      recipient,
    });

    // Next, get the local gas quote
    const localQuote = await this.getLocalTransferFeeAmount({
      originToken: originTokenAmount.token,
      destination,
      sender,
      senderPubKey,
      interchainFee: igpQuote,
      tokenFeeQuote,
    });

    return {
      interchainQuote: igpQuote,
      localQuote,
      tokenFeeQuote,
    };
  }

  /**
   * Estimate fees for a CrossCollateralRouter transfer.
   */
  protected async estimateCrossCollateralFees({
    originTokenAmount,
    destination,
    destinationToken,
    recipient,
    sender,
    senderPubKey,
  }: {
    originTokenAmount: TokenAmount<IToken>;
    destination: ChainNameOrId;
    destinationToken: IToken;
    recipient: Address;
    sender: Address;
    senderPubKey?: HexString;
  }): Promise<WarpCoreFeeEstimate> {
    const { token: originToken } = originTokenAmount;
    const resolvedDestinationToken = this.resolveDestinationToken({
      originToken,
      destination,
      destinationToken,
    });

    const { igpQuote: interchainQuote, tokenFeeQuote } =
      await this.getInterchainTransferFee({
        originTokenAmount,
        destination,
        sender,
        recipient,
        destinationToken: resolvedDestinationToken,
      });

    const localQuote = await this.getLocalTransferFeeAmount({
      originToken,
      destination,
      sender,
      senderPubKey,
      interchainFee: interchainQuote,
      tokenFeeQuote,
      destinationToken: resolvedDestinationToken,
    });

    return {
      interchainQuote,
      localQuote,
      tokenFeeQuote,
    };
  }

  /**
   * Computes the max transferrable amount of the from the given
   * token balance, accounting for local and interchain gas fees
   */
  async getMaxTransferAmount({
    balance,
    destination,
    recipient,
    sender,
    senderPubKey,
    feeEstimate,
    destinationToken,
  }: {
    balance: TokenAmount<IToken>;
    destination: ChainNameOrId;
    recipient: Address;
    sender: Address;
    senderPubKey?: HexString;
    feeEstimate?: WarpCoreFeeEstimate;
    destinationToken?: IToken;
  }): Promise<TokenAmount<IToken>> {
    const originToken = balance.token;

    if (!feeEstimate) {
      feeEstimate = await this.estimateTransferRemoteFees({
        originTokenAmount: balance,
        destination,
        recipient,
        sender,
        senderPubKey,
        destinationToken,
      });
    }
    const { localQuote, interchainQuote, tokenFeeQuote } = feeEstimate;

    let maxAmount = balance;
    if (originToken.isFungibleWith(localQuote.token)) {
      maxAmount = maxAmount.minus(localQuote.amount);
    }

    if (originToken.isFungibleWith(interchainQuote.token)) {
      maxAmount = maxAmount.minus(interchainQuote.amount);
    }
    if (originToken.isFungibleWith(tokenFeeQuote?.token)) {
      const { tokenFeeQuote: newFeeQuote } =
        await this.getInterchainTransferFee({
          originTokenAmount: maxAmount,
          destination,
          recipient,
          sender,
          destinationToken,
        });
      // Because tokenFeeQuote is calculated based on the amount, we need to recalculate
      // the tokenFeeQuote after subtracting the localQuote and IGP to get max transfer amount
      // to be as close as possible
      maxAmount = maxAmount.minus(newFeeQuote?.amount || 0n);
    }

    if (maxAmount.amount > 0) return maxAmount;
    else return originToken.amount(0);
  }

  async getTokenCollateral(token: IToken): Promise<bigint> {
    if (LOCKBOX_STANDARDS.includes(token.standard)) {
      const adapter = token.getAdapter(
        this.multiProvider,
      ) as EvmHypXERC20LockboxAdapter;
      const tokenCollateral = await adapter.getBridgedSupply();
      return tokenCollateral;
    } else {
      const adapter = token.getAdapter(this.multiProvider);
      const tokenCollateral = await adapter.getBalance(token.addressOrDenom);
      return tokenCollateral;
    }
  }

  /**
   * Checks if destination chain's collateral is sufficient to cover the transfer
   */
  async isDestinationCollateralSufficient({
    originTokenAmount,
    destination,
    destinationToken,
  }: {
    originTokenAmount: TokenAmount<IToken>;
    destination: ChainNameOrId;
    destinationToken?: IToken;
  }): Promise<boolean> {
    const { token: originToken, amount } = originTokenAmount;
    this.logger.debug(
      `Checking collateral for ${originToken.symbol} to ${destination}`,
    );

    const resolvedDestinationToken = this.resolveDestinationToken({
      originToken,
      destination,
      destinationToken,
    });

    if (
      !TOKEN_COLLATERALIZED_STANDARDS.includes(
        resolvedDestinationToken.standard,
      )
    ) {
      this.logger.debug(
        `${resolvedDestinationToken.symbol} is not collateralized, skipping`,
      );
      return true;
    }

    const destinationBalance = await this.getTokenCollateral(
      resolvedDestinationToken,
    );

    const destinationBalanceInOriginDecimals = convertDecimalsToIntegerString(
      resolvedDestinationToken.decimals,
      originToken.decimals,
      destinationBalance.toString(),
    );

    // check for scaling factor
    if (
      originToken.scale &&
      resolvedDestinationToken.scale &&
      originToken.scale !== resolvedDestinationToken.scale
    ) {
      const precisionFactor = 100_000;
      const scaledAmount = convertToScaledAmount({
        fromScale: originToken.scale,
        toScale: resolvedDestinationToken.scale,
        amount,
        precisionFactor,
      });

      return (
        BigInt(destinationBalanceInOriginDecimals) * BigInt(precisionFactor) >=
        scaledAmount
      );
    }

    const isSufficient = BigInt(destinationBalanceInOriginDecimals) >= amount;
    this.logger.debug(
      `${originTokenAmount.token.symbol} to ${destination} has ${
        isSufficient ? 'sufficient' : 'INSUFFICIENT'
      } collateral`,
    );
    return isSufficient;
  }

  /**
   * Checks if a token transfer requires an approval tx first
   */
  async isApproveRequired({
    originTokenAmount,
    owner,
  }: {
    originTokenAmount: TokenAmount<IToken>;
    owner: Address;
  }): Promise<boolean> {
    const { token, amount } = originTokenAmount;
    const adapter = token.getAdapter(this.multiProvider);
    const isRequired = await adapter.isApproveRequired(
      owner,
      token.addressOrDenom,
      amount,
    );
    this.logger.debug(
      `Approval is${isRequired ? '' : ' not'} required for transfer of ${
        token.symbol
      }`,
    );
    return isRequired;
  }

  /**
   * Ensure the remote token transfer would be valid for the given chains, amount, sender, and recipient
   */
  async validateTransfer({
    originTokenAmount,
    destination,
    recipient,
    sender,
    senderPubKey,
    destinationToken,
  }: {
    originTokenAmount: TokenAmount<IToken>;
    destination: ChainNameOrId;
    recipient: Address;
    sender: Address;
    senderPubKey?: HexString;
    destinationToken?: IToken;
  }): Promise<Record<string, string> | null> {
    const chainError = this.validateChains(
      originTokenAmount.token.chainName,
      destination,
    );
    if (chainError) return chainError;

    const recipientError = this.validateRecipient(recipient, destination);
    if (recipientError) return recipientError;

    const resolvedDestinationToken = (() => {
      try {
        return this.resolveDestinationToken({
          originToken: originTokenAmount.token,
          destination,
          destinationToken,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Invalid destination token';
        return { error: message };
      }
    })();
    if ('error' in resolvedDestinationToken) {
      return { destinationToken: resolvedDestinationToken.error };
    }

    const amountError = await this.validateAmount(
      originTokenAmount,
      destination,
      recipient,
      resolvedDestinationToken,
    );
    if (amountError) return amountError;

    const destinationRateLimitError = await this.validateDestinationRateLimit(
      originTokenAmount,
      destination,
      resolvedDestinationToken,
    );
    if (destinationRateLimitError) return destinationRateLimitError;

    const destinationCollateralError = await this.validateDestinationCollateral(
      originTokenAmount,
      destination,
      resolvedDestinationToken,
    );
    if (destinationCollateralError) return destinationCollateralError;

    const originCollateralError =
      await this.validateOriginCollateral(originTokenAmount);
    if (originCollateralError) return originCollateralError;

    const balancesError = await this.validateTokenBalances(
      originTokenAmount,
      destination,
      sender,
      recipient,
      senderPubKey,
      resolvedDestinationToken,
    );
    if (balancesError) return balancesError;

    return null;
  }

  /**
   * Ensure the origin and destination chains are valid and known by this WarpCore
   */
  protected validateChains(
    origin: ChainNameOrId,
    destination: ChainNameOrId,
  ): Record<string, string> | null {
    if (!origin) return { origin: 'Origin chain required' };
    if (!destination) return { destination: 'Destination chain required' };
    const originMetadata = this.multiProvider.tryGetChainMetadata(origin);
    const destinationMetadata =
      this.multiProvider.tryGetChainMetadata(destination);
    if (!originMetadata) return { origin: 'Origin chain metadata missing' };
    if (!destinationMetadata)
      return { destination: 'Destination chain metadata missing' };
    if (
      this.routeBlacklist.some(
        (bl) =>
          bl.origin === originMetadata.name &&
          bl.destination === destinationMetadata.name,
      )
    ) {
      return { destination: 'Route is not currently allowed' };
    }
    return null;
  }

  /**
   * Ensure recipient address is valid for the destination chain
   */
  protected validateRecipient(
    recipient: Address,
    destination: ChainNameOrId,
  ): Record<string, string> | null {
    const destinationMetadata =
      this.multiProvider.getChainMetadata(destination);
    const { protocol, bech32Prefix } = destinationMetadata;
    // Ensure recip address is valid for the destination chain's protocol
    if (!isValidAddress(recipient, protocol) || isZeroishAddress(recipient))
      return { recipient: 'Invalid recipient' };

    // Also ensure the address denom is correct if the dest protocol is Cosmos
    if (
      protocol === ProtocolType.Cosmos ||
      protocol === ProtocolType.CosmosNative
    ) {
      if (!bech32Prefix) {
        this.logger.error(`No bech32 prefix found for chain ${destination}`);
        return { destination: 'Invalid chain data' };
      } else if (!recipient.startsWith(bech32Prefix)) {
        this.logger.error(`Recipient prefix should be ${bech32Prefix}`);
        return { recipient: 'Invalid recipient prefix' };
      }
    }
    return null;
  }

  /**
   * Ensure token amount is valid
   */
  protected async validateAmount(
    originTokenAmount: TokenAmount<IToken>,
    destination: ChainNameOrId,
    recipient: Address,
    destinationToken?: IToken,
  ): Promise<Record<string, string> | null> {
    if (!originTokenAmount.amount || originTokenAmount.amount < 0n) {
      const isNft = originTokenAmount.token.isNft();
      return { amount: isNft ? 'Invalid Token Id' : 'Invalid amount' };
    }

    // Check the transfer amount is sufficient on the destination side

    const originToken = originTokenAmount.token;

    const resolvedDestinationToken = this.resolveDestinationToken({
      originToken,
      destination,
      destinationToken,
    });
    const destinationAdapter = resolvedDestinationToken.getAdapter(
      this.multiProvider,
    );

    // Get the min required destination amount
    const minDestinationTransferAmount =
      await destinationAdapter.getMinimumTransferAmount(recipient);

    // Convert the minDestinationTransferAmount to an origin amount
    const minOriginTransferAmount = originToken.amount(
      convertDecimalsToIntegerString(
        resolvedDestinationToken.decimals,
        originToken.decimals,
        minDestinationTransferAmount.toString(),
      ),
    );

    if (minOriginTransferAmount.amount > originTokenAmount.amount) {
      return {
        amount: `Minimum transfer amount is ${minOriginTransferAmount.getDecimalFormattedAmount()} ${
          originToken.symbol
        }`,
      };
    }

    return null;
  }

  /**
   * Ensure the sender has sufficient balances for transfer and interchain gas
   */
  protected async validateTokenBalances(
    originTokenAmount: TokenAmount<IToken>,
    destination: ChainNameOrId,
    sender: Address,
    recipient: Address,
    senderPubKey?: HexString,
    destinationToken?: IToken,
  ): Promise<Record<string, string> | null> {
    const { token: originToken, amount } = originTokenAmount;

    const { amount: senderBalance } = await originToken.getBalance(
      this.multiProvider,
      sender,
    );
    const senderBalanceAmount = originTokenAmount.token.amount(senderBalance);

    // Check 1: Check basic token balance
    if (amount > senderBalance) return { amount: 'Insufficient balance' };

    // Check 2: Ensure the balance can cover interchain fee
    // Slightly redundant with Check 5 but gives more specific error messages

    const { igpQuote: interchainQuote, tokenFeeQuote } =
      await this.getInterchainTransferFee({
        originTokenAmount,
        destination,
        sender,
        recipient,
        destinationToken,
      });
    // Get balance of the IGP fee token, which may be different from the transfer token
    const interchainQuoteTokenBalance = originToken.isFungibleWith(
      interchainQuote.token,
    )
      ? senderBalanceAmount
      : await interchainQuote.token.getBalance(this.multiProvider, sender);
    if (interchainQuoteTokenBalance.amount < interchainQuote.amount) {
      return {
        amount: `Insufficient ${interchainQuote.token.symbol} for interchain gas`,
      };
    }

    // Check 3: Ensure the balance can cover the token fee which would be the same asset as the originTokenValue
    // Slightly redundant with Check 5 but gives more specific error messages
    if (
      tokenFeeQuote?.amount &&
      amount + tokenFeeQuote.amount > senderBalance
    ) {
      return {
        amount: `Insufficient balance to cover token fee`,
      };
    }

    // Check 4: Simulates the transfer by getting the local gas fee
    const localQuote = await this.getLocalTransferFeeAmount({
      originToken,
      destination,
      sender,
      senderPubKey,
      interchainFee: interchainQuote,
      tokenFeeQuote,
      destinationToken,
    });

    const feeEstimate = { interchainQuote, localQuote };

    // Check 5: Ensure balances can cover the COMBINED amount and fees
    const maxTransfer = await this.getMaxTransferAmount({
      balance: senderBalanceAmount,
      destination,
      recipient,
      sender,
      senderPubKey,
      feeEstimate,
      destinationToken,
    });
    if (amount > maxTransfer.amount) {
      return { amount: 'Insufficient balance for gas and transfer' };
    }

    return null;
  }

  protected resolveDestinationToken({
    originToken,
    destination,
    destinationToken,
  }: {
    originToken: IToken;
    destination: ChainNameOrId;
    destinationToken?: IToken;
  }): IToken {
    const destinationName = this.multiProvider.getChainName(destination);
    const destinationCandidates = originToken
      .getConnections()
      .filter((connection) => connection.token.chainName === destinationName)
      .map((connection) => connection.token);

    assert(
      destinationCandidates.length > 0,
      `No connection found for ${destinationName}`,
    );

    if (destinationToken) {
      assert(
        destinationToken.chainName === destinationName,
        `Destination token chain mismatch for ${destinationName}`,
      );
      const matchedToken = destinationCandidates.find(
        (candidate) =>
          candidate.equals(destinationToken) ||
          tokenIdentifiersEqual(
            candidate.addressOrDenom,
            destinationToken.addressOrDenom,
          ),
      );
      assert(
        matchedToken,
        `Destination token ${destinationToken.addressOrDenom} is not connected from ${originToken.chainName} to ${destinationName}`,
      );
      return matchedToken;
    }

    assert(
      destinationCandidates.length === 1,
      `Ambiguous route to ${destinationName}; specify destination token`,
    );
    return destinationCandidates[0];
  }

  findToken(
    chainName: ChainName,
    addressOrDenom?: Address | string,
  ): Token | null {
    if (!addressOrDenom) return null;

    const results = this.tokens.filter(
      (token) =>
        token.chainName === chainName &&
        tokenIdentifiersEqual(token.addressOrDenom, addressOrDenom),
    );

    if (results.length === 1) return results[0];

    if (results.length > 1)
      throw new Error(`Ambiguous token search results for ${addressOrDenom}`);

    const chainMetadata = this.multiProvider.getChainMetadata(chainName);
    if (chainMetadata.nativeToken?.denom === addressOrDenom) {
      return Token.FromChainMetadataNativeToken(chainMetadata);
    }

    return null;
  }

  getTokenChains(): ChainName[] {
    return [...new Set(this.tokens.map((token) => token.chainName)).values()];
  }

  getTokensForChain(chainName: ChainName): Token[] {
    return this.tokens.filter((token) => token.chainName === chainName);
  }

  getTokensForRoute(origin: ChainName, destination: ChainName): Token[] {
    return this.tokens.filter(
      (token) =>
        token.chainName === origin && token.getConnectionForChain(destination),
    );
  }

  /**
   * Ensure the sender has sufficient balances for transfer and interchain gas
   */
  protected async validateDestinationCollateral(
    originTokenAmount: TokenAmount<IToken>,
    destination: ChainNameOrId,
    destinationToken?: IToken,
  ): Promise<Record<string, string> | null> {
    const valid = await this.isDestinationCollateralSufficient({
      originTokenAmount,
      destination,
      destinationToken,
    });

    if (!valid) {
      return { amount: 'Insufficient collateral on destination' };
    }
    return null;
  }

  /**
   * Ensure the sender has sufficient balances for minting
   */
  protected async validateDestinationRateLimit(
    originTokenAmount: TokenAmount<IToken>,
    destination: ChainNameOrId,
    destinationToken?: IToken,
  ): Promise<Record<string, string> | null> {
    const { token: originToken, amount } = originTokenAmount;
    const resolvedDestinationToken = this.resolveDestinationToken({
      originToken,
      destination,
      destinationToken,
    });

    if (!MINT_LIMITED_STANDARDS.includes(resolvedDestinationToken.standard)) {
      this.logger.debug(
        `${resolvedDestinationToken.symbol} does not have rate limit constraint, skipping`,
      );
      return null;
    }

    let destinationMintLimit: bigint = 0n;
    if (
      resolvedDestinationToken.standard === TokenStandard.EvmHypVSXERC20 ||
      resolvedDestinationToken.standard ===
        TokenStandard.EvmHypVSXERC20Lockbox ||
      resolvedDestinationToken.standard === TokenStandard.EvmHypXERC20 ||
      resolvedDestinationToken.standard === TokenStandard.EvmHypXERC20Lockbox
    ) {
      const adapter = resolvedDestinationToken.getAdapter(
        this.multiProvider,
      ) as IHypXERC20Adapter<unknown>;
      destinationMintLimit = await adapter.getMintLimit();

      if (
        resolvedDestinationToken.standard === TokenStandard.EvmHypVSXERC20 ||
        resolvedDestinationToken.standard ===
          TokenStandard.EvmHypVSXERC20Lockbox
      ) {
        const bufferCap = await adapter.getMintMaxLimit();
        const max = bufferCap / 2n;
        if (destinationMintLimit > max) {
          this.logger.debug(
            `Mint limit ${destinationMintLimit} exceeds max ${max}, using max`,
          );
          destinationMintLimit = max;
        }
      }
    } else if (
      resolvedDestinationToken.standard === TokenStandard.EvmHypCollateralFiat
    ) {
      const adapter = resolvedDestinationToken.getAdapter(
        this.multiProvider,
      ) as EvmHypCollateralFiatAdapter;
      destinationMintLimit = await adapter.getMintLimit();
    }

    const destinationMintLimitInOriginDecimals = convertDecimalsToIntegerString(
      resolvedDestinationToken.decimals,
      originToken.decimals,
      destinationMintLimit.toString(),
    );

    const isSufficient = BigInt(destinationMintLimitInOriginDecimals) >= amount;
    this.logger.debug(
      `${originTokenAmount.token.symbol} to ${destination} has ${
        isSufficient ? 'sufficient' : 'INSUFFICIENT'
      } rate limits`,
    );
    if (!isSufficient) return { amount: 'Rate limit exceeded on destination' };
    return null;
  }

  /**
   * Ensure the sender has sufficient balances for transfer and interchain gas
   */
  protected async validateOriginCollateral(
    originTokenAmount: TokenAmount<IToken>,
  ): Promise<Record<string, string> | null> {
    const adapter = originTokenAmount.token.getAdapter(this.multiProvider);

    if (
      originTokenAmount.token.standard === TokenStandard.EvmHypXERC20 ||
      originTokenAmount.token.standard === TokenStandard.EvmHypXERC20Lockbox
    ) {
      const burnLimit = await (
        adapter as IHypXERC20Adapter<unknown>
      ).getBurnLimit();
      if (burnLimit < BigInt(originTokenAmount.amount)) {
        return { amount: 'Insufficient burn limit on origin' };
      }
    }

    return null;
  }
}
