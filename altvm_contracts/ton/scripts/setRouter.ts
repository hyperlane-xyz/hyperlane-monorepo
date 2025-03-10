import { NetworkProvider } from '@ton/blueprint';

import { loadWarpRoute, setRouter } from './common';

export async function run(provider: NetworkProvider) {
  const originDomain = Number(process.env.ORIGIN_DOMAIN);
  const destDomain = Number(process.env.DESTINATION_DOMAIN);
  const warp1 = loadWarpRoute(provider, originDomain);
  const warp2 = loadWarpRoute(provider, destDomain);

  console.log('Set router');
  await setRouter(
    provider,
    warp1.tokenRouter,
    destDomain,
    warp2.tokenRouter.address,
  );
  console.log('Done');
  console.log('Set router');
  await setRouter(
    provider,
    warp2.tokenRouter,
    originDomain,
    warp1.tokenRouter.address,
  );
  console.log('Done');
}
