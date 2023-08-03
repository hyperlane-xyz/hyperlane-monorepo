import type { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type {
  ERC721EnumerableUpgradeable,
  ERC721EnumerableUpgradeableInterface,
} from '../../../../../../@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable';

export declare class ERC721EnumerableUpgradeable__factory {
  static readonly abi: (
    | {
        anonymous: boolean;
        inputs: {
          indexed: boolean;
          internalType: string;
          name: string;
          type: string;
        }[];
        name: string;
        type: string;
        outputs?: undefined;
        stateMutability?: undefined;
      }
    | {
        inputs: {
          internalType: string;
          name: string;
          type: string;
        }[];
        name: string;
        outputs: {
          internalType: string;
          name: string;
          type: string;
        }[];
        stateMutability: string;
        type: string;
        anonymous?: undefined;
      }
  )[];
  static createInterface(): ERC721EnumerableUpgradeableInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): ERC721EnumerableUpgradeable;
}
//# sourceMappingURL=ERC721EnumerableUpgradeable__factory.d.ts.map
