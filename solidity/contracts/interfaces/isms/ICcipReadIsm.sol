// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../IInterchainSecurityModule.sol";

interface ICcipReadIsm is IInterchainSecurityModule {
    /**
     * @notice Reverts with the data needed to query information offchain
     * and be submitted via the origin mailbox
     * @dev See https://eips.ethereum.org/EIPS/eip-3668 for more information
     * @param _message data that will help construct the offchain query
     */
    function getOffchainVerifyInfo(bytes calldata _message) external view;
}
