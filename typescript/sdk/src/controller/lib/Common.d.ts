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

interface CommonInterface extends ethers.utils.Interface {
  functions: {
    'checkpointedRoot()': FunctionFragment;
    'checkpoints(bytes32)': FunctionFragment;
    'latestCheckpoint()': FunctionFragment;
    'localDomain()': FunctionFragment;
    'owner()': FunctionFragment;
    'renounceOwnership()': FunctionFragment;
    'setValidatorManager(address)': FunctionFragment;
    'transferOwnership(address)': FunctionFragment;
    'validatorManager()': FunctionFragment;
  };

  encodeFunctionData(
    functionFragment: 'checkpointedRoot',
    values?: undefined,
  ): string;
  encodeFunctionData(
    functionFragment: 'checkpoints',
    values: [BytesLike],
  ): string;
  encodeFunctionData(
    functionFragment: 'latestCheckpoint',
    values?: undefined,
  ): string;
  encodeFunctionData(
    functionFragment: 'localDomain',
    values?: undefined,
  ): string;
  encodeFunctionData(functionFragment: 'owner', values?: undefined): string;
  encodeFunctionData(
    functionFragment: 'renounceOwnership',
    values?: undefined,
  ): string;
  encodeFunctionData(
    functionFragment: 'setValidatorManager',
    values: [string],
  ): string;
  encodeFunctionData(
    functionFragment: 'transferOwnership',
    values: [string],
  ): string;
  encodeFunctionData(
    functionFragment: 'validatorManager',
    values?: undefined,
  ): string;

  decodeFunctionResult(
    functionFragment: 'checkpointedRoot',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'checkpoints',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'latestCheckpoint',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'localDomain',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(functionFragment: 'owner', data: BytesLike): Result;
  decodeFunctionResult(
    functionFragment: 'renounceOwnership',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'setValidatorManager',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'transferOwnership',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'validatorManager',
    data: BytesLike,
  ): Result;

  events: {
    'Checkpoint(bytes32,uint256)': EventFragment;
    'NewValidatorManager(address)': EventFragment;
    'OwnershipTransferred(address,address)': EventFragment;
  };

  getEvent(nameOrSignatureOrTopic: 'Checkpoint'): EventFragment;
  getEvent(nameOrSignatureOrTopic: 'NewValidatorManager'): EventFragment;
  getEvent(nameOrSignatureOrTopic: 'OwnershipTransferred'): EventFragment;
}

export class Common extends BaseContract {
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

  interface: CommonInterface;

  functions: {
    checkpointedRoot(overrides?: CallOverrides): Promise<[string]>;

    checkpoints(
      arg0: BytesLike,
      overrides?: CallOverrides,
    ): Promise<[BigNumber]>;

    latestCheckpoint(
      overrides?: CallOverrides,
    ): Promise<[string, BigNumber] & { root: string; index: BigNumber }>;

    localDomain(overrides?: CallOverrides): Promise<[number]>;

    owner(overrides?: CallOverrides): Promise<[string]>;

    renounceOwnership(
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<ContractTransaction>;

    setValidatorManager(
      _validatorManager: string,
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<ContractTransaction>;

    transferOwnership(
      newOwner: string,
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<ContractTransaction>;

    validatorManager(overrides?: CallOverrides): Promise<[string]>;
  };

  checkpointedRoot(overrides?: CallOverrides): Promise<string>;

  checkpoints(arg0: BytesLike, overrides?: CallOverrides): Promise<BigNumber>;

  latestCheckpoint(
    overrides?: CallOverrides,
  ): Promise<[string, BigNumber] & { root: string; index: BigNumber }>;

  localDomain(overrides?: CallOverrides): Promise<number>;

  owner(overrides?: CallOverrides): Promise<string>;

  renounceOwnership(
    overrides?: Overrides & { from?: string | Promise<string> },
  ): Promise<ContractTransaction>;

  setValidatorManager(
    _validatorManager: string,
    overrides?: Overrides & { from?: string | Promise<string> },
  ): Promise<ContractTransaction>;

  transferOwnership(
    newOwner: string,
    overrides?: Overrides & { from?: string | Promise<string> },
  ): Promise<ContractTransaction>;

  validatorManager(overrides?: CallOverrides): Promise<string>;

  callStatic: {
    checkpointedRoot(overrides?: CallOverrides): Promise<string>;

    checkpoints(arg0: BytesLike, overrides?: CallOverrides): Promise<BigNumber>;

    latestCheckpoint(
      overrides?: CallOverrides,
    ): Promise<[string, BigNumber] & { root: string; index: BigNumber }>;

    localDomain(overrides?: CallOverrides): Promise<number>;

    owner(overrides?: CallOverrides): Promise<string>;

    renounceOwnership(overrides?: CallOverrides): Promise<void>;

    setValidatorManager(
      _validatorManager: string,
      overrides?: CallOverrides,
    ): Promise<void>;

    transferOwnership(
      newOwner: string,
      overrides?: CallOverrides,
    ): Promise<void>;

    validatorManager(overrides?: CallOverrides): Promise<string>;
  };

  filters: {
    Checkpoint(
      root?: BytesLike | null,
      index?: BigNumberish | null,
    ): TypedEventFilter<
      [string, BigNumber],
      { root: string; index: BigNumber }
    >;

    NewValidatorManager(
      validatorManager?: null,
    ): TypedEventFilter<[string], { validatorManager: string }>;

    OwnershipTransferred(
      previousOwner?: string | null,
      newOwner?: string | null,
    ): TypedEventFilter<
      [string, string],
      { previousOwner: string; newOwner: string }
    >;
  };

  estimateGas: {
    checkpointedRoot(overrides?: CallOverrides): Promise<BigNumber>;

    checkpoints(arg0: BytesLike, overrides?: CallOverrides): Promise<BigNumber>;

    latestCheckpoint(overrides?: CallOverrides): Promise<BigNumber>;

    localDomain(overrides?: CallOverrides): Promise<BigNumber>;

    owner(overrides?: CallOverrides): Promise<BigNumber>;

    renounceOwnership(
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<BigNumber>;

    setValidatorManager(
      _validatorManager: string,
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<BigNumber>;

    transferOwnership(
      newOwner: string,
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<BigNumber>;

    validatorManager(overrides?: CallOverrides): Promise<BigNumber>;
  };

  populateTransaction: {
    checkpointedRoot(overrides?: CallOverrides): Promise<PopulatedTransaction>;

    checkpoints(
      arg0: BytesLike,
      overrides?: CallOverrides,
    ): Promise<PopulatedTransaction>;

    latestCheckpoint(overrides?: CallOverrides): Promise<PopulatedTransaction>;

    localDomain(overrides?: CallOverrides): Promise<PopulatedTransaction>;

    owner(overrides?: CallOverrides): Promise<PopulatedTransaction>;

    renounceOwnership(
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<PopulatedTransaction>;

    setValidatorManager(
      _validatorManager: string,
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<PopulatedTransaction>;

    transferOwnership(
      newOwner: string,
      overrides?: Overrides & { from?: string | Promise<string> },
    ): Promise<PopulatedTransaction>;

    validatorManager(overrides?: CallOverrides): Promise<PopulatedTransaction>;
  };
}
