// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

    struct SenderInformation {
        uint256 bondBalance;
        uint dataSubmitted;
        uint validData;
        uint invalidData;
        bool bondPaid;
    }
