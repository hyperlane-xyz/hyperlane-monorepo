// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {ICcipReadIsm} from "../../interfaces/isms/ICcipReadIsm.sol";
import {Message} from "../../libs/Message.sol";
import {AbstractMultisigIsm} from "../multisig/AbstractMultisigIsm.sol";
import {CcipReadIsmMetadata} from "../../libs/isms/CcipReadIsmMetadata.sol";

/// @param sender the address of the contract making the call, usually address(this)
/// @param urls the URLs to query for offchain data
/// @param callData context needed for offchain service to service request
/// @param callbackFunction function selector to call with offchain information, verify in this case
/// @param extraData e
error OffchainLookup(
    address sender,
    string[] urls,
    bytes callData,
    bytes4 callbackFunction,
    bytes extraData
);

/**
 * @title CcipReadIsm
 * @notice Manages an ownable set of validators that ECDSA sign checkpoints to
 * reach a quorum.
 */
abstract contract AbstractCcipReadIsm is ICcipReadIsm, AbstractMultisigIsm {
    // ============ Libraries ============

    using Message for bytes;
    using CcipReadIsmMetadata for bytes;

    // ============ Constants ============

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.CCIP_READ);

    // ============ Mutable Storage ============

    string[] public offchainUrls;
    bytes public extraData;
    bytes public offchainCallData;

    // ============ External Functions ============

    function ccipRead(bytes calldata message) external view returns (bool) {
        revert OffchainLookup(
            address(this),
            offchainUrls,
            offchainCallData,
            AbstractCcipReadIsm.ccipReadCallback.selector,
            extraData
        );
        return true;
    }

    function ccipReadCallback(bytes calldata response, bytes calldata extraData)
        external
        view
        returns (bool)
    {
        // TODO: magic numbers
        uint256 metadataOffset = uint256(bytes32(response[0:32]));
        uint256 messageOffset = uint256(bytes32(response[33:64]));

        return
            verify(
                response[metadataOffset:messageOffset],
                response[messageOffset:]
            );
    }

    // ============ Public Functions ============

    /**
     * @notice Returns the signature at a given index from the metadata.
     * @param _metadata ABI encoded module metadata
     * @param _index The index of the signature to return
     * @return signature Packed encoding of signature (65 bytes)
     */
    function signatureAt(bytes calldata _metadata, uint256 _index)
        internal
        pure
        virtual
        override
        returns (bytes memory)
    {
        return CcipReadIsmMetadata.signatureAt(_metadata, _index);
    }

    // ============ Internal Functions ============

    /**
     * @notice Returns the digest to be used for signature verification.
     * @param _metadata ABI encoded module metadata
     * @param _message Formatted Hyperlane message (see Message.sol).
     * @return digest The digest to be signed by validators
     */
    function digest(bytes calldata _metadata, bytes calldata _message)
        internal
        view
        override
        returns (bytes32)
    {
        return keccak256(_message.body());
    }
}
