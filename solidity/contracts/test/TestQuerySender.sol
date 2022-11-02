// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Call, IInterchainQueryRouter} from "../../interfaces/IInterchainQueryRouter.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

contract TestQuerySender is Initializable {
    IInterchainQueryRouter queryRouter;

    address public lastAddressResult;
    uint256 public lastUint256Result;
    bytes32 public lastBytes32Result;

    event ReceivedAddressResult(address result);
    event ReceivedUint256Result(uint256 result);
    event ReceivedBytes32Result(bytes32 result);

    function initialize(address _queryRouterAddress) public initializer {
        queryRouter = IInterchainQueryRouter(_queryRouterAddress);
    }

    function queryAddress(
        uint32 _destinationDomain,
        address _target,
        bytes calldata _targetData
    ) public {
        queryRouter.query(
            _destinationDomain,
            Call({to: _target, data: _targetData}),
            abi.encodePacked(this.handleQueryAddressResult.selector)
        );
    }

    function handleQueryAddressResult(address _result) public {
        emit ReceivedAddressResult(_result);
        lastAddressResult = _result;
    }

    function queryUint256(
        uint32 _destinationDomain,
        address _target,
        bytes calldata _targetData
    ) public {
        queryRouter.query(
            _destinationDomain,
            Call({to: _target, data: _targetData}),
            abi.encodePacked(this.handleQueryUint256Result.selector)
        );
    }

    function handleQueryUint256Result(uint256 _result) public {
        emit ReceivedUint256Result(_result);
        lastUint256Result = _result;
    }

    function queryBytes32(
        uint32 _destinationDomain,
        address _target,
        bytes calldata _targetData
    ) public {
        queryRouter.query(
            _destinationDomain,
            Call({to: _target, data: _targetData}),
            abi.encodePacked(this.handleQueryBytes32Result.selector)
        );
    }

    function handleQueryBytes32Result(bytes32 _result) public {
        emit ReceivedBytes32Result(_result);
        lastBytes32Result = _result;
    }
}
