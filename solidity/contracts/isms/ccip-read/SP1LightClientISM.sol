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
import {ISP1LightClient} from "../../interfaces/ISP1LightClient.sol";

// ============ Internal Imports ============

import {AbstractCcipReadIsm} from "./AbstractCcipReadIsm.sol";
import {Message} from "../../libs/Message.sol";
import {Mailbox} from "../../Mailbox.sol";
import {DispatchedHook} from "../../hooks/DispatchedHook.sol";
import {StorageProof} from "../../libs/StateProofHelpers.sol";
import {ISuccinctProofsService} from "../../interfaces/ccip-gateways/ISuccinctProofsService.sol";

/**
 * @title SP1LightClientIsm
 * @notice Uses Succinct to verify that a message was delivered via a Hyperlane Mailbox and tracked by DispatchedHook
 */
contract SP1LightClientIsm is AbstractCcipReadIsm, OwnableUpgradeable {
    using Message for bytes;

    /// @notice LightClient to read the state root from
    ISP1LightClient public lightClient;

    /// @notice Destination Mailbox
    Mailbox public destinationMailbox;

    /// @notice Source DispatchedHook
    DispatchedHook public dispatchedHook;

    /// @notice Slot # of the Source DispatchedHook.dispatched store that will be used to generate a Storage Key. The resulting Key will be passed into eth_getProof
    uint256 public dispatchedSlot;

    /// @notice Array of Gateway URLs that the Relayer will call to fetch proofs
    string[] public offchainUrls;

    /**
     * @param _destinationMailbox the destination chain Mailbox
     * @param _dispatchedHook the source chain DispatchedHook
     * @param _dispatchedSlot the source chain DispatchedHook slot number of the dispatched mapping
     * @param _offchainUrls urls to make ccip read queries
     */
    function initialize(
        address _destinationMailbox,
        address _dispatchedHook,
        address _lightClient,
        uint256 _dispatchedSlot,
        string[] memory _offchainUrls
    ) external initializer {
        __Ownable_init();
        destinationMailbox = Mailbox(_destinationMailbox);
        dispatchedHook = DispatchedHook(_dispatchedHook);
        lightClient = ISP1LightClient(_lightClient);
        dispatchedSlot = _dispatchedSlot;
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
     * @dev Basically, this checks if the DispatchedHook.dispatched has messageId set on the source chain
     * @param _proofs accountProof and storageProof from eth_getProof
     * @param _message Hyperlane encoded interchain message
     * @return True if the message was dispatched by source Mailbox
     */
    function verify(
        bytes calldata _proofs,
        bytes calldata _message
    ) external view returns (bool) {
        try
            this.getDispatchedValue(
                _proofs,
                dispatchedSlotKey(_message.nonce())
            )
        returns (bytes memory dispatchedMessageId) {
            return keccak256(dispatchedMessageId) != _message.id();
        } catch {
            return false;
        }
    }

    /**
     * @notice Gets the slot value of DispatchedHook.dispatched mapping given a slot key and proofs
     * @param _proofs encoded account proof and storage proof
     * @param _dispatchedSlotKey hash of the source chain DispatchedHook slot number to do a storage proof for
     * @return byte value of the dispatched[nonce]
     */
    function getDispatchedValue(
        bytes calldata _proofs,
        bytes32 _dispatchedSlotKey
    ) public view returns (bytes memory) {
        // Get the slot value as bytes
        (bytes[] memory accountProof, bytes[] memory storageProof) = abi.decode(
            _proofs,
            (bytes[], bytes[])
        );

        // Get the storage root of DispatchedHook
        bytes32 storageRoot = StorageProof.getStorageRoot(
            address(dispatchedHook),
            accountProof,
            getHeadStateRoot()
        );
        // Returns the value of dispatched
        return
            StorageProof.getStorageBytes(
                keccak256(abi.encode(_dispatchedSlotKey)),
                storageProof,
                storageRoot
            );
    }

    /**
     * @notice Gets the current head state root from Succinct LightClient
     */
    function getHeadStateRoot() public view returns (bytes32) {
        return lightClient.executionStateRoots(lightClient.head());
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
                address(dispatchedHook),
                dispatchedSlotKey(_message.nonce()),
                getHeadStateRoot()
            ),
            SP1LightClientIsm.process.selector,
            _message
        );
    }

    /**
     * @notice Calculates storage key of the source chain DispatchedHook.dispatched mapping
     * @param _messageNonce message nonce
     *
     * mapping(uint256 messageNonce => messageId)
     */
    function dispatchedSlotKey(
        uint32 _messageNonce
    ) public view returns (bytes32) {
        return keccak256(abi.encode(_messageNonce, dispatchedSlot));
    }

    /**
     * @notice Callback after CCIP read activities are complete.
     * @dev See https://eips.ethereum.org/EIPS/eip-3668 for more information
     * @param _proofs response from CCIP read that will be passed back to verify() through the DispatchedHook
     * @param _message data that will help construct the offchain query
     */
    function process(bytes calldata _proofs, bytes calldata _message) external {
        destinationMailbox.process(_proofs, _message);
    }
}
