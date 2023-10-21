// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {console2} from "forge-std/console2.sol";
// ============ Internal Imports ============
import {IOptimisticIsm} from "../../interfaces/isms/IOptimisticIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";

// import {StaticMOfNAddressSetFactory} from "../../libs/StaticMOfNAddressSetFactory.sol";

contract OptimisticISM is Ownable, IOptimisticIsm {
    event SetSubmodule(IInterchainSecurityModule indexed submodule);
    event SetFraudWindow(uint64 indexed fraudWindow);

    uint8 public constant override moduleType = uint8(Types.OPTIMISTIC);

    /// @notice The number of seconds after which a message is considered non-fraudulent
    uint64 public fraudWindow;

    IInterchainSecurityModule internal _submodule;

    struct MessageCheck {
        uint64 timestamp;
        address checkingSubmodule;
    }

    address[] public watchers;

    mapping(address => bool) public fraudulantSubmodules;
    mapping(bytes32 => MessageCheck) public messages;

    modifier onlyWatchers() {
        bool isWatcher = false;
        for (uint256 i = 0; i < watchers.length; i++) {
            if (watchers[i] == msg.sender) {
                isWatcher = true;
                break;
            }
        }
        require(isWatcher, "OptimisticISM: caller is not a watcher");
        _;
    }

    constructor(IInterchainSecurityModule submodule, uint64 _fraudWindow)
        Ownable()
    {
        _setSubmodule(submodule);
        _setFraudWindow(_fraudWindow);
    }

    function preVerify(bytes calldata _metadata, bytes calldata _message)
        external
        returns (bool)
    {
        // load current checking submodule
        IInterchainSecurityModule checkingSubmodule = _submodule;

        bool isVerified = checkingSubmodule.verify(_metadata, _message);
        if (!isVerified) {
            return false;
        }
        messages[keccak256(abi.encode(_metadata, _message))] = MessageCheck({
            timestamp: uint64(block.timestamp) + fraudWindow,
            checkingSubmodule: address(checkingSubmodule)
        });
        return true;
    }

    /**
     * @inheritdoc IInterchainSecurityModule
     * @dev Reverts when paused, otherwise returns `true`.
     */
    function verify(bytes calldata _metadata, bytes calldata _message)
        external
        view
        returns (bool)
    {
        // load message
        MessageCheck memory message = messages[
            keccak256(abi.encode(_metadata, _message))
        ];

        // The message has been pre-verified
        if (message.timestamp == 0) {
            console2.log("message not pre-verified");
            return false;
        }

        // The submodule used to pre-verify the message has not been flagged as compromised by m-of-n watchers
        if (_isFraudulentSubmodule(message.checkingSubmodule)) {
            console2.log("fraudulent submodule");
            return false;
        }

        console2.log("message timestamp ", message.timestamp);
        // The fraud window has elapsed
        if (uint64(block.timestamp) < message.timestamp) {
            console2.log("fraud window not passed");
            return false;
        }

        return true;
    }

    function addWatcher(address watcher) external onlyOwner {
        watchers.push(watcher);
    }

    function markFraudulent(address _submodule) external onlyWatchers {
        fraudulantSubmodules[_submodule] = true;
    }

    function submodule(bytes calldata _message)
        external
        view
        returns (IInterchainSecurityModule)
    {
        return _submodule;
    }

    function setSubmodule(IInterchainSecurityModule newSubmodule)
        external
        onlyOwner
    {
        //todo: do we need a check to see if the submodule is within a list of submoduiels?

        _setSubmodule(newSubmodule);
    }

    function getMessage(bytes32 id)
        external
        view
        returns (MessageCheck memory)
    {
        return messages[id];
    }

    function _setSubmodule(IInterchainSecurityModule newSubmodule) internal {
        _submodule = IInterchainSecurityModule(newSubmodule);
        emit SetSubmodule(newSubmodule);
    }

    function _setFraudWindow(uint64 _fraudWindow) internal {
        fraudWindow = _fraudWindow;
        emit SetFraudWindow(_fraudWindow);
    }

    function _isFraudulentSubmodule(address module)
        internal
        view
        returns (bool)
    {
        console2.log(
            "checking submodule fraudulence",
            module,
            fraudulantSubmodules[module]
        );
        return fraudulantSubmodules[module];
    }
}
