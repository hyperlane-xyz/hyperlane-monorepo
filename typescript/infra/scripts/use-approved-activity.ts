import { ApiKeyStamper } from '@turnkey/api-key-stamper';
import { TurnkeyClient } from '@turnkey/http';
import chalk from 'chalk';
import 'dotenv/config';

import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../config/contexts.js';
import { Role } from '../src/roles.js';
import { getSafeAndService } from '../src/utils/safe.js';

import { getArgs } from './agent-utils.js';
import { getEnvironmentConfig } from './core-utils.js';

const SAFE_ADDRESS = '0xD3cB2dB894f2c6064DD6a5286C9c7E517Ca528B5';
const CHAIN = 'ethereum';

const SAFE_TX_HASH =
  '0xe98eec7ad09629577a7a2c169e270e15af352d9fdc27176f09ed7c5e61420e41';

async function main() {
  const { environment, activityId } = await getArgs()
    .describe('activity-id', 'The ID of the approved Turnkey activity')
    .demandOption('activity-id')
    .string('activity-id').argv;

  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  // Initialize Turnkey client
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

  rootLogger.info(`Fetching result for approved activity ${activityId}...`);

  // 1. Fetch the result of the approved activity
  const activityResponse = await client.getActivity({
    activityId,
    organizationId,
  });

  const activity = activityResponse.activity;

  if (activity.status !== 'ACTIVITY_STATUS_COMPLETED') {
    rootLogger.error(
      chalk.red(
        `Activity ${activityId} is not complete. Its status is ${activity.status}.`,
      ),
    );
    rootLogger.error(
      'Please ensure the activity is approved in the Turnkey UI before running this script.',
    );
    process.exit(1);
  }

  rootLogger.info(chalk.green('Activity is approved and signature found!'));

  console.log(JSON.stringify(activity.result, null, 2));

  const signResult = activity.result.signRawPayloadResult;
  if (!signResult) {
    rootLogger.error('No sign result found');
    process.exit(1);
  }

  const v = parseInt(signResult.v, 16) + 31;
  const signature = `0x${signResult.r}${signResult.s}${v.toString(16)}`;

  // 3. Confirm the transaction on Gnosis Safe
  rootLogger.info(
    `Confirming Safe transaction ${SAFE_TX_HASH} with the fetched signature...`,
  );
  const envConfig = getEnvironmentConfig(environment);
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
  );

  const { safeService } = await getSafeAndService(
    CHAIN,
    multiProvider,
    SAFE_ADDRESS,
  );

  await safeService.confirmTransaction(SAFE_TX_HASH, signature);

  rootLogger.info(
    chalk.green.bold(
      `✅ Successfully confirmed Safe transaction ${SAFE_TX_HASH} on ${CHAIN}!`,
    ),
  );
}

main().catch((err) => {
  rootLogger.error(chalk.red('❌ Error using approved activity:'), err);
  process.exit(1);
});
