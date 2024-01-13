// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {AbstractCcipReadIsm} from "../AbstractCcipReadIsm.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Mailbox} from "../../../Mailbox.sol";
import {LightClient} from "./LightClient.sol";

contract TelepathyCcipReadIsm is
    AbstractCcipReadIsm,
    OwnableUpgradeable,
    LightClient
{
    Mailbox public mailbox;
    string[] public offchainUrls;

    constructor(
        bytes32 genesisValidatorsRoot,
        uint256 genesisTime,
        uint256 secondsPerSlot,
        uint256 slotsPerPeriod,
        uint256 syncCommitteePeriod,
        bytes32 syncCommitteePoseidon,
        uint32 sourceChainId,
        uint16 finalityThreshold,
        bytes32 stepFunctionId,
        bytes32 rotateFunctionId,
        address gatewayAddress
    )
        payable
        LightClient(
            genesisValidatorsRoot,
            genesisTime,
            secondsPerSlot,
            slotsPerPeriod,
            syncCommitteePeriod,
            syncCommitteePoseidon,
            sourceChainId,
            finalityThreshold,
            stepFunctionId,
            rotateFunctionId,
            gatewayAddress
        )
    {}

    function initialize(
        Mailbox _mailbox,
        string[] memory _offchainUrls
    ) external initializer {
        __Ownable_init();
        mailbox = _mailbox;
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
     * @param _proofs accountProof and storageProof from eth_getProof
     * @param _message Hyperlane encoded interchain message
     * @return True if the message was verified
     */
    function verify(
        bytes calldata _proofs,
        bytes calldata _message
    ) external returns (bool) {
        //> Take the accountProof and storageProof from eth_getProof
        (bytes[] memory accountProof, bytes[] memory storageProof) = abi.decode(
            _proofs,
            (bytes[], bytes[])
        );

        //> Take the executionStateRoot from the store
        //> Calculate the storageRoot using accountProof, source Endpoint, executionStateRoot
        //> Get the storageValue of the nonce
        //> Check if it is message.nonce - 1
    }

    /**
     * @notice Reverts with the data needed to query Succinct for header proofs
     * @dev See https://eips.ethereum.org/EIPS/eip-3668 for more information
     * @param _message data that will help construct the offchain query
     */
    function getOffchainVerifyInfo(bytes calldata _message) external view {
        // Todo: In the future, check if fees have been paid before request a proof from Succinct.

        revert OffchainLookup(
            address(this),
            offchainUrls,
            _message,
            TelepathyCcipReadIsm.process.selector,
            _message
        );
    }

    /**
     * @notice Callback after CCIP read activities are complete.
     * This validate and stores the state proof and then calls mailbox to process the message
     * @dev See https://eips.ethereum.org/EIPS/eip-3668 for more information
     * @param _proofs response from CCIP read that will be passed back to verify() through the Mailbox
     * @param _message data that will help construct the offchain query
     */
    function process(bytes calldata _proofs, bytes calldata _message) external {
        // mailbox.process(_metadata, _message);
    }
}
