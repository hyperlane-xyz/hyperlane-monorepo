// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PackageVersioned} from "../PackageVersioned.sol";
import {Quote, ITokenBridge, ITokenFee} from "../interfaces/ITokenBridge.sol";
import {Quotes} from "./libs/Quotes.sol";

interface ITokenRouteInfo {
    function token() external view returns (address);
}

/**
 * @title TransferRouter
 * @notice A proxy contract that wraps an underlying ITokenBridge (warp route),
 * adding an additional fee layer via an ITokenFee contract before forwarding
 * the transfer to the underlying route.
 * @dev This is NOT a Hyperlane Router — it does not interact with mailboxes directly.
 * It composes an existing warp route with a fee contract.
 */
contract TransferRouter is Ownable, PackageVersioned {
    using SafeERC20 for IERC20;
    using Quotes for Quote[];

    /// @notice The ERC20 token managed by this router
    IERC20 public immutable token;

    /// @notice The fee contract used to quote/charge fees
    address public feeContract;

    event TransferRouted(
        address indexed route,
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount,
        uint256 fee,
        bytes32 messageId
    );

    event FeeContractSet(address feeContract);

    constructor(
        address _token,
        address _feeContract,
        address _owner
    ) Ownable() {
        token = IERC20(_token);

        if (_feeContract != address(0)) {
            require(
                address(ITokenRouteInfo(_feeContract).token()) == _token,
                "fee token mismatch"
            );
        }
        feeContract = _feeContract;
        _transferOwnership(_owner);
    }

    /// @notice Set the fee contract used for fee calculation
    function setFeeContract(address _feeContract) external onlyOwner {
        if (_feeContract != address(0)) {
            require(
                address(ITokenRouteInfo(_feeContract).token()) ==
                    address(token),
                "fee token mismatch"
            );
        }
        feeContract = _feeContract;
        emit FeeContractSet(_feeContract);
    }

    /// @notice Quote the total fees for a remote transfer via the given route
    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        address _route
    ) external view returns (Quote[] memory) {
        require(
            ITokenRouteInfo(_route).token() == address(token),
            "token mismatch"
        );

        // Get underlying route quotes
        Quote[] memory routeQuotes = ITokenFee(_route).quoteTransferRemote(
            _destination,
            _recipient,
            _amount
        );

        if (feeContract == address(0)) {
            return routeQuotes;
        }

        // Get our fee quotes
        Quote[] memory feeQuotes = ITokenFee(feeContract).quoteTransferRemote(
            _destination,
            _recipient,
            _amount
        );

        // Merge fee quotes into route quotes by adding amounts for matching tokens
        // Start with a copy of route quotes
        Quote[] memory merged = new Quote[](routeQuotes.length);
        for (uint256 i = 0; i < routeQuotes.length; i++) {
            merged[i] = routeQuotes[i];
        }

        // For each fee quote, try to merge into an existing entry or append
        uint256 extraCount = 0;
        bool[] memory feeMatched = new bool[](feeQuotes.length);
        for (uint256 i = 0; i < feeQuotes.length; i++) {
            for (uint256 j = 0; j < merged.length; j++) {
                if (merged[j].token == feeQuotes[i].token) {
                    merged[j].amount += feeQuotes[i].amount;
                    feeMatched[i] = true;
                    break;
                }
            }
            if (!feeMatched[i]) {
                extraCount++;
            }
        }

        if (extraCount == 0) {
            return merged;
        }

        // Append unmatched fee quotes
        Quote[] memory result = new Quote[](merged.length + extraCount);
        for (uint256 i = 0; i < merged.length; i++) {
            result[i] = merged[i];
        }
        uint256 idx = merged.length;
        for (uint256 i = 0; i < feeQuotes.length; i++) {
            if (!feeMatched[i]) {
                result[idx++] = feeQuotes[i];
            }
        }

        return result;
    }

    /**
     * @notice Transfer tokens to a remote chain via the given route, charging an additional fee.
     * @dev No reentrancy guard — trusts route input per design decision.
     * The caller is responsible for passing a trusted route address.
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        address _route
    ) external payable returns (bytes32) {
        require(
            ITokenRouteInfo(_route).token() == address(token),
            "token mismatch"
        );

        // Calculate our fee
        uint256 ourFee = 0;
        if (feeContract != address(0)) {
            Quote[] memory feeQuotes = ITokenFee(feeContract)
                .quoteTransferRemote(_destination, _recipient, _amount);
            ourFee = feeQuotes.extract(address(token));
        }

        // Calculate underlying route token needs
        Quote[] memory routeQuotes = ITokenFee(_route).quoteTransferRemote(
            _destination,
            _recipient,
            _amount
        );
        uint256 underlyingNeeds = routeQuotes.extract(address(token));

        // Pull tokens from user
        token.safeTransferFrom(
            msg.sender,
            address(this),
            underlyingNeeds + ourFee
        );

        // Send fee to feeContract
        if (ourFee > 0) {
            token.safeTransfer(feeContract, ourFee);
        }

        // Approve route for underlying needs
        token.forceApprove(_route, underlyingNeeds);

        // Forward to route
        bytes32 messageId = ITokenBridge(_route).transferRemote{
            value: msg.value
        }(_destination, _recipient, _amount);

        // Reset approval
        token.forceApprove(_route, 0);

        emit TransferRouted(
            _route,
            _destination,
            _recipient,
            _amount,
            ourFee,
            messageId
        );

        return messageId;
    }
}
