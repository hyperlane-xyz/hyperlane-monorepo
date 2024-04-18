pragma solidity >=0.8.0;

import {IFiatToken} from "./IFiatToken.sol";
import {TokenRouter} from "./libs/TokenRouter.sol";

contract HypFiatTokenCollateral is TokenRouter {
    IFiatToken public immutable fiatToken;

    constructor(address _fiatToken, address _mailbox) TokenRouter(_mailbox) {
        fiatToken = IFiatToken(_fiatToken);
    }

    function _transferFromSender(
        uint256 _amountOrId
    ) internal override returns (bytes memory) {
        fiatToken.burn(_amountOrId);
        return "";
    }

    function _transferTo(
        address _recipient,
        uint256 _amountOrId,
        bytes calldata /*metadata*/
    ) internal override {
        fiatToken.mint(_recipient, _amountOrId);
    }

    function balanceOf(
        address _account
    ) external view override returns (uint256) {
        return fiatToken.balanceOf(_account);
    }
}
