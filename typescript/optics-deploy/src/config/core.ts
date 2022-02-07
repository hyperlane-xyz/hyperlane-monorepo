import { BigNumberish } from 'ethers';
import { CoreConfigAddresses } from './addresses';
import { ChainName } from './chain';
import { DeployEnvironment } from '../deploy';

export interface CoreConfig {
  environment: DeployEnvironment;
  recoveryTimelock: number;
  optimisticSeconds: number;
  processGas: BigNumberish;
  reserveGas: BigNumberish;
  addresses: Partial<Record<ChainName, CoreConfigAddresses>>;
}
