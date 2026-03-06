// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

    struct VerificationSlot {
        address verifier;
        bool result;
        bool completed;
        uint256 deadline;
    }