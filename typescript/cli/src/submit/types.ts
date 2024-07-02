import type {
  ChainName,
  MultiProvider,
  SubmitterMetadata,
  TransformerMetadata,
} from '@hyperlane-xyz/sdk';

export interface SubmitterBuilderSettings {
  submitterMetadata: SubmitterMetadata;
  transformersMetadata: TransformerMetadata[];
  multiProvider: MultiProvider;
  chain: ChainName;
  isDryRun?: boolean;
}
