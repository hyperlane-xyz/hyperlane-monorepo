import * as ethers from 'ethers';
import { NonceManager } from '@ethersproject/experimental';
import { ProxyAddresses } from './proxyUtils';

export function deployEnvironment(): DeployEnvironment {
  const e = process.env.OPTICS_DEPLOY_ENVIRONMENT;

  if (e === 'staging') {
    return 'staging';
  } else if (e === 'prod') {
    return 'prod';
  }

  return 'dev';
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
