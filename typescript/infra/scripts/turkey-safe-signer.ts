import { ApiKeyStamper } from '@turnkey/api-key-stamper';
import { TurnkeySigner } from '@turnkey/ethers';
import { TurnkeyClient } from '@turnkey/http';
import chalk from 'chalk';
import 'dotenv/config';

import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  eqAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../config/contexts.js';
import { Role } from '../src/roles.js';
import {
  getPendingTxsForChains,
  getSafeAndService,
} from '../src/utils/safe.js';

import { getEnvironmentConfig } from './core-utils.js';

const SAFE_ADDRESS = '0xD3cB2dB894f2c6064DD6a5286C9c7E517Ca528B5';
const AW_TURKEY_SIGNER_ADDRESS = '0xC42DA54b9De34e857a2ab5F79a0cA1E9b3AABd6b';
const CHAIN = 'ethereum';

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  const apiPublicKey = process.env.API_PUBLIC_KEY!;
  const apiPrivateKey = process.env.API_PRIVATE_KEY!;
  const organizationId = process.env.ORGANIZATION_ID!;

  if (!apiPublicKey || !apiPrivateKey || !organizationId) {
    rootLogger.error('Missing required environment variables');
    process.exit(1);
  }

  const client = new TurnkeyClient(
    { baseUrl: 'https://api.turnkey.com' },
    new ApiKeyStamper({
      apiPublicKey,
      apiPrivateKey,
    }),
  );

  const turnkeySigner = new TurnkeySigner({
    client,
    organizationId,
    signWith: AW_TURKEY_SIGNER_ADDRESS,
  });

  const address = await turnkeySigner.getAddress();
  rootLogger.info(
    `Successfully initialized Turnkey signer for address: ${address}`,
  );

  const envConfig = getEnvironmentConfig('mainnet3');
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    [CHAIN],
  );

  multiProvider.setSigner(CHAIN, turnkeySigner);

  rootLogger.info('Checking for pending Safe transactions...');
  const pendingTxs = await getPendingTxsForChains([CHAIN], multiProvider, {
    [CHAIN]: SAFE_ADDRESS,
  });

  if (pendingTxs.length === 0) {
    rootLogger.info('No pending transactions found to sign.');
    return;
  }

  rootLogger.info(`Found ${pendingTxs.length} pending transaction(s).`);
  console.table(pendingTxs);

  const txToSign = pendingTxs[0];
  rootLogger.info(
    `Attempting to sign transaction with nonce ${txToSign.nonce} and hash ${txToSign.fullTxHash}`,
  );

  const { safeSdk, safeService } = await getSafeAndService(
    CHAIN,
    multiProvider,
    SAFE_ADDRESS,
  );

  // Check if the signer has already signed
  const transaction = await safeService.getTransaction(txToSign.fullTxHash);
  const signerAddress = await multiProvider.getSignerAddress(CHAIN);
  const isAlreadySigned = transaction.confirmations?.some((conf) =>
    eqAddress(conf.owner, signerAddress),
  );

  if (isAlreadySigned) {
    rootLogger.info(
      `Transaction ${txToSign.fullTxHash} is already signed by ${signerAddress}.`,
    );
    return;
  }

  try {
    const signature = await safeSdk.signTransactionHash(txToSign.fullTxHash);
    await safeService.confirmTransaction(txToSign.fullTxHash, signature.data);
    rootLogger.info(
      chalk.green(
        `Successfully signed Safe transaction with hash ${txToSign.fullTxHash}`,
      ),
    );
  } catch (error) {
    rootLogger.error(
      chalk.red(
        `Failed to sign Safe transaction with hash ${txToSign.fullTxHash}:`,
      ),
      error,
    );
  }
}

main().then(console.log).catch(console.error);
