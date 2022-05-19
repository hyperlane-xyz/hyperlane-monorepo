/* Autogenerated file. Do not edit manually. */

/* tslint:disable */

/* eslint-disable */
import { EventFragment, FunctionFragment, Result } from '@ethersproject/abi';
import { BytesLike } from '@ethersproject/bytes';
import { Listener, Provider } from '@ethersproject/providers';
import {
  BaseContract,
  BigNumber,
  BigNumberish,
  CallOverrides,
  ContractTransaction,
  EventFilter,
  Overrides,
  PopulatedTransaction,
  Signer,
  ethers,
} from 'ethers';

import { TypedEvent, TypedEventFilter, TypedListener } from './commons';

interface RouterTemplateInterface extends ethers.utils.Interface {
  functions: {
    'abacusConnectionManager()': FunctionFragment;
    'dispatchTypeA(uint32,uint256)': FunctionFragment;
    'enrollRemoteRouter(uint32,bytes32)': FunctionFragment;
    'handle(uint32,bytes32,bytes)': FunctionFragment;
    'owner()': FunctionFragment;
    'renounceOwnership()': FunctionFragment;
    'routers(uint32)': FunctionFragment;
    'setAbacusConnectionManager(address)': FunctionFragment;
    'transferOwnership(address)': FunctionFragment;
  };

  encodeFunctionData(
    functionFragment: 'abacusConnectionManager',
    values?: undefined,
  ): string;
  encodeFunctionData(
    functionFragment: 'dispatchTypeA',
    values: [BigNumberish, BigNumberish],
  ): string;
  encodeFunctionData(
    functionFragment: 'enrollRemoteRouter',
    values: [BigNumberish, BytesLike],
  ): string;
  encodeFunctionData(
    functionFragment: 'handle',
    values: [BigNumberish, BytesLike, BytesLike],
  ): string;
  encodeFunctionData(functionFragment: 'owner', values?: undefined): string;
  encodeFunctionData(
    functionFragment: 'renounceOwnership',
    values?: undefined,
  ): string;
  encodeFunctionData(
    functionFragment: 'routers',
    values: [BigNumberish],
  ): string;
  encodeFunctionData(
    functionFragment: 'setAbacusConnectionManager',
    values: [string],
  ): string;
  encodeFunctionData(
    functionFragment: 'transferOwnership',
    values: [string],
  ): string;

  decodeFunctionResult(
    functionFragment: 'abacusConnectionManager',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'dispatchTypeA',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'enrollRemoteRouter',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(functionFragment: 'handle', data: BytesLike): Result;
  decodeFunctionResult(functionFragment: 'owner', data: BytesLike): Result;
  decodeFunctionResult(
    functionFragment: 'renounceOwnership',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(functionFragment: 'routers', data: BytesLike): Result;
  decodeFunctionResult(
    functionFragment: 'setAbacusConnectionManager',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'transferOwnership',
    data: BytesLike,
  ): Result;

  events: {
    'EnrollRemoteRouter(uint32,bytes32)': EventFragment;
    'OwnershipTransferred(address,address)': EventFragment;
    'SetAbacusConnectionManager(address)': EventFragment;
    'TypeAReceived(uint256)': EventFragment;
  };

  getEvent(nameOrSignatureOrTopic: 'EnrollRemoteRouter'): EventFragment;
  getEvent(nameOrSignatureOrTopic: 'OwnershipTransferred'): EventFragment;
  getEvent(nameOrSignatureOrTopic: 'SetAbacusConnectionManager'): EventFragment;
  getEvent(nameOrSignatureOrTopic: 'TypeAReceived'): EventFragment;
}

export class RouterTemplate extends BaseContract {
  connect(signerOrProvider: Signer | Provider | string): this;
  attach(addressOrName: string): this;
  deployed(): Promise<this>;

  listeners<EventArgsArray extends Array<any>, EventArgsObject>(
    eventFilter?: TypedEventFilter<EventArgsArray, EventArgsObject>,
  ): Array<TypedListener<EventArgsArray, EventArgsObject>>;
  off<EventArgsArray extends Array<any>, EventArgsObject>(
    eventFilter: TypedEventFilter<EventArgsArray, EventArgsObject>,
    listener: TypedListener<EventArgsArray, EventArgsObject>,
  ): this;
  on<EventArgsArray extends Array<any>, EventArgsObject>(
    eventFilter: TypedEventFilter<EventArgsArray, EventArgsObject>,
    listener: TypedListener<EventArgsArray, EventArgsObject>,
  ): this;
  once<EventArgsArray extends Array<any>, EventArgsObject>(
    eventFilter: TypedEventFilter<EventArgsArray, EventArgsObject>,
    listener: TypedListener<EventArgsArray, EventArgsObject>,
  ): this;
  removeListener<EventArgsArray extends Array<any>, EventArgsObject>(
    eventFilter: TypedEventFilter<EventArgsArray, EventArgsObject>,
    listener: TypedListener<EventArgsArray, EventArgsObject>,
  ): this;
  removeAllListeners<EventArgsArray extends Array<any>, EventArgsObject>(
    eventFilter: TypedEventFilter<EventArgsArray, EventArgsObject>,
  ): this;

  listeners(eventName?: string): Array<Listener>;
  off(eventName: string, listener: Listener): this;
  on(eventName: string, listener: Listener): this;
  once(eventName: string, listener: Listener): this;
  removeListener(eventName: string, listener: Listener): this;
  removeAllListeners(eventName?: string): this;

  queryFilter<EventArgsArray extends Array<any>, EventArgsObject>(
    event: TypedEventFilter<EventArgsArray, EventArgsObject>,
    fromBlockOrBlockhash?: string | number | undefined,
    toBlock?: string | number | undefined,
  ): Promise<Array<TypedEvent<EventArgsArray & EventArgsObject>>>;

  interface: RouterTemplateInterface;

  functions: {
    abacusConnectionManager(overrides?: CallOverrides): Promise<[string]>;

    dispatchTypeA(
      _destinationDomain: BigNumberish,
      _number: BigNumberish,
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<ContractTransaction>;

    enrollRemoteRouter(
      _domain: BigNumberish,
      _router: BytesLike,
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<ContractTransaction>;

    handle(
      _origin: BigNumberish,
      _sender: BytesLike,
      _message: BytesLike,
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<ContractTransaction>;

    owner(overrides?: CallOverrides): Promise<[string]>;

    renounceOwnership(
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<ContractTransaction>;

    routers(arg0: BigNumberish, overrides?: CallOverrides): Promise<[string]>;

    setAbacusConnectionManager(
      _abacusConnectionManager: string,
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<ContractTransaction>;

    transferOwnership(
      newOwner: string,
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<ContractTransaction>;
  };

  abacusConnectionManager(overrides?: CallOverrides): Promise<string>;

  dispatchTypeA(
    _destinationDomain: BigNumberish,
    _number: BigNumberish,
    overrides?: Overrides & { from?: string | Promise<string> },
  ): Promise<ContractTransaction>;

  enrollRemoteRouter(
    _domain: BigNumberish,
    _router: BytesLike,
    overrides?: Overrides & { from?: string | Promise<string> },
  ): Promise<ContractTransaction>;

  handle(
    _origin: BigNumberish,
    _sender: BytesLike,
    _message: BytesLike,
    overrides?: Overrides & { from?: string | Promise<string> },
  ): Promise<ContractTransaction>;

  owner(overrides?: CallOverrides): Promise<string>;

  renounceOwnership(
    overrides?: Overrides & { from?: string | Promise<string> },
  ): Promise<ContractTransaction>;

  routers(arg0: BigNumberish, overrides?: CallOverrides): Promise<string>;

  setAbacusConnectionManager(
    _abacusConnectionManager: string,
    overrides?: Overrides & { from?: string | Promise<string> },
  ): Promise<ContractTransaction>;

  transferOwnership(
    newOwner: string,
    overrides?: Overrides & { from?: string | Promise<string> },
  ): Promise<ContractTransaction>;

  callStatic: {
    abacusConnectionManager(overrides?: CallOverrides): Promise<string>;

    dispatchTypeA(
      _destinationDomain: BigNumberish,
      _number: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<void>;

    enrollRemoteRouter(
      _domain: BigNumberish,
      _router: BytesLike,
      overrides?: CallOverrides,
    ): Promise<void>;

    handle(
      _origin: BigNumberish,
      _sender: BytesLike,
      _message: BytesLike,
      overrides?: CallOverrides,
    ): Promise<void>;

    owner(overrides?: CallOverrides): Promise<string>;

    renounceOwnership(overrides?: CallOverrides): Promise<void>;

    routers(arg0: BigNumberish, overrides?: CallOverrides): Promise<string>;

    setAbacusConnectionManager(
      _abacusConnectionManager: string,
      overrides?: CallOverrides,
    ): Promise<void>;

    transferOwnership(
      newOwner: string,
      overrides?: CallOverrides,
    ): Promise<void>;
  };

  filters: {
    EnrollRemoteRouter(
      domain?: BigNumberish | null,
      router?: BytesLike | null,
    ): TypedEventFilter<[number, string], { domain: number; router: string }>;

    OwnershipTransferred(
      previousOwner?: string | null,
      newOwner?: string | null,
    ): TypedEventFilter<
      [string, string],
      { previousOwner: string; newOwner: string }
    >;

    SetAbacusConnectionManager(
      abacusConnectionManager?: string | null,
    ): TypedEventFilter<[string], { abacusConnectionManager: string }>;

    TypeAReceived(
      number?: null,
    ): TypedEventFilter<[BigNumber], { number: BigNumber }>;
  };

  estimateGas: {
    abacusConnectionManager(overrides?: CallOverrides): Promise<BigNumber>;

    dispatchTypeA(
      _destinationDomain: BigNumberish,
      _number: BigNumberish,
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<BigNumber>;

    enrollRemoteRouter(
      _domain: BigNumberish,
      _router: BytesLike,
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<BigNumber>;

    handle(
      _origin: BigNumberish,
      _sender: BytesLike,
      _message: BytesLike,
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<BigNumber>;

    owner(overrides?: CallOverrides): Promise<BigNumber>;

    renounceOwnership(
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<BigNumber>;

    routers(arg0: BigNumberish, overrides?: CallOverrides): Promise<BigNumber>;

    setAbacusConnectionManager(
      _abacusConnectionManager: string,
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<BigNumber>;

    transferOwnership(
      newOwner: string,
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<BigNumber>;
  };

  populateTransaction: {
    abacusConnectionManager(
      overrides?: CallOverrides,
    ): Promise<PopulatedTransaction>;

    dispatchTypeA(
      _destinationDomain: BigNumberish,
      _number: BigNumberish,
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<PopulatedTransaction>;

    enrollRemoteRouter(
      _domain: BigNumberish,
      _router: BytesLike,
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<PopulatedTransaction>;

    handle(
      _origin: BigNumberish,
      _sender: BytesLike,
      _message: BytesLike,
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<PopulatedTransaction>;

    owner(overrides?: CallOverrides): Promise<PopulatedTransaction>;

    renounceOwnership(
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<PopulatedTransaction>;

    routers(
      arg0: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<PopulatedTransaction>;

    setAbacusConnectionManager(
      _abacusConnectionManager: string,
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<PopulatedTransaction>;

    transferOwnership(
      newOwner: string,
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<PopulatedTransaction>;
  };
}
