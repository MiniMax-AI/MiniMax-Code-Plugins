# BrewPage

Publish HTML, Markdown, static sites, files, JSON and key-value data from MiniMax Code and share the resulting HTTPS link. The plugin connects directly to the hosted BrewPage MCP server at `https://brewpage.app/mcp` over Streamable HTTP.

## Try it

```text
Publish this Markdown as an unlisted BrewPage page that expires in one day. Return just the reader link.

# Next release
The import preview is ready for review.
```

MiniMax Code can call `publish` with the supplied content and return a working reader URL. Anyone who receives that URL can open the page. Keep the owner token and management link private for later updates or deletion.

## Requirements

Use MiniMax Code with remote MCP support and an internet connection. The portable manifest and the 0.4-compatible manifest both select the same hosted endpoint. The plugin runs on platforms supported by MiniMax Code, needs no additional executable and requires no BrewPage account, API key or payment for anonymous publication. MiniMax Code's own model access is separate.

BrewPage MCP 3.0.0 exposes 13 tools, including `publish`, `update_publication`, `read_page_data` and `domains`. The hosted service also supports optional account connection through OAuth in compatible clients. This plugin uses the anonymous connection by default. [Tool reference and local stdio alternative](https://github.com/kochetkov-ma/brewpage-openapi/tree/v3.0.0/mcp-server#quick-start)

## Data and network

MiniMax Code sends the content and options you choose to `https://brewpage.app/mcp`. BrewPage hosts the submitted material and returns a reader link. For file publication from a URL, BrewPage retrieves the file from the public URL supplied in the request. A public listing can be requested explicitly. This plugin contains no scripts or telemetry. [BrewPage privacy policy](https://brewpage.app/privacy)

The MIT license covers these plugin files. The BrewPage hosting service is operated separately. [Public source for the portable manifests and license](https://github.com/kochetkov-ma/brewpage-publish-plugins/tree/585373a578d70135a86f967270e1da4e3caf8df2/agent-plugin)
