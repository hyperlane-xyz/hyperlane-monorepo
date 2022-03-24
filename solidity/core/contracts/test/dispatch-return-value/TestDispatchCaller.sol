// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// In solidity, only account for the non-return value dispatch
interface ITestDispatcher {
    function dispatch(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        bytes memory _messageBody
    ) external;
}

contract TestDispatchCaller {
    ITestDispatcher public dispatcher;

    constructor(ITestDispatcher _dispatcher) {
        dispatcher = _dispatcher;
    }

    function callDispatch(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        bytes memory _messageBody
    ) external {
        dispatcher.dispatch(
            _destinationDomain,
            _recipientAddress,
            _messageBody
        );
    }

    function setDispatcher(ITestDispatcher _newDispatcher) external {
        dispatcher = _newDispatcher;
    }
}
