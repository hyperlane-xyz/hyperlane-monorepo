import { types } from '@abacus-network/utils';
import { ChainName } from './chain';
import { DeployEnvironment } from './environment';

interface IndexingConfig {
  from: number;
  chunk: number;
}

interface AwsConfig {
  region: string;
}

interface ProcessorConfig {
  indexOnly: string[];
  s3Bucket: string;
}

interface RelayerConfig {
  // How of a relayer should
  interval?: number;
}

interface ValidatorConfig {
  // How often an validator should check for new updates
  interval?: number;
  // How long an validator should wait for relevant state changes afterwords
  pause?: number;
}

export interface DockerConfig {
  repo: string;
  tag: string;
}

export interface AgentConfig {
  environment: DeployEnvironment;
  namespace: string;
  runEnv: string;
  docker: DockerConfig;
  index?: IndexingConfig;
  aws?: AwsConfig;
  processor?: ProcessorConfig;
  validator?: ValidatorConfig;
  relayer?: RelayerConfig;
}

export type RustSigner = {
  key: string;
  type: string; // TODO
};

export type RustConnection = {
  type: string; // TODO
  url: string;
};

export type RustContractBlock = {
  address: types.Address;
  domain: String;
  name: ChainName;
  rpcStyle: string; // TODO
  connection: RustConnection;
};

export type RustConfig = {
  environment: DeployEnvironment;
  signers: Partial<Record<ChainName, RustSigner>>;
  // Agents have not yet been moved to use the Outbox/Inbox names.
  replicas: Partial<Record<ChainName, RustContractBlock>>;
  home: RustContractBlock;
  tracing: {
    level: string;
    fmt: 'json';
  };
  db: string;
};
