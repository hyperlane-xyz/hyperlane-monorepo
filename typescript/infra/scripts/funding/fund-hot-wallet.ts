import { formatUnits, parseUnits } from 'ethers/lib/utils.js';
import { format } from 'util';

import {
  ChainName,
  TOKEN_STANDARD_TO_PROVIDER_TYPE,
  Token,
  TransferParams,
  TypedTransaction,
  getSignerForChain,
} from '@hyperlane-xyz/sdk';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getDeployerKey } from '../../src/agents/key-utils.js';
import { EnvironmentConfig } from '../../src/config/environment.js';
import { assertChain } from '../../src/utils/utils.js';
import { getAgentConfig, getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const logger = rootLogger.child({ module: 'fund-hot-wallet' });

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

  // Create token instance
  logger.info({ chainName, protocol }, 'Preparing token adapter');

  const token = Token.FromChainMetadataNativeToken(chainMetadata);
  const adapter = token.getAdapter(multiProtocolProvider);

  // Get signer
  logger.info({ chainName, protocol }, 'Retrieving signer info');

  const agentConfig = getAgentConfig(Contexts.Hyperlane, config.environment);
  const privateKeyAgent = getDeployerKey(agentConfig, chainName);

  await privateKeyAgent.fetch();
  const signer = await getSignerForChain(
    chainName,
    {
      privateKey: privateKeyAgent.privateKey,
      address: privateKeyAgent.address,
    },
    multiProtocolProvider,
  );

  logger.info({ chainName, protocol }, 'Performing pre transaction checks');

  // Check balance before transfer
  const fromAddress = await signer.address();
  const currentBalance = await adapter.getBalance(fromAddress);

  logger.info(
    {
      fromAddress,
      currentBalance: currentBalance.toString(),
      symbol: token.symbol,
    },
    'Current sender balance',
  );

  // Convert amount to wei/smallest unit
  const decimals = token.decimals;
  const weiAmount = parseUnits(amount, decimals).toBigInt();

  logger.info(
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

  logger.info(
    {
      transferParams,
      dryRun,
    },
    'Preparing transfer transaction',
  );

  // Execute the transfer
  const transferTx = await adapter.populateTransferTx(transferParams);

  const protocolTypedTx: TypedTransaction = {
    transaction: transferTx as any,
    type: TOKEN_STANDARD_TO_PROVIDER_TYPE[token.standard] as any,
  };

  console.log(JSON.stringify(protocolTypedTx, null, 2));

  if (dryRun || true) {
    logger.info('DRY RUN: Would execute transfer with above parameters');
    return;
  }

  await signer.sendTransaction(protocolTypedTx as any);

  // Verify the transfer
  const newBalance = await adapter.getBalance(fromAddress);
  const recipientBalance = await adapter.getBalance(recipientAddress);

  logger.info(
    {
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
