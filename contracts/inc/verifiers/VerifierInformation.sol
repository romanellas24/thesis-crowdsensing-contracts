// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

    struct VerifierInformation {
        uint256 lastVerified;
        bool hasVerified;
        uint256 verifyingData;
        bool isVerifying;
    }
