import { input, select } from '@inquirer/prompts';
import postgres from 'postgres';
import yargs from 'yargs';

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
import {
  formatBalanceThreshold,
  sortThresholds,
} from '../../src/funding/balances.js';
import {
  LOCAL_PROM_URL,
  PROMETHEUS_LOCAL_PORT,
  PrometheusInstantResult,
  fetchPrometheusInstantExpression,
  portForwardPrometheusServer,
} from '../../src/infrastructure/monitoring/prometheus.js';
import { fetchLatestGCPSecret } from '../../src/utils/gcloud.js';
import { writeJsonAtPath } from '../../src/utils/utils.js';
import { withSkipReview } from '../agent-utils.js';

const tokenPrices: ChainMap<string> = rawTokenPrices;
const currentDailyRelayerBurn: ChainMap<number> = rawDailyRelayerBurn;
const desiredRelayerBalances: ChainMap<number> = rawDesiredRelayerBalances;

const DAILY_BURN_PATH = `${THRESHOLD_CONFIG_PATH}/dailyRelayerBurn.json`;
const SCRAPER_READ_ONLY_DB_SECRET_NAME =
  'hyperlane-mainnet3-scraper3-db-read-only';

const LOOK_BACK_DAYS = 10; // the number of days to look back for average destination tx costs
const MIN_NUMBER_OF_TXS = 100; // the minimum number of txs to consider for daily burn
const MIN_BURN_INCREASE_FACTOR = 0.05; // burn should be at least 5% higher than current to be updated
const LOW_PROPOSED_BURN_FACTOR = 0.5; // proposed burn should be at least 50% lower than current to initiate user review

async function main() {
  const { skipReview } = await withSkipReview(yargs(process.argv.slice(2)))
    .argv;

  validateTokenPrices();

  const sealevelDomainIds: ChainMap<string> = await getSealevelDomainIds();

  let burnData: ChainMap<number>;
  try {
    burnData = await calculateDailyRelayerBurn(sealevelDomainIds, skipReview);
  } catch (err) {
    rootLogger.error('Error fetching daily burn data:', err);
    process.exit(1);
  }

  burnData = sortThresholds(burnData);

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
  const credentialsUrl = await fetchLatestGCPSecret(
    SCRAPER_READ_ONLY_DB_SECRET_NAME,
  );
  return postgres(credentialsUrl, { ssl: 'require' });
}

async function getDailyRelayerBurnScraperDB(
  sealevelDomainIds: ChainMap<string>,
) {
  const sealevelDomainIdsArr = Object.values(sealevelDomainIds);

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
          AND mv.destination_domain_id != ALL(${sealevelDomainIdsArr})
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
  sealevelDomainIds: ChainMap<string>,
): Promise<ChainMap<number>> {
  const portForwardProcess = await portForwardPrometheusServer(
    PROMETHEUS_LOCAL_PORT,
  );

  const burn: ChainMap<number> = {};

  const rangeHours = LOOK_BACK_DAYS * 24;

  const sealevelChainNames = Object.keys(sealevelDomainIds);

  // This PromQL query does:
  // - sum_over_time(... [${rangeHours}h:]): accumulate the "only decrease" deltas over the last LOOK_BACK_DAYS
  // - sum by (chain)(...): get a separate series for each chain
  // - / LOOK_BACK_DAYS: divide the total by LOOK_BACK_DAYS, yielding an average "per day" value.
  const promQlQuery = `
    sum by (chain) (
      sum_over_time(
        clamp_min(
          (
            hyperlane_wallet_balance{
              hyperlane_deployment="mainnet3",
              hyperlane_context=~"rc|hyperlane",
              chain=~"(${sealevelChainNames.join('|')})",
              wallet_name="relayer"
            } offset 1m
          )
          -
          hyperlane_wallet_balance{
            hyperlane_deployment="mainnet3",
            hyperlane_context=~"rc|hyperlane",
            chain=~"(${sealevelChainNames.join('|')})",
            wallet_name="relayer"
          },
          0
        )[${rangeHours}h:]
      )
    ) / ${LOOK_BACK_DAYS}
  `.trim();

  let results: PrometheusInstantResult[];

  try {
    results = await fetchPrometheusInstantExpression(
      LOCAL_PROM_URL,
      promQlQuery,
    );
  } finally {
    portForwardProcess.kill();
    rootLogger.info('Prometheus server port-forward process killed');
  }

  for (const series of results) {
    const chain = series.metric.chain;

    if (series.value) {
      burn[chain] = formatBalanceThreshold(parseFloat(series.value[1]));
    } else if (series.histogram) {
      rootLogger.warn(
        `Unexpected histogram data found for "${chain} in Prometheus, skipping.`,
      );
    }
  }

  return burn;
}

async function calculateDailyRelayerBurn(
  sealevelDomainIds: ChainMap<string>,
  skipReview: boolean,
): Promise<ChainMap<number>> {
  const [dbBurnData, sealevelBurnData] = await Promise.all([
    getDailyRelayerBurnScraperDB(sealevelDomainIds),
    getSealevelBurnProm(sealevelDomainIds),
  ]);

  const combinedBurnData: ChainMap<number> = {
    ...dbBurnData,
    ...sealevelBurnData,
  };

  let updatedBurnData: ChainMap<number> = {};

  const lowProposedDailyBurn: Array<{
    chain: string;
    proposedBurn: number;
    currentBurn: number;
  }> = [];

  const burnInfoTable: Array<{
    chain: string;
    proposedBurn: number;
    currentBurn: number;
    proposedRelayerBalanceDollars: number;
    currentRelayerBalanceDollars: number;
  }> = [];

  for (const chain of Object.keys(tokenPrices)) {
    const currentBurn = currentDailyRelayerBurn[chain] ?? 0; // currentDailyRelayerBurn[chain] maybe undefined if this is a new chain
    const burnFromData = combinedBurnData[chain] ?? 0; // combinedBurnData[chain] maybe undefined if there is no data for this chain, i.e no messages or no metrics scraped to prometheus in the look back window

    const proposedBurn = computeProposedDailyBurn(
      burnFromData,
      parseFloat(tokenPrices[chain]),
    );

    const newBurn = decideNewDailyBurn(proposedBurn, currentBurn);

    // If the proposed is > 50% lower than current, we store it for review
    if (!skipReview && proposedBurn < currentBurn * LOW_PROPOSED_BURN_FACTOR) {
      lowProposedDailyBurn.push({
        chain,
        proposedBurn,
        currentBurn,
      });
    }

    burnInfoTable.push({
      chain,
      proposedBurn: formatBalanceThreshold(proposedBurn),
      currentBurn: formatBalanceThreshold(currentBurn),
      proposedRelayerBalanceDollars: formatBalanceThreshold(
        proposedBurn *
          parseFloat(tokenPrices[chain]) *
          RELAYER_BALANCE_TARGET_DAYS,
      ),
      currentRelayerBalanceDollars: formatBalanceThreshold(
        desiredRelayerBalances[chain] * parseFloat(tokenPrices[chain]),
      ),
    });

    updatedBurnData[chain] = formatBalanceThreshold(newBurn);
  }

  console.table(burnInfoTable);

  if (skipReview) {
    rootLogger.info(
      'Skipping review for proposed burn values that are less than the current values.',
    );
    return updatedBurnData;
  }

  if (lowProposedDailyBurn.length > 0) {
    console.table(lowProposedDailyBurn);
    const userAdjustments =
      await handleLowProposedDailyBurn(lowProposedDailyBurn);
    updatedBurnData = { ...updatedBurnData, ...userAdjustments };
  }

  return updatedBurnData;
}

function computeProposedDailyBurn(
  measuredDailyBurn: number,
  tokenPrice: number,
): number {
  const minNativeBalance = RELAYER_MIN_DOLLAR_BALANCE_PER_DAY / tokenPrice;
  return formatBalanceThreshold(Math.max(measuredDailyBurn, minNativeBalance));
}

function decideNewDailyBurn(proposedBurn: number, currentBurn: number): number {
  // If the proposed burn is at least 10% above the current, update it.
  if (proposedBurn > currentBurn * (1 + MIN_BURN_INCREASE_FACTOR)) {
    return proposedBurn;
  }
  return currentBurn;
}

async function getSealevelDomainIds(): Promise<ChainMap<string>> {
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

async function handleLowProposedDailyBurn(
  lowProposedDailyBurn: Array<{
    chain: string;
    proposedBurn: number;
    currentBurn: number;
  }>,
): Promise<ChainMap<number>> {
  const updatedDailyBurn: ChainMap<number> = {};
  const manualOption = 'manual';

  enum UserChoice {
    Accept = 'accept',
    Reject = 'reject',
    Manual = manualOption,
  }

  // allow to sweepingly accept or reject all proposed daily burn changes or fallback to individual review
  const selectedOption = await select<string>({
    message: 'Accept all proposed daily burn changes?',
    choices: [
      {
        description: 'Accept all the proposed daily burn changes',
        value: UserChoice.Accept,
      },
      {
        description:
          'Reject all the proposed daily burn changes and keep the current daily burns',
        value: UserChoice.Reject,
      },
      {
        description: 'Manually review the daily burn changes for each chain',
        value: UserChoice.Manual,
      },
    ],
  });

  if (selectedOption === UserChoice.Accept) {
    for (const item of lowProposedDailyBurn) {
      updatedDailyBurn[item.chain] = item.proposedBurn;
    }
    return updatedDailyBurn;
  } else if (selectedOption === UserChoice.Reject) {
    return updatedDailyBurn;
  }

  for (const item of lowProposedDailyBurn) {
    const { chain, proposedBurn, currentBurn } = item;

    const selectedOption = await select<number | string>({
      message: `Proposed daily burn for ${chain} is 50% less than current daily burn. Update daily burn for ${chain}?`,
      choices: [
        {
          description: `Use the proposed daily burn (${proposedBurn})`,
          value: proposedBurn,
        },
        {
          description: `Keep the current daily burn (${currentBurn})`,
          value: currentBurn,
        },
        {
          description: 'Manually enter a new daily burn',
          value: manualOption,
        },
      ],
    });

    if (selectedOption === manualOption) {
      const newDailyBurn = await input({
        message: `Enter new daily burn for ${chain}`,
        validate: (value) => {
          if (isNaN(parseFloat(value))) {
            return 'Please enter a valid number.';
          }
          return true;
        },
      });
      updatedDailyBurn[chain] = parseFloat(newDailyBurn);
    } else {
      updatedDailyBurn[chain] = selectedOption as number;
    }
  }

  return updatedDailyBurn;
}

main().catch((err) => {
  rootLogger.error('Error:', err);
  process.exit(1);
});
