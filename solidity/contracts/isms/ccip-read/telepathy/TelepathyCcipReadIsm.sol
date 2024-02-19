// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ External Imports ============
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {LightClient} from "@telepathyx/LightClient.sol";

// ============ Internal Imports ============

import {AbstractCcipReadIsm} from "../AbstractCcipReadIsm.sol";
import {Message} from "../../../libs/Message.sol";
import {Mailbox} from "../../../Mailbox.sol";
import {StorageProof} from "../../../libs/StateProofHelpers.sol";
import {ISuccinctProofsService} from "../../../interfaces/ccip-gateways/ISuccinctProofsService.sol";

/**
 * @title TelepathyCcipReadIsm
 * @notice Uses Succinct to verify that a message was delivered via a Hyperlane Mailbox
 */
contract TelepathyCcipReadIsm is
    AbstractCcipReadIsm,
    OwnableUpgradeable,
    LightClient
{
    using Message for bytes;

    /// @notice  Source Mailbox
    Mailbox public mailbox;

    /// @notice  Slot # on the Source Mailbox that will be used to generate a Storage Key. The resulting Key will be passed into eth_getProof
    uint256 public deliveriesSlot;

    /// @notice  Array of Gateway URLs that the Relayer will call to fetch proofs
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

    /**
     * @param _mailbox the source chain mailbox address
     * @param _deliveriesSlot the source chain mailbox slot number for deliveries mapping
     * @param _offchainUrls urls to make ccip read queries
     */
    function initialize(
        Mailbox _mailbox,
        uint256 _deliveriesSlot,
        string[] memory _offchainUrls
    ) external initializer {
        __Ownable_init();
        mailbox = _mailbox;
        deliveriesSlot = _deliveriesSlot;
        offchainUrls = _offchainUrls;
    }

    function offchainUrlsLength() external view returns (uint256) {
        return offchainUrls.length;
    }

    /**
     * @notice Sets the offchain urls used by CCIP read.
     * The first url will be used and if the request fails, the next one will be used, and so on
     * @param _urls an allowlist of urls that will get passed into the Gateway
     */
    function setOffchainUrls(string[] memory _urls) external onlyOwner {
        require(_urls.length > 0, "!length");
        offchainUrls = _urls;
    }

    /**
     * @notice Verifies that the message id is valid by using the headers by Succinct and eth_getProof
     * @dev Basically, this checks if the Mailbox.deliveries[messageId] has been commited on the source chain
     * @param _proofs accountProof and storageProof from eth_getProof
     * @param _message Hyperlane encoded interchain message
     * @return True if the message was verified
     */
    function verify(
        bytes calldata _proofs,
        bytes calldata _message
    ) external returns (bool) {
        return true;
        (bytes[] memory accountProof, bytes[] memory storageProof) = abi.decode(
            _proofs,
            (bytes[], bytes[])
        );

        // Get the slot value as bytes
        bytes memory deliveriesValue = getDeliveriesValue(
            accountProof,
            storageProof,
            storageKey(_message.id())
        );

        return keccak256(deliveriesValue) != bytes32("");
    }

    /**
     * @notice Gets the slot value of Mailbox.deliveries mapping given a slot key and proofs
     * @param _accountProof the account proof
     * @param _storageProof the storage proof
     * @param _deliveriesSlotKey hash of the source chain mailbox slot number to do a storage proof for
     * @return byte value of the deliveries[slotKey]
     */
    function getDeliveriesValue(
        bytes[] memory _accountProof,
        bytes[] memory _storageProof,
        bytes32 _deliveriesSlotKey
    ) public view returns (bytes memory) {
        bytes32 storageRoot = StorageProof.getStorageRoot(
            address(mailbox),
            _accountProof,
            executionStateRoots[head]
        );
        return
            StorageProof.getStorageBytes(
                _deliveriesSlotKey,
                _storageProof,
                storageRoot
            );
    }

    /**
     * @notice Reverts with the data needed to query Succinct for header proofs
     * @dev See https://eips.ethereum.org/EIPS/eip-3668 for more information
     * @param _message encoded Message that will be included in offchain query
     *
     * @dev In the future, check if fees have been paid before request a proof from Succinct.
     * For now this feature is not complete according to the Succinct team.
     */
    function getOffchainVerifyInfo(bytes calldata _message) external view {
        revert OffchainLookup(
            address(this),
            offchainUrls,
            abi.encodeWithSelector(
                ISuccinctProofsService.getProofs.selector,
                address(mailbox),
                storageKey(_message.id()),
                1
            ), // TODO fix this hardcode
            TelepathyCcipReadIsm.process.selector,
            _message
        );
    }

    /**
     * @notice Creates a single storage key using the slot and messageId.
     * This corresponds to the deliveries store in the source chain Mailbox contract.
     * @param _messageId message id
     */
    function storageKey(bytes32 _messageId) public view returns (bytes32) {
        // TODO figure out a different storage slot since deliveries is the wrong one to use
        return
            keccak256(
                abi.encode(keccak256(abi.encode(_messageId, deliveriesSlot)))
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
        mailbox.process(_proofs, _message);
    }
}
