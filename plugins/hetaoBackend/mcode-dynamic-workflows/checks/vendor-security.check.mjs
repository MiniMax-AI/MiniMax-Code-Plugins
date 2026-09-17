import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readableHTML, markdownText} from '../web/readable.mjs';

// The reported Marked patterns recognize Markdown syntax; they do not sanitize
// HTML. The application renderer must escape every raw HTML token regardless
// of tag case or the way the tokenizer splits an HTML comment.
test('raw HTML remains inert with mixed-case tags and alternate comment endings', () => {
  for (const input of [
    '<SCRIPT>alert(1)</SCRIPT>',
    'paragraph\n<ScRiPt>alert(1)</sCrIpT>',
    '<!-- comment --!><SCRIPT>alert(1)</SCRIPT>',
    '<!--> <img src=x onerror=alert(1)>',
    '<textarea><img src=x onerror=alert(1)></textarea>',
    '<style></style><svg onload=alert(1)>',
    '[click](JaVaScRiPt:alert%281%29)',
  ]) {
    for (const output of [readableHTML(input), markdownText(input)]) {
      assert.doesNotMatch(output, /<(?:script|img|svg|textarea|style)\b/i);
      assert.doesNotMatch(output, /(?:href="|\]\()(?:javascript|data):/i);
    }
  }
});

// A child process provides a hard bound even if a synchronous regex stalls.
// Exercise the actual expanded grammar, not the unused /brackets/ template.
test('expanded Marked link grammar handles the reported brackets witness', () => {
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {Lexer} from 'marked';
    import {readableHTML, markdownText} from './web/readable.mjs';
    for (const grammar of Object.values(Lexer.rules.inline)) {
      for (const name of ['link', 'reflink', 'nolink']) {
        assert.ok(grammar[name] instanceof RegExp);
        assert.ok(!grammar[name].source.includes('brackets'));
      }
    }
    for (const count of [32, 1024, 8192]) {
      const label = 'brackets'.repeat(count);
      for (const input of ['[' + label + '!', '[' + label + '](https://example.com)', '[[' + label + ']!']) {
        assert.ok(readableHTML(input).includes(label));
        assert.ok(markdownText(input).includes(label));
      }
    }
  `], {cwd: new URL('../', import.meta.url), timeout: 10000, stdio: 'pipe'});
});

// The Zod string is evaluated as a Node Function body, never inserted into an
// HTML script element. Verify both quote injection and HTML closing-tag keys
// through the actual JIT path used by the locked MCP dependency.
test('Zod JIT treats hostile object property names as literal keys', () => {
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import * as z from 'zod/v4';
    const OriginalFunction = globalThis.Function;
    let compiled = 0;
    globalThis.Function = new Proxy(OriginalFunction, {
      construct(target, args) {
        if (args.at(-1).includes('__workflowSecuritySentinel')) compiled++;
        return Reflect.construct(target, args);
      }
    });
    try {
      globalThis.__workflowSecuritySentinel = 0;
      const keys = [
        '</script><script>globalThis.__workflowSecuritySentinel=1</script>',
        'x");globalThis.__workflowSecuritySentinel=1;//',
        'x\\"\\\\\\n',
        String.fromCharCode(0x2028, 0x2029),
        'constructor', 'prototype'
      ];
      const schema = z.object(Object.fromEntries(keys.map(key => [key, z.string()])));
      const input = Object.fromEntries(keys.map(key => [key, 'literal']));
      assert.deepEqual(schema.parse(input), input);
      assert.equal(schema.safeParse({...input, [keys[0]]: 42}).success, false);
      assert.ok(compiled > 0, 'must exercise code generation');
      assert.equal(globalThis.__workflowSecuritySentinel, 0);
    } finally { globalThis.Function = OriginalFunction; delete globalThis.__workflowSecuritySentinel; }
  `], {cwd: new URL('../', import.meta.url), timeout: 10000, stdio: 'pipe'});
});
