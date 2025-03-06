import {
  HIGH_URGENCY_RELAYER_FOOTER,
  HIGH_URGENCY_RELAYER_HEADER,
  LOW_URGENCY_ENG_KEY_FUNDER_FOOTER,
  LOW_URGENCY_KEY_FUNDER_FOOTER,
  LOW_URGENCY_KEY_FUNDER_HEADER,
} from './alert-query-templates.js';
import {
  BalanceThresholdType,
  balanceThresholdConfigMapping,
} from './balances.js';

export const GRAFANA_URL = 'https://abacusworks.grafana.net';

export enum AlertType {
  LowUrgencyKeyFunderBalance = 'lowUrgencyKeyFunderBalance',
  LowUrgencyEngKeyFunderBalance = 'lowUrgencyEngKeyFunderBalance',
  HighUrgencyRelayerBalance = 'highUrgencyRelayerBalance',
}

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

export enum WalletName {
  KeyFunder = 'keyFunder',
  Relayer = 'relayer',
  // ATAPayer = 'ataPayer',
}

export const walletNameQueryFormat: Record<WalletName, string> = {
  [WalletName.KeyFunder]: 'key-funder',
  [WalletName.Relayer]: 'relayer',
  // [WalletName.ATAPayer]: '.*ata-payer
};

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
      footer: LOW_URGENCY_ENG_KEY_FUNDER_FOOTER,
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
export interface ProvisionedAlertRule {
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
