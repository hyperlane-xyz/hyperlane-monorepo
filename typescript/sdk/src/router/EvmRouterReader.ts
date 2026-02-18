import { constants } from 'ethers';

import { MailboxClient__factory, Router__factory } from '@hyperlane-xyz/core';
import { Address, eqAddress, rootLogger } from '@hyperlane-xyz/utils';

import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { EvmHookReader } from '../hook/EvmHookReader.js';
import { EvmIsmReader } from '../ism/EvmIsmReader.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';
import { HyperlaneReader } from '../utils/HyperlaneReader.js';

import {
  DerivedMailboxClientConfig,
  DerivedRouterConfig,
  RemoteRouters,
  RemoteRoutersSchema,
} from './types.js';

export class EvmRouterReader extends HyperlaneReader {
  protected readonly logger = rootLogger.child({ module: 'EvmRouterReader' });
  protected evmHookReader: EvmHookReader;
  protected evmIsmReader: EvmIsmReader;

  constructor(
    multiProvider: MultiProvider,
    chain: ChainNameOrId,
    protected readonly concurrency: number = DEFAULT_CONTRACT_READ_CONCURRENCY,
  ) {
    super(multiProvider, chain);
    this.evmHookReader = new EvmHookReader(multiProvider, chain, concurrency);
    this.evmIsmReader = new EvmIsmReader(multiProvider, chain, concurrency);
  }

  public async readRouterConfig(
    address: Address,
  ): Promise<DerivedRouterConfig> {
    const mailboxClientConfig = await this.fetchMailboxClientConfig(address);
    const remoteRouters = await this.fetchRemoteRouters(address);
    // proxyAdmin and foreignDeployment are not directly readable from a generic router
    // and depend on deployment context or specific router implementations.
    return {
      ...mailboxClientConfig,
      remoteRouters,
    };
  }

  async fetchMailboxClientConfig(
    routerAddress: Address,
  ): Promise<DerivedMailboxClientConfig> {
    const mailboxClient = MailboxClient__factory.connect(
      routerAddress,
      this.provider,
    );
    const { mailbox, owner, hookAddress, ismAddress } =
      await this.multiProvider.multicall(this.chain, {
        mailbox: {
          contract: mailboxClient,
          functionName: 'mailbox',
          transform: (result) => result as Address,
        },
        owner: {
          contract: mailboxClient,
          functionName: 'owner',
          transform: (result) => result as Address,
        },
        hookAddress: {
          contract: mailboxClient,
          functionName: 'hook',
          transform: (result) => result as Address,
        },
        ismAddress: {
          contract: mailboxClient,
          functionName: 'interchainSecurityModule',
          transform: (result) => result as Address,
        },
      });

    const derivedIsm = eqAddress(ismAddress, constants.AddressZero)
      ? constants.AddressZero
      : await this.evmIsmReader.deriveIsmConfig(ismAddress);
    const derivedHook = eqAddress(hookAddress, constants.AddressZero)
      ? constants.AddressZero
      : await this.evmHookReader.deriveHookConfig(hookAddress);

    return {
      owner,
      mailbox,
      hook: derivedHook,
      interchainSecurityModule: derivedIsm,
    };
  }

  async fetchRemoteRouters(routerAddress: Address): Promise<RemoteRouters> {
    const router = Router__factory.connect(routerAddress, this.provider);
    const domains = await router.domains();

    const remoteRouters = (await this.multiProvider.multicall(
      this.chain,
      domains.map((domain) => ({
        contract: router,
        functionName: 'routers',
        args: [domain],
      })),
    )) as Address[];

    const routers = Object.fromEntries(
      domains.map((domain, index) => [
        domain,
        { address: remoteRouters[index] },
      ]),
    );
    return RemoteRoutersSchema.parse(routers);
  }
}
