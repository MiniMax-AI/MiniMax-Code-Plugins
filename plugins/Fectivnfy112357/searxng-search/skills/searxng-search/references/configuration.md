# SearXNG configuration reference

Use this document when you need to:

- set up the skill for the first time
- change the SearXNG instance or auth settings
- debug configuration/auth/setup errors from `scripts/search.py`

## Config file locations

The script reads configuration from:

1. `$XDG_CONFIG_HOME/agents/searxng.toml`
2. If `XDG_CONFIG_HOME` is not set, it defaults to `~/.config/agents/searxng.toml`
3. If the TOML file does not exist, the script falls back to the legacy JSON file at `$XDG_CONFIG_HOME/agents/searxng.json`

In practice, the common paths are:

- `~/.config/agents/searxng.toml`
- `~/.config/agents/searxng.json` (legacy fallback)

## Supported fields

| Field | Type | Required | Description |
|---|---|---|---|
| `base_url` | `string` | **Yes** | Base URL of the SearXNG instance, for example `https://searx.example.com` |
| `auth` | `object` | No | Authentication config |
| `auth.type` | `string` | If `auth` is set | Must be `"bearer"` or `"basic"` |
| `auth.token` | `string` | If `auth.type = "bearer"` | Bearer token value; supports `$ENV_VAR` or `${ENV_VAR}` |
| `auth.user` | `string` | If `auth.type = "basic"` | Basic auth username; supports `$ENV_VAR` or `${ENV_VAR}` |
| `auth.pass` | `string` | If `auth.type = "basic"` | Basic auth password; supports `$ENV_VAR` or `${ENV_VAR}` |
| `headers` | `object` | No | Extra HTTP headers to send with the request |
| `default_language` | `string` | No | Default language code, for example `en` or `zh-CN` |
| `default_categories` | `string[]` | No | Default categories, for example `["general", "news"]` |
| `default_engines` | `string[]` | No | Default engines, for example `["google", "duckduckgo"]` |
| `default_safesearch` | `number` | No | Default safe search level: `0`, `1`, or `2` |
| `default_time_range` | `string` | No | Default time range: `"day"`, `"month"`, or `"year"` |
| `default_max_results` | `number` | No | Default number of results to display; script default is `5` |
| `timeout` | `number` | No | Request timeout in seconds; script default is `30` |

## Example TOML config: bearer auth

```toml
base_url = "https://searx.example.com"
default_categories = ["general"]
default_engines = ["google", "duckduckgo", "brave"]
default_max_results = 10

[auth]
type = "bearer"
token = "your-token-here"

[headers]
X-Custom-Header = "value"
```

## Example TOML config: bearer auth with environment variable

```toml
base_url = "https://searx.example.com"
default_categories = ["general"]

[auth]
type = "bearer"
token = "$SEARXNG_TOKEN"
```

Then export the variable before running the script:

```bash
export SEARXNG_TOKEN='your-token-here'
```

## Example TOML config: basic auth

```toml
base_url = "https://searx.example.com"
default_safesearch = 1

[auth]
type = "basic"
user = "admin"
pass = "password"
```

## Example TOML config: basic auth with environment variables

```toml
base_url = "https://searx.example.com"

[auth]
type = "basic"
user = "$SEARXNG_USER"
pass = "$SEARXNG_PASS"
```

```bash
export SEARXNG_USER='admin'
export SEARXNG_PASS='password'
```

## Legacy JSON fallback

If `searxng.toml` does not exist, the script still supports the old JSON format.

```json
{
  "base_url": "https://searx.example.com",
  "default_categories": ["general"],
  "default_engines": ["google", "duckduckgo"],
  "default_max_results": 10,
  "auth": {
    "type": "bearer",
    "token": "$SEARXNG_TOKEN"
  },
  "headers": {
    "X-Custom-Header": "value"
  }
}
```

## Troubleshooting

### `ERROR: Config file not found: ...`

The config file is missing from the expected path.

Checks:

- confirm whether `XDG_CONFIG_HOME` is set
- create `~/.config/agents/searxng.toml` if you do not use a custom XDG path
- if you are still using the old JSON config, make sure the TOML file is absent and the JSON file exists at the fallback path

Minimum working TOML:

```toml
base_url = "https://your-searxng-instance.com"
```

### `ERROR: TOML config found at ... but this Python does not support TOML.`

Your Python is too old for `tomllib`.

Fix one of these:

- use Python 3.11+
- remove/rename `searxng.toml` and use the legacy JSON fallback instead

### `ERROR: Invalid TOML in ...` / `ERROR: Invalid JSON in ...`

The config file has syntax errors.

Checks:

- validate commas, quotes, and brackets in JSON
- validate table syntax (`[auth]`, `[headers]`) and string quoting in TOML
- make sure arrays look like `["general", "news"]`

### `ERROR: base_url is required in ...`

Add a `base_url` value.

Example:

```toml
base_url = "https://searx.example.com"
```

Use the SearXNG instance root URL. The script will normalize trailing slashes automatically.

### `ERROR: Environment variable SOME_VAR is not set`

You referenced an env var in `auth.token`, `auth.user`, or `auth.pass`, but it is not exported in the current shell.

Fix:

```bash
export SOME_VAR='value'
```

Then rerun the command from the same shell/session.

### `ERROR: auth.token required for bearer auth`

You set `auth.type = "bearer"` but did not provide `auth.token`.

Example:

```toml
[auth]
type = "bearer"
token = "$SEARXNG_TOKEN"
```

### `ERROR: auth.user and auth.pass required for basic auth`

You set `auth.type = "basic"` but one or both credentials are missing.

Example:

```toml
[auth]
type = "basic"
user = "$SEARXNG_USER"
pass = "$SEARXNG_PASS"
```

### `ERROR: Unknown auth.type '...'`

Only these auth modes are supported:

- `bearer`
- `basic`

Correct typos or remove `auth` entirely if the instance does not require authentication.

### `ERROR: HTTP 401: ...` / `ERROR: HTTP 403: ...`

The request reached the server, but auth or access control failed.

Checks:

- verify `auth.type`
- verify the bearer token or basic auth credentials
- verify any required custom headers under `headers`
- confirm your SearXNG instance allows API access from your environment

### `ERROR: Request failed: ...`

This is usually a network, DNS, TLS, or connectivity problem.

Checks:

- verify `base_url`
- make sure the instance is reachable from your machine
- check VPN, proxy, DNS, or certificate issues

### `ERROR: Invalid JSON response from SearXNG`

The endpoint responded, but not with valid JSON. This often means the URL points to the wrong place or a proxy/login page returned HTML.

Checks:

- verify `base_url` points to the SearXNG instance root
- confirm the instance supports `/search?format=json`
- check whether a reverse proxy or SSO page is intercepting the request

### `ERROR: SearXNG returned error: ...`

The server returned a structured API error.

Checks:

- inspect the error text
- verify query parameters and instance settings
- try the same instance in a browser or with `curl` to confirm the backend is healthy

## Quick setup checklist

1. Create `~/.config/agents/searxng.toml`
2. Set `base_url`
3. Add auth only if your instance requires it
4. Export any referenced environment variables
5. Run a smoke test:

```bash
python3 scripts/search.py "SearXNG documentation"
```
