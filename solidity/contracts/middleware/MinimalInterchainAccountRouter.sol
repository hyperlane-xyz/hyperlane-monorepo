// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.13;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ Internal Imports ============
import {OwnableMulticall} from "./libs/OwnableMulticall.sol";
import {InterchainAccountMessage} from "./libs/InterchainAccountMessage.sol";
import {CallLib} from "./libs/Call.sol";
import {AbstractInterchainAccountRouter} from "./AbstractInterchainAccountRouter.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {Router} from "../client/Router.sol";
import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../libs/Message.sol";
import {AbstractRoutingIsm} from "../isms/routing/AbstractRoutingIsm.sol";

// ============ External Imports ============
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

/**
 * @title Minimal InterchainAccountRouter for chains with tight deployment size limits.
 * @notice Stripped-down version of InterchainAccountRouter that removes commit-reveal
 * functionality, unused function overloads, and the CommitmentReadIsm sub-deployment.
 * @dev Retains only the functions actually called by the TypeScript SDK/CLI/infra.
 * Account derivation is identical to the full InterchainAccountRouter — ICAs created
 * by either contract version are interoperable.
 */
contract MinimalInterchainAccountRouter is
    AbstractInterchainAccountRouter,
    AbstractRoutingIsm
{
    // ============ Libraries ============

    using TypeCasts for bytes32;
    using InterchainAccountMessage for bytes;
    using Message for bytes;

    // ============ Constructor ============
    constructor(
        address _mailbox,
        address _hook,
        address _owner
    ) Router(_mailbox) {
        setHook(_hook);
        _transferOwnership(_owner);

        bytes memory _bytecode = _implementationBytecode(address(this));
        implementation = Create2.deploy(0, bytes32(0), _bytecode);
        bytecodeHash = _proxyBytecodeHash(implementation);
    }

    /**
     * @notice Handles dispatched messages by relaying calls to the interchain account.
     * @dev Only supports CALLS message type (no commit-reveal).
     */
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) external payable override onlyMailbox {
        bytes32 _owner = _message.owner();
        bytes32 _salt = _message.salt();
        bytes32 _ism = _message.ism();

        OwnableMulticall ica = getDeployedInterchainAccount(
            _origin,
            _owner,
            _sender,
            _ism.bytes32ToAddress(),
            _salt
        );

        CallLib.Call[] memory calls = _message.calls();
        ica.multicall{value: msg.value}(calls);
    }

    /**
     * @notice ISM routing — returns the ISM specified in the message body, or the default ISM.
     * @dev Simplified from the full router: no CCIP-READ / REVEAL path.
     */
    function route(
        bytes calldata _message
    ) public view override returns (IInterchainSecurityModule) {
        bytes calldata _body = _message.body();
        address _ism = InterchainAccountMessage.ism(_body).bytes32ToAddress();
        if (_ism == address(0)) {
            _ism = address(mailbox.defaultIsm());
        }
        return IInterchainSecurityModule(_ism);
    }
}
