import debug from 'debug';

import { Address } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { HookFactories, hookFactories } from './contracts';
import { HookConfig, HookType } from './types';

export class HyperlaneHookDeployer extends HyperlaneDeployer<
  HookConfig,
  HookFactories
> {
  constructor(
    multiProvider: MultiProvider,
    readonly mailboxes: ChainMap<Address>,
  ) {
    super(multiProvider, hookFactories, {
      logger: debug('hyperlane:HyperlaneHookDeployer'),
    });
  }

  async deployContracts(
    chain: ChainName,
    config: HookConfig,
    mailbox = this.mailboxes[chain],
  ): Promise<HyperlaneContracts<HookFactories>> {
    if (config.type === HookType.MERKLE_TREE) {
      const hook = await this.deployContract(chain, config.type, [mailbox]);
      return { [config.type]: hook } as any;
    } else if (config.type === HookType.INTERCHAIN_GAS_PAYMASTER) {
      const hook = await this.deployContract(chain, config.type, []);
      return { [config.type]: hook } as any;
    } else {
      throw new Error(`Unexpected hook type: ${JSON.stringify(config)}`);
    }
  }
}
