import { ethers } from 'ethers';

import { IRegistry } from '@hyperlane-xyz/registry';
import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';
import { CallData } from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../config/environment.js';

export type PreparedMulticall = CallData & {
  destination: ChainName;
  gasLimit: ethers.BigNumber;
  value: ethers.BigNumber;
};

export type QueuedMulticall = PreparedMulticall & {
  nonce: number;
};

export type Call3 = {
  target: string;
  allowFailure: boolean;
  callData: string;
};

export type Call3Value = Call3 & {
  value: ethers.BigNumber;
};

export type KesselRunner = {
  environment: DeployEnvironment;
  targetNetworks: ChainName[];
  multiProvider: MultiProvider;
  registry: IRegistry;
};

export type TransferCall = {
  destination: number;
  recipient: string;
  amount: ethers.BigNumber;
  value: ethers.BigNumber;
};
