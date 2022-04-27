export const addresses = {
  alfajores: {
    upgradeBeaconController: '0xeCa505b0777152e68776f1C5a875EE4dFbf59b94',
    abacusConnectionManager: '0xB01b98d52767280934e98cf5F7B57DaC434473B9',
    interchainGasPaymaster: '0x125379056774C4246d016b2C58c6fbb80ab8829b',
    inboxes: {
      kovan: {
        proxy: '0x65D545ae04b394fAfBE2EeD4036aBbc0485De8Db',
        implementation: '0x5908D50cC36d40ABe284BAb9f43d290D7B083020',
        beacon: '0xDE9b9CbAaB774E9DCC4Af1bdd2b510d97dC1705c',
        validatorManager: '0x70a122D942B38EDC1C3E691aF19209CD17aDe555',
      },
    },
    outbox: {
      validatorManager: '0xf78caF314423c749681D3C7B08FCd66d7a4BA683',
      proxy: '0xdCCA08dC4ec34d58f69415b0C7C8e0042779c559',
      implementation: '0x63C950170534907d40B77ecF61bd07980B51f2a4',
      beacon: '0x6D91F26Fb1430bC0F557cC8BD7F815b441541c68',
    },
  },
  kovan: {
    upgradeBeaconController: '0x943bA1d4c8A20dd3c568cE16FbaB297F7d3178C3',
    abacusConnectionManager: '0x9318D51F02EcAf21682d546D8260c96580D4b49e',
    interchainGasPaymaster: '0x93Ea081a3F8c5e34F51FA4d164a43d2925e24238',
    outbox: {
      validatorManager: '0x81485d5C439a393375A65b9060aaD791aCD90439',
      proxy: '0xa42Eb261e74Fd92bC376Bb4CC19Ca51Ca7EBFf6C',
      implementation: '0xB5a43311274bEb8478Bd5909e08Fd940FC2A75C9',
      beacon: '0xB4dD7B062A927ff166312a9B49975184965950f7',
    },
    inboxes: {
      alfajores: {
        validatorManager: '0x73B075e931B7dA89E00422Dbc8205369211C40e2',
        proxy: '0x0bA30c539f67027797209B314afE7A0390F536ab',
        implementation: '0x84710af0473Fe6672C9C9e7B2d8B16eCE6D1b581',
        beacon: '0x75f3E7BB237cAEADdf8BA2B22f93884eD3923B8C',
      },
    },
  },
};
