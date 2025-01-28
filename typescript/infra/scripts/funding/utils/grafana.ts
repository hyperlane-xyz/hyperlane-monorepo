import { checkbox } from '@inquirer/prompts';

import { ChainMap } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { fetchGCPSecret } from '../../../src/utils/gcloud.js';

import {
  HIGH_URGENCY_RELAYER_FOOTER,
  HIGH_URGENCY_RELAYER_HEADER,
  LOW_URGENCY_KEY_FUNDER_FOOTER,
  LOW_URGENCY_KEY_FUNDER_HEADER,
} from './alert-query-templates.js';
import {
  BalanceThresholdType,
  balanceThresholdConfigMapping,
} from './constants.js';

export const GRAFANA_URL = 'https://abacusworks.grafana.net';

export const THRESHOLD_CONFIG_PATH = './config/environments/mainnet3/balances';

export const logger = rootLogger.child({ module: 'grafana' });

export enum AlertType {
  LowUrgencyKeyFunderBalance = 'lowUrgencyKeyFunderBalance',
  LowUrgencyEngKeyFunderBalance = 'lowUrgencyEngKeyFunderBalance',
  HighUrgencyRelayerBalance = 'highUrgencyRelayerBalance',
}

export enum WalletName {
  KeyFunder = 'keyFunder',
  Relayer = 'relayer',
  // ATAPayer = 'ataPayer',
}

const walletNameQueryFormat: Record<WalletName, string> = {
  [WalletName.KeyFunder]: 'key-funder',
  [WalletName.Relayer]: 'relayer',
  // [WalletName.ATAPayer]: '.*ata-payer
};

interface AlertConfig {
  walletName: WalletName;
  grafanaAlertId: string;
  configFileName: string;
  choiceLabel: string;
  queryTemplate: {
    header: string;
    footer: string;
  };
}

export const alertConfigMapping: Record<AlertType, AlertConfig> = {
  [AlertType.LowUrgencyKeyFunderBalance]: {
    walletName: WalletName.KeyFunder,
    grafanaAlertId: 'ae9z3blz6fj0gb',
    configFileName:
      balanceThresholdConfigMapping[
        BalanceThresholdType.LowUrgencyKeyFunderBalance
      ].configFileName,
    choiceLabel:
      balanceThresholdConfigMapping[
        BalanceThresholdType.LowUrgencyKeyFunderBalance
      ].choiceLabel,
    queryTemplate: {
      header: LOW_URGENCY_KEY_FUNDER_HEADER,
      footer: LOW_URGENCY_KEY_FUNDER_FOOTER,
    },
  },
  [AlertType.LowUrgencyEngKeyFunderBalance]: {
    walletName: WalletName.KeyFunder,
    grafanaAlertId: 'ceb9c63qs7fuoe',
    configFileName:
      balanceThresholdConfigMapping[
        BalanceThresholdType.LowUrgencyEngKeyFunderBalance
      ].configFileName,
    choiceLabel:
      balanceThresholdConfigMapping[
        BalanceThresholdType.LowUrgencyEngKeyFunderBalance
      ].choiceLabel,
    queryTemplate: {
      header: LOW_URGENCY_KEY_FUNDER_HEADER,
      footer: LOW_URGENCY_KEY_FUNDER_FOOTER,
    },
  },
  [AlertType.HighUrgencyRelayerBalance]: {
    walletName: WalletName.Relayer,
    grafanaAlertId: 'beb9c2jwhacqoe',
    configFileName:
      balanceThresholdConfigMapping[
        BalanceThresholdType.HighUrgencyRelayerBalance
      ].configFileName,
    choiceLabel:
      balanceThresholdConfigMapping[
        BalanceThresholdType.HighUrgencyRelayerBalance
      ].choiceLabel,
    queryTemplate: {
      header: HIGH_URGENCY_RELAYER_HEADER,
      footer: HIGH_URGENCY_RELAYER_FOOTER,
    },
  },
};

interface NotificationSettings {
  receiver: string;
  group_by: string[];
}

interface AlertQueryModel {
  editorMode?: string;
  exemplar?: boolean;
  expr: string;
  instant?: boolean;
  intervalMs: number;
  legendFormat?: string;
  maxDataPoints: number;
  range?: boolean;
  refId: string;
  conditions?: Array<{
    evaluator: {
      params: number[];
      type: string;
    };
    operator: {
      type: string;
    };
    query: {
      params: any[];
    };
    reducer: {
      params: any[];
      type: string;
    };
    type: string;
  }>;
  datasource?: {
    name?: string;
    type: string;
    uid: string;
  };
  expression?: string;
  type?: string;
}

interface AlertQuery {
  refId: string;
  queryType: string;
  relativeTimeRange: {
    from: number;
    to: number;
  };
  datasourceUid: string;
  model: AlertQueryModel;
}

// interface defined based on documentation at https://grafana.com/docs/grafana/latest/developers/http_api/alerting_provisioning/#span-idprovisioned-alert-rulespan-provisionedalertrule
interface ProvisionedAlertRule {
  id: number;
  uid: string;
  orgID: number;
  folderUID: string;
  ruleGroup: string;
  title: string;
  condition: string;
  data: AlertQuery[];
  noDataState: string;
  execErrState: string;

  updated: string;
  for: string;

  annotations?: Record<string, string>;
  labels?: Record<string, string>;
  isPaused?: boolean;
  notification_settings?: NotificationSettings;
}

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
