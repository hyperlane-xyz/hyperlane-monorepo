import type { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type {
  IERC721Enumerable,
  IERC721EnumerableInterface,
} from '../../../../../../@openzeppelin/contracts/token/ERC721/extensions/IERC721Enumerable';

export declare class IERC721Enumerable__factory {
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
  static createInterface(): IERC721EnumerableInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): IERC721Enumerable;
}
//# sourceMappingURL=IERC721Enumerable__factory.d.ts.map
