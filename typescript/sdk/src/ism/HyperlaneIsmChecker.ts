import { types } from '@hyperlane-xyz/utils';

import { HyperlaneAppChecker } from '../deploy/HyperlaneAppChecker';
import { ChainName } from '../types';

import { HyperlaneIsmFactory } from './HyperlaneIsmFactory';
import { IsmConfig } from './types';

// TODO: How do we feed in the module address?
export class HyperlaneIsmChecker extends HyperlaneAppChecker<
  HyperlaneIsmFactory,
  IsmConfig
> {
  constructor(
    multiProvider: MultiProvider,
    app: App,
    configMap: ChainMap<Config>,
    readonly addressMap: ChainMap<types.Address>,
  ) {
    super(multiProvider, app, configMap);
  }

  async checkChain(chain: ChainName): Promise<void> {
    const config = this.configMap[chain];

    await this.checkDomainOwnership(chain);
    await this.checkModule(chain);
  }

  async ownables(chain: ChainName): Promise<{ [key: string]: Ownable }> {
    // Recurse and collect routing ISMs
  }

  async checkModule(
    chain: ChainName,
    moduleAddress: types.Address,
    config: IsmConfig,
  ): Promise<boolean> {
    const provider = this.multiProvider.getProvider(chain);
    const module = IInterchainSecurityModule__factory.connect(
      moduleAddress,
      provider,
    );
    const actualType = await module.moduleType();
    if (actualType !== config.type) return false;
    switch (config.type) {
      case ModuleType.MULTISIG: {
        const multisigIsmFactory = this.getContracts(chain).multisigIsmFactory;
        const expectedAdddress = await multisigIsmFactory.getAddress(
          config.validators.sort(),
          config.threshold,
        );
        return eqAddress(expectedAdddress, module.address);
      }
      case ModuleType.ROUTING: {
        let matches = true;
        const routingIsm = new DomainRoutingIsm__factory()
          .attach(module.address)
          .connect(this.multiProvider.getProvider(chain));
        for (const chain of Object.keys(config.domains)) {
          const domainModule = await routingIsm.modules(
            this.multiProvider.getDomainId(chain),
          );
          matches =
            matches &&
            (await this.matches(chain, domainModule, config.domains[chain]));
        }
        return matches;
      }
      default: {
        throw new Error('Unsupported ModuleType');
      }
    }
  }
}
