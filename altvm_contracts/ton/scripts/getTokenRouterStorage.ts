import { NetworkProvider } from '@ton/blueprint';
import { Address } from '@ton/core';
import * as fs from 'fs';
import * as path from 'path';

import { JettonMinterContract } from '../wrappers/JettonMinter';
import { TokenRouter } from '../wrappers/TokenRouter';

import { loadWarpRoute } from './common';
import { Route } from './types';

export async function run(provider: NetworkProvider) {
  const originDomain = Number(process.env.ORIGIN_DOMAIN);
  const destDomain = Number(process.env.DESTINATION_DOMAIN);

  const route = loadWarpRoute(provider, originDomain);

  let storage = await route.tokenRouter.getStorage();
  console.log(
    'TokenRouterConfig:',
    JSON.stringify(
      storage,
      (key, value) => {
        if (
          value &&
          typeof value.toString === 'function' &&
          value.constructor.name === 'Address'
        ) {
          return value.toString();
        }
        if (Buffer.isBuffer(value)) {
          return value.toString('hex');
        }
        return value;
      },
      2,
    ),
  );
}
