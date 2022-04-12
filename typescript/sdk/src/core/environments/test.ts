export const addresses = {
  alfajores: {
    upgradeBeaconController: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    xAppConnectionManager: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707',
    outboxMultisigValidatorManager:
      '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
    inboxMultisigValidatorManagers: {
      kovan: '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853',
      mumbai: '0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0',
      fuji: '0x0B306BF915C4d645ff596e518fAf3F9669b97016',
    },
    outbox: {
      proxy: '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9',
      implementation: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
      beacon: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
    },
    inboxes: {
      kovan: {
        proxy: '0x610178dA211FEF7D417bC0e6FeD39F05609AD788',
        implementation: '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6',
        beacon: '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318',
      },
      mumbai: {
        proxy: '0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82',
        implementation: '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6',
        beacon: '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318',
      },
      fuji: {
        proxy: '0x959922bE3CAee4b8Cd9a407cc3ac1C251C2007B1',
        implementation: '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6',
        beacon: '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318',
      },
    },
  },
  kovan: {
    upgradeBeaconController: '0x68B1D87F95878fE05B998F19b66F4baba5De1aed',
    xAppConnectionManager: '0x322813Fd9A801c5507c9de605d63CEA4f2CE6c44',
    outboxMultisigValidatorManager:
      '0x3Aa5ebB10DC797CAC828524e59A333d0A371443c',
    inboxMultisigValidatorManagers: {
      alfajores: '0x4A679253410272dd5232B3Ff7cF5dbB88f295319',
      mumbai: '0xE6E340D132b5f46d1e472DebcD681B2aBc16e57E',
      fuji: '0x9E545E3C0baAB3E08CdfD552C960A1050f373042',
    },
    outbox: {
      proxy: '0x4ed7c70F96B99c776995fB64377f0d4aB3B0e1C1',
      implementation: '0xc6e7DF5E7b4f2A278906862b61205850344D4e7d',
      beacon: '0x59b670e9fA9D0A427751Af201D676719a970857b',
    },
    inboxes: {
      alfajores: {
        proxy: '0xc5a5C42992dECbae36851359345FE25997F5C42d',
        implementation: '0x7a2088a1bFc9d81c55368AE168C2C02570cB814F',
        beacon: '0x09635F643e140090A9A8Dcd712eD6285858ceBef',
      },
      mumbai: {
        proxy: '0xc3e53F4d16Ae77Db1c982e75a937B9f60FE63690',
        implementation: '0x7a2088a1bFc9d81c55368AE168C2C02570cB814F',
        beacon: '0x09635F643e140090A9A8Dcd712eD6285858ceBef',
      },
      fuji: {
        proxy: '0xa82fF9aFd8f496c3d6ac40E2a0F282E47488CFc9',
        implementation: '0x7a2088a1bFc9d81c55368AE168C2C02570cB814F',
        beacon: '0x09635F643e140090A9A8Dcd712eD6285858ceBef',
      },
    },
  },
  mumbai: {
    upgradeBeaconController: '0x851356ae760d987E095750cCeb3bC6014560891C',
    xAppConnectionManager: '0x4826533B4897376654Bb4d4AD88B7faFD0C98528',
    outboxMultisigValidatorManager:
      '0xf5059a5D33d5853360D16C683c16e67980206f36',
    inboxMultisigValidatorManagers: {
      alfajores: '0x0E801D84Fa97b50751Dbf25036d067dCf18858bF',
      kovan: '0x809d550fca64d94Bd9F66E60752A544199cfAC3D',
      fuji: '0x5f3f1dBD7B74C6B46e8c44f98792A1dAf8d69154',
    },
    outbox: {
      proxy: '0x70e0bA845a1A0F2DA3359C97E0285013525FFC49',
      implementation: '0x95401dc811bb5740090279Ba06cfA8fcF6113778',
      beacon: '0x998abeb3E57409262aE5b751f60747921B33613E',
    },
    inboxes: {
      alfajores: {
        proxy: '0x5eb3Bc0a489C5A8288765d2336659EbCA68FCd00',
        implementation: '0x8f86403A4DE0BB5791fa46B8e795C547942fE4Cf',
        beacon: '0x9d4454B023096f34B160D6B654540c56A1F81688',
      },
      kovan: {
        proxy: '0x4c5859f0F772848b2D91F1D83E2Fe57935348029',
        implementation: '0x8f86403A4DE0BB5791fa46B8e795C547942fE4Cf',
        beacon: '0x9d4454B023096f34B160D6B654540c56A1F81688',
      },
      fuji: {
        proxy: '0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575',
        implementation: '0x8f86403A4DE0BB5791fa46B8e795C547942fE4Cf',
        beacon: '0x9d4454B023096f34B160D6B654540c56A1F81688',
      },
    },
  },
  fuji: {
    upgradeBeaconController: '0x82e01223d51Eb87e16A03E24687EDF0F294da6f1',
    xAppConnectionManager: '0xFD471836031dc5108809D173A067e8486B9047A3',
    outboxMultisigValidatorManager:
      '0x2bdCC0de6bE1f7D2ee689a0342D76F52E8EFABa3',
    inboxMultisigValidatorManagers: {
      alfajores: '0x1429859428C0aBc9C2C47C8Ee9FBaf82cFA0F20f',
      kovan: '0x1fA02b2d6A771842690194Cf62D91bdd92BfE28d',
      mumbai: '0x4C4a2f8c81640e47606d3fd77B353E87Ba015584',
    },
    outbox: {
      proxy: '0xc351628EB244ec633d5f21fBD6621e1a683B1181',
      implementation: '0x7969c5eD335650692Bc04293B07F5BF2e7A673C0',
      beacon: '0x7bc06c482DEAd17c0e297aFbC32f6e63d3846650',
    },
    inboxes: {
      alfajores: {
        proxy: '0x922D6956C99E12DFeB3224DEA977D0939758A1Fe',
        implementation: '0xB0D4afd8879eD9F52b28595d31B441D079B2Ca07',
        beacon: '0x162A433068F51e18b7d13932F27e66a3f99E6890',
      },
      kovan: {
        proxy: '0xdbC43Ba45381e02825b14322cDdd15eC4B3164E6',
        implementation: '0xB0D4afd8879eD9F52b28595d31B441D079B2Ca07',
        beacon: '0x162A433068F51e18b7d13932F27e66a3f99E6890',
      },
      mumbai: {
        proxy: '0x21dF544947ba3E8b3c32561399E88B52Dc8b2823',
        implementation: '0xB0D4afd8879eD9F52b28595d31B441D079B2Ca07',
        beacon: '0x162A433068F51e18b7d13932F27e66a3f99E6890',
      },
    },
  },
};
