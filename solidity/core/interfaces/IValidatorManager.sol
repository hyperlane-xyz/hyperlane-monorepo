// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {BN256} from "../libs/BN256.sol";

interface IValidatorManager {
    function verificationKey(uint32 _domain, bytes32[] calldata _missing)
        external
        view
        returns (BN256.G1Point memory);
}
