// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;
pragma experimental ABIEncoderV2;

// ============ External Imports ============
import {TypedMemView} from "@summa-tx/memview-sol/contracts/TypedMemView.sol";

library ControllerMessage {
    using TypedMemView for bytes;
    using TypedMemView for bytes29;

    uint256 private constant CALL_PREFIX_LEN = 64;
    uint256 private constant MSG_PREFIX_NUM_ITEMS = 2;
    uint256 private constant MSG_PREFIX_LEN = 2;
    uint256 private constant ENROLL_REMOTE_ROUTER_LEN = 37;
    uint256 private constant SET_ADDRESS_LEN = 33;

    enum Types {
        Invalid, // 0
        Call, // 1
        SetController, // 2
        EnrollRemoteRouter, // 3
        Data, // 4
        SetAbacusConnectionManager // 5
    }

    struct Call {
        bytes32 to;
        bytes data;
    }

    modifier typeAssert(bytes29 _view, Types _t) {
        _view.assertType(uint40(_t));
        _;
    }

    // Types.Call
    function data(bytes29 _view) internal view returns (bytes memory _data) {
        _data = TypedMemView.clone(
            _view.slice(CALL_PREFIX_LEN, dataLen(_view), uint40(Types.Data))
        );
    }

    function formatCalls(Call[] memory _calls)
        internal
        view
        returns (bytes memory _msg)
    {
        uint256 _numCalls = _calls.length;
        bytes29[] memory _encodedCalls = new bytes29[](
            _numCalls + MSG_PREFIX_NUM_ITEMS
        );

        // Add Types.Call identifier
        _encodedCalls[0] = abi.encodePacked(Types.Call).ref(0);
        // Add number of calls
        _encodedCalls[1] = abi.encodePacked(uint8(_numCalls)).ref(0);

        for (uint256 i = 0; i < _numCalls; i++) {
            Call memory _call = _calls[i];
            bytes29 _callMsg = abi
                .encodePacked(_call.to, _call.data.length, _call.data)
                .ref(0);

            _encodedCalls[i + MSG_PREFIX_NUM_ITEMS] = _callMsg;
        }

        _msg = TypedMemView.join(_encodedCalls);
    }

    function formatSetController(bytes32 _controller)
        internal
        view
        returns (bytes memory _msg)
    {
        _msg = TypedMemView.clone(
            mustBeSetController(
                abi.encodePacked(Types.SetController, _controller).ref(0)
            )
        );
    }

    function formatEnrollRemoteRouter(uint32 _domain, bytes32 _router)
        internal
        view
        returns (bytes memory _msg)
    {
        _msg = TypedMemView.clone(
            mustBeEnrollRemoteRouter(
                abi
                    .encodePacked(Types.EnrollRemoteRouter, _domain, _router)
                    .ref(0)
            )
        );
    }

    function formatSetAbacusConnectionManager(bytes32 _abacusConnectionManager)
        internal
        view
        returns (bytes memory _msg)
    {
        _msg = TypedMemView.clone(
            mustBeSetAbacusConnectionManager(
                abi
                    .encodePacked(
                        Types.SetAbacusConnectionManager,
                        _abacusConnectionManager
                    )
                    .ref(0)
            )
        );
    }

    function getCalls(bytes29 _msg) internal view returns (Call[] memory) {
        uint8 _numCalls = uint8(_msg.indexUint(1, 1));

        // Skip message prefix
        bytes29 _msgPtr = _msg.slice(
            MSG_PREFIX_LEN,
            _msg.len() - MSG_PREFIX_LEN,
            uint40(Types.Call)
        );

        Call[] memory _calls = new Call[](_numCalls);

        uint256 counter = 0;
        while (_msgPtr.len() > 0) {
            _calls[counter].to = to(_msgPtr);
            _calls[counter].data = data(_msgPtr);

            _msgPtr = nextCall(_msgPtr);
            counter++;
        }

        return _calls;
    }

    function nextCall(bytes29 _view)
        internal
        pure
        typeAssert(_view, Types.Call)
        returns (bytes29)
    {
        uint256 lastCallLen = CALL_PREFIX_LEN + dataLen(_view);
        return
            _view.slice(
                lastCallLen,
                _view.len() - lastCallLen,
                uint40(Types.Call)
            );
    }

    function messageType(bytes29 _view) internal pure returns (Types) {
        return Types(uint8(_view.typeOf()));
    }

    /*
        Message fields
    */

    // All Types
    function identifier(bytes29 _view) internal pure returns (uint8) {
        return uint8(_view.indexUint(0, 1));
    }

    // Types.Call
    function to(bytes29 _view) internal pure returns (bytes32) {
        return _view.index(0, 32);
    }

    // Types.Call
    function dataLen(bytes29 _view) internal pure returns (uint256) {
        return uint256(_view.index(32, 32));
    }

    // Types.EnrollRemoteRouter
    function domain(bytes29 _view) internal pure returns (uint32) {
        return uint32(_view.indexUint(1, 4));
    }

    // Types.EnrollRemoteRouter
    function router(bytes29 _view) internal pure returns (bytes32) {
        return _view.index(5, 32);
    }

    // Types.SetController
    function controller(bytes29 _view) internal pure returns (bytes32) {
        return _view.index(1, 32);
    }

    // Types.SetAbacusConnectionManager
    function abacusConnectionManager(bytes29 _view)
        internal
        pure
        returns (bytes32)
    {
        return _view.index(1, 32);
    }

    /*
        Message Type: CALL
        struct Call {
            identifier,     // message ID -- 1 byte
            numCalls,       // number of calls -- 1 byte
            calls[], {
                to,         // address to call -- 32 bytes
                dataLen,    // call data length -- 32 bytes,
                data        // call data -- 0+ bytes (length unknown)
            }
        }
    */

    function isValidCall(bytes29 _view) internal pure returns (bool) {
        return
            identifier(_view) == uint8(Types.Call) &&
            _view.len() >= CALL_PREFIX_LEN;
    }

    function isCall(bytes29 _view) internal pure returns (bool) {
        return isValidCall(_view) && messageType(_view) == Types.Call;
    }

    function tryAsCall(bytes29 _view) internal pure returns (bytes29) {
        if (isValidCall(_view)) {
            return _view.castTo(uint40(Types.Call));
        }
        return TypedMemView.nullView();
    }

    function mustBeCall(bytes29 _view) internal pure returns (bytes29) {
        return tryAsCall(_view).assertValid();
    }

    /*
        Message Type: SET CONTROLLER
        struct SetController {
            identifier, // message ID -- 1 byte
            addr        // address of new controller -- 32 bytes
        }
    */

    function isValidSetController(bytes29 _view) internal pure returns (bool) {
        return
            identifier(_view) == uint8(Types.SetController) &&
            _view.len() == SET_ADDRESS_LEN;
    }

    function isSetController(bytes29 _view) internal pure returns (bool) {
        return
            isValidSetController(_view) &&
            messageType(_view) == Types.SetController;
    }

    function tryAsSetController(bytes29 _view) internal pure returns (bytes29) {
        if (isValidSetController(_view)) {
            return _view.castTo(uint40(Types.SetController));
        }
        return TypedMemView.nullView();
    }

    function mustBeSetController(bytes29 _view)
        internal
        pure
        returns (bytes29)
    {
        return tryAsSetController(_view).assertValid();
    }

    /*
        Message Type: ENROLL REMOTE ROUTER
        struct EnrollRemoteRouter {
            identifier, // message ID -- 1 byte
            domain,     // domain of new router -- 4 bytes
            addr        // address of new router -- 32 bytes
        }
    */

    function isValidEnrollRemoteRouter(bytes29 _view)
        internal
        pure
        returns (bool)
    {
        return
            identifier(_view) == uint8(Types.EnrollRemoteRouter) &&
            _view.len() == ENROLL_REMOTE_ROUTER_LEN;
    }

    function isEnrollRemoteRouter(bytes29 _view) internal pure returns (bool) {
        return
            isValidEnrollRemoteRouter(_view) &&
            messageType(_view) == Types.EnrollRemoteRouter;
    }

    function tryAsEnrollRemoteRouter(bytes29 _view)
        internal
        pure
        returns (bytes29)
    {
        if (isValidEnrollRemoteRouter(_view)) {
            return _view.castTo(uint40(Types.EnrollRemoteRouter));
        }
        return TypedMemView.nullView();
    }

    function mustBeEnrollRemoteRouter(bytes29 _view)
        internal
        pure
        returns (bytes29)
    {
        return tryAsEnrollRemoteRouter(_view).assertValid();
    }

    /*
        Message Type: SET XAPPCONNECTIONMANAGER
        struct SetAbacusConnectionManager {
            identifier, // message ID -- 1 byte
            addr        // address of new abacusConnectionManager -- 32 bytes
        }
    */

    function isValidSetAbacusConnectionManager(bytes29 _view)
        internal
        pure
        returns (bool)
    {
        return
            identifier(_view) == uint8(Types.SetAbacusConnectionManager) &&
            _view.len() == SET_ADDRESS_LEN;
    }

    function isSetAbacusConnectionManager(bytes29 _view)
        internal
        pure
        returns (bool)
    {
        return
            isValidSetAbacusConnectionManager(_view) &&
            messageType(_view) == Types.SetAbacusConnectionManager;
    }

    function tryAsSetAbacusConnectionManager(bytes29 _view)
        internal
        pure
        returns (bytes29)
    {
        if (isValidSetAbacusConnectionManager(_view)) {
            return _view.castTo(uint40(Types.SetAbacusConnectionManager));
        }
        return TypedMemView.nullView();
    }

    function mustBeSetAbacusConnectionManager(bytes29 _view)
        internal
        pure
        returns (bytes29)
    {
        return tryAsSetAbacusConnectionManager(_view).assertValid();
    }
}
