import { Contract, RpcProvider } from 'starknet';

import { getCompiledContract } from '@hyperlane-xyz/starknet-core';
import { Domain, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';

import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from './AbstractHyperlaneModule.js';
import { EvmCoreReader } from './EvmCoreReader.js';
import { DeployedCoreAddresses } from './schemas.js';
import { CoreConfig } from './types.js';

export class StarknetCoreModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  CoreConfig,
  DeployedCoreAddresses
> {
  protected logger = rootLogger.child({ module: 'EvmCoreModule' });
  protected coreReader: EvmCoreReader;
  public readonly chainName: string;

  // We use domainId here because MultiProvider.getDomainId() will always
  // return a number, and EVM the domainId and chainId are the same.
  public readonly domainId: Domain;

  constructor(
    protected readonly multiProvider: MultiProvider,
    args: HyperlaneModuleParams<CoreConfig, DeployedCoreAddresses>,
  ) {
    super(args);
    this.coreReader = new EvmCoreReader(multiProvider, this.args.chain);
    this.chainName = this.multiProvider.getChainName(this.args.chain);
    this.domainId = multiProvider.getDomainId(args.chain);
  }

  public read(address: string): Promise<CoreConfig> {
    const mailboxContract = getCompiledContract('mailbox');
    const provider = new RpcProvider({
      nodeUrl: '',
    });
    const mailbox = new Contract(mailboxContract.abi, address, provider);
  }
}
