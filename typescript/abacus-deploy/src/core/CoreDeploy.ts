import { ChainConfig } from '../types';
import { Deploy } from '../deploy';
import { CoreConfig } from './types';
import { CoreInstance } from './CoreInstance';

export class CoreDeploy extends Deploy<CoreInstance>{
  
  // TODO(asa): Can this be moved to Deploy? 
  static async deploy(chains: Record<number, ChainConfig>, config: CoreConfig): Promise<CoreDeploy> {
    const domains = Object.keys(chains).map((d) => parseInt(d))
    const instances: Record<number, CoreInstance>= {};
    for (const domain of domains) {
      instances[domain] = await CoreInstance.deploy(domains, chains[domain], config)
    }
    const deploy = new CoreDeploy(instances);
    return deploy
  }
}
