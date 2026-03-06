// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

//DST = Data Sent Token (Name similar to BAT - Basic Attention Token handled by Brave Browser)
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract DataSentTokenContract is ERC20, Ownable {
    constructor(uint256 initialSupply) ERC20("DataSentToken", "DST") Ownable(msg.sender) {
        _mint(msg.sender, initialSupply);
    }

    // Funzione per coniare nuovi token (solo dal proprietario)
    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }

    // Funzione per bruciare i token
    function burn(uint256 amount) public {
        _burn(msg.sender, amount);
    }
}