// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {AbstractCcipReadIsm} from "./AbstractCcipReadIsm.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

contract TelepathyCcipReadIsm is AbstractCcipReadIsm, OwnableUpgradeable {
    string[] public offchainUrls;

    function initialize(string[] memory _offchainUrls) external initializer {
        __Ownable_init();
        offchainUrls = _offchainUrls;
    }

    function offchainUrlsLength() external view returns (uint256) {
        return offchainUrls.length;
    }

    /**
     * @notice Defines a security model responsible for verifying interchain
     * messages based on the provided metadata.
     * the security model encoded by the module (e.g. validator signatures)
     * @param _urls an allowlist of urls that will get passed into the Gateway
     */
    function setOffchainUrls(string[] memory _urls) external onlyOwner {
        require(_urls.length > 0, "!length");
        offchainUrls = _urls;
    }

    /**
     * @notice Defines a security model responsible for verifying interchain
     * messages based on the provided metadata.
     * @param _metadata Off-chain metadata provided by a relayer, specific to
     * the security model encoded by the module (e.g. validator signatures)
     * @param _message Hyperlane encoded interchain message
     * @return True if the message was verified
     */
    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external returns (bool) {
        //> Take the accountProof and storageProof from eth_getProof
        //> Take the executionStateRoot from the store
        //> Calculate the storageRoot using accountProof, source Endpoint, executionStateRoot
        //> Get the storageValue of the nonce
        //> Check if it is message.nonce - 1
    }

    /**
     * @notice Reverts with the data needed to query information offchain
     * and be submitted via the origin mailbox. The callback is always process()
     * @dev See https://eips.ethereum.org/EIPS/eip-3668 for more information
     * @param _message data that will help construct the offchain query
     */
    function getOffchainVerifyInfo(bytes calldata _message) external view {
        revert OffchainLookup(
            address(this),
            offchainUrls,
            _message,
            TelepathyCcipReadIsm.process.selector,
            _message
        );
    }

    /**
     * @notice Callback after CCIP read activities are complete. This validate and stores the state proof
     * and then calls mailbox to process the message
     * @dev See https://eips.ethereum.org/EIPS/eip-3668 for more information
     * @param _message data that will help construct the offchain query
     */
    function process(
        bytes calldata _metadata,
        bytes calldata _message
    ) external {
        //> Send a request to eth_getProof
        // mailbox.process(_metadata, _message);
    }
}
