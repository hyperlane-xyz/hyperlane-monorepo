// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.19;

import {IExecutorQuoterRouter} from "../interfaces/wormhole/IExecutor.sol";

/**
 * @title MockExecutorQuoterRouter
 * @notice Deterministic stand-in for the shared Wormhole Executor Quoter
 * Router.
 * @dev Records the last request so tests can assert the exact tuple that was
 * priced and paid for. It never delivers anything; the destination callback is
 * driven explicitly by the test.
 */
contract MockExecutorQuoterRouter is IExecutorQuoterRouter {
    struct Request {
        uint16 dstChain;
        bytes32 dstAddr;
        address refundAddr;
        address quoter;
        bytes requestBytes;
        bytes relayInstructions;
        uint256 value;
    }

    event ExecutionRequested(
        uint16 dstChain,
        bytes32 dstAddr,
        address refundAddr,
        address quoter,
        bytes requestBytes,
        bytes relayInstructions,
        uint256 value
    );

    uint256 public fee;
    bool public quoteReverts;
    bool public requestReverts;
    bytes32 public expectedRelayInstructionsHash;

    Request internal _lastRequest;
    uint256 public requestCount;

    constructor(uint256 fee_) {
        fee = fee_;
    }

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function setQuoteReverts(bool reverts_) external {
        quoteReverts = reverts_;
    }

    function setRequestReverts(bool reverts_) external {
        requestReverts = reverts_;
    }

    function setExpectedRelayInstructions(
        bytes calldata instructions
    ) external {
        expectedRelayInstructionsHash = keccak256(instructions);
    }

    function lastRequest() external view returns (Request memory) {
        return _lastRequest;
    }

    function quoteExecution(
        uint16,
        bytes32,
        address,
        address,
        bytes calldata,
        bytes calldata relayInstructions
    ) external view returns (uint256) {
        require(!quoteReverts, "MockExecutorQuoterRouter: quote reverted");
        require(
            expectedRelayInstructionsHash == bytes32(0) ||
                expectedRelayInstructionsHash == keccak256(relayInstructions),
            "MockExecutorQuoterRouter: unexpected instructions"
        );
        return fee;
    }

    function requestExecution(
        uint16 dstChain,
        bytes32 dstAddr,
        address refundAddr,
        address quoter,
        bytes calldata requestBytes,
        bytes calldata relayInstructions
    ) external payable {
        require(!requestReverts, "MockExecutorQuoterRouter: request reverted");
        require(msg.value == fee, "MockExecutorQuoterRouter: invalid fee");
        require(
            expectedRelayInstructionsHash == bytes32(0) ||
                expectedRelayInstructionsHash == keccak256(relayInstructions),
            "MockExecutorQuoterRouter: unexpected instructions"
        );

        _lastRequest = Request({
            dstChain: dstChain,
            dstAddr: dstAddr,
            refundAddr: refundAddr,
            quoter: quoter,
            requestBytes: requestBytes,
            relayInstructions: relayInstructions,
            value: msg.value
        });
        requestCount += 1;

        emit ExecutionRequested(
            dstChain,
            dstAddr,
            refundAddr,
            quoter,
            requestBytes,
            relayInstructions,
            msg.value
        );
    }
}
