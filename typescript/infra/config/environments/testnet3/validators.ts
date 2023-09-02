import { chainMetadata } from '@hyperlane-xyz/sdk';

import { ValidatorBaseChainConfigMap } from '../../../src/config/agent';
import { Contexts } from '../../contexts';
import { validatorBaseConfigsFn } from '../utils';

import { environment } from './chains';

export const validatorChainConfig = (
  context: Contexts,
): ValidatorBaseChainConfigMap => {
  const validatorsConfig = validatorBaseConfigsFn(environment, context);
  return {
    alfajores: {
      interval: 5,
      reorgPeriod: chainMetadata.alfajores.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0xe6072396568e73ce6803b12b7e04164e839f1e54',
            '0x9f177f51289b22515f41f95872e1511391b8e105',
            '0x15f77400845eb1c971ad08de050861d5508cad6c',
          ],
          [Contexts.ReleaseCandidate]: [
            '0x45e5c228b38e1cf09e9a3423ed0cf4862c4bf3de',
            '0x30c40c29dc21896ccc510c581ce0c88ba5552467',
            '0xc60ef4fc6f9530fdb37b1cf4c2c16a6764e6f723',
          ],
        },
        'alfajores',
      ),
    },
    fuji: {
      interval: 5,
      reorgPeriod: chainMetadata.fuji.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0x9fa19ead5ec76e437948b35e227511b106293c40',
            '0x227e7d6507762ece0c94678f8c103eff9d682476',
            '0x2379e43740e4aa4fde48cf4f00a3106df1d8420d',
          ],
          [Contexts.ReleaseCandidate]: [
            '0xd81ba169170a9b582812cf0e152d2c168572e21f',
            '0x05900a676389219c934ba0de3fcd625dbbac0cc0',
            '0x1bf7d94ddcca25a8b139b6d21fd396fe959f21c8',
          ],
        },
        'fuji',
      ),
    },
    mumbai: {
      interval: 5,
      reorgPeriod: chainMetadata.mumbai.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0x0a664ea799447da6b15645cf8b9e82072a68343f',
            '0x6ae6f12929a960aba24ba74ea310e3d37d0ac045',
            '0x51f70c047cd73bc7873273707501568857a619c4',
          ],
          [Contexts.ReleaseCandidate]: [
            '0xb537c4ce34e1cad718be52aa30b095e416eae46a',
            '0x5dbddee458d5943f9c5daea28736f569aeeed7a5',
            '0x688fd80884a23680c2c80970a357b74558d8a25e',
          ],
        },
        'mumbai',
      ),
    },
    bsctestnet: {
      interval: 5,
      reorgPeriod: chainMetadata.bsctestnet.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0x23338c8714976dd4a57eaeff17cbd26d7e275c08',
            '0x85a618d7450ebc37e0d682371f08dac94eec7a76',
            '0x95b76562e4ba1791a27ba4236801271c9115b141',
          ],
          [Contexts.ReleaseCandidate]: [
            '0x77f80ef5b18977e15d81aea8dd3a88e7df4bc0eb',
            '0x87044ecdcba9c2ada89554dd85f16344160bdeb7',
            '0x1e0bdd7de5573d010bd8681fa282ece5bc77180e',
          ],
        },
        'bsctestnet',
      ),
    },
    goerli: {
      interval: 5,
      reorgPeriod: chainMetadata.goerli.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0xf43fbd072fd38e1121d4b3b0b8a35116bbb01ea9',
            '0xa33020552a21f35e75bd385c6ab95c3dfa82d930',
            '0x0bba4043ff242f8bf3f39bafa8930a84d644d947',
          ],
          [Contexts.ReleaseCandidate]: [
            '0x9597ddb4ad2af237665559574b820596bb77ae7a',
            '0x1e88fbc51c88627be1da98feaa5ba9a2f302bb7e',
            '0x57d4db75e762ebf2fc8725dc7c3194fbefa492fc',
          ],
        },
        'goerli',
      ),
    },
    sepolia: {
      interval: 5,
      reorgPeriod: chainMetadata.sepolia.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0xbc748ee311f5f2d1975d61cdf531755ce8ce3066',
            '0xc4233b2bfe5aec08964a94b403052abb3eafcf07',
            '0x6b36286c19f5c10bdc139ea9ee7f82287303f61d',
          ],
          [Contexts.ReleaseCandidate]: [
            '0x183f15924f3a464c54c9393e8d268eb44d2b208c',
            '0x90ec2ea0229f921602f3aca97c5fd85849a2e85c',
            '0x18cf2f76d604d6f6470d924678221fb556347fbd',
          ],
        },
        'sepolia',
      ),
    },
    moonbasealpha: {
      interval: 5,
      reorgPeriod: chainMetadata.moonbasealpha.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0x890c2aeac157c3f067f3e42b8afc797939c59a32',
            '0x1b06d6fe69b972ed7420c83599d5a5c0fc185904',
            '0xe70b85206a968a99a597581f0fa09c99e7681093',
          ],
          [Contexts.ReleaseCandidate]: [
            '0xbeaf158f85d7b64ced36b8aea0bbc4cd0f2d1a5d',
            '0x9b81c45fce282177ecc828eb8fddf07fc3512808',
            '0x15a183fb89807c4036006e028d4871fb797113b2',
          ],
        },
        'moonbasealpha',
      ),
    },
    optimismgoerli: {
      interval: 5,
      reorgPeriod: chainMetadata.optimismgoerli.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0xbb8d77eefbecc55db6e5a19b0fc3dc290776f189',
            '0x69792508b4ddaa3ca52241ccfcd1e0b119a1ee65',
            '0x11ddb46c6b653e0cdd7ad5bee32ae316e18f8453',
          ],
          [Contexts.ReleaseCandidate]: [
            '0x1d6798671ac532f2bf30c3a5230697a4695705e4',
            '0xbc763cb587b9d0bf52360393a84660ea24db7057',
            '0xee331cba457352ce282a1bc1696e6d2defb6be26',
          ],
        },
        'optimismgoerli',
      ),
    },
    arbitrumgoerli: {
      interval: 5,
      reorgPeriod: chainMetadata.arbitrumgoerli.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0xce798fa21e323f6b24d9838a10ffecdefdfc4f30',
            '0xa792d39dca4426927e0f00c1618d61c9cb41779d',
            '0xdf181fcc11dfac5d01467e4547101a856dd5aa04',
          ],
          [Contexts.ReleaseCandidate]: [
            '0x6d13367c7cd713a4ea79a2552adf824bf1ecdd5e',
            '0x3a99b6590c7f18d0a77a1879990f34a908958fe1',
            '0xb77da6c29eca52b89c0fa6d220462f03258e14a9',
          ],
        },
        'arbitrumgoerli',
      ),
    },
    proteustestnet: {
      interval: 5,
      reorgPeriod: chainMetadata.proteustestnet.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0x79fc73656abb9eeaa5ee853c4569124f5bdaf9d8',
            '0x72840388d5ab57323bc4f6e6d3ddedfd5cc911f0',
            '0xd4b2a50c53fc6614bb3cd3198e0fdc03f5da973f',
          ],
          [Contexts.ReleaseCandidate]: [
            '0xc2ccc4eab0e8d441235d661e39341ae16c3bf8cd',
          ],
        },
        'proteustestnet',
      ),
    },
    solanadevnet: {
      interval: 10,
      reorgPeriod: chainMetadata.solanadevnet.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0xec0f73dbc5b1962a20f7dcbe07c98414025b0c43',
            '0x9c20a149dfa09ea9f77f5a7ca09ed44f9c025133',
            '0x967c5ecdf2625ae86580bd203b630abaaf85cd62',
          ],
          [Contexts.ReleaseCandidate]: [
            '0x21b9eff4d1a6d3122596c7fb80315bf094b6e5c2',
          ],
        },
        'solanadevnet',
      ),
    },
  };
};
