// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {BN256} from "../libs/BN256.sol";

interface IMailbox {
    // ============ Structs ============
    struct Checkpoint {
        bytes32 root;
        uint256 index;
    }

    struct Signature {
        uint256 sig;
        uint256 randomness;
        BN256.G1Point nonce;
        bytes32[] missing;
    }

    function localDomain() external view returns (uint32);
}
