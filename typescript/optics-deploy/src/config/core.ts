import { BigNumberish} from 'ethers';
import { CoreConfigAddresses } from './addresses';
import { ChainName, DomainedChain } from './chain';
type Address = string;

interface IDAddresses {
  [chain in ChainName]?: CoreConfigAddresses;
}

export interface CoreConfig {
  environment: DeployEnvironment;
  recoveryTimelock: number;
  optimisticSeconds: number;
  processGas: BigNumberish;
  reserveGas: BigNumberish;
  addresses: IDAddresses;
};
