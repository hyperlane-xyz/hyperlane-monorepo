// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

interface IValidatorManager {
    function isValidatorSignature(
        uint32 _domain,
        bytes32 _root,
        uint256 _index,
        bytes memory _signature
    ) external view returns (bool);
}
