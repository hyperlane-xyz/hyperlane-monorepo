interface IndexingConfig {
  from: number;
  chunk: number;
}

interface AwsConfig {
  awsRegion: string;
  awsKeyId: string;
  awsSecretAccessKey: string;
}

interface ProcessorConfig {
  indexOnly: string[];
  s3Bucket: string;
}

interface DockerConfig {
  repo: string;
  tag: string;
}

export interface AgentConfig {
  environment: string;
  namespace: string;
  runEnv: string;
  index: IndexingConfig;
  docker: DockerConfig;
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
  replicas: Record<string, RustContractBlock>;
  home: RustContractBlock;
  tracing: {
    level: string;
    fmt: 'json';
  };
  db: string;
};
