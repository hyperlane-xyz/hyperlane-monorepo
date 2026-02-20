import fs from 'fs';

import { ERC20Test__factory } from '@hyperlane-xyz/core';
import {
  HyperlaneSmartProvider,
  LocalAccountEvmSigner,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { ensure0x } from '@hyperlane-xyz/utils';

async function deployERC20() {
  const [rpcUrl, chain1, chain2, privateKey, outPath] = process.argv.slice(2);
  console.log('Deploying Test ERC20 contract to local node');
  const provider = HyperlaneSmartProvider.fromRpcUrl(31337, rpcUrl);
  const signer = new LocalAccountEvmSigner(ensure0x(privateKey)).connect(
    provider as any,
  );
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
