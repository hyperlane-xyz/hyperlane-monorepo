import {keccak256, stringToHex} from "viem";

export const EMPTY_BYTES_32 =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

export const PROPOSER_ROLE: string = keccak256(stringToHex("PROPOSER_ROLE"));
export const EXECUTOR_ROLE: string = keccak256(stringToHex("EXECUTOR_ROLE"));
export const CANCELLER_ROLE: string = keccak256(stringToHex("CANCELLER_ROLE"));
