import { ChainMap } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import {
  AlertType,
  GRAFANA_URL,
  ProvisionedAlertRule,
  WalletName,
  alertConfigMapping,
  walletNameQueryFormat,
} from '../config/funding/grafanaAlerts.js';
import { fetchGCPSecret } from '../utils/gcloud.js';

export const logger = rootLogger.child({ module: 'grafana' });

export function formatDailyRelayerBurn(dailyRelayerBurn: number): number {
  return Number(dailyRelayerBurn.toPrecision(3));
}

export async function fetchGrafanaAlert(alertType: AlertType, saToken: string) {
  const response = await fetch(
    `${GRAFANA_URL}/api/v1/provisioning/alert-rules/${alertConfigMapping[alertType].grafanaAlertId}`,
    {
      headers: {
        Authorization: `Bearer ${saToken}`,
        'Content-Type': 'application/json',
      },
    },
  );

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = (await response.json()) as ProvisionedAlertRule;

  const queries = data.data.map((d) => d.model.expr);

  return {
    title: data.title,
    queries,
    rawData: data,
  };
}

export async function exportGrafanaAlert(
  alertType: AlertType,
  saToken: string,
  format: string = 'json',
) {
  const response = await fetch(
    `${GRAFANA_URL}/api/v1/provisioning/alert-rules/${alertConfigMapping[alertType].grafanaAlertId}/export?format=${format}`,
    {
      headers: {
        Authorization: `Bearer ${saToken}`,
        'Content-Type': 'application/json',
      },
    },
  );

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response;
}

function parsePromQLQuery(
  query: string,
  walletName: WalletName,
): ChainMap<string> {
  const balances: ChainMap<string> = {};
  const alertRegex = getAlertRegex(walletName);

  // Get all matches
  const matches = Array.from(query.matchAll(alertRegex));
  for (const match of matches) {
    const [_, chain, balanceStr] = match;
    const minBalance = balanceStr;

    balances[chain] = minBalance;
  }

  return Object.fromEntries(Object.entries(balances).sort());
}

function getAlertRegex(walletName: WalletName): RegExp {
  switch (walletName) {
    case WalletName.KeyFunder:
      return /wallet_name="key-funder", chain="([^"]+)"[^-]+ - ([0-9.]+)/g;
    case WalletName.Relayer:
      return /wallet_name="relayer", chain="([^"]+)"[^-]+ - ([0-9.]+)/g;
    default:
      throw new Error(`Unknown wallet name: ${walletName}`);
  }
}

export async function getAlertThresholds(
  alertType: AlertType,
): Promise<ChainMap<string>> {
  const saToken = await fetchServiceAccountToken();
  const alert = await fetchGrafanaAlert(alertType, saToken);
  const alertQuery = alert.queries[0];
  const walletName = alertConfigMapping[alertType].walletName;
  return parsePromQLQuery(alertQuery, walletName);
}

export async function fetchServiceAccountToken(): Promise<string> {
  let saToken: string | undefined;

  try {
    saToken = (await fetchGCPSecret(
      'grafana-balance-alert-thresholds-token',
      false,
    )) as string;
  } catch (error) {
    logger.error(
      'Error fetching grafana service account token from GCP secrets:',
      error,
    );
    throw error;
  }

  return saToken;
}

export async function updateGrafanaAlert(
  alertUid: string,
  existingAlert: ProvisionedAlertRule,
  newQuery: string,
  saToken: string,
) {
  // Create the updated rule based on the existing one
  const updatedRule: ProvisionedAlertRule = {
    ...existingAlert,
    data: existingAlert.data.map((d) => ({
      ...d,
      model: {
        ...d.model,
        expr: newQuery,
      },
    })),
  };

  const response = await fetch(
    `${GRAFANA_URL}/api/v1/provisioning/alert-rules/${alertUid}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${saToken}`,
        'Content-Type': 'application/json',
        'X-Disable-Provenance': 'true',
      },
      body: JSON.stringify(updatedRule),
    },
  );

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(
      `Failed to update alert: ${response.status} ${JSON.stringify(errorData)}`,
    );
  }

  return response.json();
}

export function generateQuery(
  alertType: AlertType,
  thresholds: ChainMap<string>,
): string {
  const config = alertConfigMapping[alertType];
  const walletQueryName = walletNameQueryFormat[config.walletName];

  // TODO: abstract away special handling for relayer queries that need hyperlane_context
  const needsHyperlaneContext = config.walletName === WalletName.Relayer;

  const queryFragments = Object.entries(thresholds).map(
    ([chain, minBalance]) => {
      const labels = [`wallet_name="${walletQueryName}"`, `chain="${chain}"`];
      if (needsHyperlaneContext) {
        labels.push('hyperlane_context="hyperlane"');
      }
      return `last_over_time(hyperlane_wallet_balance{${labels.join(
        ', ',
      )}}[1d]) - ${minBalance} or`;
    },
  );

  return `${config.queryTemplate.header}
    ${queryFragments.join('\n    ')}

${config.queryTemplate.footer}
)`;
}

export function sortThresholds(
  newThresholds: ChainMap<string>,
): ChainMap<string> {
  const orderedThresholds: ChainMap<string> = {};
  Object.keys(newThresholds)
    .sort()
    .forEach((key) => {
      orderedThresholds[key] = newThresholds[key];
    });
  return orderedThresholds;
}
