// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {ArbRetryableTx} from "@arbitrum/nitro-contracts/src/precompiles/ArbRetryableTx.sol";
import {Lib_RLPWriter} from "@eth-optimism/contracts/libraries/rlp/Lib_RLPWriter.sol";

contract MockArbRetryableTx is ArbRetryableTx {
    struct RetryableTicket {
        uint256 destinationChainId;
        uint256 msgNum;
        address fromAddress;
        uint256 l1BaseFee;
        uint256 l1CallValue;
        uint256 maxFeePerGas;
        uint256 gasLimit;
        address destinationAddress;
        uint256 l2CallValue;
        address callValueRefundAddress;
        uint256 maxSubmissionCost;
        address excessFeeRefundAddress;
        bytes data;
    }

    RetryableTicket[] public tickets;

    // submission to L1 out of scope => static L1 base fee ~25 gwei
    uint256 internal _l1BaseFee = 25e9;

    uint256 internal constant DEFAULT_GAS_LIMIT = 25000;

    // 7 days
    uint256 lifetime = 7 * 24 * 60 * 60;

    function mockUnsafeCreateRetryableTicket(
        address to,
        uint256 l2CallValue,
        uint256 maxSubmissionCost,
        address excessFeeRefundAddress,
        address callValueRefundAddress,
        uint256 gasLimit,
        uint256 maxFeePerGas,
        bytes calldata data
    ) external payable {
        // payable send value
        tickets.push();

        {
            tickets[tickets.length - 1] = RetryableTicket({
                destinationChainId: 42161,
                msgNum: 0,
                fromAddress: msg.sender,
                l1BaseFee: _l1BaseFee,
                l1CallValue: msg.value,
                maxFeePerGas: maxFeePerGas,
                gasLimit: gasLimit,
                destinationAddress: to,
                l2CallValue: l2CallValue,
                callValueRefundAddress: callValueRefundAddress,
                maxSubmissionCost: maxSubmissionCost,
                excessFeeRefundAddress: excessFeeRefundAddress,
                data: data
            });
        }
    }

    function redeem(bytes32 ticketId) external returns (bytes32) {
        for (uint256 i = tickets.length - 1; i >= 0; i--) {
            if (getTicketId(i) == ticketId) {
                RetryableTicket memory ticket = tickets[i];

                // spent gas
                (bool success, ) = address(0).call{gas: DEFAULT_GAS_LIMIT}("");
                require(success, "Gas spent exceeded");

                if (DEFAULT_GAS_LIMIT > ticket.gasLimit)
                    revert("L2 gas limit exceeded");

                // execute ticket
                (success, ) = ticket.destinationAddress.call(ticket.data);
                require(success, "L2 call failed");

                // refund excess fee
                (success, ) = ticket.excessFeeRefundAddress.call{
                    value: ticket.gasLimit - DEFAULT_GAS_LIMIT
                }("");
                (success, ) = ticket.callValueRefundAddress.call{
                    value: ticket.l2CallValue
                }("");

                delete tickets[i];

                return ticketId;
            }
        }
        // demo
        return ticketId;
    }

    function encodeTicket(RetryableTicket memory ticket)
        internal
        pure
        returns (bytes memory)
    {
        bytes[] memory encodedFields = new bytes[](13);
        encodedFields[0] = Lib_RLPWriter.writeUint(ticket.destinationChainId);
        encodedFields[1] = Lib_RLPWriter.writeUint(ticket.msgNum);
        encodedFields[2] = Lib_RLPWriter.writeAddress(ticket.fromAddress);
        encodedFields[3] = Lib_RLPWriter.writeUint(ticket.l1BaseFee);
        encodedFields[4] = Lib_RLPWriter.writeUint(ticket.l1CallValue);
        encodedFields[5] = Lib_RLPWriter.writeUint(ticket.maxFeePerGas);
        encodedFields[6] = Lib_RLPWriter.writeUint(ticket.gasLimit);
        encodedFields[7] = Lib_RLPWriter.writeAddress(
            ticket.destinationAddress
        );
        encodedFields[8] = Lib_RLPWriter.writeUint(ticket.l2CallValue);
        encodedFields[9] = Lib_RLPWriter.writeAddress(
            ticket.callValueRefundAddress
        );
        encodedFields[10] = Lib_RLPWriter.writeUint(ticket.maxSubmissionCost);
        encodedFields[11] = Lib_RLPWriter.writeAddress(
            ticket.excessFeeRefundAddress
        );
        encodedFields[12] = ticket.data;

        bytes memory encodedTicket = Lib_RLPWriter.writeList(encodedFields);
        return Lib_RLPWriter.writeBytes(encodedTicket);
    }

    function getTicketId(uint256 index) public view returns (bytes32) {
        RetryableTicket memory ticket = tickets[index];
        bytes memory encodedTicket = encodeTicket(ticket);

        return keccak256(encodedTicket);
    }

    function getLifetime() external view returns (uint256) {
        return lifetime;
    }

    function getTimeout(
        bytes32 /*ticketId*/
    ) external pure returns (uint256) {
        return 0;
    }

    function keepalive(
        bytes32 /*ticketId*/
    ) external pure returns (uint256) {
        return 0;
    }

    function getBeneficiary(
        bytes32 /*ticketId*/
    ) external pure returns (address) {
        return address(0);
    }

    function cancel(
        bytes32 /*ticketId*/
    ) external {}

    function getCurrentRedeemer() external pure returns (address) {
        return address(0);
    }

    function submitRetryable(
        bytes32 requestId,
        uint256 l1BaseFee,
        uint256 deposit,
        uint256 callvalue,
        uint256 gasFeeCap,
        uint64 gasLimit,
        uint256 maxSubmissionFee,
        address feeRefundAddress,
        address beneficiary,
        address retryTo,
        bytes calldata retryData
    ) external {
        // pass - deprecated
    }
}
