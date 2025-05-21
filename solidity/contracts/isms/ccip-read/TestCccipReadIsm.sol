// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

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
    constructor(string[] memory _urls) {
        setUrls(_urls);
    }

    function _offchainLookupCalldata(
        bytes calldata /*_message*/
    ) internal pure override returns (bytes memory) {
        return bytes("");
    }

    function verify(
        bytes calldata metadata,
        bytes calldata
    ) external pure override returns (bool) {
        bool ok = abi.decode(metadata, (bool));
        require(ok, "TestCcipReadIsm: invalid metadata");
        return true;
    }
}
