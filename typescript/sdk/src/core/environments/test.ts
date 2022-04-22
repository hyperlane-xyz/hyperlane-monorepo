export const addresses = {
  alfajores: {
    upgradeBeaconController: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    abacusConnectionManager: '0x0165878A594ca255338adfa4d48449f69242Eb8F',
    interchainGasPaymaster: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707',
    outboxValidatorManager: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
    inboxValidatorManagers: {
      kovan: '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318',
      mumbai: '0x9A676e781A523b5d0C0e43731313A708CB607508',
      fuji: '0x9A9f2CCfdE556A7E9Ff0848998Aa4a0CFD8863AE',
    },
    outbox: {
      proxy: '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9',
      implementation: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
      beacon: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
    },
    inboxes: {
      kovan: {
        proxy: '0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0',
        implementation: '0x610178dA211FEF7D417bC0e6FeD39F05609AD788',
        beacon: '0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e',
      },
      mumbai: {
        proxy: '0x0B306BF915C4d645ff596e518fAf3F9669b97016',
        implementation: '0x610178dA211FEF7D417bC0e6FeD39F05609AD788',
        beacon: '0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e',
      },
      fuji: {
        proxy: '0x68B1D87F95878fE05B998F19b66F4baba5De1aed',
        implementation: '0x610178dA211FEF7D417bC0e6FeD39F05609AD788',
        beacon: '0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e',
      },
    },
  },
  kovan: {
    upgradeBeaconController: '0xc6e7DF5E7b4f2A278906862b61205850344D4e7d',
    abacusConnectionManager: '0x7a2088a1bFc9d81c55368AE168C2C02570cB814F',
    interchainGasPaymaster: '0x4A679253410272dd5232B3Ff7cF5dbB88f295319',
    outboxValidatorManager: '0x59b670e9fA9D0A427751Af201D676719a970857b',
    inboxValidatorManagers: {
      alfajores: '0x67d269191c92Caf3cD7723F116c85e6E9bf55933',
      mumbai: '0xa82fF9aFd8f496c3d6ac40E2a0F282E47488CFc9',
      fuji: '0xf5059a5D33d5853360D16C683c16e67980206f36',
    },
    outbox: {
      proxy: '0xa85233C63b9Ee964Add6F2cffe00Fd84eb32338f',
      implementation: '0x4ed7c70F96B99c776995fB64377f0d4aB3B0e1C1',
      beacon: '0x322813Fd9A801c5507c9de605d63CEA4f2CE6c44',
    },
    inboxes: {
      alfajores: {
        proxy: '0x84eA74d481Ee0A5332c457a4d796187F6Ba67fEB',
        implementation: '0xE6E340D132b5f46d1e472DebcD681B2aBc16e57E',
        beacon: '0xc3e53F4d16Ae77Db1c982e75a937B9f60FE63690',
      },
      mumbai: {
        proxy: '0x1613beB3B2C4f22Ee086B2b38C1476A3cE7f78E8',
        implementation: '0xE6E340D132b5f46d1e472DebcD681B2aBc16e57E',
        beacon: '0xc3e53F4d16Ae77Db1c982e75a937B9f60FE63690',
      },
      fuji: {
        proxy: '0x95401dc811bb5740090279Ba06cfA8fcF6113778',
        implementation: '0xE6E340D132b5f46d1e472DebcD681B2aBc16e57E',
        beacon: '0xc3e53F4d16Ae77Db1c982e75a937B9f60FE63690',
      },
    },
  },
  mumbai: {
    upgradeBeaconController: '0x70e0bA845a1A0F2DA3359C97E0285013525FFC49',
    abacusConnectionManager: '0x5eb3Bc0a489C5A8288765d2336659EbCA68FCd00',
    interchainGasPaymaster: '0x9d4454B023096f34B160D6B654540c56A1F81688',
    outboxValidatorManager: '0x4826533B4897376654Bb4d4AD88B7faFD0C98528',
    inboxValidatorManagers: {
      alfajores: '0x4c5859f0F772848b2D91F1D83E2Fe57935348029',
      kovan: '0x82e01223d51Eb87e16A03E24687EDF0F294da6f1',
      fuji: '0x7bc06c482DEAd17c0e297aFbC32f6e63d3846650',
    },
    outbox: {
      proxy: '0x8f86403A4DE0BB5791fa46B8e795C547942fE4Cf',
      implementation: '0x99bbA657f2BbC93c02D617f8bA121cB8Fc104Acf',
      beacon: '0x0E801D84Fa97b50751Dbf25036d067dCf18858bF',
    },
    inboxes: {
      alfajores: {
        proxy: '0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575',
        implementation: '0x1291Be112d480055DaFd8a610b7d1e203891C274',
        beacon: '0x5f3f1dBD7B74C6B46e8c44f98792A1dAf8d69154',
      },
      kovan: {
        proxy: '0x2bdCC0de6bE1f7D2ee689a0342D76F52E8EFABa3',
        implementation: '0x1291Be112d480055DaFd8a610b7d1e203891C274',
        beacon: '0x5f3f1dBD7B74C6B46e8c44f98792A1dAf8d69154',
      },
      fuji: {
        proxy: '0xc351628EB244ec633d5f21fBD6621e1a683B1181',
        implementation: '0x1291Be112d480055DaFd8a610b7d1e203891C274',
        beacon: '0x5f3f1dBD7B74C6B46e8c44f98792A1dAf8d69154',
      },
    },
  },
  fuji: {
    upgradeBeaconController: '0xcbEAF3BDe82155F56486Fb5a1072cb8baAf547cc',
    abacusConnectionManager: '0x1fA02b2d6A771842690194Cf62D91bdd92BfE28d',
    interchainGasPaymaster: '0x5081a39b8A5f0E35a8D959395a630b68B74Dd30f',
    outboxValidatorManager: '0x1429859428C0aBc9C2C47C8Ee9FBaf82cFA0F20f',
    inboxValidatorManagers: {
      alfajores: '0x4C4a2f8c81640e47606d3fd77B353E87Ba015584',
      kovan: '0x51A1ceB83B83F1985a81C295d1fF28Afef186E02',
      mumbai: '0x0355B7B8cb128fA5692729Ab3AAa199C1753f726',
    },
    outbox: {
      proxy: '0x922D6956C99E12DFeB3224DEA977D0939758A1Fe',
      implementation: '0xB0D4afd8879eD9F52b28595d31B441D079B2Ca07',
      beacon: '0x162A433068F51e18b7d13932F27e66a3f99E6890',
    },
    inboxes: {
      alfajores: {
        proxy: '0xD8a5a9b31c3C0232E196d518E89Fd8bF83AcAd43',
        implementation: '0x21dF544947ba3E8b3c32561399E88B52Dc8b2823',
        beacon: '0x2E2Ed0Cfd3AD2f1d34481277b3204d807Ca2F8c2',
      },
      kovan: {
        proxy: '0x36b58F5C1969B7b6591D752ea6F5486D069010AB',
        implementation: '0x21dF544947ba3E8b3c32561399E88B52Dc8b2823',
        beacon: '0x2E2Ed0Cfd3AD2f1d34481277b3204d807Ca2F8c2',
      },
      mumbai: {
        proxy: '0x202CCe504e04bEd6fC0521238dDf04Bc9E8E15aB',
        implementation: '0x21dF544947ba3E8b3c32561399E88B52Dc8b2823',
        beacon: '0x2E2Ed0Cfd3AD2f1d34481277b3204d807Ca2F8c2',
      },
    },
  },
};
