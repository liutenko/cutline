// Generated from artifacts/contracts/Scorecard.sol/Scorecard.json. Run: npm run abi
export const scorecardAbi = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "operator_",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [
      {
        "internalType": "uint8",
        "name": "status",
        "type": "uint8"
      }
    ],
    "name": "BadStatus",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "LengthMismatch",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotOperator",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "roundId",
        "type": "uint256"
      }
    ],
    "name": "RoundAlreadyClosed",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "agentId",
        "type": "bytes32"
      }
    ],
    "name": "UnknownAgent",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "agentId",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "string",
        "name": "name",
        "type": "string"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "agentAddr",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "string",
        "name": "strategy",
        "type": "string"
      }
    ],
    "name": "AgentRegistered",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "roundId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "agentId",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "int256",
        "name": "pnlBps",
        "type": "int256"
      },
      {
        "indexed": false,
        "internalType": "uint8",
        "name": "status",
        "type": "uint8"
      }
    ],
    "name": "AgentResult",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "roundId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "feed",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "int256",
        "name": "onchainAnswer",
        "type": "int256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "updatedAt",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "int256",
        "name": "offchainPrice",
        "type": "int256"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "readOk",
        "type": "bool"
      }
    ],
    "name": "PriceStamp",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "roundId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "stateHash",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "timestamp",
        "type": "uint256"
      }
    ],
    "name": "RoundClosed",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "agentCount",
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
        "internalType": "uint256",
        "name": "i",
        "type": "uint256"
      }
    ],
    "name": "agentIdAt",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "roundId",
        "type": "uint256"
      },
      {
        "internalType": "bytes32[]",
        "name": "ids",
        "type": "bytes32[]"
      },
      {
        "internalType": "int256[]",
        "name": "pnlBps",
        "type": "int256[]"
      },
      {
        "internalType": "uint8[]",
        "name": "status",
        "type": "uint8[]"
      },
      {
        "internalType": "bytes32",
        "name": "stateHash",
        "type": "bytes32"
      },
      {
        "internalType": "address[]",
        "name": "feeds",
        "type": "address[]"
      },
      {
        "internalType": "int256[]",
        "name": "offchainPrices",
        "type": "int256[]"
      }
    ],
    "name": "closeRound",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "agentId",
        "type": "bytes32"
      }
    ],
    "name": "getAgent",
    "outputs": [
      {
        "internalType": "string",
        "name": "name",
        "type": "string"
      },
      {
        "internalType": "address",
        "name": "agentAddr",
        "type": "address"
      },
      {
        "internalType": "string",
        "name": "strategy",
        "type": "string"
      },
      {
        "internalType": "bool",
        "name": "exists",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "agentId",
        "type": "bytes32"
      }
    ],
    "name": "getRecord",
    "outputs": [
      {
        "components": [
          {
            "internalType": "uint32",
            "name": "roundsPlayed",
            "type": "uint32"
          },
          {
            "internalType": "uint32",
            "name": "roundsFunded",
            "type": "uint32"
          },
          {
            "internalType": "uint32",
            "name": "timesCut",
            "type": "uint32"
          },
          {
            "internalType": "int256",
            "name": "cumulativePnlBps",
            "type": "int256"
          },
          {
            "internalType": "int256",
            "name": "bestPnlBps",
            "type": "int256"
          },
          {
            "internalType": "uint256",
            "name": "lastRoundId",
            "type": "uint256"
          }
        ],
        "internalType": "struct Scorecard.Record",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "operator",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "agentId",
        "type": "bytes32"
      },
      {
        "internalType": "string",
        "name": "name",
        "type": "string"
      },
      {
        "internalType": "address",
        "name": "agentAddr",
        "type": "address"
      },
      {
        "internalType": "string",
        "name": "strategy",
        "type": "string"
      }
    ],
    "name": "registerAgent",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "roundId",
        "type": "uint256"
      }
    ],
    "name": "roundClosed",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
] as const;
