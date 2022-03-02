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

export interface DockerConfig {
  repo: string;
  tag: string;
}

export interface AgentConfig {
  environment: string;
  namespace: string;
  runEnv: string;
  docker: DockerConfig;
  index?: IndexingConfig;
  aws?: AwsConfig;
  processor?: ProcessorConfig;
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
  address: string;
  domain: string;
  name: string;
  rpcStyle: string; // TODO
  connection: RustConnection;
};

export type RustConfig = {
  environment: string;
  signers: Record<string, RustSigner>;
  inboxs: Record<string, RustContractBlock>;
  outbox: RustContractBlock;
  tracing: {
    level: string;
    fmt: 'json';
  };
  db: string;
};
