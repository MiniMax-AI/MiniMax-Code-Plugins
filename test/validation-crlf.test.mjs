import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSkillText } from '../scripts/lib/validation.mjs';

const valid = '---\nname: crlf-skill\ndescription: Validate portable line endings.\n---\n\n# Instructions\n';
for (const eol of ['\n', '\r\n']) {
  const source = valid.replaceAll('\n', eol);
  test(`Skill frontmatter accepts ${JSON.stringify(eol)} line endings`, () => {
    assert.deepEqual(validateSkillText(source, 'crlf-skill'), {
      name: 'crlf-skill', description: 'Validate portable line endings.',
    });
  });
  test(`Skill validation remains strict with ${JSON.stringify(eol)}`, () => {
    assert.throws(() => validateSkillText(source, 'another-skill'), /must equal/);
    assert.throws(() => validateSkillText(source.replace('---' + eol, ''), 'crlf-skill'), /frontmatter is required/);
    assert.throws(() => validateSkillText(source.replace(eol + '---' + eol, eol), 'crlf-skill'), /not closed/);
    assert.throws(() => validateSkillText(source.replace(/# Instructions[\r\n]*$/, ''), 'crlf-skill'), /instructions are required/);
  });
}
