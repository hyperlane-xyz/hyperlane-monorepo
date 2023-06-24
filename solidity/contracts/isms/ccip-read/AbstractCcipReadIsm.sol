// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {ICcipReadIsm} from "../../interfaces/isms/ICcipReadIsm.sol";
import {IMailbox} from "../../interfaces/IMailbox.sol";
import {Message} from "../../libs/Message.sol";
import {AbstractMultisigIsm} from "../multisig/AbstractMultisigIsm.sol";

/// @param sender the address of the contract making the call, usually address(this)
/// @param urls the URLs to query for offchain data
/// @param callData context needed for offchain service to service request
/// @param callbackFunction function selector to call with offchain information
/// @param extraData additional passthrough information to call callbackFunction with
error OffchainLookup(
    address sender,
    string[] urls,
    bytes callData,
    bytes4 callbackFunction,
    bytes extraData
);

/**
 * @title AbstractCcipReadIsm
 * @notice An ISM that allows arbitrary payloads to be submitted and verified on chain.
 */
abstract contract AbstractCcipReadIsm is ICcipReadIsm {
    // ============ Libraries ============

    using Message for bytes;

    // ============ Constants ============

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.CCIP_READ);

    // ============ Mutable Storage ============

    /// @notice The URLs to query for offchain data from.
    string[] public offchainUrls;

    /// @notice Parameters to query for offchain data with.
    bytes public offchainCallData;

    /// @notice Data to pass back to the callback function.
    bytes public offchainExtraData;

    // ============ Events ============

    /**
     * @notice Emitted when the offchain URLs are updated
     * @param urls the new URLs
     */
    event OffchainUrlsUpdated(string[] urls);

    /**
     * @notice Emitted when the offchain callData is updated
     * @param callData the new callData
     */
    event OffchainCallDataUpdated(bytes callData);

    /**
     * @notice Emitted when the offchain extraData is updated
     * @param extraData the new extraData
     */
    event OffchainExtraDataUpdated(bytes extraData);

    // ============ External Functions ============

    /**
     * @notice Reverts with the data needed to query information offchain before
     * mailbox submission
     * @dev See https://eips.ethereum.org/EIPS/eip-3668 for more information
     * @return bool Ignored
     */
    function getOffchainVerifyInfo(bytes calldata)
        external
        view
        returns (bool)
    {
        revert OffchainLookup(
            address(this),
            offchainUrls,
            offchainCallData,
            // Note: consumers of getOffchainVerifyInfo should call the destination
            // chain mailbox.process(_metadata, _message)
            IMailbox.process.selector,
            offchainExtraData
        );
    }
}
