# @pipeworx/gbizinfo

Japanese corporate registry — company profiles, government procurement awards, subsidies, patents, certifications, financials and workplace disclosure, keyed on the 13-digit 法人番号 (corporate number). Source: [gBizINFO](https://info.gbiz.go.jp/), Ministry of Economy, Trade and Industry (METI).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Tools

- `gbiz_company_search(name?, prefecture?, city?, corporate_type?, has?, capital_min?, capital_max?, employees_min?, employees_max?, founded_year?, limit?, page?, _apiKey)` — find companies and their corporate numbers.
- `gbiz_company_profile(corporate_number, _apiKey)` — registry profile: legal name, kana and romanised forms, address, representative director, capital, headcount, establishment date, business summary, website, dissolution.
- `gbiz_company_procurement(corporate_number, limit?, _apiKey)` — Japanese government contracts awarded: order date, title, amount in yen, awarding ministry.
- `gbiz_company_subsidies(corporate_number, limit?, _apiKey)` — subsidies and grants received: approval date, programme, amount, granting ministry.
- `gbiz_company_records(corporate_number, kind, limit?, _apiKey)` — `patent`, `certification`, `commendation`, `finance` or `workplace`.

  **The five kinds do not share one response shape.** `patent`, `certification` and `commendation` come back as a LIST under a key matching the kind, with `returned` and `total_on_record` counts. `finance` and `workplace` are ONE record per company, so they come back as an OBJECT — `finance` under `finance` (accounting standards, the fiscal-year cover page, a `management_index` period series and `major_shareholders`), and workplace statistics under **`workplace_info`**, whose key deliberately does not match its `workplace` kind because that is what the upstream returns. For the object kinds `limit` caps the arrays nested inside, and `total_on_record` is a per-array map rather than a single number.

## Auth

**Platform key, since 2026-09-13 (fleet #1940).** The gateway holds `PLATFORM_GBIZINFO_KEY` and injects it, so callers need no key of their own. `_apiKey` is still accepted for anyone who would rather use their own token and its own quota.

It shipped BYOK-only first, with `platformKeyEnv` deliberately absent, so the gateway's `keyBlockedTools()` sank these tools from routing while no key existed — an honest `no_match` beats routing Japanese-company questions to a tool that can only refuse. The secret and `platformKeyEnv` landed in the same change, which is the rule that ordering exists to enforce (the `fda-inspections` precedent, fleet #617).

To use your own token, register free at <https://info.gbiz.go.jp/hojin/various_registration/form>. **A non-Japanese applicant can register**: the form's 利用者区分 radio offers 法人担当者 (corporate — wants a 13-digit 法人番号, Japanese company name, department, postcode, address and phone) and **個人利用者 (individual), for which the required fields are just email, password, purpose and the two consent boxes.** This is the distinction that makes gBizINFO usable where the NTA 法人番号 API is not — that one's application path requires a Japanese corporate number with no individual alternative. The token arrives by email.

The public OpenAPI document at `https://api.info.gbiz.go.jp/hojin/v3/api-docs?group=v2` embeds a token in `info.description`. The same sentence says, in Japanese, that it is for checking behaviour on the Swagger page only. It is useful for reading response shapes while building. It is not a credential to ship, and this pack does not carry it.

## Upstream behaviour worth knowing

- **A missing token is HTTP 500, not 401.** Omit the header and gBizINFO answers `500 - Internal Server Error.`; a *wrong* token answers a clean 401. Passed through, a missing credential reads as an upstream outage. Translated to an auth refusal here.
- **The host is `api.info.gbiz.go.jp` and the version is v2.** The bare `info.gbiz.go.jp` answers `/hojin/v1/...` with the *same* 500/401 signature, so it looks like a working base until you try v2 there and get an HTML 404.
- **No results is HTTP 404** — the same status and the same body as a corporate number that does not exist and as a malformed one. On a search that means zero matches, which is a normal answer; only a by-number lookup may report it as not-found.
- **The response carries no total.** The envelope is `{id, errors, message, hojin-infos}` and nothing else — no count, no next-page marker. `limit` caps at 5000 and `page` at 10. Nothing here claims a total it was not given; a search reports `more_pages_possible` instead.
- **A 200 with an empty array is the normal way of saying a real company has none of that record type.** Toyota's `/subsidy` is empty. Don't use a company like that as a smoke test — it banks a passing test that proves nothing. `苫小牧市` (1000020012131) has 61 subsidies.

### Company names are accepted wherever a corporate number is

`gbiz_company_profile`, `gbiz_company_procurement`, `gbiz_company_subsidies` and `gbiz_company_records` all take either the 13-digit 法人番号 or the company name, and a resolved name comes back as `resolved_from`. This is not a convenience. Measured the day the platform key landed: `ask_pipeworx` sent *"what Japanese government procurement contracts has Toyota Motor received?"* straight to `gbiz_company_procurement` with a non-numeric argument, because a router picks the tool whose **description** matches the question, not the one whose argument the caller happens to hold. Telling it in prose to call `gbiz_company_search` first does not change that.

The match strips the corporate-form token before comparing — the registered name is トヨタ自動車株式会社, so a bare `トヨタ自動車` matched ten filers exactly until that normalisation existed, and 株式会社 appears before or after the name depending on the company. A name matching several filers **refuses and lists them** rather than taking the first: answering confidently about the wrong company is the failure this pack is most careful about.

### The trap that bites callers, not builders

**A Latin-script name search does not find the company you mean.** `name=Toyota` matches the *romanised* name field, which most Japanese companies leave empty and which is dominated by municipal bodies — it returns 豊田市稲橋財産区 ("Toyota City Inahashi property ward"), not トヨタ自動車株式会社, with a clean 200. `name=トヨタ自動車` returns the carmaker. The tool description says so, and a Latin-script query comes back with a `match_note` saying which field it actually matched. For a specific company the corporate number is the reliable key.

## Data sources

- REST API v2: `https://api.info.gbiz.go.jp/hojin/v2/` — spec at `https://api.info.gbiz.go.jp/hojin/v3/api-docs?group=v2`, Swagger UI at <https://api.info.gbiz.go.jp/hojin/swagger-ui/index.html?urls.primaryName=v2>
- Publisher: 経済産業省 / METI (corporate number 4000012090001), <https://info.gbiz.go.jp/>

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "gbizinfo": {
      "url": "https://gateway.pipeworx.io/gbizinfo/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/gbizinfo/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "gbizinfo": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-gbizinfo"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-gbizinfo
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Gbizinfo data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
