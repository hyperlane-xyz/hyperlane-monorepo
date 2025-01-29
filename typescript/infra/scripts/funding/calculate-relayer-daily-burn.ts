import postgres, { Sql } from 'postgres';

import { ChainMap } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import rawDailyRelayerBurn from '../../config/environments/mainnet3/balances/dailyRelayerBurn.json';
import { mainnet3SupportedChainNames } from '../../config/environments/mainnet3/supportedChainNames.js';
import rawTokenPrices from '../../config/environments/mainnet3/tokenPrices.json';
import { RELAYER_MIN_DOLLAR_BALANCE_PER_DAY } from '../../src/config/funding/balances.js';
import { formatDailyRelayerBurn } from '../../src/funding/grafana.js';
import { fetchLatestGCPSecret } from '../../src/utils/gcloud.js';
import { writeJsonAtPath } from '../../src/utils/utils.js';

const tokenPrices: ChainMap<string> = rawTokenPrices;
const currentDailyRelayerBurn: ChainMap<number> = rawDailyRelayerBurn;

const DAILY_BURN_PATH =
  './config/environments/mainnet3/balances/dailyRelayerBurn.json';

const LOOK_BACK_DAYS = 10; // the number of days to look back for average destination tx costs
const MIN_NUMBER_OF_TXS = 200; // the minimum number of txs to consider for daily burn

async function main() {
  const chainsMissingInTokenPrices = mainnet3SupportedChainNames.filter(
    (chain) => !(chain in tokenPrices),
  );

  if (chainsMissingInTokenPrices.length > 0) {
    rootLogger.error(
      `Token prices missing for chains: ${chainsMissingInTokenPrices.join(
        ', ',
      )} consider adding them to tokenPrices.json and running the script again.`,
    );
    process.exit(1);
  }

  const sql = await getReadOnlyScraperDb();
  let burnData: ChainMap<number>;
  try {
    burnData = await getDailyRelayerBurn(sql);
  } catch (err) {
    rootLogger.error('Error fetching daily burn data:', err);
    process.exit(1);
  } finally {
    await sql.end();
  }

  console.table(burnData);

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

async function fetchDailyRelayerBurnData(sql: Sql) {
  const results = await sql`
    WITH
      look_back_stats AS (
        SELECT
          dest_domain.name AS domain_name,
          COUNT(*) AS total_messages,
          (
            SUM(
              mv.destination_tx_gas_used * mv.destination_tx_effective_gas_price
            ) / POWER(10, 18)
          ) / COUNT(*) AS avg_tx_cost_native,
          COUNT(*) / ${LOOK_BACK_DAYS} AS avg_daily_messages
        FROM
          message_view mv
          LEFT JOIN DOMAIN dest_domain ON mv.destination_domain_id = dest_domain.id
        WHERE
          mv.send_occurred_at >= CURRENT_TIMESTAMP - (INTERVAL '1 day' * ${LOOK_BACK_DAYS})
          AND dest_domain.is_test_net IS FALSE
          AND mv.destination_domain_id not in (1408864445, 1399811149) -- ignore sealevel chains as scraper does not capture all costs
          AND mv.is_delivered IS TRUE
        GROUP BY
          dest_domain.name
      )
    SELECT
      domain_name as chain,
      GREATEST(
        avg_tx_cost_native * ${MIN_NUMBER_OF_TXS}, 
        avg_tx_cost_native * avg_daily_messages
      ) as daily_burn
    FROM
      look_back_stats
    ORDER BY
      domain_name;
  `;
  return results;
}

async function getDailyRelayerBurn(sql: Sql) {
  const dailyRelayerBurnQueryResults = await fetchDailyRelayerBurnData(sql);

  const burn: Record<string, number> = {};
  for (const chain of Object.keys(tokenPrices)) {
    const row = dailyRelayerBurnQueryResults.find((row) => row.chain === chain);

    // minimum native balance required to maintain our desired minimum dollar balance in the relayer
    const minNativeBalance =
      RELAYER_MIN_DOLLAR_BALANCE_PER_DAY / parseFloat(tokenPrices[chain]);

    // some chains may have had no messages in the look back window so we set daily burn based on the minimum dollar balance
    const proposedDailyRelayerBurn =
      row === undefined
        ? minNativeBalance
        : Math.max(row.daily_burn, minNativeBalance);

    // only update the daily burn if the proposed daily burn is greater than the current daily burn
    // add the chain to the daily burn if it doesn't exist
    const newDailyRelayerBurn =
      chain in currentDailyRelayerBurn
        ? Math.max(proposedDailyRelayerBurn, currentDailyRelayerBurn[chain])
        : proposedDailyRelayerBurn;

    burn[chain] = formatDailyRelayerBurn(newDailyRelayerBurn);
  }

  return burn;
}

main().catch((err) => {
  rootLogger.error('Error:', err);
  process.exit(1);
});
