import { Provider, TransactionRequest } from '@ethersproject/providers';
import { ContractFactory, Overrides, Signer } from 'ethers';

import type {
  XAppConnectionManager,
  XAppConnectionManagerInterface,
} from '../XAppConnectionManager';

export declare class XAppConnectionManager__factory extends ContractFactory {
  constructor(signer?: Signer);
  deploy(
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<XAppConnectionManager>;
  getDeployTransaction(
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): TransactionRequest;
  attach(address: string): XAppConnectionManager;
  connect(signer: Signer): XAppConnectionManager__factory;
  static readonly bytecode =
    '0x608060405234801561001057600080fd5b50600061001b61006a565b600080546001600160a01b0319166001600160a01b0383169081178255604051929350917f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0908290a35061006e565b3390565b610d928061007d6000396000f3fe608060405234801561001057600080fd5b50600436106100ea5760003560e01c80638d3638f41161008c578063ce11e6ab11610066578063ce11e6ab1461029d578063f1bd6f0a146102a5578063f2fde38b146102d8578063ff204f3b1461030b576100ea565b80638d3638f41461026a5780638da5cb5b14610272578063907ea9711461027a576100ea565b8063448f904a116100c8578063448f904a146101a8578063715018a6146101db5780637904ffb7146101e357806384d9ac651461022f576100ea565b80632100c710146100ef578063282f51eb1461013057806339bb4ad914610177575b600080fd5b61012e6004803603604081101561010557600080fd5b50803563ffffffff16906020013573ffffffffffffffffffffffffffffffffffffffff1661033e565b005b6101636004803603602081101561014657600080fd5b503573ffffffffffffffffffffffffffffffffffffffff166104b2565b604080519115158252519081900360200190f35b61017f6104e2565b6040805173ffffffffffffffffffffffffffffffffffffffff9092168252519081900360200190f35b61012e600480360360208110156101be57600080fd5b503573ffffffffffffffffffffffffffffffffffffffff166104fe565b61012e6105b2565b610216600480360360208110156101f957600080fd5b503573ffffffffffffffffffffffffffffffffffffffff166106c9565b6040805163ffffffff9092168252519081900360200190f35b61012e6004803603604081101561024557600080fd5b5073ffffffffffffffffffffffffffffffffffffffff813581169160200135166106e1565b61021661079f565b61017f61083b565b61017f6004803603602081101561029057600080fd5b503563ffffffff16610857565b61017f61087f565b61012e600480360360208110156102bb57600080fd5b503573ffffffffffffffffffffffffffffffffffffffff1661089b565b61012e600480360360208110156102ee57600080fd5b503573ffffffffffffffffffffffffffffffffffffffff166109b2565b61012e6004803603602081101561032157600080fd5b503573ffffffffffffffffffffffffffffffffffffffff16610b53565b610346610c6a565b73ffffffffffffffffffffffffffffffffffffffff1661036461083b565b73ffffffffffffffffffffffffffffffffffffffff16146103e657604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820181905260248201527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604482015290519081900360640190fd5b6103ef81610c6e565b73ffffffffffffffffffffffffffffffffffffffff8116600081815260036020908152604080832080547fffffffffffffffffffffffffffffffffffffffffffffffffffffffff000000001663ffffffff8816908117909155808452600483529281902080547fffffffffffffffffffffffff0000000000000000000000000000000000000000168517905580519384525191927f4d2727478f0991174aa9ce47ef7abbde975765cc9fc1f8e239c1737bb70059c3929081900390910190a25050565b73ffffffffffffffffffffffffffffffffffffffff1660009081526003602052604090205463ffffffff16151590565b60025473ffffffffffffffffffffffffffffffffffffffff1681565b610506610c6a565b73ffffffffffffffffffffffffffffffffffffffff1661052461083b565b73ffffffffffffffffffffffffffffffffffffffff16146105a657604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820181905260248201527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604482015290519081900360640190fd5b6105af81610c6e565b50565b6105ba610c6a565b73ffffffffffffffffffffffffffffffffffffffff166105d861083b565b73ffffffffffffffffffffffffffffffffffffffff161461065a57604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820181905260248201527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604482015290519081900360640190fd5b6000805460405173ffffffffffffffffffffffffffffffffffffffff909116907f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0908390a3600080547fffffffffffffffffffffffff0000000000000000000000000000000000000000169055565b60036020526000908152604090205463ffffffff1681565b6106e9610c6a565b73ffffffffffffffffffffffffffffffffffffffff1661070761083b565b73ffffffffffffffffffffffffffffffffffffffff161461078957604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820181905260248201527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604482015290519081900360640190fd5b61079282610b53565b61079b8161089b565b5050565b600154604080517f8d3638f4000000000000000000000000000000000000000000000000000000008152905160009273ffffffffffffffffffffffffffffffffffffffff1691638d3638f4916004808301926020929190829003018186803b15801561080a57600080fd5b505afa15801561081e573d6000803e3d6000fd5b505050506040513d602081101561083457600080fd5b5051905090565b60005473ffffffffffffffffffffffffffffffffffffffff1690565b60046020526000908152604090205473ffffffffffffffffffffffffffffffffffffffff1681565b60015473ffffffffffffffffffffffffffffffffffffffff1681565b6108a3610c6a565b73ffffffffffffffffffffffffffffffffffffffff166108c161083b565b73ffffffffffffffffffffffffffffffffffffffff161461094357604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820181905260248201527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604482015290519081900360640190fd5b600280547fffffffffffffffffffffffff00000000000000000000000000000000000000001673ffffffffffffffffffffffffffffffffffffffff83169081179091556040517f3eb4e40982d3248ac68508a7f8548a3eb797d26d4f97403780f128229bf7d35a90600090a250565b6109ba610c6a565b73ffffffffffffffffffffffffffffffffffffffff166109d861083b565b73ffffffffffffffffffffffffffffffffffffffff1614610a5a57604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820181905260248201527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604482015290519081900360640190fd5b73ffffffffffffffffffffffffffffffffffffffff8116610ac6576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401808060200182810382526026815260200180610d376026913960400191505060405180910390fd5b6000805460405173ffffffffffffffffffffffffffffffffffffffff808516939216917f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e091a3600080547fffffffffffffffffffffffff00000000000000000000000000000000000000001673ffffffffffffffffffffffffffffffffffffffff92909216919091179055565b610b5b610c6a565b73ffffffffffffffffffffffffffffffffffffffff16610b7961083b565b73ffffffffffffffffffffffffffffffffffffffff1614610bfb57604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820181905260248201527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604482015290519081900360640190fd5b600180547fffffffffffffffffffffffff00000000000000000000000000000000000000001673ffffffffffffffffffffffffffffffffffffffff83169081179091556040517fd92ea1e33d049d1b556a9e1903fdcd553707c35f0bf0b2c5d554491a9a74a54790600090a250565b3390565b73ffffffffffffffffffffffffffffffffffffffff81166000818152600360208181526040808420805463ffffffff168086526004845282862080547fffffffffffffffffffffffff00000000000000000000000000000000000000001690559486905292825282547fffffffffffffffffffffffffffffffffffffffffffffffffffffffff000000001690925581519384529051919283927ff2e3d7483b67ee71de83343d173eb00829d4aff848f743b64b49a9dff2182186929181900390910190a2505056fe4f776e61626c653a206e6577206f776e657220697320746865207a65726f2061646472657373a26469706673582212209b453939a4d45aef8ba355094267486cb955f4bd7f2569605fe470c9ff499f8064736f6c63430007060033';
  static readonly abi: (
    | {
        inputs: never[];
        stateMutability: string;
        type: string;
        anonymous?: undefined;
        name?: undefined;
        outputs?: undefined;
      }
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
        stateMutability?: undefined;
        outputs?: undefined;
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
  static createInterface(): XAppConnectionManagerInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): XAppConnectionManager;
}
//# sourceMappingURL=XAppConnectionManager__factory.d.ts.map
