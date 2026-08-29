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

// ============ Internal Imports ============
import {AbstractCcipReadIsm} from "./AbstractCcipReadIsm.sol";
import {Message} from "../../libs/Message.sol";
import {Mailbox} from "../../Mailbox.sol";
import {DispatchedHook} from "../../hooks/DispatchedHook.sol";
import {StorageProof} from "../../libs/StateProofHelpers.sol";
import {ISuccinctProofsService} from "../../interfaces/ccip-gateways/ISuccinctProofsService.sol";

/**
 * @title StorageProofIsm
 * @notice Uses a LightClient to verify that a message was delivered via a Hyperlane Mailbox and tracked by DispatchedHook
 */
abstract contract StorageProofIsm is AbstractCcipReadIsm {
    using Message for bytes;

    /// @notice LightClient to read the state root from
    address public lightClient;

    /// @notice Destination Mailbox
    Mailbox public mailbox;

    /// @notice Source DispatchedHook
    DispatchedHook public dispatchedHook;

    /// @notice Slot # of the Source DispatchedHook.dispatched store that will be used to generate a Storage Key.
    uint256 public dispatchedSlot;

    /**
     * @param _mailbox the destination chain Mailbox
     * @param _dispatchedHook the source chain DispatchedHook
     * @param _lightClient the LightClient contract address
     * @param _dispatchedSlot the source chain DispatchedHook slot number of the dispatched mapping
     * @param _offchainUrls urls to make ccip read queries
     */
    function initialize(
        address _mailbox,
        address _dispatchedHook,
        address _lightClient,
        uint256 _dispatchedSlot,
        string[] memory _offchainUrls
    ) external initializer {
        __Ownable_init();
        mailbox = Mailbox(_mailbox);
        dispatchedHook = DispatchedHook(_dispatchedHook);
        lightClient = _lightClient;
        dispatchedSlot = _dispatchedSlot;
        if (_offchainUrls.length > 0) {
            setUrls(_offchainUrls);
        }
    }

    function offchainUrlsLength() external view returns (uint256) {
        return _urls.length;
    }

    function offchainUrls(uint256 index) external view returns (string memory) {
        return _urls[index];
    }

    function setOffchainUrls(string[] memory __urls) external onlyOwner {
        setUrls(__urls);
    }

    /**
     * @notice Verifies that the message id is valid by using state and storage proofs
     * @dev Checks if the DispatchedHook.dispatched contains the messageId on the source chain
     * @param _proofs accountProof and storageProof
     * @param _message Hyperlane encoded interchain message
     * @return True if the message was dispatched by source Mailbox
     */
    function verify(
        bytes calldata _proofs,
        bytes calldata _message
    ) external view virtual override returns (bool) {
        try
            this.getDispatchedValue(
                _proofs,
                dispatchedSlotKey(_message.nonce())
            )
        returns (bytes memory dispatchedMessageId) {
            if (dispatchedMessageId.length == 32) {
                bytes32 storedId;
                assembly {
                    storedId := mload(add(dispatchedMessageId, 32))
                }
                return storedId == _message.id();
            }
            return keccak256(dispatchedMessageId) == _message.id();
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
        bytes[][2] memory proofs = abi.decode(_proofs, (bytes[][2]));
        bytes[] memory accountProof = proofs[0];
        bytes[] memory storageProof = proofs[1];

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
     * @notice Gets the current head state root from LightClient
     */
    function getHeadStateRoot() public view virtual returns (bytes32);

    /**
     * @notice Gets the current head state slot from LightClient
     */
    function getHeadStateSlot() public view virtual returns (uint256);

    /**
     * @notice Calculates storage key of the source chain DispatchedHook.dispatched mapping
     * @param _messageNonce message nonce
     *
     * mapping(uint256 messageNonce => bytes32 messageId)
     */
    function dispatchedSlotKey(
        uint32 _messageNonce
    ) public view returns (bytes32) {
        return keccak256(abi.encode(uint256(_messageNonce), dispatchedSlot));
    }

    /**
     * @inheritdoc AbstractCcipReadIsm
     */
    function _offchainLookupCalldata(
        bytes calldata _message
    ) internal view virtual override returns (bytes memory) {
        return
            abi.encodeWithSelector(
                ISuccinctProofsService.getProofs.selector,
                address(dispatchedHook),
                dispatchedSlotKey(_message.nonce()),
                getHeadStateSlot()
            );
    }

    /**
     * @notice Callback after CCIP read activities are complete.
     * @dev See https://eips.ethereum.org/EIPS/eip-3668 for more information
     * @param _proofs response from CCIP read that will be passed back to verify() through the DispatchedHook
     * @param _message data that will help construct the offchain query
     */
    function process(bytes calldata _proofs, bytes calldata _message) external {
        mailbox.process(_proofs, _message);
    }
}
