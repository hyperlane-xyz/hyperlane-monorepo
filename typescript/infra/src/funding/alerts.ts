import { ChainMap } from '@hyperlane-xyz/sdk';

import {
  AlertType,
  WalletName,
  alertConfigMapping,
} from '../config/funding/grafanaAlerts.js';
import {
  fetchGrafanaAlert,
  fetchGrafanaServiceAccountToken,
} from '../infrastructure/monitoring/grafana.js';

export function parseBalancesPromQLQuery(
  query: string,
  walletName: WalletName,
): ChainMap<string> {
  const balances: ChainMap<string> = {};
  const balanceAlertRegex = getBalanceAlertRegex(walletName);

  // Get all matches
  const matches = Array.from(query.matchAll(balanceAlertRegex));
  for (const match of matches) {
    const [_, chain, balanceStr] = match;
    const minBalance = balanceStr;

    balances[chain] = minBalance;
  }

  return Object.fromEntries(Object.entries(balances).sort());
}

function getBalanceAlertRegex(walletName: WalletName): RegExp {
  switch (walletName) {
    case WalletName.KeyFunder:
      return /wallet_name="key-funder", chain="([^"]+)"[^-]+ - ([0-9.]+)/g;
    case WalletName.Relayer:
      return /wallet_name="relayer", chain="([^"]+)"[^-]+ - ([0-9.]+)/g;
    default:
      throw new Error(`Unknown wallet name: ${walletName}`);
  }
}

export async function getBalanceAlertThresholds(
  alertType: AlertType,
): Promise<ChainMap<string>> {
  const saToken = await fetchGrafanaServiceAccountToken();
  const alert = await fetchGrafanaAlert(alertType, saToken);
  const alertQuery = alert.queries[0];
  const walletName = alertConfigMapping[alertType].walletName;
  return parseBalancesPromQLQuery(alertQuery, walletName);
}
