// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {AmountPartition} from "../../token/libs/AmountPartition.sol";
import {AbstractRoutingIsm} from "../routing/AbstractRoutingIsm.sol";

/**
 * @title AmountRoutingIsm
 */
contract AmountRoutingIsm is AmountPartition, AbstractRoutingIsm {
    constructor(
        address _lowerIsm,
        address _upperIsm,
        uint256 _threshold
    ) AmountPartition(_lowerIsm, _upperIsm, _threshold) {}

    // ============ Public Functions ============
    /**
     * @notice Returns the ISM responsible for verifying _message
     * @dev Routes to upperISM ISM if amount > threshold, otherwise lowerISM ISM.
     * @param _message Formatted Hyperlane message (see Message.sol).
     * @return module The ISM to use to verify _message
     */
    function route(
        bytes calldata _message
    ) public view override returns (IInterchainSecurityModule) {
        return IInterchainSecurityModule(_partition(_message));
    }
}
