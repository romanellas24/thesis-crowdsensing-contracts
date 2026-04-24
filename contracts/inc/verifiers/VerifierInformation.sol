// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

    struct VerifierInformation {
        uint256 lastVerified;
        uint256 verifyingData;
        uint256 bondBalance;
        bool hasVerified;
        bool isVerifying;
    }
