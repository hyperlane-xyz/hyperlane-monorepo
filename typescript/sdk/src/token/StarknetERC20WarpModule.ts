import {
  Account,
  Contract,
  byteArray,
  eth,
  getChecksumAddress,
  uint256,
} from 'starknet';

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
    // Process only Starknet chains
    for (const [chain, tokenAddress] of Object.entries(routerAddresses)) {
      const isStarknetChain =
        this.multiProvider.getChainMetadata(chain).protocol !==
        ProtocolType.Starknet;
      if (isStarknetChain) {
        continue;
      }

      const account = this.account[chain];

      // Router ABI for enrollment
      const ROUTER_ABI = [
        {
          type: 'function',
          name: 'enroll_remote_router',
          inputs: [
            {
              name: 'domain',
              type: 'core::integer::u32',
            },
            {
              name: 'router',
              type: 'core::integer::u256',
            },
          ],
          outputs: [],
          state_mutability: 'external',
        },
      ];

      // Initialize contract with the deployed token address
      const contract = new Contract(ROUTER_ABI, tokenAddress, account);

      // For each non-Starknet chain, enroll its router
      for (const [remoteChain, remoteAddress] of Object.entries(
        routerAddresses,
      )) {
        if (remoteChain === chain) continue; // Skip self-enrollment

        try {
          const remoteDomain = this.multiProvider.getDomainId(remoteChain);
          const remoteRouter = uint256.bnToUint256(
            eth.validateAndParseEthAddress(remoteAddress),
          );

          this.logger.info(
            `Enrolling remote router on ${chain} for domain ${remoteDomain} with address ${remoteAddress}`,
          );

          const tx = await contract.invoke('enroll_remote_router', [
            remoteDomain,
            remoteRouter,
          ]);

          await account.waitForTransaction(tx.transaction_hash);

          this.logger.info(
            `Successfully enrolled remote router on ${chain}. Transaction: ${tx.transaction_hash}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to enroll remote router on ${chain} for chain ${remoteChain}: ${error}`,
          );
          throw error;
        }
      }
    }
  }
}
