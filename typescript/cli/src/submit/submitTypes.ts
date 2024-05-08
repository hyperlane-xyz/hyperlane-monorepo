import type {
  AccountConfig,
  ChainName,
  InterchainAccount,
  MultiProvider,
  TxSubmitterType,
  TxTransformerType,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

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
  safeAddress?: Address;
  userAddress?: Address;
}
interface TransformerSettings {
  interchainAccount?: InterchainAccount;
  accountConfig?: AccountConfig;
  hookMetadata?: any;
}
