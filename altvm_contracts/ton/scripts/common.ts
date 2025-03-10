import { NetworkProvider, sleep } from '@ton/blueprint';
import { Address, OpenedContract, toNano } from '@ton/core';
import * as fs from 'fs';
import * as path from 'path';

import { JettonMinterContract } from '../wrappers/JettonMinter';
import { JettonWalletContract } from '../wrappers/JettonWallet';
import { TokenRouter } from '../wrappers/TokenRouter';

import { Route } from './types';

export function loadWarpRoute(
  provider: NetworkProvider,
  domain: number,
): Route {
  const filePath = path.join(__dirname, `../warp-contracts-${domain}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Deployed contracts file not found: ${filePath}`);
  }
  const addrs = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return {
    tokenRouter: provider.open(
      TokenRouter.createFromAddress(Address.parse(addrs.router)),
    ),
    jettonMinter: addrs.jetton
      ? provider.open(
          JettonMinterContract.createFromAddress(Address.parse(addrs.jetton)),
        )
      : undefined,
  };
}

export async function setRouter(
  provider: NetworkProvider,
  router: OpenedContract<TokenRouter>,
  domain: number,
  domainRouter: Address,
) {
  while (true) {
    await router.sendSetRouter(provider.sender(), toNano(0.03), {
      domain: domain,
      router: domainRouter.hash,
    });
    const routers = await router.getRouters();
    await sleep(15000);
    if (
      routers.get(domain)?.toString('hex') === domainRouter.hash.toString('hex')
    )
      break;
  }
}
