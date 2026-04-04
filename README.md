# ae-mcp-plugin

Claude Code MCP server for Adobe After Effects. Lets Claude Code read AE project data, inspect layers and expressions, execute ExtendScript, validate JSX files, monitor renders, and share state across sessions.

## Architecture

```
Claude Code <--(stdio/MCP)--> MCP Server (Node.js) <--(WebSocket)--> CEP Panel (inside AE) <--(evalScript)--> ExtendScript
```

## Quick Start

### 1. Enable unsigned extensions

```bat
scripts\enable-unsigned.bat
```

### 2. Install CEP panel into After Effects

```bat
scripts\install.bat
```

### 3. Build the MCP server

```bat
scripts\build.bat
```

### 4. Add to Claude Code config

Add to `~/.claude.json` (or `~/.claude/.mcp.json`):

```json
{
  "mcpServers": {
    "ae-bridge": {
      "command": "node",
      "args": ["C:/Users/aliba/Downloads/Apollova/ae-mcp-plugin/packages/mcp-server/dist/index.js"]
    }
  }
}
```

### 5. Restart After Effects

Open the panel: **Window > Extensions > AE MCP Bridge**

The status dot turns green when Claude Code connects.

## MCP Tools

### Project Inspection
| Tool | Description |
|------|-------------|
| `ae_get_project_info` | Project name, path, AE version, item counts |
| `ae_list_comps` | List compositions (optional regex filter) |
| `ae_search_project` | Search items by name/type |

### Layer Inspection
| Tool | Description |
|------|-------------|
| `ae_list_layers` | List layers in a comp with type, in/out points |
| `ae_get_layer_properties` | Transform, source text, effects, source info |

### Expressions
| Tool | Description |
|------|-------------|
| `ae_get_expressions` | Get all expressions on a layer or entire comp |
| `ae_eval_expression_at_time` | Evaluate a property at a specific time |

### Script Execution
| Tool | Description |
|------|-------------|
| `ae_eval_extendscript` | Run arbitrary ExtendScript code |
| `ae_run_jsx_file` | Execute a JSX file from disk |
| `ae_validate_jsx_file` | Syntax check + optional dry-run via undo |

### Render Queue
| Tool | Description |
|------|-------------|
| `ae_get_render_queue` | List render queue items with status |
| `ae_monitor_render` | Poll until renders complete or timeout |
| `ae_check_output` | Verify render output files exist |

### Cross-Session Context
| Tool | Description |
|------|-------------|
| `ae_read_shared_context` | Read shared state file |
| `ae_write_shared_context` | Write key-value pair (file-locked) |

Context file location: `%APPDATA%\Apollova\ae-mcp-context.json`

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Watch mode
cd packages/mcp-server && npx vitest
```

### Project Structure

```
ae-mcp-plugin/
├── packages/
│   ├── mcp-server/           # MCP server (TypeScript)
│   │   ├── src/
│   │   │   ├── index.ts      # Entry point (stdio transport)
│   │   │   ├── bridge.ts     # WebSocket client to CEP panel
│   │   │   └── tools/        # 13 MCP tool definitions
│   │   └── tests/            # 79 vitest tests
│   └── cep-panel/            # CEP extension (installed into AE)
│       ├── CSXS/manifest.xml # Extension manifest
│       ├── index.html        # Panel UI
│       ├── js/               # WebSocket server + dispatcher
│       └── jsx/              # ExtendScript functions
└── scripts/                  # Install + build scripts
```

## Requirements

- After Effects 2024 or later
- Node.js 18+
- Windows (CEP symlink requires Windows paths)

## How It Works

1. **CEP Panel** loads inside AE and starts a WebSocket server on `127.0.0.1:9741`
2. **MCP Server** runs as a Node.js process, started by Claude Code via stdio
3. When Claude Code calls a tool (e.g. `ae_list_comps`), the MCP server sends a JSON-RPC request over WebSocket to the CEP panel
4. The CEP panel calls `csInterface.evalScript()` to run ExtendScript inside AE
5. ExtendScript accesses the AE DOM (comps, layers, expressions, render queue) and returns JSON
6. The result flows back: ExtendScript -> CEP panel -> WebSocket -> MCP server -> Claude Code
