import { Wallet, ethers } from 'ethers';

import {
  Chains,
  HyperlaneCore,
  MultiProvider,
  objMap,
} from '@hyperlane-xyz/sdk';
import { RouterConfig, chainConnectionConfigs } from '@hyperlane-xyz/sdk';

import { TokenConfig, TokenType } from '../src/config';
import { HypERC20Deployer } from '../src/deploy';

const connectionConfigs = {
  goerli: {
    ...chainConnectionConfigs.goerli,
    provider: new ethers.providers.JsonRpcProvider(
      'https://eth-goerli.public.blastapi.io',
      5,
    ),
  },
  fuji: chainConnectionConfigs.fuji,
  alfajores: chainConnectionConfigs.alfajores,
  moonbasealpha: chainConnectionConfigs.moonbasealpha,
};

async function deployNFTWrapper() {
  console.info('Getting signer');
  const signer = new Wallet(
    '3ed2c141ec02887887e94c1fbe5647fe5741c038deca248afbaaccf2c27d9258',
  );

  const multiProvider = new MultiProvider(connectionConfigs);
  multiProvider.rotateSigner(signer);
  const core = HyperlaneCore.fromEnvironment('testnet2', multiProvider);

  const config = objMap(
    connectionConfigs,
    (chain, _) =>
      ({
        type: TokenType.synthetic,
        name: 'Dai',
        symbol: 'DAI',
        totalSupply: 0,
        owner: signer.address,
        mailbox: '0x1d3aAC239538e6F1831C8708803e61A9EA299Eec',
        interchainGasPaymaster:
          core.getContracts(chain).interchainGasPaymaster.address,
      } as TokenConfig & RouterConfig),
  );
  config.goerli = {
    type: TokenType.collateral,
    token: '0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6',
    owner: signer.address,
    mailbox: '0x1d3aAC239538e6F1831C8708803e61A9EA299Eec',
    interchainGasPaymaster: core.getContracts(Chains.goerli)
      .interchainGasPaymaster.address,
  } as TokenConfig & RouterConfig;

  const deployer = new HypERC20Deployer(multiProvider, config, core);

  await deployer.deploy();
}

deployNFTWrapper().then(console.log).catch(console.error);
