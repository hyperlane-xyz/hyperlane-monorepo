import { NetworkProvider } from '@ton/blueprint';
import { Address, toNano } from '@ton/core';
import * as fs from 'fs';
import * as path from 'path';

import { TokenRouter } from '../wrappers/TokenRouter';

import { loadWarpRoute } from './common';

export async function run(provider: NetworkProvider) {
  const originDomain = Number(process.env.ORIGIN_DOMAIN);
  const destDomain = Number(process.env.DESTINATION_DOMAIN);

  console.log(
    `Loading warp routes for domains ${originDomain} and ${destDomain}`,
  );

  const warp1 = loadWarpRoute(provider, originDomain);
  const warp2 = loadWarpRoute(provider, destDomain);

  console.log(`Setting router from ${originDomain} -> ${destDomain}`);
  await warp1.tokenRouter.sendSetRouter(provider.sender(), toNano(0.1), {
    domain: destDomain,
    router: warp2.tokenRouter.address.hash,
  });

  console.log(`Setting router from ${destDomain} -> ${originDomain}`);
  await warp2.tokenRouter.sendSetRouter(provider.sender(), toNano(0.1), {
    domain: originDomain,
    router: warp1.tokenRouter.address.hash,
  });

  console.log('Routers set successfully!');
}
