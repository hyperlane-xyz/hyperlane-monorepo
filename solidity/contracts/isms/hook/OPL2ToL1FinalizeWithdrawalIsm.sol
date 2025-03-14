// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {AbstractCcipReadIsm} from "../ccip-read/AbstractCcipReadIsm.sol";
import {ICcipReadIsm} from "../../interfaces/isms/ICcipReadIsm.sol";
import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";
import {IOptimismPortal} from "../../interfaces/optimism/IOptimismPortal.sol";
import {IInterchainSecurityModule, ISpecifiesInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";

// TODO: add ownable
contract OPL2ToL1FinalizeWithdrawalIsm is AbstractCcipReadIsm {
    string[] public urls;
    IOptimismPortal public immutable opPortal;

    constructor(string[] memory _urls, address _opPortal) {
        urls = _urls;
        opPortal = IOptimismPortal(_opPortal);
    }

    function getOffchainVerifyInfo(
        bytes calldata _message
    ) external view override {
        revert OffchainLookup(
            address(this),
            urls,
            abi.encodeWithSignature("finalizeWithdrawal(bytes)", _message),
            OPL2ToL1FinalizeWithdrawalIsm.verify.selector,
            _message
        );
    }

    function verify(
        bytes calldata _metadata,
        bytes calldata /* _message */
    ) external returns (bool) {
        // TODO: validate message
        IOptimismPortal.WithdrawalTransaction memory _tx = abi.decode(
            _metadata,
            (IOptimismPortal.WithdrawalTransaction)
        );

        opPortal.finalizeWithdrawalTransaction(_tx);

        return true;
    }

    function setUrls(string[] memory _urls) external {
        urls = _urls;
    }
}
