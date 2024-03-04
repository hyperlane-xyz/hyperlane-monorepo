import debug, { Debugger } from 'debug';

import {
  Address,
  ProtocolType,
  assert,
  convertDecimals,
  convertToProtocolAddress,
  isValidAddress,
} from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../providers/MultiProtocolProvider';
import { TransactionFeeEstimate } from '../providers/transactionFeeEstimators';
import { IToken } from '../token/IToken';
import { Token } from '../token/Token';
import { TokenAmount } from '../token/TokenAmount';
import { parseTokenConnectionId } from '../token/TokenConnection';
import {
  TOKEN_COLLATERALIZED_STANDARDS,
  TOKEN_STANDARD_TO_PROVIDER_TYPE,
} from '../token/TokenStandard';
import { EVM_TRANSFER_REMOTE_GAS_ESTIMATE } from '../token/adapters/EvmTokenAdapter';
import { ChainName, ChainNameOrId } from '../types';

import {
  IgpQuoteConstants,
  RouteBlacklist,
  WarpCoreConfigSchema,
  WarpCoreFeeEstimate,
  WarpTxCategory,
  WarpTypedTransaction,
} from './types';

export interface WarpCoreOptions {
  loggerName?: string;
  igpQuoteConstants?: IgpQuoteConstants;
  routeBlacklist?: RouteBlacklist;
}

export class WarpCore {
  public readonly multiProvider: MultiProtocolProvider<{ mailbox?: Address }>;
  public readonly tokens: Token[];
  public readonly igpQuoteConstants: IgpQuoteConstants;
  public readonly routeBlacklist: RouteBlacklist;
  public readonly logger: Debugger;

  constructor(
    multiProvider: MultiProtocolProvider<{ mailbox?: Address }>,
    tokens: Token[],
    options?: WarpCoreOptions,
  ) {
    this.multiProvider = multiProvider;
    this.tokens = tokens;
    this.igpQuoteConstants = options?.igpQuoteConstants || [];
    this.routeBlacklist = options?.routeBlacklist || [];
    this.logger = debug(options?.loggerName || 'hyperlane:WarpCore');
  }

  /**
   * Takes the serialized representation of a warp config and returns a WarpCore instance
   * @param multiProvider the MultiProtocolProvider containing chain metadata
   * @param config the config object of type WarpCoreConfig
   */
  static FromConfig(
    multiProvider: MultiProtocolProvider<{ mailbox?: Address }>,
    config: unknown,
  ): WarpCore {
    // Validate and parse config data
    const parsedConfig = WarpCoreConfigSchema.parse(config);
    // Instantiate all tokens
    const tokens = parsedConfig.tokens.map(
      (t) =>
        new Token({
          ...t,
          addressOrDenom: t.addressOrDenom || '',
          connections: undefined,
        }),
    );
    // Connect tokens together
    parsedConfig.tokens.forEach((config, i) => {
      for (const connection of config.connections || []) {
        const token1 = tokens[i];
        const { chainName, addressOrDenom } = parseTokenConnectionId(
          connection.token,
        );
        const token2 = tokens.find(
          (t) =>
            t.chainName === chainName && t.addressOrDenom === addressOrDenom,
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
    // Create new Warp
    return new WarpCore(multiProvider, tokens, {
      igpQuoteConstants: parsedConfig.options?.igpQuoteConstants,
      routeBlacklist: parsedConfig.options?.routeBlacklist,
    });
  }

  /**
   * Queries the token router for an interchain gas quote (i.e. IGP fee)
   */
  async getInterchainTransferFee(
    originToken: IToken,
    destination: ChainNameOrId,
  ): Promise<TokenAmount> {
    this.logger(`Fetching interchain transfer quote to ${destination}`);
    const { chainName: originName } = originToken;
    const destinationName = this.multiProvider.getChainName(destination);

    let gasAmount: bigint;
    let gasAddressOrDenom: string | undefined;
    // Check constant quotes first
    const defaultQuote = this.igpQuoteConstants.find(
      (q) => q.origin === originName && q.destination === destinationName,
    );
    if (defaultQuote) {
      gasAmount = BigInt(defaultQuote.amount.toString());
      gasAddressOrDenom = defaultQuote.addressOrDenom;
    } else {
      // Otherwise, compute IGP quote via the adapter
      const hypAdapter = originToken.getHypAdapter(
        this.multiProvider,
        destinationName,
      );
      const destinationDomainId = this.multiProvider.getDomainId(destination);
      const quote = await hypAdapter.quoteTransferRemoteFee(
        destinationDomainId,
      );
      gasAmount = BigInt(quote.amount);
      gasAddressOrDenom = quote.addressOrDenom;
    }

    let igpToken: Token;
    if (!gasAddressOrDenom) {
      // An empty/undefined addressOrDenom indicates the native token
      igpToken = Token.FromChainMetadataNativeToken(
        this.multiProvider.getChainMetadata(originName),
      );
    } else {
      const searchResult = this.findToken(originName, gasAddressOrDenom);
      assert(searchResult, `Fee token ${gasAddressOrDenom} is unknown`);
      igpToken = searchResult;
    }

    this.logger(
      `Quoted interchain transfer fee: ${gasAmount} ${igpToken.symbol}`,
    );
    return new TokenAmount(gasAmount, igpToken);
  }

  /**
   * Simulates a transfer to estimate 'local' gas fees on the origin chain
   */
  async getLocalTransferFee(
    originToken: IToken,
    destination: ChainNameOrId,
    sender: Address,
  ): Promise<TransactionFeeEstimate> {
    const originMetadata = this.multiProvider.getChainMetadata(
      originToken.chainName,
    );
    const destinationMetadata =
      this.multiProvider.getChainMetadata(destination);

    // Form transactions to estimate local gas with
    const recipient = convertToProtocolAddress(
      sender,
      destinationMetadata.protocol,
      destinationMetadata.bech32Prefix,
    );
    const txs = await this.getTransferRemoteTxs(
      originToken.amount(1),
      destination,
      sender,
      recipient,
    );

    if (txs.length === 1) {
      return this.multiProvider.estimateTransactionFee(
        originMetadata.name,
        txs[0],
        sender,
      );
    } else if (
      txs.length === 2 &&
      originToken.protocol === ProtocolType.Ethereum
    ) {
      // For ethereum txs that require >1 tx, we assume the first is an approval
      // We use a hard-coded const as an estimate for the transferRemote gas
      const provider = this.multiProvider.getEthersV5Provider(
        originMetadata.name,
      );
      const gasPrice = BigInt((await provider.getGasPrice()).toString());
      const fee = EVM_TRANSFER_REMOTE_GAS_ESTIMATE * gasPrice;
      return {
        gasUnits: EVM_TRANSFER_REMOTE_GAS_ESTIMATE,
        gasPrice,
        fee,
      };
    } else {
      throw new Error('Cannot estimate local gas for multiple transactions');
    }
  }

  /**
   * Gets a list of populated transactions required to transfer a token to a remote chain
   * Typically just 1 transaction but sometimes more, like when an approval is required first
   */
  async getTransferRemoteTxs(
    originTokenAmount: TokenAmount,
    destination: ChainNameOrId,
    sender: Address,
    recipient: Address,
  ): Promise<Array<WarpTypedTransaction>> {
    const transactions: Array<WarpTypedTransaction> = [];

    const { token, amount } = originTokenAmount;
    const destinationName = this.multiProvider.getChainName(destination);
    const destinationDomainId = this.multiProvider.getDomainId(destination);
    const providerType = TOKEN_STANDARD_TO_PROVIDER_TYPE[token.standard];
    const hypAdapter = token.getHypAdapter(this.multiProvider, destinationName);

    if (await this.isApproveRequired(originTokenAmount, sender)) {
      this.logger(`Approval required for transfer of ${token.symbol}`);
      const approveTxReq = await hypAdapter.populateApproveTx({
        weiAmountOrId: amount.toString(),
        recipient: token.addressOrDenom,
      });
      this.logger(`Approval tx for ${token.symbol} populated`);

      const approveTx = {
        category: WarpTxCategory.Approval,
        type: providerType,
        transaction: approveTxReq,
      } as WarpTypedTransaction;
      transactions.push(approveTx);
    }

    const interchainGasAmount = await this.getInterchainTransferFee(
      token,
      destination,
    );

    const transferTxReq = await hypAdapter.populateTransferRemoteTx({
      weiAmountOrId: amount.toString(),
      destination: destinationDomainId,
      fromAccountOwner: sender,
      recipient,
      interchainGas: {
        amount: interchainGasAmount.amount,
        addressOrDenom: interchainGasAmount.token.addressOrDenom,
      },
    });
    this.logger(`Remote transfer tx for ${token.symbol} populated`);

    const transferTx = {
      category: WarpTxCategory.Transfer,
      type: providerType,
      transaction: transferTxReq,
    } as WarpTypedTransaction;
    transactions.push(transferTx);

    return transactions;
  }

  /**
   * Fetch local and interchain fee estimates for a remote transfer
   */
  async estimateTransferRemoteFees(
    originToken: IToken,
    destination: ChainNameOrId,
    sender: Address,
  ): Promise<WarpCoreFeeEstimate> {
    this.logger('Fetching remote transfer fee estimates');

    const originMetadata = this.multiProvider.getChainMetadata(
      originToken.chainName,
    );
    // If there's no native token, we can't represent local gas
    if (!originMetadata.nativeToken)
      throw new Error(`No native token found for ${originMetadata.name}`);

    // First, get the local gas quote
    const localFee = await this.getLocalTransferFee(
      originToken,
      destination,
      sender,
    );

    // Get the local gas token. This assumes the chain's native token will pay for local gas
    // This will need to be smarter if more complex scenarios on Cosmos are supported
    const localGasToken = Token.FromChainMetadataNativeToken(originMetadata);
    const localQuote = localGasToken.amount(localFee.fee);

    // Next, get interchain gas quote (aka IGP quote)
    const interchainQuote = await this.getInterchainTransferFee(
      originToken,
      destination,
    );

    return {
      interchainQuote,
      localQuote,
      localDetails: localFee,
    };
  }

  /**
   * Computes the max transferrable amount of the from the given
   * token balance, accounting for local and interchain gas fees
   */
  async getMaxTransferAmount(
    balance: TokenAmount,
    destination: ChainNameOrId,
    sender: Address,
    feeEstimate?: WarpCoreFeeEstimate,
  ): Promise<TokenAmount> {
    const originToken = balance.token;

    if (!feeEstimate) {
      feeEstimate = await this.estimateTransferRemoteFees(
        originToken,
        destination,
        sender,
      );
    }
    const { localQuote, interchainQuote } = feeEstimate;

    let maxAmount = balance;
    if (
      originToken.equals(localQuote.token) ||
      originToken.collateralizes(localQuote.token)
    ) {
      maxAmount = maxAmount.minus(localQuote.amount);
    }

    if (
      originToken.equals(interchainQuote.token) ||
      originToken.collateralizes(interchainQuote.token)
    ) {
      maxAmount = maxAmount.minus(interchainQuote.amount);
    }

    if (maxAmount.amount > 0) return maxAmount;
    else return originToken.amount(0);
  }

  /**
   * Checks if destination chain's collateral is sufficient to cover the transfer
   */
  async isDestinationCollateralSufficient(
    originTokenAmount: TokenAmount,
    destination: ChainNameOrId,
  ): Promise<boolean> {
    const { token: originToken, amount } = originTokenAmount;
    const destinationName = this.multiProvider.getChainName(destination);
    this.logger(
      `Checking collateral for ${originToken.symbol} to ${destination}`,
    );

    const destinationToken =
      originToken.getConnectionForChain(destinationName)?.token;
    assert(destinationToken, `No connection found for ${destinationName}`);

    if (!TOKEN_COLLATERALIZED_STANDARDS.includes(destinationToken.standard)) {
      this.logger(`${destinationToken.symbol} is not collateralized, skipping`);
      return true;
    }

    const adapter = destinationToken.getAdapter(this.multiProvider);
    const destinationBalance = await adapter.getBalance(
      destinationToken.addressOrDenom,
    );
    const destinationBalanceInOriginDecimals = convertDecimals(
      destinationToken.decimals,
      originToken.decimals,
      destinationBalance.toString(),
    );

    const isSufficient = BigInt(destinationBalanceInOriginDecimals) >= amount;
    this.logger(
      `${originTokenAmount.token.symbol} to ${destination} has ${
        isSufficient ? 'sufficient' : 'INSUFFICIENT'
      } collateral`,
    );
    return isSufficient;
  }

  /**
   * Checks if a token transfer requires an approval tx first
   */
  async isApproveRequired(
    originTokenAmount: TokenAmount,
    owner: Address,
  ): Promise<boolean> {
    const { token, amount } = originTokenAmount;
    const adapter = token.getAdapter(this.multiProvider);
    const isRequired = await adapter.isApproveRequired(
      owner,
      token.addressOrDenom,
      amount,
    );
    this.logger(
      `Approval is${isRequired ? '' : ' not'} required for transfer of ${
        token.symbol
      }`,
    );
    return isRequired;
  }

  /**
   * Ensure the remote token transfer would be valid for the given chains, amount, sender, and recipient
   */
  async validateTransfer(
    originTokenAmount: TokenAmount,
    destination: ChainNameOrId,
    sender: Address,
    recipient: Address,
  ): Promise<Record<string, string> | null> {
    const chainError = this.validateChains(
      originTokenAmount.token.chainName,
      destination,
    );
    if (chainError) return chainError;

    const recipientError = this.validateRecipient(recipient, destination);
    if (recipientError) return recipientError;

    const amountError = this.validateAmount(originTokenAmount);
    if (amountError) return amountError;

    const balancesError = await this.validateTokenBalances(
      originTokenAmount,
      destination,
      sender,
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
    if (!isValidAddress(recipient, protocol))
      return { recipient: 'Invalid recipient' };
    // Also ensure the address denom is correct if the dest protocol is Cosmos
    if (protocol === ProtocolType.Cosmos) {
      if (!bech32Prefix) {
        this.logger(`No bech32 prefix found for chain ${destination}`);
        return { destination: 'Invalid chain data' };
      } else if (!recipient.startsWith(bech32Prefix)) {
        this.logger(`Recipient prefix should be ${bech32Prefix}`);
        return { recipient: `Invalid recipient prefix` };
      }
    }
    return null;
  }

  /**
   * Ensure token amount is valid
   */
  protected validateAmount(
    originTokenAmount: TokenAmount,
  ): Record<string, string> | null {
    if (!originTokenAmount.amount || originTokenAmount.amount < 0n) {
      const isNft = originTokenAmount.token.isNft();
      return { amount: isNft ? 'Invalid Token Id' : 'Invalid amount' };
    }
    return null;
  }

  /**
   * Ensure the sender has sufficient balances for transfer and interchain gas
   */
  protected async validateTokenBalances(
    originTokenAmount: TokenAmount,
    destination: ChainNameOrId,
    sender: Address,
  ): Promise<Record<string, string> | null> {
    const { token, amount } = originTokenAmount;
    const { amount: senderBalance } = await token.getBalance(
      this.multiProvider,
      sender,
    );
    const senderBalanceAmount = originTokenAmount.token.amount(senderBalance);

    // First check basic token balance
    if (amount > senderBalance) return { amount: 'Insufficient balance' };

    // Next, ensure balances can cover the COMBINED amount and fees
    const feeEstimate = await this.estimateTransferRemoteFees(
      token,
      destination,
      sender,
    );
    const maxTransfer = await this.getMaxTransferAmount(
      senderBalanceAmount,
      destination,
      sender,
      feeEstimate,
    );
    if (amount > maxTransfer.amount) {
      return { amount: 'Insufficient balance for gas and transfer' };
    }

    // Finally, ensure there's sufficient balance for the IGP fee, which may
    // be a different token than the transfer token
    const igpQuote = feeEstimate.interchainQuote;
    const igpTokenBalance = await igpQuote.token.getBalance(
      this.multiProvider,
      sender,
    );
    if (igpTokenBalance.amount < igpQuote.amount) {
      return { amount: `Insufficient ${igpQuote.token.symbol} for gas` };
    }

    return null;
  }

  /**
   * Search through token list to find token with matching chain and address
   */
  findToken(
    chainName: ChainName,
    addressOrDenom?: Address | string,
  ): Token | null {
    if (!addressOrDenom) return null;

    const results = this.tokens.filter(
      (token) =>
        token.chainName === chainName &&
        token.addressOrDenom.toLowerCase() === addressOrDenom.toLowerCase(),
    );

    if (results.length === 1) return results[0];

    if (results.length > 1)
      throw new Error(`Ambiguous token search results for ${addressOrDenom}`);

    // If the token is not found, check to see if it matches the denom of chain's native token
    // This is a convenience so WarpConfigs don't need to include definitions for native tokens
    const chainMetadata = this.multiProvider.getChainMetadata(chainName);
    if (chainMetadata.nativeToken?.denom === addressOrDenom) {
      return Token.FromChainMetadataNativeToken(chainMetadata);
    }

    return null;
  }

  /**
   * Get the list of chains referenced by the tokens in this WarpCore
   */
  getTokenChains(): ChainName[] {
    return [...new Set(this.tokens.map((t) => t.chainName)).values()];
  }

  /**
   * Get the subset of tokens whose chain matches the given chainName
   */
  getTokensForChain(chainName: ChainName): Token[] {
    return this.tokens.filter((t) => t.chainName === chainName);
  }

  /**
   * Get the subset of tokens whose chain matches the given chainName
   * and which are connected to a token on the given destination chain
   */
  getTokensForRoute(origin: ChainName, destination: ChainName): Token[] {
    return this.tokens.filter(
      (t) => t.chainName === origin && t.getConnectionForChain(destination),
    );
  }
}
