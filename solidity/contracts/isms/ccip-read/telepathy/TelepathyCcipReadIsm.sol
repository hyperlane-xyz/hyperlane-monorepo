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
import {ILightClient} from "../../../interfaces/ccip-gateways/ILightClient.sol";

// ============ Internal Imports ============

import {AbstractCcipReadIsm} from "../AbstractCcipReadIsm.sol";
import {Message} from "../../../libs/Message.sol";
import {Mailbox} from "../../../Mailbox.sol";
import {TelepathyCcipReadHook} from "../../../hooks/ccip/TelepathyCcipReadHook.sol";
import {StorageProof} from "../../../libs/StateProofHelpers.sol";
import {ISuccinctProofsService} from "../../../interfaces/ccip-gateways/ISuccinctProofsService.sol";

/**
 * @title TelepathyCcipReadIsm
 * @notice Uses Succinct to verify that a message was delivered via a Hyperlane Mailbox and tracked by TelepathyCcipReadHook
 */
contract TelepathyCcipReadIsm is AbstractCcipReadIsm, OwnableUpgradeable {
    using Message for bytes;

    /// @notice LightClient to read the state root from
    ILightClient public lightClient;

    /// @notice Source Mailbox that will dispatch a message
    Mailbox public sourceMailbox;

    /// @notice Destination Mailbox
    Mailbox public destinationMailbox;

    /// @notice Source TelepathyCcipReadHook
    TelepathyCcipReadHook public telepathyCcipReadHook;

    /// @notice Slot # of the Source TelepathyCcipReadHook.dispatched store that will be used to generate a Storage Key. The resulting Key will be passed into eth_getProof
    uint256 public dispatchedSlot;

    /// @notice Array of Gateway URLs that the Relayer will call to fetch proofs
    string[] public offchainUrls;

    /**
     * @param _sourceMailbox the source chain Mailbox
     * @param _destinationMailbox the destination chain Mailbox
     * @param _telepathyCcipReadHook the source chain TelepathyCcipReadHook
     * @param _dispatchedSlot the source chain TelepathyCcipReadHook slot number of the dispatched mapping
     * @param _offchainUrls urls to make ccip read queries
     */
    function initialize(
        Mailbox _sourceMailbox,
        Mailbox _destinationMailbox,
        TelepathyCcipReadHook _telepathyCcipReadHook,
        address _lightClient,
        uint256 _dispatchedSlot,
        string[] memory _offchainUrls
    ) external initializer {
        __Ownable_init();
        sourceMailbox = _sourceMailbox;
        destinationMailbox = _destinationMailbox;
        telepathyCcipReadHook = _telepathyCcipReadHook;
        lightClient = ILightClient(_lightClient);
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
     * @dev Basically, this checks if the TelepathyCcipReadHook.dispatched has messageId set on the source chain
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
     * @notice Gets the slot value of TelepathyCcipReadHook.dispatched mapping given a slot key and proofs
     * @param _proofs encoded account proof and storage proof
     * @param _dispatchedSlotKey hash of the source chain TelepathyCcipReadHook slot number to do a storage proof for
     * @return byte value of the dispatched[sourceMailbox][nonce]
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

        // Get the storage root of TelepathyCcipReadHook
        bytes32 storageRoot = StorageProof.getStorageRoot(
            address(telepathyCcipReadHook),
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
    function getHeadStateRoot() internal view returns (bytes32) {
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
                address(telepathyCcipReadHook),
                dispatchedSlotKey(_message.nonce())
                //messageId
            ),
            TelepathyCcipReadIsm.process.selector,
            _message
        );
    }

    /**
     * @notice Creates a single storage key of the source chain TelepathyCcipReadHook.dispatched mapping
     * @param _messageNonce message nonce
     *
     * mapping(address mailbox => mapping(uint256 messageNonce => messageId))
     */
    function dispatchedSlotKey(
        uint32 _messageNonce
    ) public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    _messageNonce,
                    keccak256(
                        abi.encode(address(sourceMailbox), dispatchedSlot)
                    )
                )
            );
    }

    /**
     * @notice Callback after CCIP read activities are complete.
     * This validate and stores the state proof and then calls TelepathyCcipReadHook to process the message
     * @dev See https://eips.ethereum.org/EIPS/eip-3668 for more information
     * @param _proofs response from CCIP read that will be passed back to verify() through the TelepathyCcipReadHook
     * @param _message data that will help construct the offchain query
     */
    function process(bytes calldata _proofs, bytes calldata _message) external {
        destinationMailbox.process(_proofs, _message);
    }
}
