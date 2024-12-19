import { Account, byteArray, getChecksumAddress } from 'starknet';

import { TokenType } from '@hyperlane-xyz/sdk';
import { ContractType } from '@hyperlane-xyz/starknet-core';
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
    protected readonly account: ChainMap<Account>,
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
      { mailbox, interchainSecurityModule, type, ...rest },
    ] of Object.entries(this.config)) {
      //Ignore non-starknet chains
      if (
        this.multiProvider.getChainMetadata(chain).protocol !==
        ProtocolType.Starknet
      )
        continue;

      const deployer = new StarknetDeployer(this.account[chain]);
      const deployerAccountAddress = this.account[chain].address;
      const ismAddress = await this.getStarknetDeploymentISMAddress({
        ismConfig: interchainSecurityModule,
        mailbox: mailbox,
        chain,
        deployer,
      });
      switch (type) {
        case TokenType.synthetic: {
          const tokenAddress = await deployer.deployContract(
            'HypErc20',
            {
              decimals: tokenMetadata.decimals,
              mailbox: mailbox,
              total_supply: tokenMetadata.totalSupply,
              name: [byteArray.byteArrayFromString(tokenMetadata.name)],
              symbol: [byteArray.byteArrayFromString(tokenMetadata.symbol)],
              hook: getChecksumAddress(0),
              interchain_security_module: ismAddress,
              owner: deployerAccountAddress, //TODO: use config.owner, and in warp init ask for starknet owner
            },
            ContractType.TOKEN,
          );
          addresses[chain] = tokenAddress;
          break;
        }
        case TokenType.native: {
          const tokenAddress = await deployer.deployContract(
            'HypNative',
            {
              mailbox: mailbox,
              native_token:
                '0x49D36570D4E46F48E99674BD3FCC84644DDD6B96F7C741B1562B82F9E004DC7', // ETH address on Starknet chains
              hook: getChecksumAddress(0),
              interchain_security_module: ismAddress,
              owner: deployerAccountAddress, //TODO: use config.owner, and in warp init ask for starknet owner
            },
            ContractType.TOKEN,
          );
          addresses[chain] = tokenAddress;
          break;
        }

        case TokenType.collateral: {
          console.log({
            mailbox: mailbox,
            // @ts-ignore
            erc20: rest.token,
            owner: deployerAccountAddress, //TODO: use config.owner, and in warp init ask for starknet owner
            hook: getChecksumAddress(0),
            interchain_security_module: ismAddress,
          });
          const tokenAddress = await deployer.deployContract(
            'HypErc20Collateral',
            {
              mailbox: mailbox,
              // @ts-ignore
              erc20: rest.token,
              owner: deployerAccountAddress, //TODO: use config.owner, and in warp init ask for starknet owner
              hook: getChecksumAddress(0),
              interchain_security_module: ismAddress,
            },
            ContractType.TOKEN,
          );
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
    return deployer.deployIsm({
      chain,
      ismConfig,
      mailbox,
    });
  }
}
