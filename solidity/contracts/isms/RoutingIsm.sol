// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../libs/Message.sol";

/**
 * @title RoutingIsm
 * @notice Manages per-domain m-of-n Validator sets that are used to verify
 * interchain messages.
 */
contract RoutingIsm is IInterchainSecurityModule {
    mapping(uint32 => IInterchainSecurityModule) public isms;
    // ============ Libraries ============

    using Message for bytes;

    // ============ Constants ============

    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.ROUTING);

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor() {}

    // ============ Public Functions ============

    function setIsm(uint32 _domain, IInterchainSecurityModule _ism) external {
        isms[_domain] = _ism;
    }

    function verify(bytes calldata _metadata, bytes calldata _message)
        external
        returns (bool)
    {
        uint32 _origin = _message.origin();
        require(isms[_origin].verify(_metadata, _message));
        return true;
    }
}
