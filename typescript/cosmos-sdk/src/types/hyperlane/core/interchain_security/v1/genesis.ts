// Code generated by protoc-gen-ts_proto. DO NOT EDIT.
// versions:
//   protoc-gen-ts_proto  v1.181.2
//   protoc               unknown
// source: hyperlane/core/interchain_security/v1/genesis.proto

/* eslint-disable */
import Long from 'long';
import _m0 from 'protobufjs/minimal';

import { Any } from '../../../../google/protobuf/any';

export const protobufPackage = 'hyperlane.core.interchain_security.v1';

/** GenesisState defines the 01_interchain_security submodule's genesis state. */
export interface GenesisState {
  /** accounts are the accounts present at genesis. */
  isms: Any[];
  validator_storage_locations: ValidatorStorageLocationGenesisWrapper[];
}

/**
 * ValidatorStorageLocationGenesisWrapper stores the information for
 * validator, mailbox and storage-location which validators have announced
 */
export interface ValidatorStorageLocationGenesisWrapper {
  mailbox_id: string;
  validator_address: string;
  index: string;
  storage_location: string;
}

function createBaseGenesisState(): GenesisState {
  return { isms: [], validator_storage_locations: [] };
}

export const GenesisState = {
  encode(
    message: GenesisState,
    writer: _m0.Writer = _m0.Writer.create(),
  ): _m0.Writer {
    for (const v of message.isms) {
      Any.encode(v!, writer.uint32(10).fork()).ldelim();
    }
    for (const v of message.validator_storage_locations) {
      ValidatorStorageLocationGenesisWrapper.encode(
        v!,
        writer.uint32(18).fork(),
      ).ldelim();
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): GenesisState {
    const reader =
      input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseGenesisState();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.isms.push(Any.decode(reader, reader.uint32()));
          continue;
        case 2:
          if (tag !== 18) {
            break;
          }

          message.validator_storage_locations.push(
            ValidatorStorageLocationGenesisWrapper.decode(
              reader,
              reader.uint32(),
            ),
          );
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): GenesisState {
    return {
      isms: globalThis.Array.isArray(object?.isms)
        ? object.isms.map((e: any) => Any.fromJSON(e))
        : [],
      validator_storage_locations: globalThis.Array.isArray(
        object?.validator_storage_locations,
      )
        ? object.validator_storage_locations.map((e: any) =>
            ValidatorStorageLocationGenesisWrapper.fromJSON(e),
          )
        : [],
    };
  },

  toJSON(message: GenesisState): unknown {
    const obj: any = {};
    if (message.isms?.length) {
      obj.isms = message.isms.map((e) => Any.toJSON(e));
    }
    if (message.validator_storage_locations?.length) {
      obj.validator_storage_locations = message.validator_storage_locations.map(
        (e) => ValidatorStorageLocationGenesisWrapper.toJSON(e),
      );
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<GenesisState>, I>>(
    base?: I,
  ): GenesisState {
    return GenesisState.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<GenesisState>, I>>(
    object: I,
  ): GenesisState {
    const message = createBaseGenesisState();
    message.isms = object.isms?.map((e) => Any.fromPartial(e)) || [];
    message.validator_storage_locations =
      object.validator_storage_locations?.map((e) =>
        ValidatorStorageLocationGenesisWrapper.fromPartial(e),
      ) || [];
    return message;
  },
};

function createBaseValidatorStorageLocationGenesisWrapper(): ValidatorStorageLocationGenesisWrapper {
  return {
    mailbox_id: '0',
    validator_address: '',
    index: '0',
    storage_location: '',
  };
}

export const ValidatorStorageLocationGenesisWrapper = {
  encode(
    message: ValidatorStorageLocationGenesisWrapper,
    writer: _m0.Writer = _m0.Writer.create(),
  ): _m0.Writer {
    if (message.mailbox_id !== '0') {
      writer.uint32(8).uint64(message.mailbox_id);
    }
    if (message.validator_address !== '') {
      writer.uint32(18).string(message.validator_address);
    }
    if (message.index !== '0') {
      writer.uint32(24).uint64(message.index);
    }
    if (message.storage_location !== '') {
      writer.uint32(34).string(message.storage_location);
    }
    return writer;
  },

  decode(
    input: _m0.Reader | Uint8Array,
    length?: number,
  ): ValidatorStorageLocationGenesisWrapper {
    const reader =
      input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseValidatorStorageLocationGenesisWrapper();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 8) {
            break;
          }

          message.mailbox_id = longToString(reader.uint64() as Long);
          continue;
        case 2:
          if (tag !== 18) {
            break;
          }

          message.validator_address = reader.string();
          continue;
        case 3:
          if (tag !== 24) {
            break;
          }

          message.index = longToString(reader.uint64() as Long);
          continue;
        case 4:
          if (tag !== 34) {
            break;
          }

          message.storage_location = reader.string();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): ValidatorStorageLocationGenesisWrapper {
    return {
      mailbox_id: isSet(object.mailbox_id)
        ? globalThis.String(object.mailbox_id)
        : '0',
      validator_address: isSet(object.validator_address)
        ? globalThis.String(object.validator_address)
        : '',
      index: isSet(object.index) ? globalThis.String(object.index) : '0',
      storage_location: isSet(object.storage_location)
        ? globalThis.String(object.storage_location)
        : '',
    };
  },

  toJSON(message: ValidatorStorageLocationGenesisWrapper): unknown {
    const obj: any = {};
    if (message.mailbox_id !== '0') {
      obj.mailbox_id = message.mailbox_id;
    }
    if (message.validator_address !== '') {
      obj.validator_address = message.validator_address;
    }
    if (message.index !== '0') {
      obj.index = message.index;
    }
    if (message.storage_location !== '') {
      obj.storage_location = message.storage_location;
    }
    return obj;
  },

  create<
    I extends Exact<DeepPartial<ValidatorStorageLocationGenesisWrapper>, I>,
  >(base?: I): ValidatorStorageLocationGenesisWrapper {
    return ValidatorStorageLocationGenesisWrapper.fromPartial(
      base ?? ({} as any),
    );
  },
  fromPartial<
    I extends Exact<DeepPartial<ValidatorStorageLocationGenesisWrapper>, I>,
  >(object: I): ValidatorStorageLocationGenesisWrapper {
    const message = createBaseValidatorStorageLocationGenesisWrapper();
    message.mailbox_id = object.mailbox_id ?? '0';
    message.validator_address = object.validator_address ?? '';
    message.index = object.index ?? '0';
    message.storage_location = object.storage_location ?? '';
    return message;
  },
};

type Builtin =
  | Date
  | Function
  | Uint8Array
  | string
  | number
  | boolean
  | undefined;

export type DeepPartial<T> = T extends Builtin
  ? T
  : T extends globalThis.Array<infer U>
  ? globalThis.Array<DeepPartial<U>>
  : T extends ReadonlyArray<infer U>
  ? ReadonlyArray<DeepPartial<U>>
  : T extends {}
  ? { [K in keyof T]?: DeepPartial<T[K]> }
  : Partial<T>;

type KeysOfUnion<T> = T extends T ? keyof T : never;
export type Exact<P, I extends P> = P extends Builtin
  ? P
  : P & { [K in keyof P]: Exact<P[K], I[K]> } & {
      [K in Exclude<keyof I, KeysOfUnion<P>>]: never;
    };

function longToString(long: Long) {
  return long.toString();
}

if (_m0.util.Long !== Long) {
  _m0.util.Long = Long as any;
  _m0.configure();
}

function isSet(value: any): boolean {
  return value !== null && value !== undefined;
}
