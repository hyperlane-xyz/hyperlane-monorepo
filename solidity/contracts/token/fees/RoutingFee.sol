// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {ITokenFee, Quote} from "../../interfaces/ITokenBridge.sol";
import {BaseFee, FeeType} from "./BaseFee.sol";

/**
 * @title RoutingFee
 * @notice Implements ITokenFee, allowing per-destination fee contracts. Returns 0 fee for destinations not configured.
 */
contract RoutingFee is BaseFee {
    constructor(
        address _token,
        address _owner
    ) BaseFee(_token, type(uint256).max, type(uint256).max, _owner) {}

    mapping(uint32 destination => address feeContract) public feeContracts;

    event FeeContractSet(uint32 destination, address feeContract);

    /**
     * @notice Sets the fee contract for a specific destination chain.
     * @param destination The destination chain ID.
     * @param feeContract The address of the ITokenFee contract for this destination.
     */
    function setFeeContract(
        uint32 destination,
        address feeContract
    ) external onlyOwner {
        feeContracts[destination] = feeContract;
        emit FeeContractSet(destination, feeContract);
    }

    /**
     * @inheritdoc ITokenFee
     * @dev Returns a zero-amount Quote if no fee contract is set for the destination.
     */
    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view override returns (Quote[] memory quotes) {
        address feeContract = feeContracts[_destination];
        if (feeContract != address(0)) {
            return
                ITokenFee(feeContract).quoteTransferRemote({
                    _destination: _destination,
                    _recipient: _recipient,
                    _amount: _amount
                });
        }
        quotes = new Quote[](0);
    }

    function feeType() external pure override returns (FeeType) {
        return FeeType.ROUTING;
    }
}
