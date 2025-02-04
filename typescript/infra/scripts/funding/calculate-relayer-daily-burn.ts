import postgres, { Sql } from 'postgres';

import { ChainMap } from '@hyperlane-xyz/sdk';
import { ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import rawDailyRelayerBurn from '../../config/environments/mainnet3/balances/dailyRelayerBurn.json';
import rawDesiredRelayerBalances from '../../config/environments/mainnet3/balances/desiredRelayerBalances.json';
import { mainnet3SupportedChainNames } from '../../config/environments/mainnet3/supportedChainNames.js';
import rawTokenPrices from '../../config/environments/mainnet3/tokenPrices.json';
import {
  RELAYER_BALANCE_TARGET_DAYS,
  RELAYER_MIN_DOLLAR_BALANCE_PER_DAY,
} from '../../src/config/funding/balances.js';
import { formatBalanceThreshold } from '../../src/funding/grafana.js';
import { fetchLatestGCPSecret } from '../../src/utils/gcloud.js';
import { writeJsonAtPath } from '../../src/utils/utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const tokenPrices: ChainMap<string> = rawTokenPrices;
const currentDailyRelayerBurn: ChainMap<number> = rawDailyRelayerBurn;
const desiredRelayerBalances: ChainMap<string> = rawDesiredRelayerBalances;

const DAILY_BURN_PATH =
  './config/environments/mainnet3/balances/dailyRelayerBurn.json';

const LOOK_BACK_DAYS = 10; // the number of days to look back for average destination tx costs
const MIN_NUMBER_OF_TXS = 100; // the minimum number of txs to consider for daily burn

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

  const environment = 'mainnet3';
  const environmentConfig = getEnvironmentConfig(environment);
  const registry = await environmentConfig.getRegistry();
  const allMetadata = await registry.getMetadata();
  const sealevelDomainIds: ChainMap<string> = Object.values(allMetadata)
    .filter(
      (metadata) =>
        metadata.protocol == ProtocolType.Sealevel && !metadata.isTestnet,
    )
    .reduce((acc: { [key: string]: string }, metadata) => {
      acc[metadata.name] = metadata.domainId.toString();
      return acc;
    }, {});

  const sql = await getReadOnlyScraperDb();
  let burnData: ChainMap<number>;
  try {
    burnData = await getDailyRelayerBurn(sql, sealevelDomainIds);
    await sql.end();
  } catch (err) {
    rootLogger.error('Error fetching daily burn data:', err);
    process.exit(1);
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

async function fetchDailyRelayerBurnData(
  sql: Sql,
  sealevelDomainIds: string[],
) {
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
          AND mv.destination_domain_id != ALL(${sealevelDomainIds})
          AND mv.is_delivered IS TRUE
        GROUP BY
          dest_domain.name
      )
    SELECT
      domain_name AS chain,
      avg_tx_cost_native * ${MIN_NUMBER_OF_TXS} AS min_tx,
      avg_tx_cost_native * avg_daily_messages AS avg_tx_cost,
      GREATEST(
        avg_tx_cost_native * ${MIN_NUMBER_OF_TXS}, 
        avg_tx_cost_native * avg_daily_messages
      ) as daily_burn
    FROM
      look_back_stats
    ORDER BY
      domain_name
  `;

  return results;
}

async function getDailyRelayerBurn(
  sql: Sql,
  sealevelDomainIds: ChainMap<string>,
) {
  const dailyRelayerBurnQueryResults = await fetchDailyRelayerBurnData(
    sql,
    Object.values(sealevelDomainIds),
  );

  const sealevelChainNames = Object.keys(sealevelDomainIds);

  const burn: ChainMap<number> = {};
  const lowProposedDailyBurn: Array<{
    chain: string;
    proposedDailyBurn: number;
    currentDailyBurn: number;
  }> = [];
  const burnInfoTable: Array<{
    chain: string;
    proposedDailyBurn: number;
    currentDailyBurn: number;
    proposedRelayerBallanceDollars: number;
    currentRelayerBallanceDollars: number;
  }> = [];

  for (const chain of Object.keys(tokenPrices)) {
    // skip if chain is a sealevel chain
    if (chain in sealevelChainNames) {
      continue;
    }

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

    // log if proposedDailyRelayerBurn is 50% less than currentDailyRelayerBurn
    if (
      chain in currentDailyRelayerBurn &&
      proposedDailyRelayerBurn < currentDailyRelayerBurn[chain] * 0.5
    ) {
      lowProposedDailyBurn.push({
        chain,
        proposedDailyBurn: proposedDailyRelayerBurn,
        currentDailyBurn: currentDailyRelayerBurn[chain],
      });
    }

    // push to burnInfoTable
    burnInfoTable.push({
      chain,
      proposedDailyBurn: formatBalanceThreshold(proposedDailyRelayerBurn),
      currentDailyBurn: formatBalanceThreshold(
        currentDailyRelayerBurn[chain] ?? 0,
      ),
      proposedRelayerBallanceDollars: formatBalanceThreshold(
        proposedDailyRelayerBurn *
          parseFloat(tokenPrices[chain]) *
          RELAYER_BALANCE_TARGET_DAYS,
      ),
      currentRelayerBallanceDollars: formatBalanceThreshold(
        parseFloat(desiredRelayerBalances[chain]) *
          parseFloat(tokenPrices[chain]),
      ),
    });

    burn[chain] = formatBalanceThreshold(newDailyRelayerBurn);
  }

  console.table(burnInfoTable);

  if (lowProposedDailyBurn.length) {
    rootLogger.warn(
      `Proposed daily burn for the following chains are 50% less than current daily burn. Consider manually reviewing updating the daily burn.`,
    );
    console.table(lowProposedDailyBurn);
  }

  return burn;
}

main().catch((err) => {
  rootLogger.error('Error:', err);
  process.exit(1);
});
