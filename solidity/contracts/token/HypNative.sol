// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

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
import {TokenRouter} from "./libs/TokenRouter.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title HypNative
 * @author Abacus Works
 * @notice This contract facilitates the transfer of value between chains using value transfer hooks
 */
contract HypNative is TokenRouter {
    /**
     * @dev Emitted when native tokens are donated to the contract.
     * @param sender The address of the sender.
     * @param amount The amount of native tokens donated.
     */
    event Donation(address indexed sender, uint256 amount);
    // ============ Errors ============

    error InsufficientValue(uint256 requiredValue, uint256 providedValue);

    constructor(address _mailbox) TokenRouter(_mailbox) {}

    // ============ Initialization ============

    /**
     * @notice Initializes the contract
     * @param _valuehook The address of the value transfer hook
     * @param _interchainSecurityModule The address of the interchain security module
     * @param _owner The owner of the contract
     */
    function initialize(
        address _valuehook,
        address _interchainSecurityModule,
        address _owner
    ) public initializer {
        _MailboxClient_initialize(
            _valuehook,
            _interchainSecurityModule,
            _owner
        );
    }

    // ============ External Functions ============

    /**
     * @inheritdoc TokenRouter
     * @dev use _hook with caution, make sure that this hook can handle msg.value transfer using the metadata.msgValue()
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes calldata _hookMetadata,
        address _hook
    ) public payable virtual override returns (bytes32 messageId) {
        uint256 quote = _GasRouter_quoteDispatch(
            _destination,
            _hookMetadata,
            _hook
        );
        require(msg.value >= _amount + quote, "HypNative: insufficient value");

        bytes memory hookMetadata = StandardHookMetadata.overrideMsgValue(
            _hookMetadata,
            _amount
        );

        return
            _transferRemote(
                _destination,
                _recipient,
                _amount,
                _amount + quote,
                hookMetadata,
                _hook
            );
    }

    /// @inheritdoc TokenRouter
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable virtual override returns (bytes32 messageId) {
        bytes calldata emptyBytes;
        assembly {
            emptyBytes.length := 0
            emptyBytes.offset := 0
        }
        return
            transferRemote(
                _destination,
                _recipient,
                _amount,
                emptyBytes,
                address(hook)
            );
    }

    // ============ Internal Functions ============

    /**
     * @inheritdoc TokenRouter
     * @dev No token metadata is needed for value transfers
     */
    function _transferFromSender(
        uint256
    ) internal pure override returns (bytes memory) {
        return bytes(""); // no token metadata
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Sends the value to the recipient
     */
    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata // no token metadata
    ) internal virtual override {
        Address.sendValue(payable(_recipient), _amount);
    }

    /// @inheritdoc TokenRouter
    function balanceOf(
        address _account
    ) external view override returns (uint256) {
        return _account.balance;
    }

    receive() external payable {
        emit Donation(msg.sender, msg.value);
    }
}
