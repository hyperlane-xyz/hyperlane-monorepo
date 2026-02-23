// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

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
import {IMailbox} from "../interfaces/IMailbox.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../libs/Message.sol";
import {PackageVersioned} from "../PackageVersioned.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

abstract contract MailboxClient is OwnableUpgradeable, PackageVersioned {
    using Message for bytes;

    event HookSet(address _hook);
    event IsmSet(address _ism);

    IMailbox public immutable mailbox;

    uint32 public immutable localDomain;

    IPostDispatchHook public hook;

    IInterchainSecurityModule internal _interchainSecurityModule;

    uint256[48] private __GAP; // gap for upgrade safety

    // ============ Modifiers ============
    modifier onlyContract(address _contract) {
        require(
            Address.isContract(_contract),
            "MailboxClient: invalid mailbox"
        );
        _;
    }

    modifier onlyContractOrNull(address _contract) {
        require(
            Address.isContract(_contract) || _contract == address(0),
            "MailboxClient: invalid contract setting"
        );
        _;
    }

    /**
     * @notice Only accept messages from a Hyperlane Mailbox contract
     */
    modifier onlyMailbox() {
        require(
            msg.sender == address(mailbox),
            "MailboxClient: sender not mailbox"
        );
        _;
    }

    constructor(address _mailbox) onlyContract(_mailbox) {
        mailbox = IMailbox(_mailbox);
        localDomain = mailbox.localDomain();
        _transferOwnership(msg.sender);
    }

    function interchainSecurityModule()
        external
        view
        virtual
        returns (IInterchainSecurityModule)
    {
        return _interchainSecurityModule;
    }

    /**
     * @notice Sets the address of the application's custom hook.
     * @param _hook The address of the hook contract.
     */
    function setHook(
        address _hook
    ) public virtual onlyContractOrNull(_hook) onlyOwner {
        hook = IPostDispatchHook(_hook);
        emit HookSet(_hook);
    }

    /**
     * @notice Sets the address of the application's custom interchain security module.
     * @param _module The address of the interchain security module contract.
     */
    function setInterchainSecurityModule(
        address _module
    ) public onlyContractOrNull(_module) onlyOwner {
        _interchainSecurityModule = IInterchainSecurityModule(_module);
        emit IsmSet(_module);
    }

    // ======== Initializer =========
    function _MailboxClient_initialize(
        address _hook,
        address __interchainSecurityModule,
        address _owner
    ) internal onlyInitializing {
        __Ownable_init();
        setHook(_hook);
        setInterchainSecurityModule(__interchainSecurityModule);
        _transferOwnership(_owner);
    }

    function _isLatestDispatched(bytes32 id) internal view returns (bool) {
        return mailbox.latestDispatchedId() == id;
    }

    function _isDelivered(bytes32 id) internal view returns (bool) {
        return mailbox.delivered(id);
    }
}
