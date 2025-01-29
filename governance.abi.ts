export default [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_initiative",
        "type": "address"
      }
    ],
    "name": "claimForInitiative",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "epoch",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_initiative",
        "type": "address"
      }
    ],
    "name": "getInitiativeState",
    "outputs": [
      {
        "internalType": "enum IGovernance.InitiativeStatus",
        "name": "status",
        "type": "uint8"
      },
      {
        "internalType": "uint256",
        "name": "lastEpochClaim",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "claimableAmount",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
] as const;
