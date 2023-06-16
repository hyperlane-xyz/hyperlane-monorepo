// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../IInterchainSecurityModule.sol";

interface ICcipReadIsm is IInterchainSecurityModule {
    /**
     * @notice Reverts with the data needed to query information offchain
     * and be submitted via verifyWithProof
     * @dev See https://eips.ethereum.org/EIPS/eip-3668 for more information
     * @param _message data that will help construct the offchain query
     * @return bool Ignored
     */
    function getOffchainVerifyInfo(bytes calldata _message)
        external
        view
        returns (bool);

    /**
     * @notice Function to be called with the result of the offchain read
     * @param response the offchain result
     * @param extraData passthrough obtained from getOffchainVerifyInfo, must remain unchanged
     * @return bool
     */
    function verifyWithProof(bytes calldata response, bytes calldata extraData)
        external
        view
        returns (bool);
}
