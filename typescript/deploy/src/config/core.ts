import { CoreConfigAddresses } from './addresses';
import { ChainName } from './chain';
import { DeployEnvironment } from '../config';

export interface CoreConfig {
  environment: DeployEnvironment;
  recoveryTimelock: number;
  addresses: Partial<Record<ChainName, CoreConfigAddresses>>;
}
