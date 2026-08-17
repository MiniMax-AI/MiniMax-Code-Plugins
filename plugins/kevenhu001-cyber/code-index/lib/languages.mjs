/**
 * Language detection and regex-based symbol extraction for the code index.
 *
 * This is a deliberately heuristic, ctags-style extractor: it reads one line at
 * a time and never builds a real AST. It is fast and dependency-free, and its
 * precision is intentionally documented as "good, not a language server".
 * Definitions are classified into kinds (function, method, class, interface,
 * ...); methods are detected inside class-like bodies using a small brace-depth
 * tracker (or Python/Ruby indent tracking). Calls and assignments are excluded
 * with per-language keyword blocklists and an "no `=` before `(`" guard.
 */

import path from 'node:path';

export const SYMBOL_KINDS = [
  'function',
  'method',
  'class',
  'interface',
  'enum',
  'struct',
  'trait',
  'type',
  'variable',
  'constant',
  'import',
  'package',
  'module',
  'namespace',
  'object',
  'mixin',
  'extension',
  'record',
  'impl',
  'protocol',
  'typedef',
  'macro',
  'property',
  'delegate',
];

const EXTENSIONS = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.py': 'python', '.pyi': 'python', '.pyw': 'python',
  '.java': 'java',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c', '.h': 'c',
  '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp', '.inl': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby', '.rake': 'ruby', '.gemspec': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.dart': 'dart',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.ksh': 'shell',
  '.lua': 'lua',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.json': 'json', '.jsonc': 'json',
  '.md': 'markdown', '.markdown': 'markdown',
  '.yml': 'yaml', '.yaml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml', '.xsl': 'xml',
  '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.sql': 'sql',
  '.proto': 'protobuf',
  '.graphql': 'graphql', '.gql': 'graphql',
};

const TS_KEYWORDS = /^(?:function|class|interface|type|enum|namespace|import|export|const|let|var|if|for|while|switch|catch|return|throw|new|delete|typeof|instanceof|void|await|yield|else|do|try|case|default|extends|implements|this|super|in|of|as)\b/u;

const JSTS = {
  parse: true,
  brace: true,
  classStart: [
    { kind: 'class', re: /^(?:export\s+|declare\s+|abstract\s+|default\s+)*class\s+([A-Za-z_$][\w$]*)/u },
    { kind: 'interface', re: /^(?:export\s+|declare\s+)*interface\s+([A-Za-z_$][\w$]*)/u },
    { kind: 'enum', re: /^(?:export\s+|declare\s+|const\s+)*enum\s+([A-Za-z_$][\w$]*)/u },
    { kind: 'namespace', re: /^(?:export\s+|declare\s+)*namespace\s+([A-Za-z_$][\w$]*)/u },
  ],
  methodPattern: {
    re: /^\s*(?:(?:public|private|protected|static|async|get|set|readonly|abstract|override|declare)\s+)*(?:[A-Za-z_$][\w$]*\s+)?([A-Za-z_$][\w$]*)\s*\(/u,
    exclude: TS_KEYWORDS,
  },
  patterns: [
    { kind: 'function', re: /^(?:export\s+|declare\s+|async\s+)*function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/u },
    { kind: 'type', re: /^(?:export\s+|declare\s+)*type\s+([A-Za-z_$][\w$]*)\s*=/u },
    { kind: 'function', re: /^(?:export\s+)*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/u },
    { kind: 'variable', re: /^(?:export\s+)*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/u },
    { kind: 'import', re: /^(?:import|export)\s+(?:type\s+)?.*?from\s+['"]([^'"]+)['"]/u },
    { kind: 'import', re: /^import\s+['"]([^'"]+)['"]/u },
  ],
};

const PYTHON = {
  parse: true,
  classStart: [
    { kind: 'class', re: /^class\s+([A-Za-z_]\w*)/u },
  ],
  methodPattern: {
    re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/u,
  },
  patterns: [
    { kind: 'function', re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/u },
    { kind: 'import', re: /^from\s+([\w.]+)\s+import\s+/u },
    { kind: 'import', re: /^import\s+([\w.]+)/u },
    { kind: 'constant', re: /^([A-Z][A-Z0-9_]*)\s*=/u },
    { kind: 'variable', re: /^([a-z_]\w*)\s*=/u },
  ],
};

const GO = {
  parse: true,
  patterns: [
    { kind: 'package', re: /^package\s+([A-Za-z_]\w*)/u },
    { kind: 'method', re: /^func\s*\([^)]*\)\s+([A-Za-z_]\w*)\s*\(/u },
    { kind: 'function', re: /^func\s+([A-Za-z_]\w*)\s*\(/u },
    { kind: 'struct', re: /^type\s+([A-Za-z_]\w*)\s+struct/u },
    { kind: 'interface', re: /^type\s+([A-Za-z_]\w*)\s+interface/u },
    { kind: 'type', re: /^type\s+([A-Za-z_]\w*)\s*(?:=|\()/u },
    { kind: 'constant', re: /^const\s+([A-Za-z_]\w*)\s*=/u },
    { kind: 'variable', re: /^var\s+([A-Za-z_]\w*)\s*=/u },
    { kind: 'import', re: /^import\s+["']?([A-Za-z_][\w./-]*)["']?/u },
  ],
};

const RUST = {
  parse: true,
  brace: true,
  classStart: [
    { kind: 'struct', re: /^(?:pub\s+)?struct\s+([A-Za-z_]\w*)/u },
    { kind: 'enum', re: /^(?:pub\s+)?enum\s+([A-Za-z_]\w*)/u },
    { kind: 'trait', re: /^(?:pub\s+)?trait\s+([A-Za-z_]\w*)/u },
    { kind: 'impl', re: /^impl\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/u },
  ],
  methodPattern: {
    re: /^\s*(?:pub\s+|async\s+|unsafe\s+|extern\s+"[^"]*"\s+)*fn\s+([a-zA-Z_]\w*)\s*\(/u,
    exclude: /^(?:if|match|while|for|loop|let|const|return|unsafe|async|await|else|where|move|ref|mut|in|as|break|continue)\b/u,
  },
  patterns: [
    { kind: 'function', re: /^(?:pub\s+|async\s+|unsafe\s+|extern\s+"[^"]*"\s+)*fn\s+([a-zA-Z_]\w*)\s*\(/u },
    { kind: 'module', re: /^(?:pub\s+)?mod\s+([a-zA-Z_]\w*)/u },
    { kind: 'type', re: /^(?:pub\s+)?type\s+([A-Za-z_]\w*)\s*=/u },
    { kind: 'constant', re: /^(?:pub\s+)?const\s+([A-Za-z_]\w*)\s*:/u },
    { kind: 'import', re: /^use\s+([a-zA-Z_:][\w:]*)/u },
    { kind: 'import', re: /^extern\s+crate\s+([a-zA-Z_]\w*)/u },
  ],
};

const JAVA = {
  parse: true,
  brace: true,
  classStart: [
    { kind: 'class', re: /^(?:public|protected|private|abstract|final|static|strictfp|sealed|non-sealed)\s+class\s+([A-Za-z_]\w*)/u },
    { kind: 'interface', re: /^(?:public|protected|private)\s+interface\s+([A-Za-z_]\w*)/u },
    { kind: 'enum', re: /^(?:public|protected|private)\s+enum\s+([A-Za-z_]\w*)/u },
    { kind: 'record', re: /^(?:public|protected|private|static|final)\s+record\s+([A-Za-z_]\w*)/u },
  ],
  methodPattern: {
    re: /^\s*(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|transient|volatile|strictfp)\s+)*(?:[A-Za-z_][\w<>\[\],.? ]*\s+)?([A-Za-z_]\w*)\s*\(/u,
    exclude: /^(?:if|for|while|switch|case|catch|do|else|try|return|throw|new|assert|synchronized|this|super|instanceof|break|continue)\b/u,
  },
  patterns: [
    { kind: 'import', re: /^import\s+(?:static\s+)?([A-Za-z_][\w.*]+)\s*;/u },
    { kind: 'package', re: /^package\s+([A-Za-z_][\w.]*)\s*;/u },
    { kind: 'constant', re: /^(?:public|protected|private|static|final)\s+(?:[A-Za-z_]\w*(?:<[^>]*>)?(?:\s*\[\])?)\s+([A-Z][A-Z0-9_]*)\s*=/u },
    { kind: 'variable', re: /^(?:public|protected|private|static|final)\s+(?:[A-Za-z_]\w*(?:<[^>]*>)?(?:\s*\[\])?)\s+([a-z_]\w*)\s*=/u },
  ],
};

const CPP = {
  parse: true,
  brace: true,
  classStart: [
    { kind: 'class', re: /^(?:class|struct|union)\s+([A-Za-z_]\w*)/u },
  ],
  methodPattern: {
    re: /^\s*(?:(?:inline|static|virtual|explicit|const|constexpr|friend|public|private|protected|override|final|noexcept|volatile|mutable|extern)\s+)*(?:[A-Za-z_][\w<>:*,&\[\] ]*\s+)?([A-Za-z_]\w*)\s*\(/u,
    exclude: /^(?:if|for|while|switch|case|catch|do|else|return|throw|new|delete|sizeof|typeof|this|template|using|try|goto|break|continue)\b/u,
  },
  lineExclude: /^(?:if|for|while|switch|case|catch|do|else|return|throw|new|delete|sizeof|typeof|this|template|using|try|goto|break|continue|static_assert)\b/u,
  patterns: [
    { kind: 'function', re: /^(?:(?:inline|static|const|extern|virtual|constexpr|unsigned|signed|long|short|int|char|float|double|bool|auto|void|size_t|[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s+)+([A-Za-z_]\w*)\s*\(/u },
    { kind: 'macro', re: /^#define\s+([A-Za-z_]\w*)/u },
    { kind: 'import', re: /^#include\s*[<"]([^>"]+)/u },
    { kind: 'type', re: /^typedef\s+(?:struct|union|enum|class)\s+([A-Za-z_]\w*)/u },
  ],
};

const CSHARP = {
  parse: true,
  brace: true,
  classStart: [
    { kind: 'class', re: /^(?:public|internal|private|protected|sealed|abstract|static|partial|readonly|record)\s+class\s+([A-Za-z_]\w*)/u },
    { kind: 'interface', re: /^(?:public|internal|private|protected)\s+interface\s+([A-Za-z_]\w*)/u },
    { kind: 'enum', re: /^(?:public|internal|private|protected)\s+enum\s+([A-Za-z_]\w*)/u },
    { kind: 'struct', re: /^(?:public|internal|private|protected|readonly|ref)\s+struct\s+([A-Za-z_]\w*)/u },
    { kind: 'record', re: /^(?:public|internal|private|protected|sealed)\s+record\s+([A-Za-z_]\w*)/u },
    { kind: 'namespace', re: /^namespace\s+([A-Za-z_][\w.]*)/u },
  ],
  methodPattern: {
    re: /^\s*(?:(?:public|internal|private|protected|static|virtual|override|abstract|sealed|async|readonly|extern|new|unsafe|partial|event)\s+)*(?:[A-Za-z_][\w<>\[\],.? ]*\s+)?([A-Za-z_]\w*)\s*\(/u,
    exclude: /^(?:if|for|foreach|while|switch|case|catch|return|throw|new|else|do|try|using|this|base|out|ref|in|lock|fixed|unsafe|await|yield|break|continue)\b/u,
  },
  patterns: [
    { kind: 'import', re: /^using\s+([A-Za-z_][\w.]*)\s*;/u },
    { kind: 'property', re: /^(?:public|internal|private|protected|static)\s+(?:[A-Za-z_]\w*(?:<[^>]*>)?(?:\s*\[\])?)\s+([A-Za-z_]\w*)\s*\{\s*get\b/u },
    { kind: 'delegate', re: /^(?:public|internal|private|protected)\s+delegate\s+(?:[A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(/u },
  ],
};

const KOTLIN = {
  parse: true,
  brace: true,
  classStart: [
    { kind: 'class', re: /^(?:public|private|protected|internal|open|abstract|sealed|data|enum|annotation|value|final|expect|actual)\s+class\s+([A-Za-z_]\w*)/u },
    { kind: 'interface', re: /^(?:public|private|protected|internal|expect|actual)\s+interface\s+([A-Za-z_]\w*)/u },
    { kind: 'object', re: /^(?:public|private|protected|internal|data)\s+object\s+([A-Za-z_]\w*)/u },
  ],
  methodPattern: {
    re: /^\s*(?:(?:public|private|protected|internal|override|open|final|abstract|inline|suspend|tailrec|operator|infix|external|annotation|lateinit)\s+)*(?:fun\s+)?([A-Za-z_]\w*)\s*\(/u,
    exclude: /^(?:if|for|while|when|catch|return|throw|new|try|this|super|val|var|fun|class|interface|object|import|package|else|do|break|continue)\b/u,
  },
  patterns: [
    { kind: 'function', re: /^(?:(?:public|private|protected|internal|override|open|final|abstract|inline|suspend|tailrec|operator|infix|external|annotation|lateinit)\s+)*fun\s+([A-Za-z_]\w*)\s*\(/u },
    { kind: 'type', re: /^(?:public|private|protected|internal)\s+typealias\s+([A-Za-z_]\w*)/u },
    { kind: 'import', re: /^import\s+([\w.*]+)/u },
    { kind: 'package', re: /^package\s+([\w.]+)/u },
    { kind: 'constant', re: /^(?:public|private|protected|internal)\s+const\s+val\s+([A-Z]\w*)/u },
    { kind: 'variable', re: /^(?:public|private|protected|internal|const)\s+(?:val|var)\s+([A-Za-z_]\w*)\s*[:=]/u },
  ],
};

const SWIFT = {
  parse: true,
  brace: true,
  classStart: [
    { kind: 'class', re: /^(?:public|private|internal|fileprivate|open|final)\s+class\s+([A-Za-z_]\w*)/u },
    { kind: 'struct', re: /^(?:public|private|internal|fileprivate)\s+struct\s+([A-Za-z_]\w*)/u },
    { kind: 'enum', re: /^(?:public|private|internal|fileprivate|indirect)\s+enum\s+([A-Za-z_]\w*)/u },
    { kind: 'protocol', re: /^(?:public|private|internal|fileprivate)\s+protocol\s+([A-Za-z_]\w*)/u },
    { kind: 'extension', re: /^(?:public|private|internal|fileprivate)\s+extension\s+([A-Za-z_]\w*)/u },
  ],
  methodPattern: {
    re: /^\s*(?:(?:public|private|internal|fileprivate|open|static|class|final|override|mutating|nonmutating|convenience|required|indirect|lazy|weak|unowned|async)\s+)*(?:func\s+)?([A-Za-z_]\w*)\s*\(/u,
    exclude: /^(?:if|for|while|switch|case|catch|return|throw|new|try|guard|else|do|repeat|break|continue|var|let|func|class|struct|enum|protocol|extension|import|in|as|is|where)\b/u,
  },
  patterns: [
    { kind: 'function', re: /^(?:(?:public|private|internal|fileprivate|open|static|class|final|override|mutating|nonmutating|convenience|required)\s+)*(?:async\s+)?func\s+([A-Za-z_]\w*)\s*\(/u },
    { kind: 'variable', re: /^(?:public|private|internal|fileprivate|static)\s+(?:let|var)\s+([A-Za-z_]\w*)\s*[:=]/u },
    { kind: 'import', re: /^import\s+([A-Za-z_][\w.]*)/u },
    { kind: 'type', re: /^(?:public|private|internal|fileprivate)\s+typealias\s+([A-Za-z_]\w*)/u },
  ],
};

const DART = {
  parse: true,
  brace: true,
  classStart: [
    { kind: 'class', re: /^(?:abstract\s+|base\s+|final\s+|sealed\s+|interface\s+)?class\s+([A-Za-z_]\w*)/u },
    { kind: 'mixin', re: /^mixin\s+([A-Za-z_]\w*)/u },
    { kind: 'extension', re: /^extension\s+([A-Za-z_]\w*)/u },
    { kind: 'enum', re: /^enum\s+([A-Za-z_]\w*)/u },
  ],
  methodPattern: {
    re: /^\s*(?:(?:static|factory|external|abstract|covariant|async|sync|sync\*|async\*|operator|get|set)\s+)*(?:[A-Za-z_][\w<>?\[\], ]*\s+)?([A-Za-z_]\w*)\s*\(/u,
    exclude: /^(?:if|for|while|switch|case|catch|do|else|return|throw|new|assert|try|this|super|var|final|const|void|int|double|bool|String|List|Map|Set|dynamic|break|continue)\b/u,
  },
  lineExclude: /^(?:if|for|while|switch|case|catch|do|else|return|throw|new|assert|try|var|final|const|late|this|super|break|continue)\b/u,
  patterns: [
    { kind: 'function', re: /^(?:[A-Za-z_][\w<>?\[\], ]*\s+)?([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:async\s*)?\{/u },
    { kind: 'typedef', re: /^typedef\s+([A-Za-z_]\w*)/u },
    { kind: 'import', re: /^import\s+['"]([^'"]+)['"]/u },
    { kind: 'import', re: /^(?:part|export)\s+['"]([^'"]+)['"]/u },
  ],
};

const PHP = {
  parse: true,
  brace: true,
  classStart: [
    { kind: 'class', re: /^(?:abstract\s+|final\s+|readonly\s+)?class\s+([A-Za-z_]\w*)/u },
    { kind: 'interface', re: /^interface\s+([A-Za-z_]\w*)/u },
    { kind: 'trait', re: /^trait\s+([A-Za-z_]\w*)/u },
    { kind: 'enum', re: /^enum\s+([A-Za-z_]\w*)/u },
  ],
  methodPattern: {
    re: /^\s*(?:(?:public|private|protected|static|abstract|final|readonly)\s+)*(?:function\s+)?([A-Za-z_]\w*)\s*\(/u,
    exclude: /^(?:if|for|foreach|while|switch|case|catch|return|throw|new|else|do|try|echo|print|die|exit|include|require|global|static|function|class|interface|trait|enum|namespace|use|continue|break)\b/u,
  },
  patterns: [
    { kind: 'function', re: /^(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+([A-Za-z_]\w*)\s*\(/u },
    { kind: 'namespace', re: /^namespace\s+([A-Za-z_\\][\w\\]*)/u },
    { kind: 'import', re: /^use\s+(?:function\s+|const\s+)?([A-Za-z_\\][\w\\]*)/u },
    { kind: 'constant', re: /^(?:const|define\(\s*['"])([A-Za-z_]\w*)/u },
    { kind: 'variable', re: /^\$([A-Za-z_]\w*)\s*=/u },
  ],
};

const RUBY = {
  parse: true,
  classStart: [
    { kind: 'class', re: /^class\s+([A-Za-z_:][\w:]*)/u },
    { kind: 'module', re: /^module\s+([A-Za-z_:][\w:]*)/u },
  ],
  methodPattern: {
    re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*)/u,
  },
  patterns: [
    { kind: 'function', re: /^def\s+(?:self\.)?([A-Za-z_]\w*)/u },
    { kind: 'import', re: /^require(?:_relative)?\s+['"]([^'"]+)['"]/u },
    { kind: 'import', re: /^load\s+['"]([^'"]+)['"]/u },
    { kind: 'constant', re: /^([A-Z]\w*)\s*=/u },
    { kind: 'attribute', re: /^attr_(?:reader|writer|accessor)\s+(?::)?([A-Za-z_]\w*)/u },
  ],
};

const SHELL = {
  parse: true,
  patterns: [
    { kind: 'function', re: /^(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/u },
    { kind: 'variable', re: /^([A-Za-z_]\w*)\s*=/u },
  ],
};

const LUA = {
  parse: true,
  patterns: [
    { kind: 'function', re: /^function\s+([A-Za-z_][\w.:]*)\s*\(/u },
    { kind: 'variable', re: /^local\s+([A-Za-z_]\w*)\s*=/u },
  ],
};

const SPECS = {
  javascript: JSTS,
  typescript: JSTS,
  python: PYTHON,
  go: GO,
  rust: RUST,
  java: JAVA,
  c: CPP,
  cpp: CPP,
  csharp: CSHARP,
  kotlin: KOTLIN,
  swift: SWIFT,
  dart: DART,
  php: PHP,
  ruby: RUBY,
  shell: SHELL,
  lua: LUA,
};

export function languageForFile(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  return EXTENSIONS[ext] ?? null;
}

export function isParseable(language) {
  return Boolean(language && SPECS[language]);
}

export function getSpec(language) {
  return SPECS[language] ?? null;
}

/**
 * Extract symbol definitions from a list of lines using the given language spec.
 * Returns [{ name, kind, line, column }] with 1-based line and column.
 */
export function extractSymbols(lines, spec) {
  const symbols = [];
  let braceDepth = 0;
  const classStack = [];
  let classIndent = null;
  const hasClassContext = Boolean(spec.classStart && spec.classStart.length);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const trimmed = line.trim();
    if (!trimmed || isCommentLine(trimmed)) continue;
    const indent = leadingWhitespace(line).length;
    const depthBefore = braceDepth;
    let emitted = false;

    if (spec.lineExclude && spec.lineExclude.test(trimmed)) {
      braceDepth += countBraces(line);
      if (spec.brace) popClassStack(classStack, braceDepth);
      continue;
    }

    if (hasClassContext) {
      for (const { kind, re } of spec.classStart) {
        const match = re.exec(line);
        if (match) {
          symbols.push({ name: match[1], kind, line: lineIndex + 1, column: columnOf(line, match) });
          if (spec.brace) classStack.push({ depth: depthBefore + countBraces(line) });
          else classIndent = indent;
          emitted = true;
          break;
        }
      }
    }

    if (!emitted && spec.methodPattern) {
      const inClass = spec.brace
        ? classStack.length > 0 && depthBefore >= classStack[classStack.length - 1].depth
        : classIndent !== null && indent > classIndent;
      if (inClass) {
        const match = spec.methodPattern.re.exec(line);
        if (
          match
          && !hasAssignmentBeforeParen(line, match)
          && !(spec.methodPattern.exclude && spec.methodPattern.exclude.test(match[1]))
        ) {
          symbols.push({ name: match[1], kind: 'method', line: lineIndex + 1, column: columnOf(line, match) });
          emitted = true;
        }
      }
    }

    if (!emitted) {
      for (const { kind, re } of spec.patterns) {
        const match = re.exec(line);
        if (match) {
          symbols.push({ name: match[1], kind, line: lineIndex + 1, column: columnOf(line, match) });
          emitted = true;
          break;
        }
      }
    }

    braceDepth += countBraces(line);
    if (spec.brace) popClassStack(classStack, braceDepth);
  }
  return symbols;
}

function columnOf(line, match) {
  const name = match[1];
  const nameIndex = line.indexOf(name, match.index);
  return nameIndex + 1;
}

function hasAssignmentBeforeParen(line, match) {
  const nameStart = match.index + match[0].indexOf(match[1]);
  const paren = line.indexOf('(', nameStart);
  if (paren === -1) return false;
  const eq = line.indexOf('=', match.index);
  return eq !== -1 && eq < paren;
}

function isCommentLine(trimmed) {
  return trimmed.startsWith('//')
    || trimmed.startsWith('/*')
    || trimmed.startsWith('*')
    || trimmed.startsWith('#')
    || trimmed.startsWith('<!--')
    || trimmed.startsWith('--');
}

function leadingWhitespace(line) {
  const match = /^[ \t]*/u.exec(line);
  return match ? match[0] : '';
}

function countBraces(line) {
  let opens = 0;
  let closes = 0;
  let inString = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === inString) {
        inString = null;
      }
      continue;
    }
    if (c === '/' && line[i + 1] === '/') break;
    if (c === "'" || c === '"' || c === '`') {
      inString = c;
      continue;
    }
    if (c === '{') opens += 1;
    else if (c === '}') closes += 1;
  }
  return opens - closes;
}

function popClassStack(stack, depth) {
  while (stack.length && stack[stack.length - 1].depth > depth) stack.pop();
}
