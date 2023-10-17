import { ConnectionClientViolation } from '..';
import { ethers } from 'ethers';

import { addressToBytes32, eqAddress } from '@hyperlane-xyz/utils';

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
  ClientViolation,
  ClientViolationType,
  MailboxClientConfig,
  OwnableConfig,
  RouterConfig,
  RouterViolation,
  RouterViolationType,
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
    await this.checkMailboxClient(chain);
    await this.checkEnrolledRouters(chain);
    await super.checkOwnership(chain, this.configMap[chain].owner);
  }

  async checkMailboxClient(chain: ChainName): Promise<void> {
    const router = this.app.router(this.app.getContracts(chain));

    const checkMailboxClientProperty = async (
      property: keyof (MailboxClientConfig & OwnableConfig),
      violationType: ClientViolationType,
    ) => {
      const actual = await router[property]();
      const value = this.configMap[chain][property];

      // If the value is an object, it's an ISM config
      // and we should make sure it matches the actual ISM config
      if (value && typeof value === 'object') {
        if (!this.ismFactory) {
          throw Error(
            'ISM factory not provided to HyperlaneRouterChecker, cannot check object-based ISM config',
          );
        }

        const matches = await moduleMatchesConfig(
          chain,
          actual,
          value,
          this.multiProvider,
          this.ismFactory!.chainMap[chain],
        );

        if (!matches) {
          this.app.logger(
            `Deploying ISM; ISM config of actual ${actual} does not match expected config ${JSON.stringify(
              value,
            )}`,
          );
          const deployedIsm = await this.ismFactory.deploy(chain, value);
          const violation: ConnectionClientViolation = {
            chain,
            type: violationType,
            contract: router,
            actual,
            expected: deployedIsm.address,
            description: `ISM config does not match deployed ISM at ${deployedIsm.address}`,
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
        const violation: ClientViolation = {
          chain,
          type: violationType,
          contract: router,
          actual,
          expected,
        };
        this.addViolation(violation);
      }
    };

    await checkMailboxClientProperty('mailbox', ClientViolationType.Mailbox);
    await checkMailboxClientProperty('hook', ClientViolationType.Hook);
    await checkMailboxClientProperty(
      'interchainSecurityModule',
      ClientViolationType.Hook,
    );
  }

  async checkEnrolledRouters(chain: ChainName): Promise<void> {
    const router = this.app.router(this.app.getContracts(chain));

    await Promise.all(
      this.app.remoteChains(chain).map(async (remoteChain) => {
        const remoteRouterAddress = this.app.routerAddress(remoteChain);
        const remoteDomainId = this.multiProvider.getDomainId(remoteChain);
        const actualRouter = await router.routers(remoteDomainId);
        const expectedRouter = addressToBytes32(remoteRouterAddress);
        if (actualRouter !== expectedRouter) {
          const violation: RouterViolation = {
            chain,
            remoteChain,
            type: RouterViolationType.EnrolledRouter,
            contract: router,
            actual: actualRouter,
            expected: expectedRouter,
          };
          this.addViolation(violation);
        }
      }),
    );
  }
}
