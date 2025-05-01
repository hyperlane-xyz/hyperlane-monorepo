import { ChainMap } from '@hyperlane-xyz/sdk';
import { inCIMode, rootLogger } from '@hyperlane-xyz/utils';

import {
  AlertType,
  GRAFANA_URL,
  ProvisionedAlertRule,
  WalletName,
  alertConfigMapping,
  walletNameQueryFormat,
} from '../../config/funding/grafanaAlerts.js';
import { fetchGCPSecret } from '../../utils/gcloud.js';

export const logger = rootLogger.child({ module: 'grafana' });

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

export async function fetchGrafanaServiceAccountToken(): Promise<string> {
  let saToken: string | undefined;

  if (inCIMode()) {
    saToken = process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN;
    if (!saToken) {
      throw new Error(
        'GRAFANA_SERVICE_ACCOUNT_TOKEN is not set in CI environment',
      );
    }
    return saToken;
  }

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
  thresholds: ChainMap<number>,
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
      )}}[1d]) - ${minBalance.toString()} or`;
    },
  );

  return `${config.queryTemplate.header}
    ${queryFragments.join('\n    ')}

${config.queryTemplate.footer}
)`;
}
