// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;
pragma experimental ABIEncoderV2;

import "../governance/GovernanceRouter.sol";
import {TypeCasts} from "../XAppConnectionManager.sol";

contract TestGovernanceRouter is GovernanceRouter {
    constructor(uint32 _localDomain, uint256 _recoveryTimelock)
        GovernanceRouter(_localDomain, 50)
    {} // solhint-disable-line no-empty-blocks

    function testSetRouter(uint32 _domain, address _router) external {
        _internalSetRouter(_domain, _router); // set the router locally

        bytes memory _msg = abi.encodeWithSelector(
            this._setRouter.selector,
            _domain,
            TypeCasts.addressToBytes32(_router)
        );

        _sendToAllRemoteRouters(_msg);
    }

    function setRouterAddress(uint32 _domain, address _router) external {
        _internalSetRouter(_domain, _router);
    }

    function containsDomain(uint32 _domain) external view returns (bool) {
        for (uint256 i = 0; i < domains.length; i++) {
            if (domains[i] == _domain) return true;
        }

        return false;
    }
}
