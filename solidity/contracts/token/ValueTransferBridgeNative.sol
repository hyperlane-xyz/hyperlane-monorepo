// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {HypNative} from "./HypNative.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {TokenMessage} from "./libs/TokenMessage.sol";
import {TokenRouter} from "./libs/TokenRouter.sol";
import {Quotes, IValueTransferBridge} from "../interfaces/IValueTransferBridge.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title Native/ERC20 tokens L2 to L1 value transfer abstraction
 * @author Substance Labs
 * @dev Derives from the Hyperlane native token router, but supports
 * transfer of ERC20 token value
 */
abstract contract ValueTransferBridgeNative is HypNative {
    using TypeCasts for bytes32;
    using TypeCasts for address;
    using TokenMessage for bytes;

    uint32 constant HOOK_METADATA_GAS_LIMIT = 450_000;

    // L2 bridge used to initiate the withdrawal
    address public l2Bridge; // TODO: immutable
    // L1 domain where the withdrawal will be finalized
    uint32 public immutable l1Domain;

    error NotImplemented();

    /**
     * @dev see MailboxClient's initializer for other configurables
     */
    constructor(
        uint32 _l1Domain,
        address _l2Bridge,
        address _mailbox
    ) HypNative(_mailbox) {
        l1Domain = _l1Domain;
        l2Bridge = _l2Bridge;
        _transferOwnership(_msgSender()); // TODO: remove
    }

    function setL2Bridge(address _l2Bridge) external onlyOwner {
        l2Bridge = _l2Bridge;
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view virtual returns (Quotes[] memory quotes) {
        uint256 quoteAmount = _Router_quoteDispatch(
            l1Domain,
            _getQuoteTokenMessage(),
            _overrideGasLimit(),
            address(hook)
        ) +
            _l2BridgeQuoteTransferRemote(
                l1Domain,
                _recipient,
                _amount,
                _l2BridgeExtraData()
            );

        quotes = new Quotes[](1);
        quotes[0] = Quotes(address(0), quoteAmount);
    }

    function transferRemote(
        uint32 /* _destination */,
        bytes32 /* _recipient */,
        uint256 /* _amount */,
        bytes calldata /* _hookMetadata */,
        address /* _hook */
    ) external payable override returns (bytes32) {
        revert NotImplemented();
    }

    function _transferFromSender(
        uint256 _amountOrId
    ) internal override returns (bytes memory metadata) {
        metadata = _l2BridgeTransferRemote(
            l1Domain,
            _mustHaveRemoteRouter(l1Domain),
            _amountOrId,
            _l2BridgeExtraData()
        );
    }

    function _l2BridgeExtraData() internal view virtual returns (bytes memory) {
        return bytes("");
    }

    function _getQuoteTokenMessage() internal view returns (bytes memory) {
        return TokenMessage.format(bytes32(0), 0, _l2BridgeExtraData());
    }

    /**
     * @notice Implements the value transfer (through a withdrawal) on L2
     * @param _destination destination domain
     * @param _recipient the receiver of the funds
     * @param _amount amount to transfer
     * @param _extraData data to send within the withdrawal operation
     */
    function _l2BridgeTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes memory _extraData
    ) internal virtual returns (bytes memory metadata);

    /**
     * @notice Returns the rollup bridge fees needed to perform the tranfer to L1
     * @param _destination destination domain
     * @param _recipient the receiver of the funds
     * @param _amount amount to transfer
     */
    function _l2BridgeQuoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes memory _extraData
    ) internal view virtual returns (uint256) {
        return 0;
    }

    function _overrideGasLimit() internal view returns (bytes memory) {
        return StandardHookMetadata.overrideGasLimit(HOOK_METADATA_GAS_LIMIT);
    }
}
