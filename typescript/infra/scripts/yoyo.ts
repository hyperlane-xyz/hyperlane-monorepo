import { AbacusCore, ChainNameToDomainId } from '@abacus-network/sdk';
import { YoApp } from '@abacus-network/yo/dist/src/index';

import { TestnetNetworks } from "../config/environments/testnet/domains";
import { getCoreEnvironmentConfig, getEnvironment } from './utils';

export const addresses = {
  "alfajores": {
    "router": "0xB7C51c5fc8D2deA2563370aaC6993c8893098442",
    "abacusConnectionManager": "0x433f7d6d0cB9eb8FF2902Ad01C1BEd6C09934a33"
  },
  "kovan": {
    "router": "0xE3D93F9296FA3dF262E1a54f0de02F71E845af6b",
    "abacusConnectionManager": "0xF7561c34f17A32D5620583A3397C304e7038a7F6"
  },
  "fuji": {
    "router": "0x1D8742741d87d886F72dC0379541Cd4188DFd46E",
    "abacusConnectionManager": "0xF7561c34f17A32D5620583A3397C304e7038a7F6"
  },
  "mumbai": {
    "router": "0x5f2fFCF69c58AcA2b521690400756FAe8CC99117",
    "abacusConnectionManager": "0x46f7C5D896bbeC89bE1B19e4485e59b4Be49e9Cc"
  },
  "bsctestnet": {
    "router": "0x36502C6e24C51ba4839c4c4A070aeB52E1adB672",
    "abacusConnectionManager": "0xC2E36cd6e32e194EE11f15D9273B64461A4D49A2"
  },
  "arbitrumrinkeby": {
    "router": "0xd9d99AC1C645563576b8Df22cBebFC23FB60Ec73",
    "abacusConnectionManager": "0xC2E36cd6e32e194EE11f15D9273B64461A4D49A2"
  },
  "optimismkovan": {
    "router": "0xCCC126d96efcc342BF2781A7d224D3AB1F25B19C",
    "abacusConnectionManager": "0xC2E36cd6e32e194EE11f15D9273B64461A4D49A2"
  }
}

async function main() {
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  const core = AbacusCore.fromEnvironment(environment, multiProvider);
  const app = new YoApp(
    addresses,
    // @ts-ignore
    multiProvider,
  );
  console.log(!!core);
  const networks = Object.keys(addresses) as TestnetNetworks[]
  const crossNetworks = networks.map(origin => ({ origin, remotes: networks.filter(_ => _ !== origin) }))
  // for (const origin of networks) {
  //     for (const remote of networks) {
  //         if (origin === remote) {
  //             continue
  //         }

  //         console.log(`sent from ${origin} to ${remote}`)
  //         await app.yoRemote(origin, remote)
  //     }
  // }

  const map = app.contractsMap;

  const stats = await Promise.all(crossNetworks.map(({ origin,  remotes}) => {
    return Promise.all(remotes.map(async (remote) => {
      const sendingStat = await map[origin].contracts.router.sentTo(ChainNameToDomainId[remote])
      const receivingStat = await map[remote].contracts.router.receivedFrom(ChainNameToDomainId[origin])
      return { origin, remote, sent: sendingStat.toNumber(), received: receivingStat.toNumber() }
    }))
  }))
  console.log(stats);
}

main().then(console.log).catch(console.error);
