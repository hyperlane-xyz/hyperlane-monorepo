import debug from 'debug';

import { Address } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { HyperlaneIgpDeployer } from '../gas/HyperlaneIgpDeployer';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
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
    readonly ismFactory: HyperlaneIsmFactory,
    readonly igpDeployer = new HyperlaneIgpDeployer(multiProvider),
  ) {
    super(multiProvider, hookFactories, {
      logger: debug('hyperlane:HookDeployer'),
    });
  }

  async deployContracts(
    chain: ChainName,
    config: HookConfig,
    mailbox = this.mailboxes[chain],
  ): Promise<HyperlaneContracts<HookFactories>> {
    let deployedHooks: any = {};
    if (config.type === HookType.MERKLE_TREE) {
      const hook = await this.deployContract(chain, config.type, [mailbox]);
      deployedHooks = { [config.type]: hook };
    } else if (config.type === HookType.INTERCHAIN_GAS_PAYMASTER) {
      // TODO: share timelock/proxyadmin with core
      await this.igpDeployer.deployContracts(chain, config);
    } else if (config.type === HookType.AGGREGATION) {
      for (const hookConfig of config.modules) {
        deployedHooks[hookConfig.type] = await this.deployContracts(
          chain,
          hookConfig,
          mailbox,
        );
      }
      const aggregationHookFactory =
        this.ismFactory.getContracts(chain).aggregationHookFactory;
      this.ismFactory.deployThresholdFactory();
    } else {
      throw new Error(`Unexpected hook type: ${JSON.stringify(config)}`);
    }

    return deployedHooks;
  }
}
