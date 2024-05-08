import type {
  ChainName,
  EV5GnosisSafeTxSubmitterProps,
  EV5ImpersonatedAccountTxSubmitterProps,
  EV5InterchainAccountTxTransformerProps,
  MultiProvider,
  TxSubmitterType,
  TxTransformerType,
} from '@hyperlane-xyz/sdk';

export interface SubmitterBuilderSettings {
  submitterMetadata: SubmitterMetadata;
  transformersMetadata: TransformerMetadata[];
  multiProvider: MultiProvider;
}
export interface SubmitterMetadata {
  type: TxSubmitterType;
  chain: ChainName;
  settings?: SubmitterSettings;
}
export interface TransformerMetadata {
  type: TxTransformerType;
  chain: ChainName;
  settings?: TransformerSettings;
}

interface SubmitterSettings {
  eV5GnosisSafeProps: EV5GnosisSafeTxSubmitterProps;
  eV5ImpersonatedAccountProps: EV5ImpersonatedAccountTxSubmitterProps;
}
interface TransformerSettings {
  eV5InterchainAccountProps: EV5InterchainAccountTxTransformerProps;
}
