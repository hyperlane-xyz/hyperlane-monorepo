import { constants } from 'ethers';

import {
  FungibleTokenRouter__factory,
  MailboxClient__factory,
  Router__factory,
} from '@hyperlane-xyz/core';
import { Address, eqAddress, rootLogger } from '@hyperlane-xyz/utils';

import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { EvmTokenFeeReader } from '../fee/EvmTokenFeeReader.js';
import { TokenFeeConfig } from '../fee/types.js';
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
  protected evmTokenFeeReader: EvmTokenFeeReader;

  constructor(
    multiProvider: MultiProvider,
    chain: ChainNameOrId,
    protected readonly concurrency: number = DEFAULT_CONTRACT_READ_CONCURRENCY,
  ) {
    super(multiProvider, chain);
    this.evmHookReader = new EvmHookReader(multiProvider, chain, concurrency);
    this.evmIsmReader = new EvmIsmReader(multiProvider, chain, concurrency);
    this.evmTokenFeeReader = new EvmTokenFeeReader(multiProvider, chain);
  }

  public async readRouterConfig(
    address: Address,
  ): Promise<DerivedRouterConfig> {
    const mailboxClientConfig = await this.fetchMailboxClientConfig(address);
    const remoteRouters = await this.fetchRemoteRouters(address);
    const tokenFee = await this.fetchTokenFee(address);
    // proxyAdmin and foreignDeployment are not directly readable from a generic router
    // and depend on deployment context or specific router implementations.
    return {
      ...mailboxClientConfig,
      tokenFee,
      remoteRouters,
    };
  }

  public async fetchTokenFee(address: Address): Promise<TokenFeeConfig> {
    const fungibleTokenRouter = FungibleTokenRouter__factory.connect(
      address,
      this.provider,
    );
    const tokenFee = await fungibleTokenRouter.feeRecipient();
    return this.evmTokenFeeReader.deriveTokenFeeConfig(tokenFee);
  }

  async fetchMailboxClientConfig(
    routerAddress: Address,
  ): Promise<DerivedMailboxClientConfig> {
    const mailboxClient = MailboxClient__factory.connect(
      routerAddress,
      this.provider,
    );
    const [mailbox, owner, hookAddress, ismAddress] = await Promise.all([
      mailboxClient.mailbox(),
      mailboxClient.owner(),
      mailboxClient.hook(),
      mailboxClient.interchainSecurityModule(),
    ]);

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

    const routers = Object.fromEntries(
      await Promise.all(
        domains.map(async (domain) => {
          return [domain, { address: await router.routers(domain) }];
        }),
      ),
    );
    return RemoteRoutersSchema.parse(routers);
  }
}
