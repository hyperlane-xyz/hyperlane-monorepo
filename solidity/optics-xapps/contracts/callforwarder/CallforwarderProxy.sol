// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;
import {ICallforwarderProxy} from "../../interfaces/callforwarder/ICallforwarderProxy.sol";

contract CallForwarderProxy is ICallforwarderProxy {
    address public router;
    address public target;
    address public from;
    uint32 public origin;

    constructor(
        address _router,
        address _target,
        address _from,
        uint32 _origin
    ) {
        router = _router;
        target = _target;
        from = _from;
        origin = _origin;
    }

    function callFromRouter(
        address _from,
        uint32 _origin,
        bytes calldata _data
    ) external override returns (bytes memory _ret) {
        require(msg.sender == router, "only router can call");
        require(_from == from, "from address is incorrect");
        require(_origin == origin, "origin is incorrect");
        bool _success;
        (_success, _ret) = target.call(_data);
        // revert if the call failed
        require(_success, "call failed");
    }
}
