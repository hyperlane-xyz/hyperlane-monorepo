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
  PopulatedTransaction,
  Signer,
  ethers,
} from 'ethers';

import { TypedEvent, TypedEventFilter, TypedListener } from './commons';

interface IValidatorManagerInterface extends ethers.utils.Interface {
  functions: {
    'isValidatorSignature(uint32,bytes32,uint256,bytes)': FunctionFragment;
  };

  encodeFunctionData(
    functionFragment: 'isValidatorSignature',
    values: [BigNumberish, BytesLike, BigNumberish, BytesLike],
  ): string;

  decodeFunctionResult(
    functionFragment: 'isValidatorSignature',
    data: BytesLike,
  ): Result;

  events: {};
}

export class IValidatorManager extends BaseContract {
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

  interface: IValidatorManagerInterface;

  functions: {
    isValidatorSignature(
      _domain: BigNumberish,
      _root: BytesLike,
      _index: BigNumberish,
      _signature: BytesLike,
      overrides?: CallOverrides,
    ): Promise<[boolean]>;
  };

  isValidatorSignature(
    _domain: BigNumberish,
    _root: BytesLike,
    _index: BigNumberish,
    _signature: BytesLike,
    overrides?: CallOverrides,
  ): Promise<boolean>;

  callStatic: {
    isValidatorSignature(
      _domain: BigNumberish,
      _root: BytesLike,
      _index: BigNumberish,
      _signature: BytesLike,
      overrides?: CallOverrides,
    ): Promise<boolean>;
  };

  filters: {};

  estimateGas: {
    isValidatorSignature(
      _domain: BigNumberish,
      _root: BytesLike,
      _index: BigNumberish,
      _signature: BytesLike,
      overrides?: CallOverrides,
    ): Promise<BigNumber>;
  };

  populateTransaction: {
    isValidatorSignature(
      _domain: BigNumberish,
      _root: BytesLike,
      _index: BigNumberish,
      _signature: BytesLike,
      overrides?: CallOverrides,
    ): Promise<PopulatedTransaction>;
  };
}
