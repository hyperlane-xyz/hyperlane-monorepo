export const addresses = {
  alfajores: {
    upgradeBeaconController: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    xAppConnectionManager: '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318',
    validatorManager: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
    outbox: {
      proxy: '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6',
      implementation: '0x0165878A594ca255338adfa4d48449f69242Eb8F',
      beacon: '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853',
    },
    inboxes: {
      kovan: {
        proxy: '0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82',
        implementation: '0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e',
        beacon: '0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0',
      },
      mumbai: {
        proxy: '0x0B306BF915C4d645ff596e518fAf3F9669b97016',
        implementation: '0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e',
        beacon: '0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0',
      },
      fuji: {
        proxy: '0x9A9f2CCfdE556A7E9Ff0848998Aa4a0CFD8863AE',
        implementation: '0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e',
        beacon: '0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0',
      },
    },
  },
  kovan: {
    upgradeBeaconController: '0x3Aa5ebB10DC797CAC828524e59A333d0A371443c',
    xAppConnectionManager: '0xc5a5C42992dECbae36851359345FE25997F5C42d',
    validatorManager: '0xc6e7DF5E7b4f2A278906862b61205850344D4e7d',
    outbox: {
      proxy: '0x09635F643e140090A9A8Dcd712eD6285858ceBef',
      implementation: '0x4A679253410272dd5232B3Ff7cF5dbB88f295319',
      beacon: '0x7a2088a1bFc9d81c55368AE168C2C02570cB814F',
    },
    inboxes: {
      alfajores: {
        proxy: '0x84eA74d481Ee0A5332c457a4d796187F6Ba67fEB',
        implementation: '0xE6E340D132b5f46d1e472DebcD681B2aBc16e57E',
        beacon: '0xc3e53F4d16Ae77Db1c982e75a937B9f60FE63690',
      },
      mumbai: {
        proxy: '0xa82fF9aFd8f496c3d6ac40E2a0F282E47488CFc9',
        implementation: '0xE6E340D132b5f46d1e472DebcD681B2aBc16e57E',
        beacon: '0xc3e53F4d16Ae77Db1c982e75a937B9f60FE63690',
      },
      fuji: {
        proxy: '0x851356ae760d987E095750cCeb3bC6014560891C',
        implementation: '0xE6E340D132b5f46d1e472DebcD681B2aBc16e57E',
        beacon: '0xc3e53F4d16Ae77Db1c982e75a937B9f60FE63690',
      },
    },
  },
  mumbai: {
    upgradeBeaconController: '0x95401dc811bb5740090279Ba06cfA8fcF6113778',
    xAppConnectionManager: '0x36C02dA8a0983159322a80FFE9F24b1acfF8B570',
    validatorManager: '0x998abeb3E57409262aE5b751f60747921B33613E',
    outbox: {
      proxy: '0x5eb3Bc0a489C5A8288765d2336659EbCA68FCd00',
      implementation: '0x8f86403A4DE0BB5791fa46B8e795C547942fE4Cf',
      beacon: '0x9d4454B023096f34B160D6B654540c56A1F81688',
    },
    inboxes: {
      alfajores: {
        proxy: '0x5f3f1dBD7B74C6B46e8c44f98792A1dAf8d69154',
        implementation: '0x4c5859f0F772848b2D91F1D83E2Fe57935348029',
        beacon: '0x1291Be112d480055DaFd8a610b7d1e203891C274',
      },
      kovan: {
        proxy: '0xCD8a1C3ba11CF5ECfa6267617243239504a98d90',
        implementation: '0x4c5859f0F772848b2D91F1D83E2Fe57935348029',
        beacon: '0x1291Be112d480055DaFd8a610b7d1e203891C274',
      },
      fuji: {
        proxy: '0x2bdCC0de6bE1f7D2ee689a0342D76F52E8EFABa3',
        implementation: '0x4c5859f0F772848b2D91F1D83E2Fe57935348029',
        beacon: '0x1291Be112d480055DaFd8a610b7d1e203891C274',
      },
    },
  },
  fuji: {
    upgradeBeaconController: '0x7bc06c482DEAd17c0e297aFbC32f6e63d3846650',
    xAppConnectionManager: '0x1fA02b2d6A771842690194Cf62D91bdd92BfE28d',
    validatorManager: '0xc351628EB244ec633d5f21fBD6621e1a683B1181',
    outbox: {
      proxy: '0x5081a39b8A5f0E35a8D959395a630b68B74Dd30f',
      implementation: '0x162A433068F51e18b7d13932F27e66a3f99E6890',
      beacon: '0x922D6956C99E12DFeB3224DEA977D0939758A1Fe',
    },
    inboxes: {
      alfajores: {
        proxy: '0x21dF544947ba3E8b3c32561399E88B52Dc8b2823',
        implementation: '0x04C89607413713Ec9775E14b954286519d836FEf',
        beacon: '0x4C4a2f8c81640e47606d3fd77B353E87Ba015584',
      },
      kovan: {
        proxy: '0xD8a5a9b31c3C0232E196d518E89Fd8bF83AcAd43',
        implementation: '0x04C89607413713Ec9775E14b954286519d836FEf',
        beacon: '0x4C4a2f8c81640e47606d3fd77B353E87Ba015584',
      },
      mumbai: {
        proxy: '0x51A1ceB83B83F1985a81C295d1fF28Afef186E02',
        implementation: '0x04C89607413713Ec9775E14b954286519d836FEf',
        beacon: '0x4C4a2f8c81640e47606d3fd77B353E87Ba015584',
      },
    },
  },
};
