// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

    struct VerificationSlot {
        address verifier;
        uint48 deadline;
        bool result;
        bool completed;
    }