import { BridgeContractAddresses } from '../contracts';
import { ChainName } from '../../types';

export const local: Partial<Record<ChainName, BridgeContractAddresses>> = {
  celo: {
    router: {
      proxy: '0xCD8a1C3ba11CF5ECfa6267617243239504a98d90',
      implementation: '0x5f3f1dBD7B74C6B46e8c44f98792A1dAf8d69154',
      beacon: '0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575',
    },
    token: {
      proxy: '0x1291Be112d480055DaFd8a610b7d1e203891C274',
      implementation: '0x809d550fca64d94Bd9F66E60752A544199cfAC3D',
      beacon: '0x4c5859f0F772848b2D91F1D83E2Fe57935348029',
    },
  },
  ethereum: {
    router: {
      proxy: '0xFD471836031dc5108809D173A067e8486B9047A3',
      implementation: '0x7bc06c482DEAd17c0e297aFbC32f6e63d3846650',
      beacon: '0xc351628EB244ec633d5f21fBD6621e1a683B1181',
    },
    token: {
      proxy: '0x7969c5eD335650692Bc04293B07F5BF2e7A673C0',
      implementation: '0x82e01223d51Eb87e16A03E24687EDF0F294da6f1',
      beacon: '0x2bdCC0de6bE1f7D2ee689a0342D76F52E8EFABa3',
    },
  },
  polygon: {
    router: {
      proxy: '0x5081a39b8A5f0E35a8D959395a630b68B74Dd30f',
      implementation: '0x162A433068F51e18b7d13932F27e66a3f99E6890',
      beacon: '0x922D6956C99E12DFeB3224DEA977D0939758A1Fe',
    },
    token: {
      proxy: '0xB0D4afd8879eD9F52b28595d31B441D079B2Ca07',
      implementation: '0xcbEAF3BDe82155F56486Fb5a1072cb8baAf547cc',
      beacon: '0x1429859428C0aBc9C2C47C8Ee9FBaf82cFA0F20f',
    },
  },
};
