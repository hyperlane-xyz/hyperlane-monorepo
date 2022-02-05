import { BigNumberish} from 'ethers';
import { CoreConfigAddresses } from './addresses';
import { ChainName } from './chain';
import { DeployEnvironment } from '../deploy';

interface IDAddresses {
  [key in ChainName]?: CoreConfigAddresses;
}

export interface CoreConfig {
  environment: DeployEnvironment;
  recoveryTimelock: number;
  optimisticSeconds: number;
  processGas: BigNumberish;
  reserveGas: BigNumberish;
  addresses: IDAddresses;
};
