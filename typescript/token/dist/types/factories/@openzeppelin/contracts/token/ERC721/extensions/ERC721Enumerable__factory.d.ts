import type { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type {
  ERC721Enumerable,
  ERC721EnumerableInterface,
} from '../../../../../../@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable';

export declare class ERC721Enumerable__factory {
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
  static createInterface(): ERC721EnumerableInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): ERC721Enumerable;
}
//# sourceMappingURL=ERC721Enumerable__factory.d.ts.map
