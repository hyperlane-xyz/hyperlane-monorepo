import postgres, { Sql } from 'postgres';

import { ChainMap } from '@hyperlane-xyz/sdk';
import { ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import rawDailyRelayerBurn from '../../config/environments/mainnet3/balances/dailyRelayerBurn.json';
import rawDesiredRelayerBalances from '../../config/environments/mainnet3/balances/desiredRelayerBalances.json';
import { getRegistry } from '../../config/environments/mainnet3/chains.js';
import { mainnet3SupportedChainNames } from '../../config/environments/mainnet3/supportedChainNames.js';
import rawTokenPrices from '../../config/environments/mainnet3/tokenPrices.json';
import {
  RELAYER_BALANCE_TARGET_DAYS,
  RELAYER_MIN_DOLLAR_BALANCE_PER_DAY,
  THRESHOLD_CONFIG_PATH,
} from '../../src/config/funding/balances.js';
import { formatBalanceThreshold } from '../../src/funding/balances.js';
import {
  PrometheusResult,
  fetchPrometheusData,
  portForwardPrometheusServer,
} from '../../src/infrastructure/monitoring/prometheus.js';
import { fetchLatestGCPSecret } from '../../src/utils/gcloud.js';
import { writeJsonAtPath } from '../../src/utils/utils.js';

const tokenPrices: ChainMap<string> = rawTokenPrices;
const currentDailyRelayerBurn: ChainMap<number> = rawDailyRelayerBurn;
const desiredRelayerBalances: ChainMap<string> = rawDesiredRelayerBalances;

const DAILY_BURN_PATH = `${THRESHOLD_CONFIG_PATH}/dailyRelayerBurn.json`;
const SCRAPER_READ_ONLY_DB = 'hyperlane-mainnet3-scraper3-db-read-only';

const LOOK_BACK_DAYS = 10; // the number of days to look back for average destination tx costs
const MIN_NUMBER_OF_TXS = 100; // the minimum number of txs to consider for daily burn
const PROMETHEUS_LOCAL_PORT = 9092;

async function main() {
  validateTokenPrices();

  const sealevelDomainIds: ChainMap<string> = await getSealeveDomainIds();

  let burnData: ChainMap<number>;
  try {
    burnData = await calculateDailyRelayerBurn(sealevelDomainIds);
  } catch (err) {
    rootLogger.error('Error fetching daily burn data:', err);
    process.exit(1);
  }

  writeBurnDataToFile(burnData);
}

function validateTokenPrices() {
  const chainsMissingInTokenPrices = mainnet3SupportedChainNames.filter(
    (chain) => !(chain in tokenPrices),
  );

  if (chainsMissingInTokenPrices.length > 0) {
    rootLogger.error(
      `Token prices missing for chains: ${chainsMissingInTokenPrices.join(
        ', ',
      )} -- consider adding them to tokenPrices.json and running again.`,
    );
    process.exit(1);
  }
}

async function getReadOnlyScraperDb() {
  const credentialsUrl = await fetchLatestGCPSecret(SCRAPER_READ_ONLY_DB);
  return postgres(credentialsUrl);
}

async function getDailyRelayerBurnScraperDB(sealevelDomainIds: string[]) {
  const sql = await getReadOnlyScraperDb();

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

  await sql.end();

  const burnData: ChainMap<number> = {};
  for (const row of results) {
    burnData[row.chain] = row.daily_burn;
  }

  return burnData;
}

async function getSealevelBurnProm(
  chainNames: string[],
  lookBackDays: number = 10,
): Promise<ChainMap<number>> {
  const portForwardProcess = await portForwardPrometheusServer(
    PROMETHEUS_LOCAL_PORT,
  );

  const promUrl = `http://localhost:${PROMETHEUS_LOCAL_PORT}`;

  const burn: ChainMap<number> = {};

  const rangeHours = lookBackDays * 24;

  // This PromQL does:
  // - sum_over_time(... [${rangeHours}h:]): accumulate the "only decrease" deltas over the last lookBackDays
  // - sum by (chain)(...): get a separate series for each chain
  // - / lookBackDays: divide the total by lookBackDays, yielding an average "per day" value.
  const promQlQuery = `
    sum by (chain) (
      sum_over_time(
        clamp_min(
          (
            hyperlane_wallet_balance{
              hyperlane_deployment="mainnet3",
              hyperlane_context=~"rc|hyperlane",
              chain=~"(${chainNames.join('|')})",
              wallet_name="relayer"
            } offset 1m
          )
          -
          hyperlane_wallet_balance{
            hyperlane_deployment="mainnet3",
            hyperlane_context=~"rc|hyperlane",
            chain=~"(${chainNames.join('|')})",
            wallet_name="relayer"
          },
          0
        )[${rangeHours}h:]
      )
    ) / ${lookBackDays}
  `.trim();

  let results: PrometheusResult[];

  try {
    results = await fetchPrometheusData(promUrl, promQlQuery);
  } finally {
    portForwardProcess.kill();
    rootLogger.info('Prometheus server port-forward process killed');
  }

  for (const series of results) {
    const chainLabel = series.metric.chain;

    // value is [ <timestamp>, <stringValue> ].
    if (series.value && series.value.length === 2) {
      const numericStr = series.value[1];
      burn[chainLabel] = formatBalanceThreshold(parseFloat(numericStr));
    } else {
      burn[chainLabel] = 0;
    }
  }

  return burn;
}

async function calculateDailyRelayerBurn(sealevelDomainIds: ChainMap<string>) {
  const dbBurnData = await getDailyRelayerBurnScraperDB(
    Object.values(sealevelDomainIds),
  );

  const sealevelBurnData: ChainMap<number> = await getSealevelBurnProm(
    Object.keys(sealevelDomainIds),
    LOOK_BACK_DAYS,
  );

  const burnData: ChainMap<number> = { ...dbBurnData, ...sealevelBurnData };
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
    const dailyBurn = burnData[chain];

    // minimum native balance required to maintain our desired minimum dollar balance in the relayer
    const minNativeBalance =
      RELAYER_MIN_DOLLAR_BALANCE_PER_DAY / parseFloat(tokenPrices[chain]);

    // some chains may have had no messages in the look back window so we set daily burn based on the minimum dollar balance
    const proposedDailyRelayerBurn = Math.max(dailyBurn, minNativeBalance);

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

    burnData[chain] = formatBalanceThreshold(newDailyRelayerBurn);
  }

  console.table(burnInfoTable);

  if (lowProposedDailyBurn.length > 0) {
    rootLogger.warn(
      `Proposed daily burn for the following chains are 50% less than current daily burn. Consider manually reviewing updating the daily burn.`,
    );
    console.table(lowProposedDailyBurn);
  }

  return burnData;
}

async function getSealeveDomainIds(): Promise<ChainMap<string>> {
  const registry = await getRegistry();
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
  return sealevelDomainIds;
}

function writeBurnDataToFile(burnData: ChainMap<number>) {
  try {
    rootLogger.info('Writing daily burn data to file..');
    writeJsonAtPath(DAILY_BURN_PATH, burnData);
    rootLogger.info('Daily burn data written to file.');
  } catch (err) {
    rootLogger.error('Error writing daily burn data to file:', err);
  }
}

main().catch((err) => {
  rootLogger.error('Error:', err);
  process.exit(1);
});
