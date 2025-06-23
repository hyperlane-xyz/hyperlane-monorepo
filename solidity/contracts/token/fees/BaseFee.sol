// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {ITokenFee, Quote} from "../../interfaces/ITokenBridge.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

enum FeeType {
    ZERO,
    LINEAR,
    REGRESSIVE,
    PROGRESSIVE
}

abstract contract BaseFee is Ownable, ITokenFee {
    address public immutable token;
    uint256 public immutable maxFee;
    uint256 public immutable halfAmount;

    constructor(
        address _token,
        uint256 _maxFee,
        uint256 _halfAmount,
        address _owner
    ) Ownable() {
        token = _token;
        maxFee = _maxFee;
        halfAmount = _halfAmount;
        _transferOwnership(_owner);
    }

    function claim(address beneficiary) external onlyOwner {
        if (token == address(0)) {
            payable(beneficiary).transfer(address(this).balance);
        } else {
            uint256 balance = IERC20(token).balanceOf(address(this));
            IERC20(token).transfer(beneficiary, balance);
        }
    }

    function quoteTransferRemote(
        uint32 /*_destination*/,
        bytes32 /*_recipient*/,
        uint256 _amount
    ) external view override returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote(token, _quoteTransfer(_amount));
    }

    function _quoteTransfer(
        uint256 _amount
    ) internal view virtual returns (uint256 fee);

    function feeType() external view virtual returns (FeeType);

    receive() external payable {}
}
