// SPDX-License-Identifier: Apache-2.0
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
import {MinimalProxy} from "../libs/MinimalProxy.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";
import {Router} from "../client/Router.sol";
import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../libs/Message.sol";
import {AbstractRoutingIsm} from "../isms/routing/AbstractRoutingIsm.sol";

// ============ External Imports ============
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

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

    using TypeCasts for address;
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
     * @notice Dispatches a sequence of remote calls to be made by an owner's
     * interchain account on the destination domain.
     * @dev This is the only callRemote variant — the SDK calls this signature directly.
     */
    function callRemoteWithOverrides(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism,
        CallLib.Call[] calldata _calls,
        bytes memory _hookMetadata
    ) public payable override returns (bytes32) {
        emit RemoteCallDispatched(
            _destination,
            msg.sender,
            _router,
            _ism,
            InterchainAccountMessage.EMPTY_SALT
        );
        bytes memory _body = InterchainAccountMessage.encode(
            msg.sender,
            _ism,
            _calls
        );
        return
            _dispatchMessageWithValue(
                _destination,
                _router,
                _body,
                _hookMetadata,
                hook,
                msg.value
            );
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

    /**
     * @notice Returns the local address of an interchain account (address params).
     * @dev Called by SDK: getLocalInterchainAccount(uint32,address,address,address)
     */
    function getLocalInterchainAccount(
        uint32 _origin,
        address _owner,
        address _router,
        address _ism
    ) external view override returns (OwnableMulticall) {
        return
            OwnableMulticall(
                _getLocalInterchainAccount(
                    _getSalt(
                        _origin,
                        _owner.addressToBytes32(),
                        _router.addressToBytes32(),
                        _ism.addressToBytes32(),
                        InterchainAccountMessage.EMPTY_SALT
                    )
                )
            );
    }

    /**
     * @notice Returns and deploys (if not already) an interchain account (address params).
     * @dev Called by SDK: getDeployedInterchainAccount(uint32,address,address,address)
     */
    function getDeployedInterchainAccount(
        uint32 _origin,
        address _owner,
        address _router,
        address _ism
    ) public override returns (OwnableMulticall) {
        return
            getDeployedInterchainAccount(
                _origin,
                _owner.addressToBytes32(),
                _router.addressToBytes32(),
                _ism,
                InterchainAccountMessage.EMPTY_SALT
            );
    }

    /**
     * @notice Returns and deploys (if not already) an interchain account (full params).
     * @dev Used internally by handle() and the address-param overload above.
     */
    function getDeployedInterchainAccount(
        uint32 _origin,
        bytes32 _owner,
        bytes32 _router,
        address _ism,
        bytes32 _userSalt
    ) public override returns (OwnableMulticall) {
        bytes32 _deploySalt = _getSalt(
            _origin,
            _owner,
            _router,
            _ism.addressToBytes32(),
            _userSalt
        );
        address payable _account = _getLocalInterchainAccount(_deploySalt);
        if (!Address.isContract(_account)) {
            bytes memory _bytecode = MinimalProxy.bytecode(implementation);
            _account = payable(Create2.deploy(0, _deploySalt, _bytecode));
            emit InterchainAccountCreated(
                _account,
                _origin,
                _router,
                _owner,
                _ism,
                _userSalt
            );
        }
        return OwnableMulticall(_account);
    }

    /**
     * @notice Returns the gas payment required to dispatch a message.
     * @dev Called by SDK: quoteGasPayment(uint32,uint256)
     */
    function quoteGasPayment(
        uint32 _destination,
        uint256 _gasLimit
    ) public view override returns (uint256 _gasPayment) {
        return
            _Router_quoteDispatch(
                _destination,
                new bytes(0),
                StandardHookMetadata.overrideGasLimit(_gasLimit),
                address(hook)
            );
    }
}
