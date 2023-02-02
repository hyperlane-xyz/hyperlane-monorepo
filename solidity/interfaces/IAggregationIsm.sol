// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.0;

import {IInterchainSecurityModule} from "./IInterchainSecurityModule.sol";

interface IAggregationIsm is IInterchainSecurityModule {
    /**
     * @notice Returns the set of ISMs responsible for verifying _message
     * @dev Can change based on the content of _message
     * @param _message Hyperlane formatted interchain message
     * @return The array of ISM addresses
     */
    function isms(bytes calldata _message)
        external
        view
        returns (IInterchainSecurityModule[] memory);
}
