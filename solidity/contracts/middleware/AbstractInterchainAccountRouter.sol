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

// ============ External Imports ============
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// solhint-disable-next-line hyperlane/enumerable-domain-mapping
abstract contract AbstractInterchainAccountRouter is Router {
    using TypeCasts for address;
    using TypeCasts for bytes32;
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

    // solhint-disable-next-line hyperlane/no-virtual-override
    function interchainSecurityModule()
        external
        view
        virtual
        override
        returns (IInterchainSecurityModule)
    {
        return IInterchainSecurityModule(address(this));
    }

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

    receive() external payable {}

    /**
     * @notice Approves the fee token for the hook to spend.
     * @dev Grants max approval so the hook can pull fee tokens during dispatch.
     * @param _feeToken The ERC20 fee token address.
     * @param _hook The hook address to approve.
     */
    function approveFeeTokenForHook(address _feeToken, address _hook) external {
        IERC20(_feeToken).forceApprove(_hook, type(uint256).max);
    }

    function getDeployedInterchainAccount(
        uint32 _origin,
        address _owner,
        address _router,
        address _ism
    ) public virtual returns (OwnableMulticall) {
        return
            getDeployedInterchainAccount(
                _origin,
                _owner.addressToBytes32(),
                _router.addressToBytes32(),
                _ism,
                InterchainAccountMessage.EMPTY_SALT
            );
    }

    function getDeployedInterchainAccount(
        uint32 _origin,
        bytes32 _owner,
        bytes32 _router,
        address _ism,
        bytes32 _userSalt
    ) public virtual returns (OwnableMulticall) {
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

    function getLocalInterchainAccount(
        uint32 _origin,
        address _owner,
        address _router,
        address _ism
    ) external view virtual returns (OwnableMulticall) {
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

    function quoteGasPayment(
        uint32 _destination,
        uint256 _gasLimit
    ) public view virtual returns (uint256 _gasPayment) {
        return
            _Router_quoteDispatch(
                _destination,
                new bytes(0),
                StandardHookMetadata.overrideGasLimit(_gasLimit),
                address(hook)
            );
    }

    function callRemoteWithOverrides(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism,
        CallLib.Call[] calldata _calls,
        bytes memory _hookMetadata
    ) public payable virtual returns (bytes32) {
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

    function _dispatchMessageWithValue(
        uint32 _destination,
        bytes32 _router,
        bytes memory _body,
        bytes memory _hookMetadata,
        IPostDispatchHook _hook,
        uint256 _value
    ) internal returns (bytes32) {
        require(_router != bytes32(0), "no router specified for destination");

        address _feeToken = _hookMetadata.feeToken();
        if (_feeToken != address(0)) {
            uint256 _fee = _Router_quoteDispatch(
                _destination,
                bytes(""),
                _hookMetadata,
                address(_hook)
            );

            IERC20(_feeToken).safeTransferFrom(msg.sender, address(this), _fee);
            // Standing approval is acceptable here: postDispatch replay with a
            // crafted message could spend this approval, but tokens are never held
            // in this contract so there is nothing to drain. Funds collected by the
            // hook are recoverable by the hook beneficiary, not the attacker.
            IERC20(_feeToken).forceApprove(address(_hook), type(uint256).max);
        }

        return
            mailbox.dispatch{value: _value}(
                _destination,
                _router,
                _body,
                _hookMetadata,
                _hook
            );
    }

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

    // solhint-disable-next-line hyperlane/no-virtual-override
    function _enrollRemoteRouter(
        uint32 _destination,
        bytes32 _address
    ) internal virtual override {
        _enrollRemoteRouterAndIsm(
            _destination,
            _address,
            InterchainAccountMessage.EMPTY_SALT
        );
    }

    function _enrollRemoteIsm(uint32 _destination, bytes32 _ism) internal {
        isms[_destination] = _ism;
        emit RemoteIsmEnrolled(_destination, _ism);
    }

    function _enrollRemoteRouterAndIsm(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism
    ) internal {
        require(
            routers(_destination) == InterchainAccountMessage.EMPTY_SALT &&
                isms[_destination] == InterchainAccountMessage.EMPTY_SALT,
            "router and ISM defaults are immutable once set"
        );
        Router._enrollRemoteRouter(_destination, _router);
        _enrollRemoteIsm(_destination, _ism);
    }

    /**
     * @notice Returns the remote address of a locally owned interchain account
     * @dev This interchain account is not guaranteed to have been deployed
     * @dev This function will only work if the destination domain is EVM compatible
     * @param _owner The local owner of the interchain account
     * @param _router The remote InterchainAccountRouter
     * @param _ism The remote address of the ISM
     * @param _userSalt Salt provided by the user, allows control over account derivation.
     * @return The remote address of the interchain account
     */
    function getRemoteInterchainAccount(
        address _owner,
        address _router,
        address _ism,
        bytes32 _userSalt
    ) public view returns (address) {
        require(_router != address(0), "no router specified for destination");

        address _implementation = Create2.computeAddress(
            bytes32(0),
            keccak256(_implementationBytecode(_router)),
            _router
        );

        bytes32 _bytecodeHash = _proxyBytecodeHash(_implementation);
        bytes32 _salt = _getSalt(
            localDomain,
            _owner.addressToBytes32(),
            address(this).addressToBytes32(),
            _ism.addressToBytes32(),
            _userSalt
        );
        return Create2.computeAddress(_salt, _bytecodeHash, _router);
    }

    function _getSalt(
        uint32 _origin,
        bytes32 _owner,
        bytes32 _router,
        bytes32 _ism,
        bytes32 _userSalt
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(_origin, _owner, _router, _ism, _userSalt)
            );
    }

    function _getLocalInterchainAccount(
        bytes32 _salt
    ) internal view returns (address payable) {
        return payable(Create2.computeAddress(_salt, bytecodeHash));
    }
}
