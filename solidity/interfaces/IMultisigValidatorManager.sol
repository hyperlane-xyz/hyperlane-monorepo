// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.0;

interface IMultisigValidatorManager {
    function domain() external view returns (uint32);

    // The domain hash of the validator set's outbox chain.
    function domainHash() external view returns (bytes32);

    function threshold() external view returns (uint256);
}
