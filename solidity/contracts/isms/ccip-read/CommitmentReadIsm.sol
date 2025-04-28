// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {Mailbox} from "../../Mailbox.sol";
import {AbstractCcipReadIsm} from "./AbstractCcipReadIsm.sol";

contract CommitmentReadIsm is AbstractCcipReadIsm {
    string[] public urls;
    Mailbox public immutable mailbox;

    constructor(string[] memory _urls, Mailbox _mailbox) {
        urls = _urls;
        mailbox = _mailbox;
    }

    function getOffchainVerifyInfo(
        bytes calldata _message
    ) external view override {
        revert OffchainLookup({
            sender: address(this),
            urls: urls,
            callData: abi.encodeWithSignature(
                "getCallsFromCommitment(bytes32)",
                _message
            ),
            callbackFunction: this.process.selector,
            extraData: _message
        });
    }

    /// @dev called by the relayer when the off-chain data is ready
    function process(
        bytes calldata _metadata,
        bytes calldata _message
    ) external {
        mailbox.process(_metadata, _message);
    }

    /**
     * @notice Verifies the commitment by comparing the calldata hash to the commitment
     * @param _metadata The calls represented by the commitment
     * @param _message The commitment
     * @return true if the commitment is valid, false otherwise
     */
    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external pure returns (bool) {
        bytes32 commitment = abi.decode(_message, (bytes32));
        bytes32 calldataHash = keccak256(_metadata);

        if (calldataHash == commitment) {
            return true;
        }
        return false;
    }
}
