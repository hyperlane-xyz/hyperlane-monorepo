export const addresses = {
  alfajores: {
    upgradeBeaconController: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    xAppConnectionManager: '0x610178dA211FEF7D417bC0e6FeD39F05609AD788',
    validatorManager: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
    interchainGasPaymaster: '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318',
    outbox: {
      proxy: '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6',
      implementation: '0x0165878A594ca255338adfa4d48449f69242Eb8F',
      beacon: '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853',
    },
    inboxes: {
      kovan: {
        proxy: '0x0B306BF915C4d645ff596e518fAf3F9669b97016',
        implementation: '0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82',
        beacon: '0x9A676e781A523b5d0C0e43731313A708CB607508',
      },
      mumbai: {
        proxy: '0x9A9f2CCfdE556A7E9Ff0848998Aa4a0CFD8863AE',
        implementation: '0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82',
        beacon: '0x9A676e781A523b5d0C0e43731313A708CB607508',
      },
      fuji: {
        proxy: '0x3Aa5ebB10DC797CAC828524e59A333d0A371443c',
        implementation: '0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82',
        beacon: '0x9A676e781A523b5d0C0e43731313A708CB607508',
      },
    },
  },
  kovan: {
    upgradeBeaconController: '0x59b670e9fA9D0A427751Af201D676719a970857b',
    xAppConnectionManager: '0xc3e53F4d16Ae77Db1c982e75a937B9f60FE63690',
    validatorManager: '0x4ed7c70F96B99c776995fB64377f0d4aB3B0e1C1',
    interchainGasPaymaster: '0xE6E340D132b5f46d1e472DebcD681B2aBc16e57E',
    outbox: {
      proxy: '0x67d269191c92Caf3cD7723F116c85e6E9bf55933',
      implementation: '0x09635F643e140090A9A8Dcd712eD6285858ceBef',
      beacon: '0xc5a5C42992dECbae36851359345FE25997F5C42d',
    },
    inboxes: {
      alfajores: {
        proxy: '0x851356ae760d987E095750cCeb3bC6014560891C',
        implementation: '0xa82fF9aFd8f496c3d6ac40E2a0F282E47488CFc9',
        beacon: '0x1613beB3B2C4f22Ee086B2b38C1476A3cE7f78E8',
      },
      mumbai: {
        proxy: '0x95401dc811bb5740090279Ba06cfA8fcF6113778',
        implementation: '0xa82fF9aFd8f496c3d6ac40E2a0F282E47488CFc9',
        beacon: '0x1613beB3B2C4f22Ee086B2b38C1476A3cE7f78E8',
      },
      fuji: {
        proxy: '0x70e0bA845a1A0F2DA3359C97E0285013525FFC49',
        implementation: '0xa82fF9aFd8f496c3d6ac40E2a0F282E47488CFc9',
        beacon: '0x1613beB3B2C4f22Ee086B2b38C1476A3cE7f78E8',
      },
    },
  },
  mumbai: {
    upgradeBeaconController: '0x99bbA657f2BbC93c02D617f8bA121cB8Fc104Acf',
    xAppConnectionManager: '0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575',
    validatorManager: '0x0E801D84Fa97b50751Dbf25036d067dCf18858bF',
    interchainGasPaymaster: '0x5f3f1dBD7B74C6B46e8c44f98792A1dAf8d69154',
    outbox: {
      proxy: '0x1291Be112d480055DaFd8a610b7d1e203891C274',
      implementation: '0x809d550fca64d94Bd9F66E60752A544199cfAC3D',
      beacon: '0x4c5859f0F772848b2D91F1D83E2Fe57935348029',
    },
    inboxes: {
      alfajores: {
        proxy: '0x7bc06c482DEAd17c0e297aFbC32f6e63d3846650',
        implementation: '0x2bdCC0de6bE1f7D2ee689a0342D76F52E8EFABa3',
        beacon: '0x7969c5eD335650692Bc04293B07F5BF2e7A673C0',
      },
      kovan: {
        proxy: '0xFD471836031dc5108809D173A067e8486B9047A3',
        implementation: '0x2bdCC0de6bE1f7D2ee689a0342D76F52E8EFABa3',
        beacon: '0x7969c5eD335650692Bc04293B07F5BF2e7A673C0',
      },
      fuji: {
        proxy: '0x1429859428C0aBc9C2C47C8Ee9FBaf82cFA0F20f',
        implementation: '0x2bdCC0de6bE1f7D2ee689a0342D76F52E8EFABa3',
        beacon: '0x7969c5eD335650692Bc04293B07F5BF2e7A673C0',
      },
    },
  },
  fuji: {
    upgradeBeaconController: '0x162A433068F51e18b7d13932F27e66a3f99E6890',
    xAppConnectionManager: '0xDC11f7E700A4c898AE5CAddB1082cFfa76512aDD',
    validatorManager: '0x922D6956C99E12DFeB3224DEA977D0939758A1Fe',
    interchainGasPaymaster: '0xD8a5a9b31c3C0232E196d518E89Fd8bF83AcAd43',
    outbox: {
      proxy: '0x2E2Ed0Cfd3AD2f1d34481277b3204d807Ca2F8c2',
      implementation: '0x4C4a2f8c81640e47606d3fd77B353E87Ba015584',
      beacon: '0x21dF544947ba3E8b3c32561399E88B52Dc8b2823',
    },
    inboxes: {
      alfajores: {
        proxy: '0x202CCe504e04bEd6fC0521238dDf04Bc9E8E15aB',
        implementation: '0x8198f5d8F8CfFE8f9C413d98a0A55aEB8ab9FbB7',
        beacon: '0x0355B7B8cb128fA5692729Ab3AAa199C1753f726',
      },
      kovan: {
        proxy: '0x172076E0166D1F9Cc711C77Adf8488051744980C',
        implementation: '0x8198f5d8F8CfFE8f9C413d98a0A55aEB8ab9FbB7',
        beacon: '0x0355B7B8cb128fA5692729Ab3AAa199C1753f726',
      },
      mumbai: {
        proxy: '0xBEc49fA140aCaA83533fB00A2BB19bDdd0290f25',
        implementation: '0x8198f5d8F8CfFE8f9C413d98a0A55aEB8ab9FbB7',
        beacon: '0x0355B7B8cb128fA5692729Ab3AAa199C1753f726',
      },
    },
  },
};
