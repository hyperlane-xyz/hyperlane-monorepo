import { Signer } from 'ethers';
import { Account, byteArray, getChecksumAddress } from 'starknet';

import { TokenType } from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, rootLogger } from '@hyperlane-xyz/utils';

import { StarknetDeployer } from '../deploy/StarknetDeployer.js';
import { IsmConfig } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap } from '../types.js';

import { HypERC20Deployer } from './deploy.js';
import { WarpRouteDeployConfig } from './types.js';

export class StarknetERC20WarpModule {
  protected logger = rootLogger.child({ module: 'StarknetERC20WarpModule' });

  constructor(
    protected readonly getAccount: (chain: string) => Promise<Account | Signer>,
    protected readonly config: WarpRouteDeployConfig,
    protected readonly multiProvider: MultiProvider,
  ) {}

  public async deployToken(): Promise<ChainMap<string>> {
    // TODO: manage this in a multi-protocol way, for now works as we just support native-synthetic pair
    const tokenMetadata = await HypERC20Deployer.deriveTokenMetadata(
      this.multiProvider,
      this.config,
    );
    assert(
      tokenMetadata && tokenMetadata.decimals,
      "Token metadata can't be extracted",
    );
    const addresses: ChainMap<string> = {};
    for (const [
      chain,
      { mailbox, interchainSecurityModule, type },
    ] of Object.entries(this.config)) {
      //Ignore non-starknet chains
      if (
        this.multiProvider.getChainMetadata(chain).protocol !==
        ProtocolType.Starknet
      )
        continue;

      const account = (await this.getAccount(chain)) as Account;
      const deployer = new StarknetDeployer(account);

      let ismAddress = await this.getStarknetDeploymentISMAddress({
        ismConfig: interchainSecurityModule,
        mailbox: mailbox,
        chain,
        deployer,
      });
      switch (type) {
        case TokenType.synthetic: {
          const tokenAddress = await deployer.deployContract('HypErc20', {
            decimals: tokenMetadata.decimals,
            mailbox: mailbox,
            total_supply: tokenMetadata.totalSupply,
            name: [byteArray.byteArrayFromString(tokenMetadata.name)],
            symbol: [byteArray.byteArrayFromString(tokenMetadata.symbol)],
            hook: getChecksumAddress(0),
            interchain_security_module: ismAddress,
            owner: account.address, //TODO: use config.owner, and in warp init ask for starknet owner
          });
          addresses[chain] = tokenAddress;
          break;
        }
        case TokenType.native: {
          const tokenAddress = await deployer.deployContract('HypNative', {
            mailbox: mailbox,
            hook: getChecksumAddress(0),
            interchain_security_module: ismAddress,
            owner: account.address, //TODO: use config.owner, and in warp init ask for starknet owner
          });
          addresses[chain] = tokenAddress;
          break;
        }
        default:
          throw Error('Token type is not supported on starknet');
      }
    }
    return addresses;
  }

  async getStarknetDeploymentISMAddress({
    ismConfig,
    chain,
    mailbox,
    deployer,
  }: {
    ismConfig?: IsmConfig;
    chain: string;
    mailbox: string;
    deployer: StarknetDeployer;
  }): Promise<string> {
    if (!ismConfig) return getChecksumAddress(0);
    if (typeof ismConfig === 'string') return ismConfig;
    return await deployer.deployIsm({
      chain,
      ismConfig,
      mailbox,
    });
  }
}
