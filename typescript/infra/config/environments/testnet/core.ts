import { CoreConfig } from '../../../src/core';

export const core: CoreConfig = {
  validatorManagers: {
    alfajores: {
      validators: [
        '0x5274db49971f14457fb1b1743012e2527804dc73',
        '0x636ca13eb829880539c0078ba9d53214b65603a2',
        '0x2f5f8c4bb89dfc1c4e905f7e3cd35294b62a572b',
      ],
      threshold: 2,
    },
    kovan: {
      validators: [
        '0x84b998a059719d4476959ffbe0a0402ec65a7c62',
        '0x5aaf0bbbc15f13bcb5f4b2bff5e2f935f4360bb5',
        '0x3d12f6d395a6532de3d45bd668de43685cb500c3',
      ],
      threshold: 2,
    },
    fuji: {
      validators: [
        '0x57d4976751978df23be86ec42e27a5749b1beeda',
        '0x5149b863416de4fae9e1cb63c9564414f4f0bb18',
        '0xd1ea680f4777eb31569aea1768eaf83bf5587a98',
      ],
      threshold: 2,
    },
    mumbai: {
      validators: [
        '0x962a63cf73c8beef63ecd753bc57c80241368818',
        '0x636d98ed1cd8e5190900ed53a71e8da0076c2672',
        '0xf9e86b19152cc8437794d01d4aec8c8a4eb34b20',
      ],
      threshold: 2,
    },
    bsctestnet: {
      validators: [
        '0x71a66da2ad833efca67b2257b45f6c6ba11e3816',
        '0x7306663d18af55294dfd44782fa5c7e16d94485f',
        '0x19cd5f316993ad15d1ac569cd4e70cbc5e1682ac',
      ],
      threshold: 2,
    },
    arbitrumrinkeby: {
      validators: [
        '0x4f78b649646b50b1ff41984cde8b7f4f36e1071d',
        '0xf71e75225daaf19135b316c76a9105fbdce4b70a',
        '0xded3da1c63c37499c627272f46d66e0e46a5bd07',
      ],
      threshold: 2,
    },
    optimismkovan: {
      validators: [
        '0x938b35471ff2e968a125f5f3fc02ede89f7b90c0',
        '0x3b8f4217153e9bb9ae3aa8d314269dd06584081d',
        '0x2a58a8982a06fbb3757d1c614c6f3ab733d93e6d',
      ],
      threshold: 2,
    },
    auroratestnet: {
      validators: [
        '0x3dd10f59ec2f18441eb0a3feca489e6d74752260',
        '0x10ac12f07488ea10371071fccc6a7a1e2733fe35',
        '0xdf0154233855528a114b4bd640a3fde2020c3b3b',
      ],
      threshold: 2,
    },
  },
};
