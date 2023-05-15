// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IArbitrumMessageHook} from "../interfaces/hooks/IArbitrumMessageHook.sol";
import {ArbitrumISM} from "../isms/native/ArbitrumISM.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

// ============ External Imports ============
import {IInbox} from "@arbitrum/nitro-contracts/src/bridge/IInbox.sol";
import {AddressAliasHelper} from "@arbitrum/nitro-contracts/src/libraries/AddressAliasHelper.sol";

/**
 * @title ArbitrumMessageHook
 * @notice Message hook to inform the Arbitrum ISM of messages published through
 * the native Arbitrum bridge.
 */
contract ArbitrumMessageHook is IArbitrumMessageHook {
    // ============ Constants ============

    // Domain of chain on which the optimism ISM is deployed
    uint32 public immutable destinationDomain;
    // Arbitrum's inbox used to send messages from L1 -> L2
    IInbox public immutable inbox;

    // ============ Public Storage ============

    // Arbitrum ISM to verify messages
    ArbitrumISM public ism;

    // ============ Constructor ============

    constructor(uint32 _destinationDomain, IInbox _inbox) {
        destinationDomain = _destinationDomain;
        inbox = _inbox;
    }

    // ============ External Functions ============

    /**
     * @notice Hook to inform the Arbitrum ISM of messages published through.
     * @notice anyone can call this function, that's why we to send msg.sender
     * @param _destination The destination domain of the message.
     * @param _messageId The message ID.
     * @return gasOverhead The gas overhead for the function call on L2.
     */
    function postDispatch(uint32 _destination, bytes32 _messageId)
        external
        override
        returns (uint256)
    {
        require(
            _destination == destinationDomain,
            "ArbitrumHook: invalid destination domain"
        );
        require(
            address(ism) != address(0),
            "ArbitrumHook: ArbitrumISM not set"
        );

        bytes memory _payload = abi.encodeCall(
            ism.receiveFromHook,
            (_messageId, msg.sender)
        );

        uint256 submissionFee = inbox.calculateRetryableSubmissionFee(
            _payload.length,
            0
        );

        address l2Alias = AddressAliasHelper.applyL1ToL2Alias(msg.sender);

        IInbox(inbox).createRetryableTicket{value: submissionFee}({
            to: address(ism),
            l2CallValue: 0, // no value is transferred to the L2 to
            maxSubmissionCost: submissionFee,
            excessFeeRefundAddress: l2Alias,
            callValueRefundAddress: l2Alias,
            gasLimit: 0,
            maxFeePerGas: 0,
            data: _payload
        });

        return submissionFee;
    }
}
