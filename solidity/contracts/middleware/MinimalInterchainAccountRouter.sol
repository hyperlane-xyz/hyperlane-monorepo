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
import {MinimalProxy} from "../libs/MinimalProxy.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";
import {Router} from "../client/Router.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {Mailbox} from "../Mailbox.sol";
import {Message} from "../libs/Message.sol";
import {AbstractRoutingIsm} from "../isms/routing/AbstractRoutingIsm.sol";

// ============ External Imports ============
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title Minimal InterchainAccountRouter for chains with tight deployment size limits.
 * @notice Stripped-down version of InterchainAccountRouter that removes commit-reveal
 * functionality, unused function overloads, and the CommitmentReadIsm sub-deployment.
 * @dev Retains only the functions actually called by the TypeScript SDK/CLI/infra.
 * Account derivation is identical to the full InterchainAccountRouter — ICAs created
 * by either contract version are interoperable.
 */
// solhint-disable-next-line hyperlane/enumerable-domain-mapping
contract MinimalInterchainAccountRouter is Router, AbstractRoutingIsm {
    // ============ Libraries ============

    using TypeCasts for address;
    using TypeCasts for bytes32;
    using InterchainAccountMessage for bytes;
    using Message for bytes;
    using StandardHookMetadata for bytes;
    using SafeERC20 for IERC20;

    // ============ Constants ============

    address public immutable implementation;
    bytes32 public immutable bytecodeHash;

    // ============ Public Storage ============
    mapping(uint32 destinationDomain => bytes32 ism) public isms;

    // ============ Upgrade Gap ============

    uint256[47] private __GAP;

    // ============ Events ============

    event RemoteIsmEnrolled(uint32 indexed domain, bytes32 ism);

    event RemoteCallDispatched(
        uint32 indexed destination,
        address indexed owner,
        bytes32 router,
        bytes32 ism,
        bytes32 salt
    );

    event InterchainAccountCreated(
        address indexed account,
        uint32 origin,
        bytes32 router,
        bytes32 owner,
        address ism,
        bytes32 salt
    );

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

    function interchainSecurityModule()
        external
        view
        override
        returns (IInterchainSecurityModule)
    {
        return IInterchainSecurityModule(address(this));
    }

    // ============ Admin Functions ============

    function enrollRemoteRouterAndIsm(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism
    ) external onlyOwner {
        _enrollRemoteRouterAndIsm(_destination, _router, _ism);
    }

    function enrollRemoteRouterAndIsms(
        uint32[] calldata _destinations,
        bytes32[] calldata _routers,
        bytes32[] calldata _isms
    ) external onlyOwner {
        require(
            _destinations.length == _routers.length &&
                _destinations.length == _isms.length,
            "length mismatch"
        );
        for (uint256 i = 0; i < _destinations.length; i++) {
            _enrollRemoteRouterAndIsm(_destinations[i], _routers[i], _isms[i]);
        }
    }

    // ============ Receive ============

    /// @dev Accept hook refunds (e.g. IGP overpayment, ProtocolFee excess).
    receive() external payable {}

    // ============ External Functions ============

    function approveFeeTokenForHook(address _feeToken, address _hook) external {
        IERC20(_feeToken).forceApprove(_hook, type(uint256).max);
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
    ) public payable returns (bytes32) {
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
        return _dispatch(_destination, _router, _body, _hookMetadata);
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

    // ============ Account Getters ============

    /**
     * @notice Returns the local address of an interchain account (address params).
     * @dev Called by SDK: getLocalInterchainAccount(uint32,address,address,address)
     */
    function getLocalInterchainAccount(
        uint32 _origin,
        address _owner,
        address _router,
        address _ism
    ) external view returns (OwnableMulticall) {
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
    ) public returns (OwnableMulticall) {
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
    ) public returns (OwnableMulticall) {
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

    // ============ Gas Quoting ============

    /**
     * @notice Returns the gas payment required to dispatch a message.
     * @dev Called by SDK: quoteGasPayment(uint32,uint256)
     */
    function quoteGasPayment(
        uint32 _destination,
        uint256 _gasLimit
    ) public view returns (uint256 _gasPayment) {
        return
            _Router_quoteDispatch(
                _destination,
                new bytes(0),
                StandardHookMetadata.overrideGasLimit(_gasLimit),
                address(hook)
            );
    }

    // ============ Internal Functions ============

    function _implementationBytecode(
        address router
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                type(OwnableMulticall).creationCode,
                abi.encode(router)
            );
    }

    function _proxyBytecodeHash(
        address _implementation
    ) internal pure returns (bytes32) {
        return keccak256(MinimalProxy.bytecode(_implementation));
    }

    /// @dev Required for use of Router, compiler will not include this function in the bytecode
    function _handle(uint32, bytes32, bytes calldata) internal pure override {
        assert(false);
    }

    function _enrollRemoteRouter(
        uint32 _destination,
        bytes32 _address
    ) internal override {
        _enrollRemoteRouterAndIsm(
            _destination,
            _address,
            InterchainAccountMessage.EMPTY_SALT
        );
    }

    // ============ Private Functions ============

    function _enrollRemoteIsm(uint32 _destination, bytes32 _ism) private {
        isms[_destination] = _ism;
        emit RemoteIsmEnrolled(_destination, _ism);
    }

    function _enrollRemoteRouterAndIsm(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism
    ) private {
        require(
            routers(_destination) == InterchainAccountMessage.EMPTY_SALT &&
                isms[_destination] == InterchainAccountMessage.EMPTY_SALT,
            "router and ISM defaults are immutable once set"
        );
        Router._enrollRemoteRouter(_destination, _router);
        _enrollRemoteIsm(_destination, _ism);
    }

    function _dispatch(
        uint32 _destination,
        bytes32 _router,
        bytes memory _body,
        bytes memory _hookMetadata
    ) private returns (bytes32) {
        require(_router != bytes32(0), "no router specified for destination");

        address _feeToken = _hookMetadata.feeToken();
        if (_feeToken != address(0)) {
            uint256 _fee = _Router_quoteDispatch(
                _destination,
                bytes(""),
                _hookMetadata,
                address(hook)
            );
            IERC20(_feeToken).safeTransferFrom(msg.sender, address(this), _fee);
            IERC20(_feeToken).forceApprove(address(hook), type(uint256).max);
        }

        return
            mailbox.dispatch{value: msg.value}(
                _destination,
                _router,
                _body,
                _hookMetadata,
                hook
            );
    }

    function _getSalt(
        uint32 _origin,
        bytes32 _owner,
        bytes32 _router,
        bytes32 _ism,
        bytes32 _userSalt
    ) private pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(_origin, _owner, _router, _ism, _userSalt)
            );
    }

    function _getLocalInterchainAccount(
        bytes32 _salt
    ) private view returns (address payable) {
        return payable(Create2.computeAddress(_salt, bytecodeHash));
    }
}
