// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

contract MockArbSys {
    event L2ToL1Tx(
        address caller,
        address indexed destination,
        uint256 indexed hash,
        uint256 indexed position,
        uint256 arbBlockNum,
        uint256 ethBlockNum,
        uint256 timestamp,
        uint256 callvalue,
        bytes data
    );

    bool public isAliased;
    address public callerWithoutAliasing;

    function setCallerWithoutAliasing(
        address _caller,
        bool _isAliased
    ) external {
        callerWithoutAliasing = _caller;
        isAliased = _isAliased;
    }

    function wasMyCallersAddressAliased() external view returns (bool) {
        return isAliased;
    }

    function myCallersAddressWithoutAliasing() external view returns (address) {
        return callerWithoutAliasing;
    }

    function sendTxToL1(
        address destination,
        bytes calldata data
    ) external payable returns (uint256) {
        emit L2ToL1Tx(
            msg.sender,
            destination,
            uint256(keccak256(data)),
            42,
            block.number * 10,
            block.number,
            block.timestamp,
            msg.value,
            data
        );
        return 0;
    }
}

contract MockArbitrumInbox {
    uint256 public submissionFee = 0.001 ether;
    uint256 public nextTicketId = 1;

    event InboxMessageDelivered(uint256 indexed messageNum, bytes data);
    event RetryableTicketCreated(uint256 indexed ticketId);

    function setSubmissionFee(uint256 _fee) external {
        submissionFee = _fee;
    }

    function calculateRetryableSubmissionFee(
        uint256 /*dataLength*/,
        uint256 /*baseFee*/
    ) external view returns (uint256) {
        return submissionFee;
    }

    function createRetryableTicket(
        address /*to*/,
        uint256 l2CallValue,
        uint256 maxSubmissionCost,
        address /*excessFeeRefundAddress*/,
        address /*callValueRefundAddress*/,
        uint256 gasLimit,
        uint256 maxFeePerGas,
        bytes calldata data
    ) external payable returns (uint256) {
        require(maxSubmissionCost >= submissionFee, "MockInbox: insufficient submission cost");
        require(
            msg.value >= maxSubmissionCost + l2CallValue + (gasLimit * maxFeePerGas),
            "MockInbox: insufficient value"
        );
        uint256 ticketId = nextTicketId++;
        emit RetryableTicketCreated(ticketId);
        emit InboxMessageDelivered(ticketId, data);
        return ticketId;
    }
}

contract MockArbBridge {
    error BridgeCallFailed();

    address public activeOutbox;
    address public l2ToL1Sender;

    constructor() {
        activeOutbox = address(this);
    }

    function setL2ToL1Sender(address _sender) external {
        l2ToL1Sender = _sender;
    }

    function bridge() external view returns (address) {
        return address(this);
    }

    function executeTransaction(
        bytes32[] calldata /*proof*/,
        uint256 /*index*/,
        address /*l2Sender*/,
        address to,
        uint256 /*l2Block*/,
        uint256 /*l1Block*/,
        uint256 /*timestamp*/,
        uint256 value,
        bytes calldata data
    ) external payable {
        (bool success, bytes memory returndata) = to.call{value: value}(data);
        if (!success) {
            if (returndata.length > 0) {
                // solhint-disable-next-line no-inline-assembly
                assembly {
                    let returndata_size := mload(returndata)
                    revert(add(32, returndata), returndata_size)
                }
            } else {
                revert BridgeCallFailed();
            }
        }
    }
}
