import debug, { Debugger } from 'debug';

import { ERC20__factory, ERC721__factory } from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  convertDecimals,
  eqAddress,
  isValidAddress,
} from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../providers/MultiProtocolProvider';
import {
  PROTOCOL_TO_DEFAULT_PROVIDER_TYPE,
  TypedTransaction,
} from '../providers/ProviderType';
import { Token } from '../token/Token';
import { TokenAmount } from '../token/TokenAmount';
import {
  TOKEN_COLLATERALIZED_STANDARDS,
  TokenStandard,
} from '../token/TokenStandard';
import { ChainName, ChainNameOrId } from '../types';

import {
  IgpQuoteConstants,
  RouteBlacklist,
  WarpCoreConfigSchema,
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

  // Takes the serialized representation of a complete warp config and returns a WarpCore instance
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
          connectedTokens: undefined,
        }),
    );
    // Connect tokens together
    parsedConfig.tokens.forEach((config, i) => {
      for (const connection of config.connectedTokens || []) {
        const token1 = tokens[i];
        const [_protocol, chainName, addrOrDenom] = connection.split('|');
        const token2 = tokens.find(
          (t) => t.chainName === chainName && t.addressOrDenom === addrOrDenom,
        );
        if (!token2) {
          throw new Error(
            `Connected token not found: ${chainName} ${addrOrDenom}`,
          );
        }
        token1.addConnectedToken(token2);
      }
    });
    // Create new Warp
    return new WarpCore(multiProvider, tokens, {
      igpQuoteConstants: parsedConfig.options?.igpQuoteConstants,
      routeBlacklist: parsedConfig.options?.routeBlacklist,
    });
  }

  async getTransferGasQuote(
    originToken: Token,
    destination: ChainNameOrId,
  ): Promise<TokenAmount> {
    const { chainName: originName, protocol: originProtocol } = originToken;
    const destinationName = this.multiProvider.getChainName(destination);

    // Step 1: Determine the amount

    let gasAmount: bigint;
    // Check constant quotes first
    const defaultQuote = this.igpQuoteConstants.find(
      (q) => q.origin === originName && q.destination === destinationName,
    );
    if (defaultQuote) {
      gasAmount = BigInt(defaultQuote.quote.toString());
    } else {
      // Otherwise, compute IGP quote via the adapter
      const hypAdapter = originToken.getHypAdapter(this.multiProvider);
      const destinationDomainId = this.multiProvider.getDomainId(destination);
      gasAmount = BigInt(await hypAdapter.quoteGasPayment(destinationDomainId));
    }

    // Step 2: Determine the IGP token
    // TODO, it would be more robust to determine this based on on-chain data
    // rather than these janky heuristic

    let igpToken: Token;
    if (
      originToken.igpTokenAddressOrDenom ||
      (originToken.collateralAddressOrDenom &&
        originProtocol === ProtocolType.Cosmos)
    ) {
      const address =
        originToken.igpTokenAddressOrDenom ||
        originToken.collateralAddressOrDenom;
      const searchResult = this.findToken(originName, address);
      if (!searchResult) throw new Error(`IGP token ${address} is unknown`);
      igpToken = searchResult;
    } else {
      // Otherwise use the plain old native token from the route origin
      igpToken = Token.FromChainMetadataNativeToken(
        this.multiProvider.getChainMetadata(originName),
      );
    }

    this.logger(`Quoted igp gas payment: ${gasAmount} ${igpToken.symbol}`);
    return new TokenAmount(gasAmount, igpToken);
  }

  async getTransferRemoteTxs(
    originTokenAmount: TokenAmount,
    destination: ChainNameOrId,
    sender: Address,
    recipient: Address,
  ): Promise<{ approveTx?: TypedTransaction; transferTx: TypedTransaction }> {
    const { token, amount } = originTokenAmount;
    const destinationDomainId = this.multiProvider.getDomainId(destination);
    const providerType = PROTOCOL_TO_DEFAULT_PROVIDER_TYPE[token.protocol];
    const hypAdapter = token.getHypAdapter(this.multiProvider);

    let approveTx: TypedTransaction | undefined = undefined;
    if (await this.isApproveRequired(originTokenAmount, sender)) {
      this.logger(`Approval required for transfer of ${token.symbol}`);
      const approveTxReq = await hypAdapter.populateApproveTx({
        weiAmountOrId: amount.toString(),
        recipient: token.addressOrDenom,
      });
      this.logger(`Approval tx for ${token.symbol} populated`);
      approveTx = {
        type: providerType,
        transaction: approveTxReq,
      } as TypedTransaction;
    }

    const igpQuote = await this.getTransferGasQuote(token, destination);

    const transferTxReq = await hypAdapter.populateTransferRemoteTx({
      weiAmountOrId: amount.toString(),
      destination: destinationDomainId,
      recipient,
      interchainGas: igpQuote,
    });
    this.logger(`Remote transfer tx for ${token.symbol} populated`);

    const transferTx = {
      type: providerType,
      transaction: transferTxReq,
    } as TypedTransaction;

    return { approveTx, transferTx };
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

    const destinationToken = originToken.connectedTokens?.find(
      (t) => t.chainName === destinationName,
    );
    if (!destinationToken)
      throw new Error(`No destination token found for ${destinationName}`);

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
    sender: Address,
  ): Promise<boolean> {
    const { token, amount } = originTokenAmount;
    const tokenAddress = token.addressOrDenom;
    if (token.standard !== TokenStandard.EvmHypCollateral) {
      return false;
    }

    const provider = this.multiProvider.getEthersV5Provider(token.chainName);
    let isRequired: boolean;
    if (token.isNft()) {
      const contract = ERC721__factory.connect(tokenAddress, provider);
      const approvedAddress = await contract.getApproved(amount);
      isRequired = !eqAddress(approvedAddress, tokenAddress);
    } else {
      const contract = ERC20__factory.connect(tokenAddress, provider);
      const allowance = await contract.allowance(sender, tokenAddress);
      isRequired = allowance.lt(amount);
    }
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
    // Ensure recip address is valid for the destination chain's protocol
    if (!isValidAddress(recipient, destinationMetadata.protocol))
      return { recipient: 'Invalid recipient' };
    // Also ensure the address denom is correct if the dest protocol is Cosmos
    if (destinationMetadata.protocol === ProtocolType.Cosmos) {
      if (!destinationMetadata.bech32Prefix) {
        this.logger(`No bech32 prefix found for chain ${destination}`);
        return { destination: 'Invalid chain data' };
      } else if (!recipient.startsWith(destinationMetadata.bech32Prefix)) {
        this.logger(`Recipient address prefix should be ${destination}`);
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

    // First check basic token balance
    if (amount > senderBalance) return { amount: 'Insufficient balance' };

    // Next, ensure balances can cover IGP fees
    const igpQuote = await this.getTransferGasQuote(token, destination);
    if (token.equals(igpQuote.token) || token.collateralizes(igpQuote.token)) {
      const total = amount + igpQuote.amount;
      if (senderBalance < total)
        return { amount: 'Insufficient balance for gas and transfer' };
    } else {
      const igpTokenBalance = await igpQuote.token.getBalance(
        this.multiProvider,
        sender,
      );
      if (igpTokenBalance.amount < igpQuote.amount)
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
    if (!results.length) return null;
    if (results.length > 1)
      throw new Error(`Ambiguous token search results for ${addressOrDenom}`);
    return results[0];
  }

  /**
   * Get the list of chains referenced by the tokens in this WarpCore
   */
  getTokenChains(): ChainName[] {
    return [...new Set(this.tokens.map((t) => t.chainName)).values()];
  }
}
