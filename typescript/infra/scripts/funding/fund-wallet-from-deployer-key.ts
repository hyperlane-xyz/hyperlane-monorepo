import { formatUnits } from 'ethers/lib/utils.js';
import { format } from 'util';

import {
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

    .string('token')
    .alias('t', 'token')
    .describe(
      'token',
      'Optional token address for the token that should be funded. The native token will be used if no address is provided',
    )

    .string('decimals')
    .alias('d', 'decimals')
    .describe(
      'decimals',
      'Optional token decimals used to format the amount into its native denomination if the token metadata cannnot be derived onchain',
    )

    .boolean('dry-run')
    .describe('dry-run', 'Simulate the transaction without sending')
    .default('dry-run', false).argv;

  const config = getEnvironmentConfig(argv.environment);
  const { recipient, amount, chain, dryRun, token, decimals } = argv;

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

  try {
    await fundAccount({
      config,
      chainName: chain!,
      recipientAddress: recipient,
      amount,
      dryRun,
      tokenAddress: token,
      tokenDecimals: decimals ? parseInt(decimals) : undefined,
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
  recipientAddress: Address;
  tokenAddress?: Address;
  tokenDecimals?: number;
  amount: string;
  dryRun: boolean;
}

async function fundAccount({
  config,
  chainName,
  recipientAddress,
  amount,
  dryRun,
  tokenAddress,
  tokenDecimals,
}: FundingParams): Promise<void> {
  const multiProtocolProvider = await config.getMultiProtocolProvider();

  const chainMetadata = multiProtocolProvider.getChainMetadata(chainName);
  const protocol = chainMetadata.protocol;

  const fundingLogger = logger.child({
    chainName,
    protocol,
  });

  const tokenPriceGetter = new CoinGeckoTokenPriceGetter({
    chainMetadata: { [chainName]: chainMetadata },
    apiKey: await getCoinGeckoApiKey(fundingLogger),
  });

  // TODO: update this to get token info if available
  let tokenPrice;
  try {
    tokenPrice = tokenAddress
      ? await tokenPriceGetter.fetchPriceDataByContractAddress(
          chainName,
          tokenAddress,
        )
      : await tokenPriceGetter.getTokenPrice(chainName);
  } catch (err) {
    fundingLogger.error(
      { chainName, err },
      `Failed to get native token price for ${chainName}, falling back to 1usd`,
    );
    tokenPrice = 1;
  }
  const fundingAmountInUsd = parseFloat(amount) * tokenPrice;

  if (fundingAmountInUsd > MAX_FUNDING_AMOUNT_IN_USD) {
    throw new Error(
      `Funding amount in USD exceeds max funding amount. Max: ${MAX_FUNDING_AMOUNT_IN_USD}. Got: ${fundingAmountInUsd}`,
    );
  }

  // Create adapter instance
  let adapter: ITokenAdapter<unknown>;
  if (tokenAddress) {
    adapter = getCollateralTokenAdapter({
      chainName,
      multiProvider: multiProtocolProvider,
      tokenAddress,
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
      `Expected decimals for ${tokenAddress ? '' : 'native'} token ${tokenAddress ?? ''} on chain "${chainName}" to be defined`,
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
      `Insufficient balance. Have: ${formatUnits(currentBalance, decimals)} ${tokenMetadata.symbol}, Need: ${amount} ${tokenMetadata.symbol}`,
    );
  }

  // Build transfer parameters based on protocol requirements
  const transferParams: TransferParams = {
    weiAmountOrId: weiAmount,
    recipient: recipientAddress,
    fromAccountOwner: fromAddress,
  };

  fundingLogger.info(
    {
      transferParams,
      dryRun,
    },
    'Preparing transfer transaction',
  );

  // Execute the transfer
  const transferTx = await adapter.populateTransferTx(transferParams);

  const protocolTypedTx = {
    transaction: transferTx,
    type: PROTOCOL_TO_DEFAULT_PROVIDER_TYPE[protocol],
  } as ProtocolTypedTransaction<typeof protocol>;

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
      senderNewBalance: formatUnits(newBalance, decimals),
      recipientBalance: formatUnits(recipientBalance, decimals),
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
