import {
  Account,
  Contract,
  MultiType,
  Uint256,
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
        mailbox: mailbox!,
        chain,
        deployer,
      });
      switch (type) {
        case TokenType.synthetic: {
          const tokenAddress = await deployer.deployContract(
            'HypErc20',
            {
              decimals: tokenMetadata.decimals,
              mailbox: mailbox!,
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
          const tokenAddress = await deployer.deployContract(
            'HypErc20Collateral',
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

      // Updated Router ABI to include batch enrollment
      const ROUTER_ABI = [
        {
          type: 'function',
          name: 'enroll_remote_routers',
          inputs: [
            {
              name: 'domains',
              type: 'core::array::Array::<core::integer::u32>',
            },
            {
              name: 'routers',
              type: 'core::array::Array::<core::integer::u256>',
            },
          ],
          outputs: [],
          state_mutability: 'external',
        },
      ];

      const contract = new Contract(ROUTER_ABI, tokenAddress, account);

      try {
        // Prepare arrays for batch enrollment
        const domains: number[] = [];
        const routers: Uint256[] = [];

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

        const tx = await contract.invoke('enroll_remote_routers', [
          domains,
          routers,
        ]);

        await account.waitForTransaction(tx.transaction_hash);

        this.logger.info(
          `Successfully enrolled all remote routers on ${chain}. Transaction: ${tx.transaction_hash}`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to enroll remote routers on ${chain}: ${error}`,
        );
        throw error;
      }
    }
  }
}
