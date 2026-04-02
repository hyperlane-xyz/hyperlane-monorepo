// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

interface IPredicateWrapper {
    error IPredicateWrapper__UnauthorizedTransfer();
    error IPredicateWrapper__InvalidRegistry();
    error IPredicateWrapper__InvalidPolicy();
    error IPredicateWrapper__WithdrawFailed();
    error IPredicateWrapper__AttestationInvalid();
    error IPredicateWrapper__InsufficientValue();
    error IPredicateWrapper__PostDispatchNotExecuted();
    error IPredicateWrapper__RefundFailed();
    error IPredicateWrapper__ReentryDetected();
}
