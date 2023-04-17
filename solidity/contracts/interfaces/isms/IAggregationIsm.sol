// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {IInterchainSecurityModule} from "../IInterchainSecurityModule.sol";

interface IAggregationIsm is IInterchainSecurityModule {
    /**
     * @notice Returns the set of modules responsible for verifying _message
     * and the number of modules that must verify
     * @dev Can change based on the content of _message
     * @param _message Hyperlane formatted interchain message
     * @return modules The array of ISM addresses
     * @return threshold The number of modules needed to verify
     */
    function modulesAndThreshold(bytes calldata _message)
        external
        view
        returns (address[] memory modules, uint8 threshold);
}
