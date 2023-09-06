import { ethers } from 'ethers';

import { addressToBytes32, assert, eqAddress } from '@hyperlane-xyz/utils';

import { HyperlaneFactories } from '../contracts/types';
import { HyperlaneAppChecker } from '../deploy/HyperlaneAppChecker';
import {
  HyperlaneIsmFactory,
  moduleMatchesConfig,
} from '../ism/HyperlaneIsmFactory';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { RouterApp } from './RouterApps';
import {
  ConnectionClientConfig,
  ConnectionClientViolation,
  ConnectionClientViolationType,
  OwnableConfig,
  RouterConfig,
} from './types';

export class HyperlaneRouterChecker<
  Factories extends HyperlaneFactories,
  App extends RouterApp<Factories>,
  Config extends RouterConfig,
> extends HyperlaneAppChecker<App, Config> {
  constructor(
    multiProvider: MultiProvider,
    app: App,
    configMap: ChainMap<Config>,
    readonly ismFactory?: HyperlaneIsmFactory,
  ) {
    super(multiProvider, app, configMap);
  }

  async checkChain(chain: ChainName): Promise<void> {
    await this.checkHyperlaneConnectionClient(chain);
    await this.checkEnrolledRouters(chain);
    await super.checkOwnership(chain, this.configMap[chain].owner);
  }

  async checkHyperlaneConnectionClient(chain: ChainName): Promise<void> {
    const router = this.app.router(this.app.getContracts(chain));

    const checkConnectionClientProperty = async (
      property: keyof (ConnectionClientConfig & OwnableConfig),
      violationType: ConnectionClientViolationType,
    ) => {
      const actual = await router[property]();
      const value = this.configMap[chain][property];

      // If the value is an object, it's an ISM config
      // and we should make sure it matches the actual ISM config
      if (value && typeof value === 'object') {
        const matches = await moduleMatchesConfig(
          chain,
          actual,
          value,
          this.multiProvider,
          this.ismFactory!.chainMap[chain],
        );

        if (!matches) {
          const violation: ConnectionClientViolation = {
            chain,
            type: violationType,
            contract: router,
            actual,
            expected: ethers.constants.AddressZero,
            description: `ISM config does not match expected config ${JSON.stringify(
              value,
            )}`,
          };
          this.addViolation(violation);
        }
        return;
      }
      const expected =
        value && typeof value === 'string'
          ? value
          : ethers.constants.AddressZero;
      if (!eqAddress(actual, expected)) {
        const violation: ConnectionClientViolation = {
          chain,
          type: violationType,
          contract: router,
          actual,
          expected,
        };
        this.addViolation(violation);
      }
    };

    await checkConnectionClientProperty(
      'mailbox',
      ConnectionClientViolationType.Mailbox,
    );
    await checkConnectionClientProperty(
      'interchainGasPaymaster',
      ConnectionClientViolationType.InterchainGasPaymaster,
    );
    await checkConnectionClientProperty(
      'interchainSecurityModule',
      ConnectionClientViolationType.InterchainSecurityModule,
    );
  }

  async checkEnrolledRouters(chain: ChainName): Promise<void> {
    const router = this.app.router(this.app.getContracts(chain));

    await Promise.all(
      this.app.remoteChains(chain).map(async (remoteChain) => {
        const remoteRouter = this.app.router(
          this.app.getContracts(remoteChain),
        );
        const remoteDomainId = this.multiProvider.getDomainId(remoteChain);
        const address = await router.routers(remoteDomainId);
        assert(address === addressToBytes32(remoteRouter.address));
      }),
    );
  }
}
