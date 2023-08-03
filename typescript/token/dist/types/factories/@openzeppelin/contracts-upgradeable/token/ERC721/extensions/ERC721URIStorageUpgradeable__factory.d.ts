import type { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type {
  ERC721URIStorageUpgradeable,
  ERC721URIStorageUpgradeableInterface,
} from '../../../../../../@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721URIStorageUpgradeable';

export declare class ERC721URIStorageUpgradeable__factory {
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
  static createInterface(): ERC721URIStorageUpgradeableInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): ERC721URIStorageUpgradeable;
}
//# sourceMappingURL=ERC721URIStorageUpgradeable__factory.d.ts.map
