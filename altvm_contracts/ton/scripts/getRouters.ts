import { NetworkProvider } from '@ton/blueprint';
import { Address, Cell } from '@ton/core';

import { loadWarpRoute } from './common';
import { Route } from './types';

export async function run(provider: NetworkProvider) {
  const originDomain = Number(process.env.ORIGIN_DOMAIN);
  const destDomain = Number(process.env.DESTINATION_DOMAIN);

  const printStorage = async (domain: number, route: Route) => {
    const storage = await route.tokenRouter.getStorage();
    const routers = storage.routers;
    console.log(
      `router ${domain} ${route.tokenRouter.address.toRawString()} ${route.tokenRouter.address.toString(
        { testOnly: false },
      )}:`,
    );
    for (const key of routers.keys()) {
      const addr = routers.get(key);
      if (addr) {
        const tonAddress = new Address(0, addr);
        console.log(`  ${key}: ${tonAddress.toRawString()}`);
      }
    }
    const state = await provider.provider(route.tokenRouter.address).getState();
    if (state.state.type == 'active') {
      console.log(
        'code hash',
        Cell.fromBoc(state.state.code!)[0].hash().toString('hex'),
      );
    }
    console.log(
      '  Mailbox',
      storage.mailboxAddress.toRawString(),
      storage.mailboxAddress.toString({ testOnly: true }),
    );

    console.log(
      '  Jetton',
      storage.jettonAddress?.toRawString(),
      storage.jettonAddress?.toString({ testOnly: true }),
    );
    ``;
  };
  const originRoute = loadWarpRoute(provider, originDomain);
  await printStorage(originDomain, originRoute);
  const destRoute = loadWarpRoute(provider, destDomain);
  await printStorage(destDomain, destRoute);
}
