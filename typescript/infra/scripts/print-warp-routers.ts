import { strip0x } from '@hyperlane-xyz/utils';

import { getWarpCoreConfig } from '../config/registry.js';

import { getArgs, getWarpRouteIdInteractive } from './agent-utils.js';

// This is a quality of life script meant to be used with https://abacus-works.metabaseapp.com/dashboard/793-warp-route-details?routers_comma_separated=4F0654395d621De4d1101c0F98C1Dba73ca0a61f%2CbBa1938ff861c77eA1687225B9C33554379Ef327%2Ca0bD9e96556E27e6FfF0cC0F77496390d9844E1e%2C69158d1A7325Ca547aF66C3bA599F8111f7AB519%2C910FF91a92c9141b8352Ad3e50cF13ef9F3169A1%2C324d0b921C03b1e42eeFD198086A64beC3d736c2%2C7bD2676c85cca9Fa2203ebA324fb8792fbd520b8%2C2dC335bDF489f8e978477Ae53924324697e0f7BB%2C5beADE696E12aBE2839FEfB41c7EE6DA1f074C55%2C4A8149B1b9e0122941A69D01D23EaE6bD1441b4f%2CAf6bEdBA6ab73f0a5941d429807C8B9c24Ea95F3
// which allows you to input a comma separated list of warp route router address
// and view the unprocessed messages relating to them.

async function main() {
  const { environment } = await getArgs().argv;
  const warpRouteId = await getWarpRouteIdInteractive(environment);

  const warpConfig = getWarpCoreConfig(warpRouteId);
  const addresses = warpConfig.tokens
    .filter((t) => !!t.addressOrDenom)
    // The metabase query expects addresses without the 0x prefix
    .map((t) => strip0x(t.addressOrDenom!));

  console.log(addresses.join(','));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
