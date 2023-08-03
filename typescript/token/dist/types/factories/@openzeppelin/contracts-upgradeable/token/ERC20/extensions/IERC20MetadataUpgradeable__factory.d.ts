import type { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type {
  IERC20MetadataUpgradeable,
  IERC20MetadataUpgradeableInterface,
} from '../../../../../../@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20MetadataUpgradeable';

export declare class IERC20MetadataUpgradeable__factory {
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
  static createInterface(): IERC20MetadataUpgradeableInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): IERC20MetadataUpgradeable;
}
//# sourceMappingURL=IERC20MetadataUpgradeable__factory.d.ts.map
