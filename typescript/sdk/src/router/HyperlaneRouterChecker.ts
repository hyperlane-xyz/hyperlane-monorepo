import { addressToBytes32, assert, eqAddress } from '@hyperlane-xyz/utils';

import { HyperlaneFactories } from '../contracts/types.js';
import { HyperlaneAppChecker } from '../deploy/HyperlaneAppChecker.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { moduleMatchesConfig } from '../ism/utils.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap, ChainName } from '../types.js';

import { RouterApp } from './RouterApps.js';
import {
  ClientViolation,
  ClientViolationType,
  RouterConfig,
  RouterViolation,
  RouterViolationType,
} from './types.js';

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
    await super.checkOwnership(
      chain,
      this.configMap[chain].owner,
      this.configMap[chain].ownerOverrides,
    );
  }

  async checkMailboxClient(chain: ChainName): Promise<void> {
    const router = this.app.router(this.app.getContracts(chain));

    const config = this.configMap[chain];

    const mailboxAddr = await router.mailbox();
    if (!eqAddress(mailboxAddr, config.mailbox)) {
      this.addViolation({
        chain,
        type: ClientViolationType.Mailbox,
        contract: router,
        actual: mailboxAddr,
        expected: config.mailbox,
      });
    }

    if (config.hook) {
      assert(
        typeof config.hook === 'string',
        'Hook objects not supported in router checker',
      );
      const hook = await router.hook();
      if (!eqAddress(hook, config.hook as string)) {
        this.addViolation({
          chain,
          type: ClientViolationType.Hook,
          contract: router,
          actual: hook,
          expected: config.hook,
        });
      }
    }

    if (config.interchainSecurityModule) {
      const actual = await router.interchainSecurityModule();
      if (
        typeof config.interchainSecurityModule !== 'string' &&
        !this.ismFactory
      ) {
        throw Error(
          'ISM factory not provided to HyperlaneRouterChecker, cannot check object-based ISM config',
        );
      }

      const matches = await moduleMatchesConfig(
        chain,
        actual,
        config.interchainSecurityModule,
        this.multiProvider,
        this.ismFactory?.chainMap[chain] ?? ({} as any),
      );

      if (!matches) {
        const violation: ClientViolation = {
          chain,
          type: ClientViolationType.InterchainSecurityModule,
          contract: router,
          actual,
          expected: config.interchainSecurityModule,
          description: `ISM config does not match deployed ISM`,
        };
        this.addViolation(violation);
      }
    }
  }

  async checkEnrolledRouters(chain: ChainName): Promise<void> {
    const router = this.app.router(this.app.getContracts(chain));
    const remoteChains = await this.app.remoteChains(chain);
    await Promise.all(
      remoteChains.map(async (remoteChain) => {
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
