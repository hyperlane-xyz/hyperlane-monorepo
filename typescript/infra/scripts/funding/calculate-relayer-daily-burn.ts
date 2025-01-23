import postgres, { Sql } from 'postgres';

import { ChainMap } from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import rawDailyBurn from '../../config/environments/mainnet3/balances/dailyBurn.json';
import { mainnet3SupportedChainNames } from '../../config/environments/mainnet3/supportedChainNames.js';
import rawTokenPrices from '../../config/environments/mainnet3/tokenPrices.json';
import { fetchLatestGCPSecret } from '../../src/utils/gcloud.js';
import { writeJsonAtPath } from '../../src/utils/utils.js';

import { RELAYER_MIN_DOLLAR_BALANCE_PER_DAY } from './utils/constants.js';
import { formatDailyBurn } from './utils/utils.js';

const tokenPrices: ChainMap<string> = rawTokenPrices;
const currentDailyBurn: ChainMap<number> = rawDailyBurn;

const DAILY_BURN_PATH =
  './config/environments/mainnet3/balances/dailyBurn.json';

const LOOKBACK_DAYS = 10; // the number of days to look back for average destination tx costs
const MIN_NUMBER_OF_TXS = 200; // the minimum number of txs to consider for daily burn

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  const sql = await getReadOnlyScraperDb();
  let burnData: ChainMap<number>;
  try {
    burnData = await getRelayerDailyBurn(sql);
  } catch (err) {
    rootLogger.error('Error fetching daily burn data:', err);
    process.exit(1);
  } finally {
    await sql.end();
  }

  const burnArray = Object.entries(burnData).map(([chain, dailyBurn]) => ({
    chain,
    dailyBurn,
  }));

  console.table(burnArray);

  const chainsMissingInTokenPrices = mainnet3SupportedChainNames.filter(
    (chain) => !(chain in tokenPrices),
  );

  if (chainsMissingInTokenPrices.length > 0) {
    rootLogger.error(
      `Token prices missing for chains: ${chainsMissingInTokenPrices.join(
        ', ',
      )} consider adding them to tokenPrices.json and running the script again.`,
    );
  }

  try {
    rootLogger.info('Writing daily burn data to file..');
    writeJsonAtPath(DAILY_BURN_PATH, burnData);
    rootLogger.info('Daily burn data written to file.');
  } catch (err) {
    rootLogger.error('Error writing daily burn data to file:', err);
  }
}

async function getReadOnlyScraperDb() {
  const credentialsUrl = await fetchLatestGCPSecret(
    'hyperlane-mainnet3-scraper3-db-read-only',
  );
  return postgres(credentialsUrl);
}

async function fetchDailyBurnData(sql: Sql) {
  const results = await sql`
    WITH
      lookback_stats AS (
        SELECT
          dest_domain.name AS domain_name,
          AVG(
            mv.destination_tx_gas_used * mv.destination_tx_effective_gas_price
          ) / POWER(10, 18) AS avg_tx_cost_native,
          COUNT(*) / ${LOOKBACK_DAYS} AS avg_daily_messages
        FROM
          message_view mv
          LEFT JOIN DOMAIN dest_domain ON mv.destination_domain_id = dest_domain.id
        WHERE
          mv.send_occurred_at >= CURRENT_TIMESTAMP - INTERVAL '10 days'
          AND dest_domain.is_test_net IS FALSE
          AND mv.is_delivered IS TRUE
        GROUP BY
          dest_domain.name
      )
    SELECT
      domain_name as chain,
      avg_tx_cost_native * ${MIN_NUMBER_OF_TXS} as tx_cost,
      avg_tx_cost_native * avg_daily_messages as avg_daily_tx_cost,
      GREATEST(avg_tx_cost_native * ${MIN_NUMBER_OF_TXS}, avg_tx_cost_native * avg_daily_messages) as daily_burn
    FROM
      lookback_stats
    ORDER BY
      domain_name;
  `;
  return results;
}

async function getRelayerDailyBurn(sql: Sql) {
  const dailyBurnQueryResults = await fetchDailyBurnData(sql);

  const burn: Record<string, number> = {};
  for (const chain of Object.keys(tokenPrices)) {
    const row = dailyBurnQueryResults.find((row) => row.chain === chain);

    // minimum native balance required to maintain a our desired minimum dollar balance in the relayer
    const minNativeBalance =
      RELAYER_MIN_DOLLAR_BALANCE_PER_DAY / parseFloat(tokenPrices[chain]);

    // some chains may have had no messages in the last 10 days so we set daily burn based in the minimum dollar balance
    const proposedDailyBurn =
      row === undefined
        ? minNativeBalance
        : Math.max(row.daily_burn, minNativeBalance);

    // only update the daily burn if the proposed daily burn is greater than the current daily burn
    // add the chain to the daily burn if it doesn't exist
    const newDailyBurn =
      chain in currentDailyBurn
        ? Math.max(proposedDailyBurn, currentDailyBurn[chain])
        : proposedDailyBurn;

    burn[chain] = formatDailyBurn(newDailyBurn);
  }

  return burn;
}

main().catch((err) => {
  rootLogger.error('Error:', err);
  process.exit(1);
});
