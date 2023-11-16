// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "../client/Router.sol";

contract TestRouter is Router {
    event InitializeOverload();

    constructor(address _mailbox) Router(_mailbox) {}

    function initialize(
        address _hook,
        address _interchainSecurityModule
    ) public initializer {
        _MailboxClient_initialize(_hook, _interchainSecurityModule, msg.sender);
    }

    function _handle(uint32, bytes32, bytes calldata) internal pure override {}

    function isRemoteRouter(
        uint32 _domain,
        bytes32 _potentialRemoteRouter
    ) external view returns (bool) {
        return _isRemoteRouter(_domain, _potentialRemoteRouter);
    }

    function mustHaveRemoteRouter(
        uint32 _domain
    ) external view returns (bytes32) {
        return _mustHaveRemoteRouter(_domain);
    }

    function dispatch(uint32 _destination, bytes memory _msg) external payable {
        _dispatch(_destination, _msg);
    }
}
