import type { FunctionFragment, Result } from '@ethersproject/abi';
import type { Listener, Provider } from '@ethersproject/providers';
import type {
  BaseContract,
  BigNumber,
  BytesLike,
  CallOverrides,
  ContractTransaction,
  Overrides,
  PopulatedTransaction,
  Signer,
  utils,
} from 'ethers';

import type {
  OnEvent,
  TypedEvent,
  TypedEventFilter,
  TypedListener,
} from '../../../../../common';

export interface IInterchainSecurityModuleInterface extends utils.Interface {
  functions: {
    'moduleType()': FunctionFragment;
    'verify(bytes,bytes)': FunctionFragment;
  };
  getFunction(
    nameOrSignatureOrTopic: 'moduleType' | 'verify',
  ): FunctionFragment;
  encodeFunctionData(
    functionFragment: 'moduleType',
    values?: undefined,
  ): string;
  encodeFunctionData(
    functionFragment: 'verify',
    values: [BytesLike, BytesLike],
  ): string;
  decodeFunctionResult(functionFragment: 'moduleType', data: BytesLike): Result;
  decodeFunctionResult(functionFragment: 'verify', data: BytesLike): Result;
  events: {};
}
export interface IInterchainSecurityModule extends BaseContract {
  connect(signerOrProvider: Signer | Provider | string): this;
  attach(addressOrName: string): this;
  deployed(): Promise<this>;
  interface: IInterchainSecurityModuleInterface;
  queryFilter<TEvent extends TypedEvent>(
    event: TypedEventFilter<TEvent>,
    fromBlockOrBlockhash?: string | number | undefined,
    toBlock?: string | number | undefined,
  ): Promise<Array<TEvent>>;
  listeners<TEvent extends TypedEvent>(
    eventFilter?: TypedEventFilter<TEvent>,
  ): Array<TypedListener<TEvent>>;
  listeners(eventName?: string): Array<Listener>;
  removeAllListeners<TEvent extends TypedEvent>(
    eventFilter: TypedEventFilter<TEvent>,
  ): this;
  removeAllListeners(eventName?: string): this;
  off: OnEvent<this>;
  on: OnEvent<this>;
  once: OnEvent<this>;
  removeListener: OnEvent<this>;
  functions: {
    moduleType(overrides?: CallOverrides): Promise<[number]>;
    verify(
      _metadata: BytesLike,
      _message: BytesLike,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
  };
  moduleType(overrides?: CallOverrides): Promise<number>;
  verify(
    _metadata: BytesLike,
    _message: BytesLike,
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  callStatic: {
    moduleType(overrides?: CallOverrides): Promise<number>;
    verify(
      _metadata: BytesLike,
      _message: BytesLike,
      overrides?: CallOverrides,
    ): Promise<boolean>;
  };
  filters: {};
  estimateGas: {
    moduleType(overrides?: CallOverrides): Promise<BigNumber>;
    verify(
      _metadata: BytesLike,
      _message: BytesLike,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
  };
  populateTransaction: {
    moduleType(overrides?: CallOverrides): Promise<PopulatedTransaction>;
    verify(
      _metadata: BytesLike,
      _message: BytesLike,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
  };
}
//# sourceMappingURL=IInterchainSecurityModule.d.ts.map
