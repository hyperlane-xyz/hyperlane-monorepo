import postgres, { Sql } from 'postgres';

import { Contexts } from '../../config/contexts.js';
import { KeyFunderHelmManager } from '../../src/funding/key-funder.js';
import { fetchLatestGCPSecret } from '../../src/utils/gcloud.js';
import { assertCorrectKubeContext } from '../agent-utils.js';
import { getConfigsBasedOnArgs } from '../core-utils.js';

async function main() {
  const highUrgency = false;

  const relayerBalanceMultiplier = highUrgency ? 1.5 : 2;

  const { agentConfig, envConfig, environment } = await getConfigsBasedOnArgs();
  if (agentConfig.context != Contexts.Hyperlane)
    throw new Error(
      `Invalid context ${agentConfig.context}, must be ${Contexts.Hyperlane}`,
    );

  await assertCorrectKubeContext(envConfig);

  const sql = await getReadOnlyScraperDb();
  await getAllChainCostSummaries(sql);
}

async function getReadOnlyScraperDb() {
  const credentialsUrl = await fetchLatestGCPSecret(
    'hyperlane-mainnet3-scraper3-db-read-only',
  );
  return postgres(credentialsUrl);
}

async function getAllChainCostSummaries(sql: Sql) {
  // const lookbackDays = 10;
  const result = await sql`
  SELECT 
    dest_domain.name AS domain_name,
    AVG(mv.destination_tx_gas_used * mv.destination_tx_effective_gas_price) AS avg_tx_cost,
    COUNT(*) / 10 AS avg_daily_messages
  FROM 
    message_view mv
  LEFT JOIN domain dest_domain 
    ON mv.destination_domain_id = dest_domain.id
  WHERE 
    mv.send_occurred_at >= CURRENT_TIMESTAMP - INTERVAL '10 days'
    AND dest_domain.is_test_net IS FALSE
    AND mv.is_delivered IS TRUE
  GROUP BY
    dest_domain.name
`;

  console.log(result);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
