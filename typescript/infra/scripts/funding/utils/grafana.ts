import { ChainMap } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { fetchGCPSecret } from '../../../src/utils/gcloud.js';

import { BalanceThresholdConfig, configFileNameMapping } from './constants.js';

export const GRAFANA_URL = 'https://abacusworks.grafana.net';

export const THRESHOLD_CONFIG_PATH = './config/environments/mainnet3/balances';

export const logger = rootLogger.child({ module: 'grafana' });

export enum AlertType {
  LowUrgencyKeyFunderBalance = 'lowUrgencyKeyFunderBalance',
  LowUrgencyEngKeyFunderBalance = 'lowUrgencyEngKeyFunderBalance',
  HighUrgencyRelayerBalance = 'highUrgencyRelayerBalance',
}

export type AlertTypeValue = `${AlertType}`;

export enum WalletName {
  KeyFunder = 'keyFunder',
  Relayer = 'relayer',
}

export type WalletNameValue = `${WalletName}`;

const alertWalletNameMapping: Record<AlertTypeValue, WalletName> = {
  [AlertType.LowUrgencyKeyFunderBalance]: WalletName.KeyFunder,
  [AlertType.LowUrgencyEngKeyFunderBalance]: WalletName.KeyFunder,
  [AlertType.HighUrgencyRelayerBalance]: WalletName.Relayer,
};

const alertIdMapping: Record<AlertTypeValue, string> = {
  [AlertType.LowUrgencyKeyFunderBalance]: 'KiJNg6p4k',
  [AlertType.LowUrgencyEngKeyFunderBalance]: 'temp',
  [AlertType.HighUrgencyRelayerBalance]: 'be64gvjo8jvuod',
};

export const alertThresholdFileMapping: Record<AlertTypeValue, string> = {
  [AlertType.LowUrgencyKeyFunderBalance]:
    configFileNameMapping[BalanceThresholdConfig.LowUrgencyKeyFunderBalance],
  [AlertType.LowUrgencyEngKeyFunderBalance]:
    configFileNameMapping[BalanceThresholdConfig.LowUrgencyEngKeyFunderBalance],
  [AlertType.HighUrgencyRelayerBalance]:
    configFileNameMapping[BalanceThresholdConfig.HighUrgencyRelayerBalance],
};

export interface AlertRule {
  uid: string;
  title: string;
  condition: string;
  data: Array<{
    refId: string;
    queryType: string;
    relativeTimeRange: {
      from: number;
      to: number;
    };
    datasourceUid: string;
    model: {
      expr: string;
    };
  }>;
}

export async function getGrafanaAlert(
  alertType: AlertTypeValue,
  saToken: string,
) {
  const alertUid = alertIdMapping[alertType];

  try {
    const response = await fetch(
      `${GRAFANA_URL}/api/v1/provisioning/alert-rules/${alertUid}`,
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

    const data = (await response.json()) as AlertRule;

    const queries = data.data.map((d) => d.model.expr);

    return {
      title: data.title,
      queries,
      rawData: data,
    };
  } catch (error) {
    if (error instanceof Error) {
      logger.error('Error fetching alert:', {
        message: error.message,
      });
    } else {
      logger.error('Unexpected error:', error);
    }
    throw error;
  }
}

export function parsePromQLQuery(
  query: string,
  walletName: WalletName,
): ChainMap<number> {
  const balances: ChainMap<number> = {};
  const alertRegex = getAlertRegex(walletName);

  // Get all matches
  const matches = Array.from(query.matchAll(alertRegex));
  for (const match of matches) {
    const [_, chain, balanceStr] = match;
    const minBalance = parseFloat(balanceStr);

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
  alertType: AlertTypeValue,
): Promise<ChainMap<number>> {
  const saToken = await fetchServiceAccountToken();
  const alert = await getGrafanaAlert(alertType, saToken);
  const alertQuery = alert.queries[0];
  const walletName = alertWalletNameMapping[alertType];
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
      'Error fetching grafa service account token from GCP secrets:',
      error,
    );
    throw error;
  }

  return saToken;
}
