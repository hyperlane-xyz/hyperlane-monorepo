import { ethers } from 'ethers';

import {
  ChainName,
  HyperlaneRouterDeployer,
} from '@hyperlane-xyz/sdk';

import {
  HypERC20CollateralConfig,
  HypERC20Config,
  HypERC721Config,
  isCollateralConfig,
  HypERC721CollateralConfig,
  isUriConfig,
} from './config';
import {
  HypERC20Contracts,
  HypERC721Contracts,
} from './contracts';
import { HypERC20Collateral__factory, HypERC20__factory, HypERC721Collateral__factory, HypERC721URICollateral__factory, HypERC721URIStorage__factory, HypERC721__factory } from './types';

export class HypERC20Deployer<
  Chain extends ChainName // inferred from configured chains passed to constructor
> extends HyperlaneRouterDeployer<
  Chain,
  HypERC20Config | HypERC20CollateralConfig,
  HypERC20Contracts,
  any // RouterFactories doesn't work well when router has multiple types
> {
  async deployContracts(
    chain: Chain,
    config: HypERC20Config | HypERC20CollateralConfig,
  ) {
    const ism = config.interchainSecurityModule ?? ethers.constants.AddressZero;
    const connection = this.multiProvider.getChainConnection(chain);
    if (isCollateralConfig(config)) {
      const router = await this.deployContractFromFactory(
        chain,
        new HypERC20Collateral__factory(),
        'HypERC20Collateral',
        [config.token],
      );
      await connection.handleTx(
        router.initialize(
          config.mailbox,
          config.interchainGasPaymaster,
          ism
        ),
      );
      return { router };
    } else {
      const router = await this.deployContractFromFactory(
        chain,
        new HypERC20__factory(),
        'HypERC20',
        [],
      );
      await connection.handleTx(router.initialize(
        config.mailbox,
        config.interchainGasPaymaster,
        ism,
        config.totalSupply,
        config.name,
        config.symbol,
      ));
      return { router };
    }
  }
}

// TODO: dedupe?
export class HypERC721Deployer<
  Chain extends ChainName
> extends HyperlaneRouterDeployer<
  Chain,
  HypERC721Config | HypERC721CollateralConfig,
  HypERC721Contracts,
  any
> {
  async deployContracts(
    chain: Chain,
    config: HypERC721Config | HypERC721CollateralConfig,
  ) {
    const ism = config.interchainSecurityModule ?? ethers.constants.AddressZero;
    const connection = this.multiProvider.getChainConnection(chain);
    if (isCollateralConfig(config)) {
      const router = await this.deployContractFromFactory(
        chain,
        isUriConfig(config) ? new HypERC721URICollateral__factory() : new HypERC721Collateral__factory(),
        `HypERC721${isUriConfig(config) ? 'URI' : ''}Collateral`,
        [config.token],
      );
      await connection.handleTx(
        router.initialize(
          config.mailbox,
          config.interchainGasPaymaster,
          ism
        ),
      );
      return { router };
    } else {
      const router = await this.deployContractFromFactory(
        chain,
        isUriConfig(config) ? new HypERC721URIStorage__factory() : new HypERC721__factory(),
        `HypERC721${isUriConfig(config) ? 'URIStorage' : ''}`,
        [],
      );
      await connection.handleTx(router.initialize(
        config.mailbox,
        config.interchainGasPaymaster,
        ism,
        config.totalSupply,
        config.name,
        config.symbol,
      ));
      return { router };
    }
  }
}
