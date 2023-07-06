// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../IInterchainSecurityModule.sol";

interface ICcipReadIsm is IInterchainSecurityModule {
    /// @dev https://eips.ethereum.org/EIPS/eip-3668
    /// @param sender the address of the contract making the call, usually address(this)
    /// @param urls the URLs to query for offchain data
    /// @param callData context needed for offchain service to service request
    /// @param callbackFunction function selector to call with offchain information
    /// @param extraData additional passthrough information to call callbackFunction with
    error OffchainLookup(
        address sender,
        string[] urls,
        bytes callData,
        bytes4 callbackFunction,
        bytes extraData
    );

    /**
     * @notice Reverts with the data needed to query information offchain
     * and be submitted via the origin mailbox
     * @dev See https://eips.ethereum.org/EIPS/eip-3668 for more information
     * @param _message data that will help construct the offchain query
     */
    function getOffchainVerifyInfo(bytes calldata _message) external view;
}
