// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ISovereignZone} from "../../interfaces/ISovereignZone.sol";

contract TestZone is ISovereignZone {
    bool private _accept;
    ZoneType public zoneType = ZoneType.MULTISIG;

    function setAccept(bool _val) external {
        _accept = _val;
    }

    function accept(
        bytes32,
        uint256,
        bytes calldata,
        bytes calldata
    ) external view returns (bool) {
        return _accept;
    }
}
