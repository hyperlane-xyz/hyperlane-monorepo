import debug from 'debug';

import { Address } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import {
  HookFactories,
  MerkleTreeHookFactory,
  hookFactories,
} from './contracts';
import { HookConfig, HookType } from './types';

export class HyperlaneHookDeployer extends HyperlaneDeployer<
  HookConfig,
  HookFactories
> {
  constructor(
    multiProvider: MultiProvider,
    readonly ismFactory: HyperlaneIsmFactory,
    readonly mailboxes: ChainMap<Address>,
  ) {
    super(multiProvider, hookFactories, {
      logger: debug('hyperlane:HyperlaneHookDeployer'),
    });
  }

  async deployContracts(
    chain: ChainName,
    config: HookConfig,
  ): Promise<HyperlaneContracts<HookFactories>> {
    if (config.type === HookType.MERKLE_TREE_HOOK) {
      return this.deployMerkleTreeHook(chain, config);
    } else {
      throw new Error(`Unsupported hook type: ${config.type}`);
    }
  }

  async deployMerkleTreeHook(
    chain: ChainName,
    _: HookConfig,
  ): Promise<HyperlaneContracts<MerkleTreeHookFactory>> {
    this.logger(`Deploying MerkleTreeHook to ${chain}`);
    const merkleTreeHook = await this.deployContract(chain, 'merkleTreeHook', [
      this.mailboxes[chain],
    ]);
    return {
      merkleTreeHook: merkleTreeHook,
    };
  }
}
