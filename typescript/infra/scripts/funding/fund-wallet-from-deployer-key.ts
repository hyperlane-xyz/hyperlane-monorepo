import { ethers } from 'ethers';
import { formatUnits, parseUnits } from 'ethers/lib/utils.js';
import { format } from 'util';

import {
  ChainName,
  CoinGeckoTokenPriceGetter,
  MultiProtocolSignerSignerAccountInfo,
  ProtocolTypedTransaction,
  TOKEN_STANDARD_TO_PROVIDER_TYPE,
  Token,
  TransferParams,
  getSignerForChain,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  assert,
  rootLogger,
  strip0x,
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

    .boolean('dry-run')
    .describe('dry-run', 'Simulate the transaction without sending')
    .default('dry-run', false).argv;

  const config = getEnvironmentConfig(argv.environment);
  const { recipient, amount, chain, dryRun } = argv;

  logger.info(
    {
      recipient,
      amount,
      chain,
      dryRun,
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
  amount: string;
  dryRun: boolean;
}

async function fundAccount({
  config,
  chainName,
  recipientAddress,
  amount,
  dryRun,
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

  let tokenPrice;
  try {
    tokenPrice = await tokenPriceGetter.getTokenPrice(chainName);
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

  // Create token instance
  const token = Token.FromChainMetadataNativeToken(chainMetadata);
  const adapter = token.getAdapter(multiProtocolProvider);

  // Get signer
  fundingLogger.info('Retrieved signer info');

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

  fundingLogger.info(
    { chainName, protocol },
    'Performing pre transaction checks',
  );

  // Check balance before transfer
  const fromAddress = await signer.address();
  const currentBalance = await adapter.getBalance(fromAddress);

  fundingLogger.info(
    {
      fromAddress,
      currentBalance: currentBalance.toString(),
      symbol: token.symbol,
    },
    'Current sender balance',
  );

  // Convert amount to wei/smallest unit
  const decimals = token.decimals;
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
      `Insufficient balance. Have: ${formatUnits(currentBalance, decimals)} ${token.symbol}, Need: ${amount} ${token.symbol}`,
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
    type: TOKEN_STANDARD_TO_PROVIDER_TYPE[token.standard],
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
      symbol: token.symbol,
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
