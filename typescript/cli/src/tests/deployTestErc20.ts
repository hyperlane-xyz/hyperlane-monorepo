import { Wallet, providers } from 'ethers';
import fs from 'fs';

import { ERC20Test__factory } from '@hyperlane-xyz/core';
import { TokenType } from '@hyperlane-xyz/sdk';

async function deployERC20() {
  const [rpcUrl, chain1, chain2, privateKey, outPath] = process.argv.slice(2);
  console.log('Deploying Test ERC20 contract to local node');
  const provider = new providers.JsonRpcProvider(rpcUrl);
  const signer = new Wallet(privateKey, provider);
  const factory = new ERC20Test__factory(signer);
  const contract = await factory.deploy(
    'fake',
    'FAKE',
    '100000000000000000000',
    18,
  );
  await contract.deployed();
  console.log('Test ERC20 contract deployed', contract.address);

  const warpDeploymentConfig = {
    [chain1]: {
      type: TokenType.collateral,
      token: contract.address,
    },
    [chain2]: {
      type: TokenType.synthetic,
    },
  };

  console.log('Writing deployment config to', outPath);
  fs.writeFileSync(outPath, JSON.stringify(warpDeploymentConfig, null, 2));
}

deployERC20().catch(console.error);
