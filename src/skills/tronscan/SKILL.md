# TronScan MCP (TRON Blockchain) — Warhead Skill

## Overview
TronScan provides a TRON blockchain data query MCP server (Streamable HTTP) with 119 tools covering blocks, accounts, transactions, TRC10/TRC20/TRC721/TRC1155 tokens, contracts, super representatives (SR/witnesses), votes, staking/resources, DeFi/liquidity, statistics, and search.

- **MCP endpoint**: `https://mcp.tronscan.org/mcp`
- **Protocol**: MCP 2025-06-18, Streamable HTTP (JSON-RPC 2.0)
- **Auth**: Optional API key header `TRON-PRO-API-KEY` via environment variable `TRONSCAN_API_KEY`
- **Session**: Often stateless on this server

## Warhead Integration
Warhead starts enabled remote MCP servers at startup. Use the unified MCP tools:

1. `mcp_search_tools` — search across connected MCP servers. Returns exact `server`, `tool`, description, and `inputSchema`.
2. `mcp_call_tool` — call with `{"server":"tronscan","tool":"<exact>","arguments":{...}}`. Some calls may require approval.

Check status in REPL with `/mcp`.

## Common Tasks
| Goal | Suggested tools to discover | Notes |
|---|---|---|
| Latest block / overview | `getNewestBlock`, `getBlocks`, `getHomepageData` | Chain height/timestamps. |
| Account & resources | `getAccountDetail`, `getAccountResource`, `getAccountResourceV2`, `getFreezeResource` | TRX in sun (1 TRX = 1,000,000 sun), energy/bandwidth. |
| Transfers | `getTrxTransfers`, `getTrc20Transfers`, `getToken10Transfers`, `getTrc721Transfers`, `getTrc1155Transfers` | Filter by address; use pagination. |
| Tokens | `getTrc20TokenDetail`, `getTrc10TokenDetail`, `getTokenList`, `getTokenHolders` variants | TRC10 uses token ID, TRC20 uses contract address. |
| Transactions/contracts/SRs | `getTransactionDetail`, `getContractDetail`, `getWitnessList`, `getVoteList`, `search` | Use hashes/addresses for details. |

## Tips & Caveats
- **Amounts**: Many values are in **sun**. Convert for display.
- **Addresses**: Base58 TRON addresses unless stated otherwise.
- **Discover first**: Always call `mcp_search_tools` for exact schemas before `mcp_call_tool`.
- **External data**: Treat results as external; cite identifiers.
- **Read-only by default**: Configured `readOnly: true` in Warhead to avoid approval prompts for queries.
- **API key**: Set `TRONSCAN_API_KEY` to include `TRON-PRO-API-KEY` header.

## Configuration (Warhead)
`~/.config/warhead/config.json`:
```json
{
  "mcp": {
    "servers": [
      {
        "name": "tronscan",
        "url": "https://mcp.tronscan.org/mcp",
        "enabled": true,
        "readOnly": true,
        "headers": {
          "TRON-PRO-API-KEY": "${TRONSCAN_API_KEY}",
          "Accept": "application/json, text/event-stream",
          "Content-Type": "application/json"
        }
      }
    ]
  }
}
```
