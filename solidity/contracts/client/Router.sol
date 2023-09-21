// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {EnumerableMapExtended} from "../libs/EnumerableMapExtended.sol";
import {GlobalHookMetadata} from "../libs/hooks/GlobalHookMetadata.sol";
import {MailboxClient} from "./MailboxClient.sol";

// ============ External Imports ============
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

abstract contract Router is
    OwnableUpgradeable,
    MailboxClient,
    IMessageRecipient
{
    using EnumerableMapExtended for EnumerableMapExtended.UintToBytes32Map;

    // ============ Mutable Storage ============
    EnumerableMapExtended.UintToBytes32Map internal _routers;

    IPostDispatchHook public hook;

    IInterchainSecurityModule public interchainSecurityModule;

    uint256[48] private __GAP; // gap for upgrade safety

    constructor(address _mailbox) MailboxClient(_mailbox) {}

    /**
     * @notice Initializes the Router contract with Hyperlane core contracts and the address of the interchain security module.
     * @param _hook The address of the post dispatch hook contract.
     * @param _interchainSecurityModule The address of the interchain security module contract.
     * @param _owner The address with owner privileges.
     */
    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) external virtual initializer {
        _Router_initialize(_hook, _interchainSecurityModule, _owner);
    }

    // ======== Initializer =========
    function _Router_initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) internal onlyInitializing {
        __Ownable_init();
        setHook(_hook);
        setInterchainSecurityModule(_interchainSecurityModule);
        _transferOwnership(_owner);
    }

    // ============ External functions ============
    function domains() external view returns (uint32[] memory) {
        return _routers.uint32Keys();
    }

    /**
     * @notice Returns the address of the Router contract for the given domain
     * @param _domain The remote domain ID.
     * @dev Returns 0 address if no router is enrolled for the given domain
     * @return router The address of the Router contract for the given domain
     */
    function routers(uint32 _domain) public view virtual returns (bytes32) {
        (, bytes32 _router) = _routers.tryGet(_domain);
        return _router;
    }

    /**
     * @notice Register the address of a Router contract for the same Application on a remote chain
     * @param _domain The domain of the remote Application Router
     * @param _router The address of the remote Application Router
     */
    function enrollRemoteRouter(uint32 _domain, bytes32 _router)
        external
        virtual
        onlyOwner
    {
        _enrollRemoteRouter(_domain, _router);
    }

    /**
     * @notice Batch version of `enrollRemoteRouter`
     * @param _domains The domaisn of the remote Application Routers
     * @param _addresses The addresses of the remote Application Routers
     */
    function enrollRemoteRouters(
        uint32[] calldata _domains,
        bytes32[] calldata _addresses
    ) external virtual onlyOwner {
        require(_domains.length == _addresses.length, "!length");
        uint256 length = _domains.length;
        for (uint256 i = 0; i < length; i += 1) {
            _enrollRemoteRouter(_domains[i], _addresses[i]);
        }
    }

    /**
     * @notice Handles an incoming message
     * @param _origin The origin domain
     * @param _sender The sender address
     * @param _message The message
     */
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) external payable virtual override onlyMailbox {
        bytes32 _router = _mustHaveRemoteRouter(_origin);
        require(_router == _sender, "Enrolled router does not match sender");
        _handle(_origin, _sender, _message);
    }

    /**
     * @notice Sets the address of the application's custom hook.
     * @param _hook The address of the hook contract.
     */
    function setHook(address _hook) public onlyOwner {
        hook = IPostDispatchHook(_hook);
    }

    function setInterchainSecurityModule(address _module) public onlyOwner {
        interchainSecurityModule = IInterchainSecurityModule(_module);
    }

    // ============ Virtual functions ============
    function _handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) internal virtual;

    // TODO: add messageBody?
    function _metadata(uint32) internal view virtual returns (bytes memory) {
        return bytes("");
    }

    // ============ Internal functions ============

    /**
     * @notice Set the router for a given domain
     * @param _domain The domain
     * @param _address The new router
     */
    function _enrollRemoteRouter(uint32 _domain, bytes32 _address)
        internal
        virtual
    {
        _routers.set(_domain, _address);
    }

    /**
     * @notice Return true if the given domain / router is the address of a remote Application Router
     * @param _domain The domain of the potential remote Application Router
     * @param _address The address of the potential remote Application Router
     */
    function _isRemoteRouter(uint32 _domain, bytes32 _address)
        internal
        view
        returns (bool)
    {
        return routers(_domain) == _address;
    }

    /**
     * @notice Assert that the given domain has a Application Router registered and return its address
     * @param _domain The domain of the chain for which to get the Application Router
     * @return _router The address of the remote Application Router on _domain
     */
    function _mustHaveRemoteRouter(uint32 _domain)
        internal
        view
        returns (bytes32)
    {
        (bool contained, bytes32 _router) = _routers.tryGet(_domain);
        require(
            contained,
            string.concat(
                "No router enrolled for domain",
                Strings.toString(_domain)
            )
        );
        return _router;
    }

    function _dispatch(uint32 _destinationDomain, bytes memory _messageBody)
        internal
        virtual
        returns (bytes32)
    {
        bytes32 _router = _mustHaveRemoteRouter(_destinationDomain);
        return
            mailbox.dispatch{value: msg.value}(
                _destinationDomain,
                _router,
                _messageBody,
                _metadata(_destinationDomain),
                hook
            );
    }

    function _quoteDispatch(
        uint32 _destinationDomain,
        bytes memory _messageBody
    ) internal view virtual returns (uint256) {
        bytes32 _router = _mustHaveRemoteRouter(_destinationDomain);
        return
            mailbox.quoteDispatch(
                _destinationDomain,
                _router,
                _messageBody,
                _metadata(_destinationDomain),
                hook
            );
    }
}
