// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;
pragma experimental ABIEncoderV2;

// ============ External Imports ============
import {TypedMemView} from "@summa-tx/memview-sol/contracts/TypedMemView.sol";
import {TypeCasts} from "@celo-org/optics-sol/contracts/XAppConnectionManager.sol";
// ============ Internal Imports ============
import {CallforwarderMessage} from "./CallforwarderMessage.sol";
import {ICallforwarderProxy} from "../../interfaces/callforwarder/ICallforwarderProxy.sol";
import {Router} from "../Router.sol";
import {XAppConnectionClient} from "../XAppConnectionClient.sol";

/*
============ Overview: Building a xApp ============
To implement a xApp, define the actions you would like to execute across chains.
For each type of action,
- in the xApp Router
    - implement a function like doTypeA to initiate the action from one domain to another (add your own parameters and logic)
    - implement a corresponding _handle function to receive, parse, and execute this type of message on the remote domain
    - add logic to the handle function to route incoming messages to the appropriate _handle function
- in the Message library,
    - implement functions to *format* the message to send to the other chain (encodes all necessary information for the action)
    - implement functions to *parse* the message once it is received on the other chain (decode all necessary information for the action)
*/
contract CallforwarderRouter is Router {
    // ============ Libraries ============

    using TypedMemView for bytes;
    using TypedMemView for bytes29;
    using CallforwarderMessage for bytes29;

    // ============ Events ============

    event TypeAReceived(uint256 number);

    // ============ Modifiers ============
    modifier typeAssert(bytes29 _view, CallforwarderMessage.Types _type) {
        _view.assertType(uint40(_type));
        _;
    }

    // ============ Constructor ============

    constructor(address _xAppConnectionManager) {
        __XAppConnectionClient_initialize(_xAppConnectionManager);
    }

    /**
     * @notice Receive messages sent via Optics from other remote xApp Routers;
     * parse the contents of the message and enact the message's effects on the local chain
     * @dev Called by an Optics Replica contract while processing a message sent via Optics
     * @param _origin The domain the message is coming from
     * @param _sender The address the message is coming from
     * @param _message The message in the form of raw bytes
     */
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes memory _message
    ) external override onlyReplica onlyRemoteRouter(_origin, _sender) {
        bytes29 _msg = _message.ref(0);
        // route message to appropriate _handle function
        // based on what type of message is encoded
        if (_msg.isValidCall()) {
            _handleCall(_origin, _msg.tryAsCall());
        } else {
            // if _message doesn't match any valid actions, revert
            require(false, "!valid action");
        }
    }

    /**
     * @notice Dispatch calls on a remote chain via the remote CallforwarderRouter
     * @param _destination The domain of the remote chain
     * @param _calls The calls
     */
    function callRemote(
        uint32 _destination,
        CallforwarderMessage.Call[] calldata _calls
    ) external {
        // ensure that destination chain has enrolled router
        bytes32 _router = _mustHaveRemote(_destination);
        // format call message
        bytes memory _msg = CallforwarderMessage.formatCalls(
            msg.sender,
            _calls
        );
        // dispatch call message using Optics
        _home().dispatch(_destination, _router, _msg);
    }

    /**
     * @notice Handle message dispatching calls locally
     * @param _msg The message
     */
    function _handleCall(uint32 _origin, bytes29 _msg)
        internal
        typeAssert(_msg, CallforwarderMessage.Types.Call)
    {
        address _from = TypeCasts.bytes32ToAddress(_msg.from());
        CallforwarderMessage.Call[] memory _calls = _msg.getCalls();
        for (uint256 i = 0; i < _calls.length; i++) {
            _dispatchCall(_from, _origin, _calls[i]);
        }
    }

    /**
     * @notice Dispatch call locally
     * @param _call The call
     */
    function _dispatchCall(
        address _from,
        uint32 _origin,
        CallforwarderMessage.Call memory _call
    ) internal {
        ICallforwarderProxy _target = ICallforwarderProxy(
            TypeCasts.bytes32ToAddress(_call.to)
        );

        _target.callFromRouter(_from, _origin, _call.data);
    }
}
