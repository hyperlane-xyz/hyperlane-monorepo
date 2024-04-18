pragma solidity >=0.8.0;

import {IFiatToken} from "./IFiatToken.sol";
import {HypERC20Collateral} from "./HypERC20Collateral.sol";

contract HypFiatTokenCollateral is HypERC20Collateral {
    constructor(
        address _fiatToken,
        address _mailbox
    ) HypERC20Collateral(_fiatToken, _mailbox) {}

    function _transferFromSender(
        uint256 _amountOrId
    ) internal override returns (bytes memory) {
        IFiatToken(address(wrappedToken)).burn(_amountOrId);
        return "";
    }

    function _transferTo(
        address _recipient,
        uint256 _amountOrId,
        bytes calldata /*metadata*/
    ) internal override {
        IFiatToken(address(wrappedToken)).mint(_recipient, _amountOrId);
    }
}
