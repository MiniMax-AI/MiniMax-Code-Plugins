import asyncio
import server

tools = asyncio.run(server.mcp.list_tools())
print("TOOL_COUNT:", len(tools))
for t in tools:
    print(" -", t.name)
