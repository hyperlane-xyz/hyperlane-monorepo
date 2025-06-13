import {
  Account,
  MultiType,
  Uint256,
  byteArray,
  eth,
  getChecksumAddress,
  uint256,
} from 'starknet';

import {
  StarknetContractName,
  TokenType,
  getStarknetHypERC20Contract,
} from '@hyperlane-xyz/sdk';
import { ContractType } from '@hyperlane-xyz/starknet-core';
import { ProtocolType, assert, rootLogger } from '@hyperlane-xyz/utils';

import { StarknetDeployer } from '../deploy/StarknetDeployer.js';
import { IsmConfig } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap } from '../types.js';

import { HypERC20Deployer } from './deploy.js';
import { PROTOCOL_TO_DEFAULT_NATIVE_TOKEN } from './nativeTokenMetadata.js';
import { WarpRouteDeployConfigMailboxRequired } from './types.js';

export class StarknetERC20WarpModule {
  protected logger = rootLogger.child({ module: 'StarknetERC20WarpModule' });

  constructor(
    protected readonly account: ChainMap<Account>,
    protected readonly config: WarpRouteDeployConfigMailboxRequired,
    protected readonly multiProvider: MultiProvider,
  ) {}

  public async deployToken(): Promise<ChainMap<string>> {
    let tokenMetadata = await HypERC20Deployer.deriveTokenMetadata(
      this.multiProvider,
      this.config,
    );
    tokenMetadata = {
      symbol: 'USDC',
      name: 'USDC',
      decimals: 6,
    };
    console.log('tokenMetadata', JSON.stringify(tokenMetadata, null, 2));
    console.log('this.config', JSON.stringify(this.config, null, 2));
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

      const deployer = new StarknetDeployer(
        this.account[chain],
        this.multiProvider,
      );
      const deployerAccountAddress = this.account[chain].address;
      const ismAddress = await this.getStarknetDeploymentISMAddress({
        ismConfig: interchainSecurityModule,
        mailbox: mailbox!,
        chain,
        deployer,
      });
      switch (type) {
        case TokenType.synthetic: {
          const tokenAddress = await deployer.deployContract(
            StarknetContractName.HYP_ERC20,
            {
              decimals: tokenMetadata.decimals,
              mailbox: mailbox!,
              total_supply: uint256.bnToUint256(0),
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
            StarknetContractName.HYP_NATIVE,
            {
              mailbox: mailbox,
              native_token: PROTOCOL_TO_DEFAULT_NATIVE_TOKEN[
                ProtocolType.Starknet
              ]!.denom as MultiType,
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
          if (chain === 'paradex') {
            const dexContract =
              '0x3ca9388f8d4e04adecbd7b06b9b24a33030a593522248a7bddd87afc0b61a0c';

            const tokenAddress = await deployer.deployContract(
              StarknetContractName.HYP_ERC20_DEX_COLLATERAL,
              {
                mailbox: mailbox!,
                dex: dexContract,
                // @ts-ignore
                wrapped_token: rest.token,
                owner: deployerAccountAddress, //TODO: use config.owner, and in warp init ask for starknet owner
                hook: getChecksumAddress(0),
                interchain_security_module: ismAddress,
              },
              ContractType.TOKEN,
            );
            addresses[chain] = tokenAddress;
            break;
          } else {
            const tokenAddress = await deployer.deployContract(
              StarknetContractName.HYP_ERC20_COLLATERAL,
              {
                mailbox: mailbox!,
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
        }
        default:
          throw Error('Token type is not supported on starknet');
      }
    }

    // After all deployments are done, enroll the routers
    await this.enrollRemoteRouters(addresses);
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

  /**
   * Enrolls remote routers for all Starknet chains using the deployed token addresses
   * @param routerAddresses Map of chain name to token/router address
   */
  public async enrollRemoteRouters(
    routerAddresses: ChainMap<string>,
  ): Promise<void> {
    for (const [chain, tokenAddress] of Object.entries(routerAddresses)) {
      const isStarknetChain =
        this.multiProvider.getChainMetadata(chain).protocol !==
        ProtocolType.Starknet;
      if (isStarknetChain) {
        continue;
      }

      const account = this.account[chain];

      // HypERC20 inherits RouterComponent
      const routerContract = getStarknetHypERC20Contract(tokenAddress, account);

      // Prepare arrays for batch enrollment
      const domains: number[] = [];
      const routers: Uint256[] = [];

      routerAddresses = {
        ethereum: '0x6912088890254E69970baEdB03284fB3D8fBCDA0',
        arbitrum: '0xF5f93d26229482adCA3e42F84D08d549cF131658',
        base: '0x0BA30bdd7D3C510De16c47385102c0B7068f4f33',
        solanamainnet:
          '0x660b444593997d9465c9a9337eb5d92ca29c43ed71038b300829d689199773d1',
        mode: '0xcA4b9B3b6Dae4E5Dc2D749b2bD400ef62E7ae642',
      };

      // Collect all remote chains' data
      Object.entries(routerAddresses).forEach(
        ([remoteChain, remoteAddress]) => {
          if (remoteChain === chain) return; // Skip self-enrollment

          const remoteDomain = this.multiProvider.getDomainId(remoteChain);
          const remoteProtocol =
            this.multiProvider.getChainMetadata(remoteChain).protocol;

          // Only validate and parse ETH address for Ethereum chains
          const remoteRouter = uint256.bnToUint256(
            remoteProtocol === ProtocolType.Ethereum
              ? eth.validateAndParseEthAddress(remoteAddress)
              : remoteAddress,
          );

          domains.push(remoteDomain);
          routers.push(remoteRouter);
        },
      );

      this.logger.info(
        `Batch enrolling ${domains.length} remote routers on ${chain}`,
      );

      const tx = await routerContract.invoke('enroll_remote_routers', [
        domains,
        routers,
      ]);

      const receipt = await account.waitForTransaction(tx.transaction_hash);

      if (receipt.isSuccess()) {
        this.logger.info(
          `Successfully enrolled all remote routers on ${chain}. Transaction: ${tx.transaction_hash}`,
        );
      } else {
        this.logger.error(
          `Failed to enroll all remote routers on ${chain}. Transaction: ${tx.transaction_hash}`,
        );
      }
    }
  }
}
