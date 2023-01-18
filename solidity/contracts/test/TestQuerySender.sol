// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainGasPaymaster} from "../../interfaces/IInterchainGasPaymaster.sol";
import {IInterchainQueryRouter} from "../../interfaces/IInterchainQueryRouter.sol";

contract TestQuerySender {
    IInterchainQueryRouter immutable queryRouter;
    IInterchainGasPaymaster immutable interchainGasPaymaster;

    address public lastAddressResult;
    uint256 public lastUint256Result;
    bytes32 public lastBytes32Result;

    event ReceivedAddressResult(address result);
    event ReceivedUint256Result(uint256 result);
    event ReceivedBytes32Result(bytes32 result);

    constructor(address _queryRouterAddress, address _interchainGasPaymaster) {
        queryRouter = IInterchainQueryRouter(_queryRouterAddress);
        interchainGasPaymaster = IInterchainGasPaymaster(
            _interchainGasPaymaster
        );
    }

    function queryAddress(
        uint32 _destinationDomain,
        address _target,
        bytes calldata _targetData,
        uint256 _gasAmount
    ) external payable {
        bytes32 _messageId = queryRouter.query(
            _destinationDomain,
            _target,
            _targetData,
            abi.encodePacked(this.handleQueryAddressResult.selector)
        );
        _payForGas(_messageId, _destinationDomain, _gasAmount);
    }

    function handleQueryAddressResult(address _result) external {
        emit ReceivedAddressResult(_result);
        lastAddressResult = _result;
    }

    function queryUint256(
        uint32 _destinationDomain,
        address _target,
        bytes calldata _targetData,
        uint256 _gasAmount
    ) external payable {
        bytes32 _messageId = queryRouter.query(
            _destinationDomain,
            _target,
            _targetData,
            abi.encodePacked(this.handleQueryUint256Result.selector)
        );
        _payForGas(_messageId, _destinationDomain, _gasAmount);
    }

    function handleQueryUint256Result(uint256 _result) external {
        emit ReceivedUint256Result(_result);
        lastUint256Result = _result;
    }

    function queryBytes32(
        uint32 _destinationDomain,
        address _target,
        bytes calldata _targetData,
        uint256 _gasAmount
    ) external payable {
        bytes32 _messageId = queryRouter.query(
            _destinationDomain,
            _target,
            _targetData,
            abi.encodePacked(this.handleQueryBytes32Result.selector)
        );
        _payForGas(_messageId, _destinationDomain, _gasAmount);
    }

    function handleQueryBytes32Result(bytes32 _result) external {
        emit ReceivedBytes32Result(_result);
        lastBytes32Result = _result;
    }

    function _payForGas(
        bytes32 _messageId,
        uint32 _destinationDomain,
        uint256 _gasAmount
    ) internal {
        interchainGasPaymaster.payForGas{value: msg.value}(
            _messageId,
            _destinationDomain,
            _gasAmount,
            msg.sender
        );
    }
}
