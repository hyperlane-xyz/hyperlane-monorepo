import { CoreContractAddresses } from '../contracts';
import { ChainName } from '../../types';

export const local: Partial<Record<ChainName, CoreContractAddresses>> = {
  celo: {
    upgradeBeaconController: '0x36b58F5C1969B7b6591D752ea6F5486D069010AB',
    xAppConnectionManager: '0x4EE6eCAD1c2Dae9f525404De8555724e3c35d07B',
    validatorManager: '0x8198f5d8F8CfFE8f9C413d98a0A55aEB8ab9FbB7',
    outbox: {
      proxy: '0x172076E0166D1F9Cc711C77Adf8488051744980C',
      implementation: '0x202CCe504e04bEd6fC0521238dDf04Bc9E8E15aB',
      beacon: '0xf4B146FbA71F41E0592668ffbF264F1D186b2Ca8',
    },
    inboxes: {
      ethereum: {
        proxy: '0xfbC22278A96299D91d41C453234d97b4F5Eb9B2d',
        implementation: '0xD84379CEae14AA33C123Af12424A37803F885889',
        beacon: '0x2B0d36FACD61B71CC05ab8F3D2355ec3631C0dd5',
      },
      polygon: {
        proxy: '0x1c85638e118b37167e9298c2268758e058DdfDA0',
        implementation: '0xD84379CEae14AA33C123Af12424A37803F885889',
        beacon: '0x2B0d36FACD61B71CC05ab8F3D2355ec3631C0dd5',
      },
    },
  },
  ethereum: {
    upgradeBeaconController: '0x7A9Ec1d04904907De0ED7b6839CcdD59c3716AC9',
    xAppConnectionManager: '0xAA292E8611aDF267e563f334Ee42320aC96D0463',
    validatorManager: '0x49fd2BE640DB2910c2fAb69bB8531Ab6E76127ff',
    outbox: {
      proxy: '0xf953b3A269d80e3eB0F2947630Da976B896A8C5b',
      implementation: '0x86A2EE8FAf9A840F7a2c64CA3d51209F9A02081D',
      beacon: '0xA4899D35897033b927acFCf422bc745916139776',
    },
    inboxes: {
      celo: {
        proxy: '0x5067457698Fd6Fa1C6964e416b3f42713513B3dD',
        implementation: '0x720472c8ce72c2A2D711333e064ABD3E6BbEAdd3',
        beacon: '0xe8D2A1E88c91DCd5433208d4152Cc4F399a7e91d',
      },
      polygon: {
        proxy: '0xCace1b78160AE76398F486c8a18044da0d66d86D',
        implementation: '0x720472c8ce72c2A2D711333e064ABD3E6BbEAdd3',
        beacon: '0xe8D2A1E88c91DCd5433208d4152Cc4F399a7e91d',
      },
    },
  },
  polygon: {
    upgradeBeaconController: '0xc0F115A19107322cFBf1cDBC7ea011C19EbDB4F8',
    xAppConnectionManager: '0xA7c59f010700930003b33aB25a7a0679C860f29c',
    validatorManager: '0xc96304e3c037f81dA488ed9dEa1D8F2a48278a75',
    outbox: {
      proxy: '0x22753E4264FDDc6181dc7cce468904A80a363E44',
      implementation: '0xD0141E899a65C95a556fE2B27e5982A6DE7fDD7A',
      beacon: '0x07882Ae1ecB7429a84f1D53048d35c4bB2056877',
    },
    inboxes: {
      celo: {
        proxy: '0x3155755b79aA083bd953911C92705B7aA82a18F9',
        implementation: '0x276C216D241856199A83bf27b2286659e5b877D3',
        beacon: '0x3347B4d90ebe72BeFb30444C9966B2B990aE9FcB',
      },
      ethereum: {
        proxy: '0x3aAde2dCD2Df6a8cAc689EE797591b2913658659',
        implementation: '0x276C216D241856199A83bf27b2286659e5b877D3',
        beacon: '0x3347B4d90ebe72BeFb30444C9966B2B990aE9FcB',
      },
    },
  },
};
