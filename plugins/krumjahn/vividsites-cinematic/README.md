# VividSites cinematic landing pages

Choose a cinematic design from the VividSites library, compare real previews,
then turn the selected build prompt and editable UI components into a landing
page in your existing project. Maintained by [VividSites / krumjahn](https://github.com/krumjahn).

**Requires a paid VividSites library account and personal API key.** All six MCP
tools require paid access, including search and previews. Your MiniMax subscription
does not include VividSites access. This plugin does not run VividSites Create,
publish a site, generate media, buy credits, or initiate payments.

## Try it

```text
Use VividSites to build a cinematic landing page for a boutique architecture
studio. Keep this project's framework, compare three dark editorial designs,
choose the closest fit, and implement it with a clear consultation CTA and
reduced-motion support. Use existing library assets; do not deploy it.
```

Expected result: real template candidates and preview links, a selected design,
and local project changes based on its build prompt, with responsive and
accessibility checks. This requires both a working MCP connection and the host's
usual editing/preview tools. For discovery only, try:

```text
Find three VividSites cinematic landing-page designs for a luxury travel brand.
Show previews and explain the differences. Do not edit files or fetch build prompts.
```

## Setup and requirements

1. Use MiniMax Code with Skills and global remote MCP settings. The package includes
   portable Agent Plugins 1.0 and `.claude-plugin/plugin.json` metadata. The latter
   points at `./skills`, relative to the plugin root as resolved by the published
   0.7.4 loader. `skills/SKILL.md` and `skills/vividsites-cinematic/SKILL.md` are
   identical copies for the two discovery layouts. See [validation](VALIDATION.md)
   for tested scope; installation and authenticated MiniMax execution are not yet verified.
2. Sign in at [VividSites MCP setup](https://www.vividsites.app/mcp?utm_source=minimax&utm_medium=plugin&utm_campaign=cinematic-landing-page).
   A [paid library plan](https://www.vividsites.app/pricing?utm_source=minimax&utm_medium=plugin&utm_campaign=cinematic-landing-page)
   or active AppSumo library entitlement is required. Create build credits alone
   do not grant library access. Obtain your personal key through that account.
3. In MiniMax's **global MCP settings**, add server `vividsites`, transport
   **Streamable HTTP**, URL `https://www.vividsites.app/api/connector`, and header
   `Authorization` with value `Bearer <your personal API key>`. Enter the real key
   only in the host's private credential/settings controls, never in chat or Git.
   [configs/mcp.example.json](configs/mcp.example.json) records the endpoint and
   transport; it intentionally contains no credential and is not auto-loaded.
4. Install/enable this plugin through your MiniMax build's plugin manager, then
   reload and check that VividSites tools appear. Keep tool approvals enabled.
   If the client cannot configure private API-key headers, it cannot use this
   connector. Do not choose anonymous authentication or put the key in the URL.

Why a separate connection: the portable plugin format has no per-user secret
reference and no generic OAuth setup. Shipping a root `mcp.json` without auth
would create an unusable anonymous connection. This package follows the community
TickTick plugin's global-MCP setup pattern rather than embedding a key or adding
a proxy. There is no OAuth flow in this connector package.

No plugin-specific executable, installer, package dependency, native binary,
background process, or hook is required. It is platform-neutral text/configuration
for MiniMax Code on macOS, Linux, and Windows; only macOS static/local checks have
been performed. The host itself needs its normal runtime, account/provider access,
model quota, and project build dependencies. Those services may charge separately.

## Tools and limits

| Tool | Use |
| --- | --- |
| `search_sites` | Find matching website designs |
| `get_template_preview` | Get library, poster, video, and available live-preview links |
| `get_build_prompt` | Retrieve build instructions and assets for a selected design |
| `search_components` | Find editable UI or 3D components |
| `get_component` | Retrieve component source and dependency information |
| `video_prompt_formula` | Retrieve cinematic video-prompt guidance, without generating media |

The names are verified against the maintained connector; authenticated live
execution is pending. The skill uses the host's discovered schemas, not copied
schemas that could drift. Premium prompt retrieval on metered plans consumes the
existing daily allowance shared with the website; other library reads do not.
Legacy `free` catalog labels do not grant free connector access. HTTP 401 denotes
missing/invalid/revoked credentials; 403 denotes no paid entitlement; 503 denotes
an unavailable access check. See the [connector documentation](https://github.com/krumjahn/vividsites-connectors).

## Network and data

- Configured MCP calls go to `https://www.vividsites.app/api/connector`. The host
  sends the API key in the Authorization header, MCP protocol metadata, and the
  requested style queries, slugs, and other tool arguments. The service receives
  normal request metadata such as IP address and can associate usage with the account.
- Search terms and returned design material enter the host's model context under
  its normal provider policy. The skill does not require uploading project files,
  customer records, or whole conversations to VividSites.
- Opening VividSites setup, pricing, support, or preview links makes ordinary
  browser requests to `www.vividsites.app`. Preview/media fetching or use in a
  generated page may also contact asset/CDN or live-preview hosts returned by
  the service, including Supabase public storage. Inspect those URLs and dependencies
  before using them; third-party assets remain subject to their own policies.
- The plugin ships no telemetry code. VividSites records service usage, including
  prompt/component delivery and access/quota events, under its existing
  [privacy policy](https://www.vividsites.app/privacy) and
  [terms](https://www.vividsites.app/terms). It does not promise zero server logging.
- Informational website links use fixed `utm_source=minimax`, `utm_medium=plugin`,
  and `utm_campaign=cinematic-landing-page` tags. They identify the distribution
  source, not an individual. No new backend or data collection is introduced by
  this contribution. Tags are not added to MCP calls, asset URLs, or users' sites;
  they do not by themselves prove MCP tool-use or sales attribution.

## License and support

Original skill, configuration, and documentation in this directory use the MIT
license in [LICENSE](LICENSE). No proprietary catalog assets are bundled or
relicensed. Retrieved content retains its own terms; the VividSites name/logo
remain trademarks and no paid access is granted by the open-source license.

[Support](https://www.vividsites.app/support) · [Validation evidence](VALIDATION.md)
