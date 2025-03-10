import { crc32 } from 'zlib';

export const METADATA_VARIANT = {
  STANDARD: 1,
};
export const ANSWER_BIT: number = 0x80000000;

export const op = (name: string): number => {
  return crc32(name) & ~ANSWER_BIT;
};

export const answer = (op: number): number => (op | ANSWER_BIT) >>> 0;

export const OpCodes = {
  // mailbox
  DISPATCH: op('op::mailbox::dispatch'),
  PROCESS: op('op::mailbox::process'),
  SET_DEFAULT_ISM: 0xd44d8496,
  SET_DEFAULT_HOOK: 0x8e6c735b,
  SET_REQUIRED_HOOK: 0x2f5451cc,
  SET_AUTHORIZED_HOOK: 0x995495a2,
  // hook
  QUOTE_DISPATCH: op('op::hook::quote_dispatch'),
  POST_DISPATCH: op('op::hook::post_dispatch'),
  SET_BENEFICIARY: 0xfc3adbc,
  // recipient
  HANDLE: op('op::recipient::handle'),
  GET_ISM: op('op::recipient::get_ism'),
  REMOVE_ISM: 0x38552523,
  // protocol fee hook
  SET_PROTOCOL_FEE: 0xf7240b7a,
  COLLECT_PROTOCOL_FEE: 0xaec506d3,
  // ism
  VERIFY: op('op::ism::verify'),
  SET_VALIDATORS_AND_THRESHOLD: 0x4dad45ea,
  SET_ISM: 0x9b6299a8,
  // validator announce
  ANNOUNCE: 0x980b3d44,
  CLAIM: 0x13a3ca6,
  TRANSFER_OWNERSHIP: 0x295e75a9,
  SET_DEST_GAS_CONFIG: 0x301bf43f,
  JETTON_TRANSFER: 0xf8a7ea5,
  JETTON_TRANSFER_NOTIFICATION: 0x7362d09c,
  JETTON_INTERNAL_TRANSFER: 0x178d4519,
  JETTON_EXCESSES: 0xd53276db,
  JETTON_BURN: 0x595f07bc,
  JETTON_BURN_NOTIFICATION: 0x7bdd97de,
  JETTON_MINT: 0x642b7d07,
  JETTON_TOP_UP: 0xd372158c,
  JETTON_CHANGE_ADMIN: 0x6501f354,
  TRANSFER_REMOTE: op('op::transfer_remote'),
  SET_ROUTER: answer(op('op:set_router')),
  MERKLE_TEST: op('op::merkle_test'),
  DELIVERY_INITIALIZE: op('op::delivery::initialize'),
};

export const Errors = {
  UNKNOWN_OPCODE: 0xffff,
  UNAUTHORIZED_SENDER: 103,
  WRONG_MAILBOX_VERSION: 100,
  WRONG_DEST_DOMAIN: 101,
  MESSAGE_DELIVERED: 102,
  MESSAGE_VERIFICATION_FAILED: 104,
  UNKNOWN_SUB_OP: 105,
  INSUFFICIENT_GAS_PAYMENT: 106,
  WRONG_SIGNATURE: 107,
  WRONG_VALIDATOR: 110,
  PUBKEY_RECOVERY: 111,
  STORAGE_LOCATION_REPLAY: 112,
  DOMAIN_VALIDATORS_NOT_FOUND: 113,
  MSG_VALUE_TOO_LOW: 114,
  MERKLE_TREE_FULL: 115,
  EXCEEDS_MAX_PROTOCOL_FEE: 116,
  INSUFFICIENT_PROTOCOL_FEE: 117,
};
