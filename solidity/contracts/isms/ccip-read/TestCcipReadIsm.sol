// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

error OffchainLookup(
    address sender,
    string[] urls,
    bytes callData,
    bytes4 callbackFunction,
    bytes extraData
);

import "../../interfaces/isms/ICcipReadIsm.sol";
import "../../interfaces/IInterchainSecurityModule.sol";
import "../../interfaces/IMailbox.sol";
import "../../libs/Message.sol";
import "./AbstractCcipReadIsm.sol";

/**
 * @title TestCcipReadIsm
 * @notice A test CCIP-Read ISM that simply checks the passed metadata as a boolean.
 */
contract TestCcipReadIsm is AbstractCcipReadIsm {
    string[] public urls;
    bytes calldataToReturn = bytes("callDataToReturn");

    constructor(string[] memory _urls) {
        urls = _urls;
    }

    function getOffchainVerifyInfo(
        bytes calldata _message
    ) external view override {
        // Revert with OffchainLookup to instruct off-chain resolution
        revert OffchainLookup(
            address(this),
            urls,
            calldataToReturn,
            bytes4(0),
            ""
        );
    }

    function verify(
        bytes calldata metadata,
        bytes calldata
    ) external view override returns (bool) {
        bool ok = abi.decode(metadata, (bool));
        require(ok, "TestCcipReadIsm: invalid metadata");
        return true;
    }
}
