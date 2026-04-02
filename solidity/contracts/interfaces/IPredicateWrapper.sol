// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

interface IPredicateWrapper {
    error PredicateWrapper__UnauthorizedTransfer();
    error PredicateWrapper__InvalidRegistry();
    error PredicateWrapper__InvalidPolicy();
    error PredicateWrapper__WithdrawFailed();
    error PredicateWrapper__AttestationInvalid();
    error PredicateWrapper__InsufficientValue();
    error PredicateWrapper__PostDispatchNotExecuted();
    error PredicateWrapper__RefundFailed();
    error PredicateWrapper__ReentryDetected();
}
