import type {
  EventFragment,
  FunctionFragment,
  Result,
} from '@ethersproject/abi';
import type { Listener, Provider } from '@ethersproject/providers';
import type {
  BaseContract,
  BigNumber,
  BigNumberish,
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
} from '../../../../common';

export interface IMailboxInterface extends utils.Interface {
  functions: {
    'count()': FunctionFragment;
    'defaultIsm()': FunctionFragment;
    'delivered(bytes32)': FunctionFragment;
    'dispatch(uint32,bytes32,bytes)': FunctionFragment;
    'latestCheckpoint()': FunctionFragment;
    'localDomain()': FunctionFragment;
    'process(bytes,bytes)': FunctionFragment;
    'recipientIsm(address)': FunctionFragment;
    'root()': FunctionFragment;
  };
  getFunction(
    nameOrSignatureOrTopic:
      | 'count'
      | 'defaultIsm'
      | 'delivered'
      | 'dispatch'
      | 'latestCheckpoint'
      | 'localDomain'
      | 'process'
      | 'recipientIsm'
      | 'root',
  ): FunctionFragment;
  encodeFunctionData(functionFragment: 'count', values?: undefined): string;
  encodeFunctionData(
    functionFragment: 'defaultIsm',
    values?: undefined,
  ): string;
  encodeFunctionData(
    functionFragment: 'delivered',
    values: [BytesLike],
  ): string;
  encodeFunctionData(
    functionFragment: 'dispatch',
    values: [BigNumberish, BytesLike, BytesLike],
  ): string;
  encodeFunctionData(
    functionFragment: 'latestCheckpoint',
    values?: undefined,
  ): string;
  encodeFunctionData(
    functionFragment: 'localDomain',
    values?: undefined,
  ): string;
  encodeFunctionData(
    functionFragment: 'process',
    values: [BytesLike, BytesLike],
  ): string;
  encodeFunctionData(
    functionFragment: 'recipientIsm',
    values: [string],
  ): string;
  encodeFunctionData(functionFragment: 'root', values?: undefined): string;
  decodeFunctionResult(functionFragment: 'count', data: BytesLike): Result;
  decodeFunctionResult(functionFragment: 'defaultIsm', data: BytesLike): Result;
  decodeFunctionResult(functionFragment: 'delivered', data: BytesLike): Result;
  decodeFunctionResult(functionFragment: 'dispatch', data: BytesLike): Result;
  decodeFunctionResult(
    functionFragment: 'latestCheckpoint',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'localDomain',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(functionFragment: 'process', data: BytesLike): Result;
  decodeFunctionResult(
    functionFragment: 'recipientIsm',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(functionFragment: 'root', data: BytesLike): Result;
  events: {
    'Dispatch(address,uint32,bytes32,bytes)': EventFragment;
    'DispatchId(bytes32)': EventFragment;
    'Process(uint32,bytes32,address)': EventFragment;
    'ProcessId(bytes32)': EventFragment;
  };
  getEvent(nameOrSignatureOrTopic: 'Dispatch'): EventFragment;
  getEvent(nameOrSignatureOrTopic: 'DispatchId'): EventFragment;
  getEvent(nameOrSignatureOrTopic: 'Process'): EventFragment;
  getEvent(nameOrSignatureOrTopic: 'ProcessId'): EventFragment;
}
export interface DispatchEventObject {
  sender: string;
  destination: number;
  recipient: string;
  message: string;
}
export declare type DispatchEvent = TypedEvent<
  [string, number, string, string],
  DispatchEventObject
>;
export declare type DispatchEventFilter = TypedEventFilter<DispatchEvent>;
export interface DispatchIdEventObject {
  messageId: string;
}
export declare type DispatchIdEvent = TypedEvent<
  [string],
  DispatchIdEventObject
>;
export declare type DispatchIdEventFilter = TypedEventFilter<DispatchIdEvent>;
export interface ProcessEventObject {
  origin: number;
  sender: string;
  recipient: string;
}
export declare type ProcessEvent = TypedEvent<
  [number, string, string],
  ProcessEventObject
>;
export declare type ProcessEventFilter = TypedEventFilter<ProcessEvent>;
export interface ProcessIdEventObject {
  messageId: string;
}
export declare type ProcessIdEvent = TypedEvent<[string], ProcessIdEventObject>;
export declare type ProcessIdEventFilter = TypedEventFilter<ProcessIdEvent>;
export interface IMailbox extends BaseContract {
  connect(signerOrProvider: Signer | Provider | string): this;
  attach(addressOrName: string): this;
  deployed(): Promise<this>;
  interface: IMailboxInterface;
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
    count(overrides?: CallOverrides): Promise<[number]>;
    defaultIsm(overrides?: CallOverrides): Promise<[string]>;
    delivered(
      messageId: BytesLike,
      overrides?: CallOverrides,
    ): Promise<[boolean]>;
    dispatch(
      _destinationDomain: BigNumberish,
      _recipientAddress: BytesLike,
      _messageBody: BytesLike,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
    latestCheckpoint(overrides?: CallOverrides): Promise<[string, number]>;
    localDomain(overrides?: CallOverrides): Promise<[number]>;
    process(
      _metadata: BytesLike,
      _message: BytesLike,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
    recipientIsm(
      _recipient: string,
      overrides?: CallOverrides,
    ): Promise<[string]>;
    root(overrides?: CallOverrides): Promise<[string]>;
  };
  count(overrides?: CallOverrides): Promise<number>;
  defaultIsm(overrides?: CallOverrides): Promise<string>;
  delivered(messageId: BytesLike, overrides?: CallOverrides): Promise<boolean>;
  dispatch(
    _destinationDomain: BigNumberish,
    _recipientAddress: BytesLike,
    _messageBody: BytesLike,
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  latestCheckpoint(overrides?: CallOverrides): Promise<[string, number]>;
  localDomain(overrides?: CallOverrides): Promise<number>;
  process(
    _metadata: BytesLike,
    _message: BytesLike,
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  recipientIsm(_recipient: string, overrides?: CallOverrides): Promise<string>;
  root(overrides?: CallOverrides): Promise<string>;
  callStatic: {
    count(overrides?: CallOverrides): Promise<number>;
    defaultIsm(overrides?: CallOverrides): Promise<string>;
    delivered(
      messageId: BytesLike,
      overrides?: CallOverrides,
    ): Promise<boolean>;
    dispatch(
      _destinationDomain: BigNumberish,
      _recipientAddress: BytesLike,
      _messageBody: BytesLike,
      overrides?: CallOverrides,
    ): Promise<string>;
    latestCheckpoint(overrides?: CallOverrides): Promise<[string, number]>;
    localDomain(overrides?: CallOverrides): Promise<number>;
    process(
      _metadata: BytesLike,
      _message: BytesLike,
      overrides?: CallOverrides,
    ): Promise<void>;
    recipientIsm(
      _recipient: string,
      overrides?: CallOverrides,
    ): Promise<string>;
    root(overrides?: CallOverrides): Promise<string>;
  };
  filters: {
    'Dispatch(address,uint32,bytes32,bytes)'(
      sender?: string | null,
      destination?: BigNumberish | null,
      recipient?: BytesLike | null,
      message?: null,
    ): DispatchEventFilter;
    Dispatch(
      sender?: string | null,
      destination?: BigNumberish | null,
      recipient?: BytesLike | null,
      message?: null,
    ): DispatchEventFilter;
    'DispatchId(bytes32)'(messageId?: BytesLike | null): DispatchIdEventFilter;
    DispatchId(messageId?: BytesLike | null): DispatchIdEventFilter;
    'Process(uint32,bytes32,address)'(
      origin?: BigNumberish | null,
      sender?: BytesLike | null,
      recipient?: string | null,
    ): ProcessEventFilter;
    Process(
      origin?: BigNumberish | null,
      sender?: BytesLike | null,
      recipient?: string | null,
    ): ProcessEventFilter;
    'ProcessId(bytes32)'(messageId?: BytesLike | null): ProcessIdEventFilter;
    ProcessId(messageId?: BytesLike | null): ProcessIdEventFilter;
  };
  estimateGas: {
    count(overrides?: CallOverrides): Promise<BigNumber>;
    defaultIsm(overrides?: CallOverrides): Promise<BigNumber>;
    delivered(
      messageId: BytesLike,
      overrides?: CallOverrides,
    ): Promise<BigNumber>;
    dispatch(
      _destinationDomain: BigNumberish,
      _recipientAddress: BytesLike,
      _messageBody: BytesLike,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
    latestCheckpoint(overrides?: CallOverrides): Promise<BigNumber>;
    localDomain(overrides?: CallOverrides): Promise<BigNumber>;
    process(
      _metadata: BytesLike,
      _message: BytesLike,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
    recipientIsm(
      _recipient: string,
      overrides?: CallOverrides,
    ): Promise<BigNumber>;
    root(overrides?: CallOverrides): Promise<BigNumber>;
  };
  populateTransaction: {
    count(overrides?: CallOverrides): Promise<PopulatedTransaction>;
    defaultIsm(overrides?: CallOverrides): Promise<PopulatedTransaction>;
    delivered(
      messageId: BytesLike,
      overrides?: CallOverrides,
    ): Promise<PopulatedTransaction>;
    dispatch(
      _destinationDomain: BigNumberish,
      _recipientAddress: BytesLike,
      _messageBody: BytesLike,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
    latestCheckpoint(overrides?: CallOverrides): Promise<PopulatedTransaction>;
    localDomain(overrides?: CallOverrides): Promise<PopulatedTransaction>;
    process(
      _metadata: BytesLike,
      _message: BytesLike,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
    recipientIsm(
      _recipient: string,
      overrides?: CallOverrides,
    ): Promise<PopulatedTransaction>;
    root(overrides?: CallOverrides): Promise<PopulatedTransaction>;
  };
}
//# sourceMappingURL=IMailbox.d.ts.map
