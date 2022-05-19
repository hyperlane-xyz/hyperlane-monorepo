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

interface Version0Interface extends ethers.utils.Interface {
  functions: {
    'VERSION()': FunctionFragment;
  };

  encodeFunctionData(functionFragment: 'VERSION', values?: undefined): string;

  decodeFunctionResult(functionFragment: 'VERSION', data: BytesLike): Result;

  events: {};
}

export class Version0 extends BaseContract {
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

  interface: Version0Interface;

  functions: {
    VERSION(overrides?: CallOverrides): Promise<[number]>;
  };

  VERSION(overrides?: CallOverrides): Promise<number>;

  callStatic: {
    VERSION(overrides?: CallOverrides): Promise<number>;
  };

  filters: {};

  estimateGas: {
    VERSION(overrides?: CallOverrides): Promise<BigNumber>;
  };

  populateTransaction: {
    VERSION(overrides?: CallOverrides): Promise<PopulatedTransaction>;
  };
}
