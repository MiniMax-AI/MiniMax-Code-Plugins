# Bundled dependency alert review

Reviewed the 13 CodeQL alerts introduced by PR #42 against the locked public
package on 2026-09-18. No scanning query, severity threshold, or path exclusion
was changed. The classifications below apply only to these specific findings;
they are not an assurance that these dependencies have no other vulnerabilities.

## Marked 18.0.13: HTML syntax patterns

Alerts #7–14 (`js/bad-tag-filter`) point into copies of Marked in `web/app.js`
and `dist/main.mjs`. They flag lower-case tag names and the comment terminator
`-->` rather than `--!>`.

Those patterns tokenize Markdown; they are not the application's HTML security
filter. `web/readable.mjs` supplies a custom `html` renderer that escapes all
`& < > " '` characters. HTML not recognized as a raw HTML token is escaped by
Marked's text renderer. Links pass an HTTP/HTTPS URL allowlist and images are
rendered as text links. Markdown exports independently escape angle brackets
outside literal code. Recognizing or failing to recognize one of these tag or
comment forms does not allow it to become active HTML.

`checks/vendor-security.check.mjs` exercises uppercase/mixed-case script tags,
`--!>` and `<!-->` comments, raw image/SVG/style/textarea tags and mixed-case
JavaScript URLs through the application HTML and Markdown renderers.
Classification: **false positive at this application's output boundary**.

## Marked 18.0.13: placeholder regexes

Alerts #2–5 (`js/redos`) refer to regex templates containing the literal word
`brackets`. In that unexpanded template the `brackets` alternative overlaps a
repeated character class. Marked passes these templates through its regex
builder, replaces `brackets` with the nested-bracket grammar, and only then
compiles the regex used for link parsing. The literal templates are not matched
against user input.

The regression check verifies that the effective inline link/reference grammars
contain no `brackets` placeholder, then renders both incomplete labels and links
with 32, 1,024 and 8,192 repetitions of the reported witness. A child-process
10-second timeout can terminate a synchronous regex stall. This is evidence for
the reported witness, not a general complexity proof for the whole parser.
Classification: **false positive on an unexecuted template**.

## Zod 4.6.5: generated object parser

Alert #6 (`js/bad-code-sanitization`) follows `JSON.stringify` in Zod's `util.esc`
into `Doc.compile`. The rule warns that JSON string escaping does not prevent a
closing `</script>` tag from escaping an HTML script element.

This copy of Zod comes from the MCP SDK in the **Node-only** `dist/main.mjs`.
`Doc.compile` supplies the generated body directly to the Node `Function`
constructor; it is never embedded in an HTML script element. Schema keys are
quoted by `JSON.stringify`, and generated local variable names are counters.
An HTML closing tag inside that quoted string has no HTML parsing context in
which to execute.

The regression check exercises actual JIT compilation (instrumenting the
Function constructor and requiring compilation of the hostile-key schema),
verifies quote/comment injection, closing script tags and Unicode separators
remain literal object keys, checks that invalid values still fail validation,
and asserts that the execution sentinel is unchanged.
Classification: **false positive for a Node function body, with no HTML sink**.

## CI evidence and boundaries

Run `npm ci --ignore-scripts` and `npm test` inside this plugin to repeat the
source checks. The dedicated Dynamic Workflow workflow runs the checks, rebuilds
the shipped assets, verifies they match the committed files, and exercises the
packaged stdio MCP entry. The repository-wide CodeQL workflow continues to scan
the bundled JavaScript unchanged.

False-positive dismissals for the above alert IDs should include the relevant
rationale from this document in their audit comments. New findings require a
fresh review; no automated dismissal policy is introduced.
