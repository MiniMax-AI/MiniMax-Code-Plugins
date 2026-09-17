// lib/classify.js — Three-tier decision tree.
//
//   pure-translate : pure instruction, ascii-clean, no hardcoded paths
//                    -> only add frontmatter fields, no body rewrite
//   pure-wrapped-fix: pure instruction but with hardcoded paths or GBK
//                    -> rewrite paths + ensure UTF-8
//   wrapped-*      : needs an external CLI/API; cannot be a pure skill
//   abandon        : unfixable openclaw-only assumptions
//
// The decision tree in §2.2 of the plan, encoded as a flat function.

/**
 * @typedef {Object} ClassifyResult
 * @property {'pure'|'wrapped'|'abandon'} tier
 * @property {string} subTier     e.g. 'pure-translate', 'wrapped-python'
 * @property {string} reason
 * @property {string[]} recommendations
 */

/**
 * @param {import('./analyze.js').AnalyzedSkill} report
 * @returns {ClassifyResult}
 */
export function classify(report) {
  const { hardcodedPaths, externalCommands, encoding, convertedFromGbk } = report;

  const hasExternalTool = externalCommands.length > 0;
  const hasHardcodedPaths = hardcodedPaths.length > 0;
  const isAsciiClean = encoding === 'utf-8' && !convertedFromGbk;

  // Q1: external tool dependence
  if (hasExternalTool) {
    // Q3: which kind?
    const labels = externalCommands.map(c => c.label);
    let sub = 'wrapped-unknown';
    if (labels.includes('pip install') || labels.includes('python invocation')) {
      sub = 'wrapped-python';
    } else if (labels.includes('cli-anything CLI')) {
      sub = 'wrapped-cli-anything';
    } else if (labels.includes('curl')) {
      sub = 'wrapped-http';
    } else if (labels.some(l => /ComfyUI|ESP32|Douyin|TTS|Feishu/.test(l))) {
      sub = 'wrapped-service';
    } else if (labels.includes('unresolved template var')) {
      // template vars alone don't count as a real external dep
      // fall through to Q2
    } else {
      sub = 'wrapped-binary';
    }
    // Only return wrapped-* if we actually decided it's wrapped
    if (sub !== 'wrapped-unknown') {
      return {
        tier: 'wrapped',
        subTier: sub,
        reason: `depends on external: ${labels.join(', ')}`,
        recommendations: [
          'emit as a mavis plugin (plugin.json + index.js)',
          'document dependency installation in README',
          'do not promise behavior parity in v0.1',
        ],
      };
    }
  }

  // Q2: hardcoded paths or encoding issues
  if (hasHardcodedPaths || convertedFromGbk) {
    return {
      tier: 'pure',
      subTier: 'pure-wrapped-fix',
      reason: convertedFromGbk
        ? `gbk source, ${hardcodedPaths.length} hardcoded path group(s)`
        : `${hardcodedPaths.length} hardcoded path group(s) found`,
      recommendations: [
        'parameterize paths via paths.js',
        'ensure UTF-8 output',
        'add Windows adaptation section if body uses shell commands',
      ],
    };
  }

  // Q4: clean pure
  return {
    tier: 'pure',
    subTier: isAsciiClean ? 'pure-translate' : 'pure-wrapped-fix',
    reason: isAsciiClean
      ? 'pure instruction, ascii-clean, no hardcoded paths'
      : 'pure instruction but needs encoding touch-up',
    recommendations: [
      'enrich frontmatter (descriptions.zh-Hans, displayNames.zh-Hans, metadata)',
      'move trigger conditions from body to description',
      'verify body is under 500 lines; split into references/ if not',
    ],
  };
}
