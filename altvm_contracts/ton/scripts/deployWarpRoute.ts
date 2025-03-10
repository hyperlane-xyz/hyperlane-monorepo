import { NetworkProvider, compile, sleep } from '@ton/blueprint';
import {
  Address,
  Dictionary,
  OpenedContract,
  SendMode,
  Sender,
  toNano,
} from '@ton/core';
import * as fs from 'fs';
import * as path from 'path';

import {
  JettonMinterContract,
  buildTokenMetadataCell,
} from '../wrappers/JettonMinter';
import { TokenRouter } from '../wrappers/TokenRouter';

import { Route, TokenStandard } from './types';

async function retry(fn: () => Promise<void>, retries: number): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await fn();
      break;
    } catch (e: any) {
      console.log('Routine failed:', e.toString());
    }
  }
}

const log = console.log;
const m = (s: string): string => '\x1b[35m' + s + '\x1b[0m';
const b = (s: string): string => '\x1b[34m' + s + '\x1b[0m';
const bufeq = (a?: Buffer, b?: Buffer) =>
  a?.toString('hex') == b?.toString('hex');
async function deploy<T>(
  c: any,
  config: any,
  code: string,
  provider: NetworkProvider,
): Promise<OpenedContract<T>> {
  const codeCell = await compile(code);
  log(b('code hash:'), codeCell.hash().toString('hex'));
  const contract = provider.open(c.createFromConfig(config, codeCell));
  const value = code == 'JettonMinter' ? toNano('1.2') : toNano('0.1');
  await retry(async () => {
    await contract.sendDeploy(provider.sender(), value);
    await provider.waitForDeploy(contract.address, 20, 3000);
  }, 5);
  return contract;
}

async function deployWarpRoute(
  provider: NetworkProvider,
  tokenStandard: TokenStandard,
  mailboxAddress: Address,
): Promise<Route> {
  log(m('DEPLOY WARP ROUTE'), tokenStandard);
  const params: Partial<Route> = {};
  let routerType = 'HypNative';
  const routers: Dictionary<number, Buffer> = Dictionary.empty(
    Dictionary.Keys.Uint(32),
    Dictionary.Values.Buffer(32),
  );
  const jettonParams =
    tokenStandard == TokenStandard.Synthetic
      ? {
          name: 'Synthetic TON ' + Math.floor(Math.random() * 10000000),
          symbol: 'TsynTON',
          decimals: '9',
          description: 'test synthetic ton',
        }
      : {
          name: 'Collateral TON ' + Math.floor(Math.random() * 10000000),
          symbol: 'TcollTON',
          decimals: '9',
          description: 'test collateral ton',
        };

  if (tokenStandard === TokenStandard.Native) {
    routerType = 'HypNative';
  } else if (
    tokenStandard === TokenStandard.Synthetic ||
    tokenStandard === TokenStandard.Collateral
  ) {
    log(m('Deploy jetton'));
    params.jettonMinter = await deploy<JettonMinterContract>(
      JettonMinterContract,
      {
        adminAddress: provider.sender().address,
        content: buildTokenMetadataCell(jettonParams),
        jettonWalletCode: await compile('JettonWallet'),
      },
      'JettonMinter',
      provider,
    );

    routerType =
      tokenStandard === TokenStandard.Synthetic
        ? 'HypJetton'
        : 'HypJettonCollateral';
  }
  log(m('Deploy router with jetton'), params.jettonMinter?.address);
  params.tokenRouter = await deploy<TokenRouter>(
    TokenRouter,
    {
      ownerAddress: provider.sender().address,
      jettonAddress: params.jettonMinter?.address,
      mailboxAddress,
      routers,
      JettonWalletCode: params.jettonMinter
        ? await compile('JettonWallet')
        : undefined,
    },
    routerType,
    provider,
  );

  if (params.jettonMinter) {
    if (tokenStandard === TokenStandard.Collateral) {
      log(m('Mint jettons to relayer wallet'));
      await retry(async () => {
        await params.jettonMinter!.sendMint(provider.sender(), {
          toAddress: provider.sender().address!,
          responseAddress: provider.sender().address!,
          jettonAmount: toNano(100),
          queryId: 0,
          value: toNano(0.2),
        });
      }, 5);
      await sleep(5000);
    }
    log(m('Change jetton admin to jetton router'));
    await retry(async () => {
      await params.jettonMinter!.sendUpdateAdmin(provider.sender(), {
        value: toNano(0.03),
        newAdminAddress: params.tokenRouter!.address,
      });
    }, 5);
    log(m('Done.'));
  }

  return {
    jettonMinter: params.jettonMinter,
    tokenRouter: params.tokenRouter!,
  };
}

function writeWarpRoute(domain: number, route: Route) {
  const filePath = path.join(__dirname, `../warp-contracts-${domain}.json`);
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        jetton: route.jettonMinter?.address.toString(),
        router: route.tokenRouter.address.toString(),
      },
      null,
      ' ',
    ),
  );
}

export async function run(provider: NetworkProvider) {
  const originDomain = Number(process.env.ORIGIN_DOMAIN);
  const destDomain = Number(process.env.DESTINATION_DOMAIN);
  const origTokenStandard =
    (process.env.ORIGIN_TOKEN_STANDARD as TokenStandard) ??
    TokenStandard.Native;
  const destTokenStandard =
    (process.env.DESTINATION_TOKEN_STANDARD as TokenStandard) ??
    TokenStandard.Synthetic;
  const origMailboxAddress = Address.parse(process.env.ORIGIN_MAILBOX!);
  const destMailboxAddress = Address.parse(process.env.DESTINATION_MAILBOX!);

  const ui = provider.ui();

  const warp1 = await deployWarpRoute(
    provider,
    origTokenStandard,
    origMailboxAddress,
  );

  const warp2 = await deployWarpRoute(
    provider,
    destTokenStandard,
    destMailboxAddress,
  );

  log(m('Set destination router'));
  await retry(async () => {
    await warp1.tokenRouter.sendSetRouter(provider.sender(), toNano(0.03), {
      domain: destDomain,
      router: warp2.tokenRouter.address.hash,
    });
    let done = false;
    await retry(async () => {
      await sleep(5000);
      const routers = await warp1.tokenRouter.getRouters();
      if (!bufeq(routers.get(destDomain)!, warp2.tokenRouter.address.hash))
        throw 'waiting for sendSetRouter to complete';
      done = true;
    }, 10);
    if (!done) throw "router doesn't set";
  }, 5);
  log(m('Done'));
  log(m('Set origin router'));
  await retry(async () => {
    await warp2.tokenRouter.sendSetRouter(provider.sender(), toNano(0.03), {
      domain: originDomain,
      router: warp1.tokenRouter.address.hash,
    });
    let done = false;
    await retry(async () => {
      await sleep(5000);
      const routers = await warp2.tokenRouter.getRouters();
      if (!bufeq(routers.get(originDomain), warp1.tokenRouter.address.hash))
        throw 'waiting for sendSetRouter to complete';
      done = true;
    }, 10);
    if (!done) throw "router doesn't set";
  }, 5);

  log(m('Done'));
  console.log(
    `Warp route ${originDomain} (${origTokenStandard}) -> ${destDomain} (${destTokenStandard}):`,
  );

  console.log(
    originDomain,
    ' JettonMinter:',
    warp1.jettonMinter?.address.toString(),
  );
  console.log(
    originDomain,
    ' TokenRouter :',
    warp1.tokenRouter.address.toString(),
  );
  console.log(
    destDomain,
    ' JettonMinter:',
    warp2.jettonMinter?.address.toString(),
  );
  console.log(
    destDomain,
    ' TokenRouter :',
    warp2.tokenRouter.address.toString(),
  );

  writeWarpRoute(originDomain, warp1);
  writeWarpRoute(destDomain, warp2);
}
