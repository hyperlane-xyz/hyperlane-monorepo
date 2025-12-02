import { formatUnits } from 'ethers/lib/utils.js';
import { format } from 'util';

import {
  ChainMap,
  ChainName,
  CoinGeckoTokenPriceGetter,
  ITokenAdapter,
  MultiProtocolSignerSignerAccountInfo,
  PROTOCOL_TO_DEFAULT_PROVIDER_TYPE,
  ProtocolTypedTransaction,
  Token,
  TransferParams,
  getCollateralTokenAdapter,
  getSignerForChain,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  assert,
  rootLogger,
  toWei,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getDeployerKey } from '../../src/agents/key-utils.js';
import { getCoinGeckoApiKey } from '../../src/coingecko/utils.js';
import { EnvironmentConfig } from '../../src/config/environment.js';
import { tokens as knownInfraTokens } from '../../src/config/warp.js';
import { assertChain } from '../../src/utils/utils.js';
import { getAgentConfig, getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const logger = rootLogger.child({
  module: 'fund-hot-wallet',
});
/**
 * For solana deployments at least 2.5 SOL are needed for rent.
 * As of 11/09/2025 the price is ~$227 meaning that 2.5 SOL are
 * ~$600.
 *
 * Ethereum mainnet deployments can be expensive too depending
 * on network activity. As the price is ~$4400, $1000 should be enough
 * to cover mainnet costs
 */
const MAX_FUNDING_AMOUNT_IN_USD = 1000;

const enum TokenFundingType {
  native = 'native',
  non_native = 'non_native',
}

type TokenToFundInfo =
  | {
      type: TokenFundingType.native;
      amount: number;
      recipientAddress: Address;
      tokenDecimals?: number;
    }
  | {
      type: TokenFundingType.non_native;
      tokenAddress: Address;
      amount: number;
      recipientAddress: Address;
      tokenDecimals?: number;
    };

async function main() {
  const argv = await getArgs()
    .string('recipient')
    .alias('r', 'recipient')
    .describe('recipient', 'The address to fund')
    .demandOption('recipient')

    .string('amount')
    .alias('a', 'amount')
    .describe(
      'amount',
      'Amount to send (in token units, e.g., "1.5" for 1.5 ETH)',
    )
    .demandOption('amount')

    .string('chain')
    .alias('c', 'chain')
    .describe('chain', 'Chain name to send funds on')
    .demandOption('chain')
    .coerce('chain', assertChain)

    .string('symbol')
    .alias('s', 'symbol')
    .describe(
      'symbol',
      'Token symbol for the token to send in this transfer. If the token is not known provide the token address with the --token flag instead',
    )
    .conflicts('symbol', 'token')

    .string('token')
    .alias('t', 'token')
    .describe(
      'token',
      'Optional token address for the token that should be funded. The native token will be used if no address is provided',
    )
    .conflicts('token', 'symbol')

    .string('decimals')
    .alias('d', 'decimals')
    .describe(
      'decimals',
      'Optional token decimals used to format the amount into its native denomination if the token metadata cannot be derived on chain',
    )

    .boolean('dry-run')
    .describe('dry-run', 'Simulate the transaction without sending')
    .default('dry-run', false).argv;

  const config = getEnvironmentConfig(argv.environment);
  const { recipient, amount, chain, dryRun, token, decimals, symbol } = argv;

  logger.info(
    {
      recipient,
      amount,
      chain,
      dryRun,
      token: token ?? 'native token',
    },
    'Starting funding operation',
  );

  assert(chain, 'Chain is required');

  let tokenToFundInfo: TokenToFundInfo;
  if (symbol) {
    const registry = await config.getRegistry();

    const warpRoutes = await registry.getWarpRoutes();
    const knownTokenAddresses: ChainMap<Record<string, string>> = {};
    Object.values(warpRoutes).forEach(({ tokens }) =>
      tokens.forEach((tokenConfig) => {
        if (!tokenConfig.collateralAddressOrDenom) {
          return;
        }

        const knownTokensForCurrentChain =
          (knownInfraTokens as Record<ChainName, Record<string, string>>)[
            tokenConfig.chainName
          ] ?? {};

        knownTokenAddresses[tokenConfig.chainName] ??= {};
        knownTokenAddresses[tokenConfig.chainName][
          tokenConfig.symbol.toLowerCase()
        ] =
          // Default to the address in the infra mapping if one exists
          knownTokensForCurrentChain[tokenConfig.symbol.toLowerCase()] ??
          tokenConfig.collateralAddressOrDenom;
      }),
    );

    const tokenAddress = knownTokenAddresses[chain]?.[symbol.toLowerCase()];
    assert(
      tokenAddress,
      `An address was not found for token with symbol "${symbol}" on chain "${chain}". Please provide the token address instead`,
    );

    tokenToFundInfo = {
      amount: parseFloat(amount),
      recipientAddress: recipient,
      tokenAddress,
      type: TokenFundingType.non_native,
      tokenDecimals: decimals ? parseInt(decimals) : undefined,
    };
  } else if (token) {
    tokenToFundInfo = {
      type: TokenFundingType.non_native,
      amount: parseFloat(amount),
      recipientAddress: recipient,
      tokenAddress: token,
      tokenDecimals: decimals ? parseInt(decimals) : undefined,
    };
  } else {
    tokenToFundInfo = {
      type: TokenFundingType.native,
      amount: parseFloat(amount),
      recipientAddress: recipient,
      tokenDecimals: decimals ? parseInt(decimals) : undefined,
    };
  }

  try {
    await fundAccount({
      config,
      chainName: chain,
      dryRun,
      fundInfo: tokenToFundInfo,
    });

    logger.info('Funding operation completed successfully');
  } catch (error) {
    logger.error(
      {
        error: format(error),
        chain,
        recipient,
        amount,
      },
      'Funding operation failed',
    );
    process.exit(1);
  }
}

interface FundingParams {
  config: EnvironmentConfig;
  chainName: ChainName;
  fundInfo: TokenToFundInfo;
  dryRun: boolean;
}

async function fundAccount({
  config,
  chainName,
  dryRun,
  fundInfo,
}: FundingParams): Promise<void> {
  const { amount, recipientAddress, tokenDecimals } = fundInfo;

  const multiProtocolProvider = await config.getMultiProtocolProvider();

  const chainMetadata = multiProtocolProvider.getChainMetadata(chainName);
  const protocol = chainMetadata.protocol;

  const fundingLogger = logger.child({
    chainName,
    protocol,
    type: fundInfo.type,
  });

  const tokenPriceGetter = new CoinGeckoTokenPriceGetter({
    chainMetadata: { [chainName]: chainMetadata },
    apiKey: await getCoinGeckoApiKey(fundingLogger),
  });

  let tokenPrice;
  try {
    if (fundInfo.type === TokenFundingType.non_native) {
      tokenPrice = await tokenPriceGetter.fetchPriceDataByContractAddress(
        chainName,
        fundInfo.tokenAddress,
      );
    } else {
      tokenPrice = await tokenPriceGetter.getTokenPrice(chainName);
    }
  } catch (err) {
    fundingLogger.error(
      { err },
      `Failed to get token price for ${chainName}, falling back to 1usd`,
    );
    tokenPrice = 1;
  }
  const fundingAmountInUsd = amount * tokenPrice;

  if (fundingAmountInUsd > MAX_FUNDING_AMOUNT_IN_USD) {
    throw new Error(
      `Funding amount in USD exceeds max funding amount. Max: ${MAX_FUNDING_AMOUNT_IN_USD}. Got: ${fundingAmountInUsd}`,
    );
  }

  // Create adapter instance
  let adapter: ITokenAdapter<unknown>;
  if (fundInfo.type === TokenFundingType.non_native) {
    adapter = getCollateralTokenAdapter({
      chainName,
      multiProvider: multiProtocolProvider,
      tokenAddress: fundInfo.tokenAddress,
    });
  } else {
    const tokenInstance = Token.FromChainMetadataNativeToken(chainMetadata);
    adapter = tokenInstance.getAdapter(multiProtocolProvider);
  }

  let tokenMetadata: {
    name: string;
    symbol: string;
    decimals: number;
  };
  try {
    const { name, symbol, decimals } = await adapter.getMetadata();
    assert(
      decimals,
      `Expected decimals for ${fundInfo.type} token funding of ${fundInfo.type === TokenFundingType.non_native ? fundInfo.tokenAddress : ''} on chain "${chainName}" to be defined`,
    );

    tokenMetadata = {
      name,
      symbol,
      decimals,
    };
  } catch (err) {
    fundingLogger.error(
      { err },
      `Failed to get token metadata for ${chainName}`,
    );

    assert(
      tokenDecimals,
      `tokenDecimals is required as the token metadata can't be derived on chain`,
    );

    tokenMetadata = {
      name: 'NAME NOT SPECIFIED',
      symbol: 'SYMBOL NOT SPECIFIED',
      decimals: tokenDecimals,
    };
  }

  // Get signer
  const agentConfig = getAgentConfig(Contexts.Hyperlane, config.environment);
  const privateKeyAgent = getDeployerKey(agentConfig, chainName);

  await privateKeyAgent.fetch();

  let accountInfo: MultiProtocolSignerSignerAccountInfo;
  if (protocol === ProtocolType.Starknet) {
    const address = privateKeyAgent.addressForProtocol(protocol);
    assert(address, `missing private key address for protocol ${protocol}`);

    accountInfo = {
      protocol,
      address,
      privateKey: privateKeyAgent.privateKeyForProtocol(protocol),
    };
  } else if (protocol === ProtocolType.Sealevel) {
    accountInfo = {
      protocol,
      privateKey: privateKeyAgent.privateKeyForProtocol(protocol),
    };
  } else {
    accountInfo = {
      protocol,
      privateKey: privateKeyAgent.privateKeyForProtocol(protocol),
    } as MultiProtocolSignerSignerAccountInfo;
  }

  const signer = await getSignerForChain(
    chainName,
    accountInfo,
    multiProtocolProvider,
  );

  // Check balance before transfer
  const fromAddress = await signer.address();
  const currentBalance = await adapter.getBalance(fromAddress);

  fundingLogger.info(
    {
      fromAddress,
      currentBalance: currentBalance.toString(),
      symbol: tokenMetadata.symbol,
    },
    'Retrieved signer balance info',
  );

  // Convert amount to wei/smallest unit
  const decimals = tokenMetadata.decimals;
  const weiAmount = BigInt(toWei(amount, decimals));

  fundingLogger.info(
    {
      amount,
      decimals,
      weiAmount: weiAmount.toString(),
    },
    'Parsed transfer amount',
  );

  // Check if we have sufficient balance
  if (currentBalance < weiAmount) {
    throw new Error(
      `Insufficient balance. Have: ${formatUnits(currentBalance.toString(), decimals)} ${tokenMetadata.symbol}, Need: ${amount} ${tokenMetadata.symbol}`,
    );
  }

  // Build transfer parameters based on protocol requirements
  const transferParams: TransferParams = {
    weiAmountOrId: weiAmount,
    recipient: recipientAddress,
    fromAccountOwner: fromAddress,
  };

  // Execute the transfer
  const transferTx = await adapter.populateTransferTx(transferParams);

  const protocolTypedTx = {
    transaction: transferTx,
    type: PROTOCOL_TO_DEFAULT_PROVIDER_TYPE[protocol],
  } as ProtocolTypedTransaction<typeof protocol>;

  fundingLogger.info(
    {
      transferParams,
      dryRun,
    },
    'Prepared transfer transaction data',
  );

  if (dryRun) {
    fundingLogger.info('DRY RUN: Would execute transfer with above parameters');
    return;
  }

  const transactionHash =
    await signer.sendAndConfirmTransaction(protocolTypedTx);
  console.log(
    `Account ${recipientAddress} funded at transaction ${transactionHash}`,
  );

  // Verify the transfer
  const newBalance = await adapter.getBalance(fromAddress);
  const recipientBalance = await adapter.getBalance(recipientAddress);

  fundingLogger.info(
    {
      transactionHash,
      senderNewBalance: formatUnits(newBalance.toString(), decimals),
      recipientBalance: formatUnits(recipientBalance.toString(), decimals),
      symbol: tokenMetadata.symbol,
    },
    'Transfer completed successfully',
  );
}

main().catch((err) => {
  logger.error(
    {
      error: format(err),
    },
    'Error occurred in main',
  );
  process.exit(1);
});
