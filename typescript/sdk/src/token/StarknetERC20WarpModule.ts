import { Account, byteArray, getChecksumAddress } from 'starknet';

import { ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { StarknetDeployer } from '../deploy/StarknetDeployer.js';
import { IsmConfig } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { WarpRouteDeployConfig } from './types.js';

export class StarknetERC20WarpModule {
  protected logger = rootLogger.child({ module: 'StarknetERC20WarpModule' });
  protected deployer: StarknetDeployer;

  constructor(
    protected readonly signer: Account,
    protected readonly config: WarpRouteDeployConfig,
    protected readonly multiProvider: MultiProvider,
  ) {
    this.deployer = new StarknetDeployer(signer);
  }

  public async deployToken() {
    for (const [chain, chainConfig] of Object.entries(this.config)) {
      //Ignore non-starknet chains
      if (
        this.multiProvider.getChainMetadata(chain).protocol !==
        ProtocolType.Starknet
      )
        continue;

      let ismAddress = await this.getStarknetDeploymentISMAddress({
        ismConfig: chainConfig.interchainSecurityModule,
        mailbox: chainConfig.mailbox,
        chain,
      });

      const tokenAddress = await this.deployer.deployContract('HypErc20', {
        decimals: 18,
        mailbox: chainConfig.mailbox,
        total_supply: 0,
        name: [byteArray.byteArrayFromString('etherum')],
        symbol: [byteArray.byteArrayFromString('ETH')],
        hook: getChecksumAddress(0),
        interchain_security_module: ismAddress,
        owner: this.signer.address,
      });
      console.log({ tokenAddress });
    }
  }

  async getStarknetDeploymentISMAddress({
    ismConfig,
    chain,
    mailbox,
  }: {
    ismConfig?: IsmConfig;
    chain: string;
    mailbox: string;
  }): Promise<string> {
    if (!ismConfig) return getChecksumAddress(0);
    if (typeof ismConfig === 'string') return ismConfig;
    return await this.deployer.deployIsm({
      chain,
      ismConfig,
      mailbox,
    });
  }
}
