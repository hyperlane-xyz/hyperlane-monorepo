import type {
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
  props: SubmitterProps;
}
export interface TransformerMetadata {
  type: TxTransformerType;
  props: TransformerProps;
}

type SubmitterProps =
  | EV5ImpersonatedAccountTxSubmitterProps
  | EV5GnosisSafeTxSubmitterProps;
type TransformerProps = EV5InterchainAccountTxTransformerProps;
