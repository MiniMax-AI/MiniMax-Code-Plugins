// node_modules/marked/lib/marked.esm.js
function A() {
  return { async: false, breaks: false, extensions: null, gfm: true, hooks: null, pedantic: false, renderer: null, silent: false, tokenizer: null, walkTokens: null };
}
var T = A();
function U(l3) {
  T = l3;
}
var E = { exec: () => null };
function I(l3) {
  let e = [];
  return (t2) => {
    let n = Math.max(0, Math.min(3, t2 - 1)), i = e[n];
    return i || (i = l3(n), e[n] = i), i;
  };
}
function d(l3, e = "") {
  let t2 = typeof l3 == "string" ? l3 : l3.source, n = { replace: (i, r) => {
    let o = typeof r == "string" ? r : r.source;
    return o = o.replace(m.caret, "$1"), t2 = t2.replace(i, o), n;
  }, getRegex: () => new RegExp(t2, e) };
  return n;
}
var we = ((l3 = "") => {
  try {
    return !!new RegExp("(?<=1)(?<!1)" + l3);
  } catch {
    return false;
  }
})();
var m = { codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm, outputLinkReplace: /\\([\[\]])/g, indentCodeCompensation: /^(\s+)(?:```)/, beginningSpace: /^\s+/, endingHash: /#$/, startingSpaceChar: /^ /, endingSpaceChar: / $/, endingSpaceTabChar: /[ \t]$/, nonSpaceChar: /[^ ]/, newLineCharGlobal: /\n/g, tabCharGlobal: /\t/g, multipleSpaceGlobal: /\s+/g, blankLine: /^[ \t]*$/, doubleBlankLine: /\n[ \t]*\n[ \t]*$/, blockquoteStart: /^ {0,3}>/, blockquoteSetextReplace: /\n {0,3}((?:=+|-+) *)(?=\n|$)/g, blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm, listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g, listIsTask: /^\[[ xX]\] +\S/, listReplaceTask: /^\[[ xX]\] +/, listTaskCheckbox: /\[[ xX]\]/, anyLine: /\n.*\n/, hrefBrackets: /^<(.*)>$/, tableDelimiter: /[:|]/, tableAlignChars: /^\||\| *$/g, tableRowBlankLine: /\n[ \t]*$/, tableAlignRight: /^ *-+: *$/, tableAlignCenter: /^ *:-+: *$/, tableAlignLeft: /^ *:-+ *$/, startATag: /^<a /i, endATag: /^<\/a>/i, startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i, endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i, startAngleBracket: /^</, endAngleBracket: />$/, pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/, unicodeAlphaNumeric: /[\p{L}\p{N}]/u, escapeTest: /[&<>"']/, escapeReplace: /[&<>"']/g, escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/, escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, caret: /(^|[^\[])\^/g, percentDecode: /%25/g, findPipe: /\|/g, splitPipe: / \|/, slashPipe: /\\\|/g, carriageReturn: /\r\n|\r/g, spaceLine: /^ +$/gm, notSpaceStart: /^\S*/, endingNewline: /\n$/, listItemRegex: (l3) => new RegExp(`^( {0,3}${l3})((?:[	 ][^\\n]*)?(?:\\n|$))`), nextBulletRegex: I((l3) => new RegExp(`^ {0,${l3}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`)), hrRegex: I((l3) => new RegExp(`^ {0,${l3}}((?:-[ 	]*){3,}|(?:_[ 	]*){3,}|(?:\\*[ 	]*){3,})(?:\\n+|$)`)), fencesBeginRegex: I((l3) => new RegExp(`^ {0,${l3}}(?:\`\`\`|~~~)`)), headingBeginRegex: I((l3) => new RegExp(`^ {0,${l3}}#`)), htmlBeginRegex: I((l3) => new RegExp(`^ {0,${l3}}(?:</?(?:${H})(?: +|$|/?>)|<(?:script|pre|style|textarea|!--))`, "i")), blockquoteBeginRegex: I((l3) => new RegExp(`^ {0,${l3}}>`)) };
var ye = /^(?:[ \t]*(?:\n|$))+/;
var Pe = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
var Se = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/;
var v = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
var _e = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
var K = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
var le = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |blockCode|fences|blockquote|heading|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/;
var ue = d(le).replace(/bull/g, K).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/\|table/g, "").getRegex();
var $e = d(le).replace(/bull/g, K).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex();
var W = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
var Le = /^[^\n]+/;
var X = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/;
var ze = d(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label", X).replace("title", /(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex();
var Ee = d(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, K).getRegex();
var H = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
var J = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
var Me = d("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))", "i").replace("comment", J).replace("tag", H).replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex();
var pe = (l3) => d(W).replace("hr", v).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("|table", "").replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", l3).replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", H).getRegex();
var Ae = pe(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
var Ie = pe(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
var Ce = d(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace("paragraph", Ie).getRegex();
var V = { blockquote: Ce, code: Pe, def: ze, fences: Se, heading: _e, hr: v, html: Me, lheading: ue, list: Ee, newline: ye, paragraph: Ae, table: E, text: Le };
var ie = d("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr", v).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("blockquote", " {0,3}>").replace("code", "(?: {4}| {0,3}	)[^\\n]").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", H).getRegex();
var Be = { ...V, lheading: $e, table: ie, paragraph: d(W).replace("hr", v).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("table", ie).replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", H).getRegex() };
var De = { ...V, html: d(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment", J).replace(/tag/g, "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(), def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/, heading: /^(#{1,6})(.*)(?:\n+|$)/, fences: E, lheading: /^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/, paragraph: d(W).replace("hr", v).replace("heading", ` *#{1,6} *[^
]`).replace("lheading", ue).replace("|table", "").replace("blockquote", " {0,3}>").replace("|fences", "").replace("|list", "").replace("|html", "").replace("|tag", "").getRegex() };
var qe = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
var ve = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
var ce = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
var He = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;
var _ = /[\p{P}\p{S}]/u;
var C = /[\s\p{P}\p{S}]/u;
var Z = /[^\s\p{P}\p{S}]/u;
var Ze = d(/^((?![*_])punctSpace)/, "u").replace(/punctSpace/g, C).getRegex();
var Ge = /[\p{Pi}\p{Ps}"']/u;
var he = /(?!~)[\p{P}\p{S}]/u;
var Qe = /(?!~)[\s\p{P}\p{S}]/u;
var Ne = /(?:[^\s\p{P}\p{S}]|~)/u;
var je = d(/link|precode-code|html/, "g").replace("link", /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace("precode-", we ? "(?<!`)()" : "(^^|[^`])").replace("code", /(?<b>`+)[^`]+\k<b>(?!`)/).replace("html", /<(?! )[^<>]*?>/).getRegex();
var de = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
var Ue = d(de, "u").replace(/punct/g, _).getRegex();
var Fe = d(de, "u").replace(/punct/g, he).getRegex();
var Ke = /^(?:\*+(?:((?!\*)(?!openQuote)punct)|([^\s*]))?)|^_+(?:((?!_)(?!openQuote)punct)|([^\s_]))?/;
var We = d(Ke, "u").replace(/openQuote/g, Ge).replace(/punct/g, _).getRegex();
var ke = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
var Xe = d(ke, "gu").replace(/notPunctSpace/g, Z).replace(/punctSpace/g, C).replace(/punct/g, _).getRegex();
var Je = d(ke, "gu").replace(/notPunctSpace/g, Ne).replace(/punctSpace/g, Qe).replace(/punct/g, he).getRegex();
var Ve = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)[\\s](\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|(?:(?!\\*)punct|notPunctSpace)(\\*+)(?!\\*)(?=notPunctSpace)";
var Ye = d(Ve, "gu").replace(/notPunctSpace/g, Z).replace(/punctSpace/g, C).replace(/punct/g, _).getRegex();
var et = d("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)", "gu").replace(/notPunctSpace/g, Z).replace(/punctSpace/g, C).replace(/punct/g, _).getRegex();
var tt = "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)[\\s](_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)|(?:(?!_)punct|notPunctSpace)(_+)(?!_)(?=notPunctSpace)";
var nt = d(tt, "gu").replace(/notPunctSpace/g, Z).replace(/punctSpace/g, C).replace(/punct/g, _).getRegex();
var rt = d(/^~~?(?:((?!~)punct)|[^\s~])/, "u").replace(/punct/g, _).getRegex();
var st = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
var it = d(st, "gu").replace(/notPunctSpace/g, Z).replace(/punctSpace/g, C).replace(/punct/g, _).getRegex();
var ot = d(/\\(punct)/, "gu").replace(/punct/g, _).getRegex();
var at = d(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email", /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex();
var lt = d(J).replace("(?:-->|$)", "-->").getRegex();
var ut = d("^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment", lt).replace("attribute", /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex();
var ge = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
var N = d(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace("brackets", ge).getRegex();
var pt = d(/^!?\[(label)\]\(\s*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?\s*\)/).replace("label", N).replace("href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/).replace("title", /"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex();
var ct = d(/^!?\[(label)\]\[(ref)\]/).replace("label", N).replace("ref", X).getRegex();
var ht = d(/^!?\[(ref)\](?:\[\])?/).replace("ref", X).getRegex();
var oe = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
var dt = d(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace("brackets", ge).getRegex();
var kt = d("reflink|nolink(?!\\()", "g").replace("reflink", d(/^!?\[(label)\]\[(ref)\]/).replace("label", dt).replace("ref", oe).getRegex()).replace("nolink", d(/^!?\[(ref)\](?:\[\])?/).replace("ref", oe).getRegex()).getRegex();
var ae = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
var Y = { _backpedal: E, anyPunctuation: ot, autolink: at, blockSkip: je, br: ce, code: ve, del: E, delLDelim: E, delRDelim: E, emStrongLDelim: Ue, emStrongRDelimAst: Xe, emStrongRDelimUnd: et, escape: qe, link: pt, nolink: ht, punctuation: Ze, reflink: ct, reflinkSearch: kt, tag: ut, text: He, url: E };
var gt = { ...Y, emStrongLDelim: We, emStrongRDelimAst: Ye, emStrongRDelimUnd: nt, link: d(/^!?\[(label)\]\((.*?)\)/).replace("label", N).getRegex(), reflink: d(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label", N).getRegex() };
var F = { ...Y, emStrongRDelimAst: Je, emStrongLDelim: Fe, delLDelim: rt, delRDelim: it, url: d(/^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("protocol", ae).replace("email", /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).getRegex(), _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/, del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/, text: d(/^(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)))/).replace("protocol", ae).getRegex() };
var ft = { ...F, br: d(ce).replace("{2,}", "*").getRegex(), text: d(F.text).replace("\\b_", "\\b_| {2,}\\n").replace(/\{2,\}/g, "*").getRegex() };
var G = { normal: V, gfm: Be, pedantic: De };
var B = { normal: Y, gfm: F, breaks: ft, pedantic: gt };
var mt = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
var fe = (l3) => mt[l3];
function R(l3, e) {
  if (e) {
    if (m.escapeTest.test(l3)) return l3.replace(m.escapeReplace, fe);
  } else if (m.escapeTestNoEncode.test(l3)) return l3.replace(m.escapeReplaceNoEncode, fe);
  return l3;
}
function ee(l3) {
  try {
    l3 = encodeURI(l3).replace(m.percentDecode, "%");
  } catch {
    return null;
  }
  return l3;
}
function te(l3, e) {
  let t2 = l3.replace(m.findPipe, (r, o, s) => {
    let u = false, a = o;
    for (; --a >= 0 && s[a] === "\\"; ) u = !u;
    return u ? "|" : " |";
  }), n = t2.split(m.splitPipe), i = 0;
  if (n[0].trim() || n.shift(), n.length > 0 && !n.at(-1)?.trim() && n.pop(), e) if (n.length > e) n.splice(e);
  else for (; n.length < e; ) n.push("");
  for (; i < n.length; i++) n[i] = n[i].trim().replace(m.slashPipe, "|");
  return n;
}
function $(l3, e, t2) {
  let n = l3.length;
  if (n === 0) return "";
  let i = 0;
  for (; i < n; ) {
    let r = l3.charAt(n - i - 1);
    if (r === e && !t2) i++;
    else if (r !== e && t2) i++;
    else break;
  }
  return l3.slice(0, n - i);
}
function ne(l3) {
  let e = l3.split(`
`), t2 = e.length - 1;
  for (; t2 >= 0 && m.blankLine.test(e[t2]); ) t2--;
  return e.length - t2 <= 2 ? l3 : e.slice(0, t2 + 1).join(`
`);
}
function D(l3) {
  return l3.toLowerCase().toUpperCase().toLowerCase();
}
function me(l3, e) {
  if (l3.indexOf(e[1]) === -1) return -1;
  let t2 = 0;
  for (let n = 0; n < l3.length; n++) if (l3[n] === "\\") n++;
  else if (l3[n] === e[0]) t2++;
  else if (l3[n] === e[1] && (t2--, t2 < 0)) return n;
  return t2 > 0 ? -2 : -1;
}
function xe(l3, e = 0) {
  let t2 = e, n = "";
  for (let i of l3) if (i === "	") {
    let r = 4 - t2 % 4;
    n += " ".repeat(r), t2 += r;
  } else n += i, t2++;
  return n;
}
function be(l3, e, t2, n, i) {
  let r = e.href, o = e.title || null, s = l3[1].replace(i.other.outputLinkReplace, "$1"), u = l3[0].charAt(0) === "!";
  n.state.inLink = true;
  let a = n.state.linkEmitted, p = n.state.inRawBlock;
  n.state.linkEmitted = false;
  let c = n.inlineTokens(s), h = n.state.linkEmitted;
  if (n.state.linkEmitted = a, n.state.inLink = false, !u) {
    if (h) {
      n.state.inRawBlock = p;
      return;
    }
    n.state.linkEmitted = true;
  }
  return { type: u ? "image" : "link", raw: t2, href: r, title: o, text: s, tokens: c };
}
function xt(l3, e, t2) {
  let n = l3.match(t2.other.indentCodeCompensation);
  if (n === null) return e;
  let i = n[1];
  return e.split(`
`).map((r) => {
    let o = r.match(t2.other.beginningSpace);
    if (o === null) return r;
    let [s] = o;
    return r.slice(Math.min(s.length, i.length));
  }).join(`
`);
}
function Re(l3, e, t2, n) {
  if (!e.includes("<")) return false;
  for (let i = 0; i < e.length; i++) {
    if (e[i] === "\\") {
      i++;
      continue;
    }
    if (e[i] === "`") {
      let s = n.inline.code.exec(e.slice(i));
      if (s) {
        i += s[0].length - 1;
        continue;
      }
    }
    if (e[i] !== "<") continue;
    let r = l3.slice(t2 + i), o = n.inline.tag.exec(r) || n.inline.autolink.exec(r);
    if (o) {
      if (o[0].length > e.length - i) return true;
      i += o[0].length - 1;
    }
  }
  return false;
}
var y = class {
  options;
  rules;
  lexer;
  constructor(e) {
    this.options = e || T;
  }
  space(e) {
    let t2 = this.rules.block.newline.exec(e);
    if (t2 && t2[0].length > 0) return { type: "space", raw: t2[0] };
  }
  code(e) {
    let t2 = this.rules.block.code.exec(e);
    if (t2) {
      let n = this.options.pedantic ? t2[0] : ne(t2[0]), i = n.replace(this.rules.other.codeRemoveIndent, "");
      return { type: "code", raw: n, codeBlockStyle: "indented", text: i };
    }
  }
  fences(e) {
    let t2 = this.rules.block.fences.exec(e);
    if (t2) {
      let n = t2[0], i = xt(n, t2[3] || "", this.rules);
      return { type: "code", raw: n, lang: t2[2] ? t2[2].trim().replace(this.rules.inline.anyPunctuation, "$1") : t2[2], text: i };
    }
  }
  heading(e) {
    let t2 = this.rules.block.heading.exec(e);
    if (t2) {
      let n = t2[2].trim();
      if (this.rules.other.endingHash.test(n)) {
        let i = $(n, "#");
        (this.options.pedantic || !i || this.rules.other.endingSpaceTabChar.test(i)) && (n = i.trim());
      }
      return { type: "heading", raw: $(t2[0], `
`), depth: t2[1].length, text: n, tokens: this.lexer.inline(n) };
    }
  }
  hr(e) {
    let t2 = this.rules.block.hr.exec(e);
    if (t2) return { type: "hr", raw: $(t2[0], `
`) };
  }
  blockquote(e) {
    let t2 = this.rules.block.blockquote.exec(e);
    if (t2) {
      let n = $(t2[0], `
`).split(`
`), i = "", r = "", o = [];
      for (; n.length > 0; ) {
        let s = false, u = [], a;
        for (a = 0; a < n.length; a++) if (this.rules.other.blockquoteStart.test(n[a])) u.push(n[a]), s = true;
        else if (!s) u.push(n[a]);
        else break;
        n = n.slice(a);
        let p = u.join(`
`), c = p.replace(this.rules.other.blockquoteSetextReplace, `
    $1`).replace(this.rules.other.blockquoteSetextReplace2, "");
        i = i ? `${i}
${p}` : p, r = r ? `${r}
${c}` : c;
        let h = this.lexer.state.top;
        if (this.lexer.state.top = true, this.lexer.blockTokens(c, o, true), this.lexer.state.top = h, n.length === 0) break;
        let k = o.at(-1);
        if (k?.type === "code") break;
        if (k?.type === "blockquote") {
          let O = k, g = n.join(`
`), w = O.raw + `
` + g.replace(this.rules.other.blockquoteSetextReplace2, ""), z = this.blockquote(w);
          o[o.length - 1] = z, i = `${i}
${g}`, r = r.substring(0, r.length - O.text.length) + z.text;
          break;
        } else if (k?.type === "list") {
          let O = k, g = O.raw + `
` + n.join(`
`), w = this.list(g);
          o[o.length - 1] = w, i = i.substring(0, i.length - k.raw.length) + w.raw, r = r.substring(0, r.length - O.raw.length) + w.raw, n = g.substring(o.at(-1).raw.length).split(`
`);
          continue;
        }
      }
      return { type: "blockquote", raw: i, tokens: o, text: r };
    }
  }
  list(e) {
    let t2 = this.rules.block.list.exec(e);
    if (t2) {
      let n = t2[1].trim(), i = n.length > 1, r = { type: "list", raw: "", ordered: i, start: i ? +n.slice(0, -1) : "", loose: false, items: [] };
      n = i ? `\\d{1,9}\\${n.slice(-1)}` : `\\${n}`, this.options.pedantic && (n = i ? n : "[*+-]");
      let o = this.rules.other.listItemRegex(n), s = false;
      for (; e; ) {
        let a = false, p = "", c = "";
        if (!(t2 = o.exec(e)) || this.rules.block.hr.test(e)) break;
        p = t2[0], e = e.substring(p.length);
        let h = xe(t2[2].split(`
`, 1)[0], t2[1].length), k = e.split(`
`, 1)[0], O = !h.trim(), g = 0;
        if (this.options.pedantic ? (g = 2, c = h.trimStart()) : O ? g = t2[1].length + 1 : (g = h.search(this.rules.other.nonSpaceChar), g = g > 4 ? 1 : g, c = h.slice(g), g += t2[1].length), O && this.rules.other.blankLine.test(k) && (p += k + `
`, e = e.substring(k.length + 1), a = true), !a) {
          let w = this.rules.other.nextBulletRegex(g), z = this.rules.other.hrRegex(g), re = this.rules.other.fencesBeginRegex(g), se = this.rules.other.headingBeginRegex(g), Te = this.rules.other.htmlBeginRegex(g), Oe = this.rules.other.blockquoteBeginRegex(g);
          for (; e; ) {
            let j = e.split(`
`, 1)[0], q;
            if (k = j, this.options.pedantic ? (k = k.replace(this.rules.other.listReplaceNesting, "  "), q = k) : q = k.replace(this.rules.other.tabCharGlobal, "    "), re.test(k) || se.test(k) || Te.test(k) || Oe.test(k) || w.test(k) || z.test(k)) break;
            if (q.search(this.rules.other.nonSpaceChar) >= g || !k.trim()) c += `
` + q.slice(g);
            else {
              if (O || h.replace(this.rules.other.tabCharGlobal, "    ").search(this.rules.other.nonSpaceChar) >= 4 || re.test(h) || se.test(h) || z.test(h)) break;
              c += `
` + k;
            }
            O = !k.trim(), p += j + `
`, e = e.substring(j.length + 1), h = q.slice(g);
          }
        }
        r.loose || (s ? r.loose = true : this.rules.other.doubleBlankLine.test(p) && (s = true)), r.items.push({ type: "list_item", raw: p, task: !!this.options.gfm && this.rules.other.listIsTask.test(c), loose: false, text: c, tokens: [] }), r.raw += p;
      }
      let u = r.items.at(-1);
      if (u) u.raw = u.raw.trimEnd(), u.text = u.text.trimEnd();
      else return;
      r.raw = r.raw.trimEnd();
      for (let a of r.items) if (this.lexer.state.top = false, a.tokens = this.lexer.blockTokens(a.text, []), !r.loose) {
        let p = a.tokens.filter((h) => h.type === "space"), c = p.length > 0 && p.some((h) => this.rules.other.anyLine.test(h.raw));
        r.loose = c;
      }
      for (let a of r.items) {
        let p = a.tokens[0];
        if (a.task && (p?.type === "text" || p?.type === "paragraph")) {
          a.text = a.text.replace(this.rules.other.listReplaceTask, ""), p.raw = p.raw.replace(this.rules.other.listReplaceTask, ""), p.text = p.text.replace(this.rules.other.listReplaceTask, "");
          for (let h = this.lexer.inlineQueue.length - 1; h >= 0; h--) if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[h].src)) {
            this.lexer.inlineQueue[h].src = this.lexer.inlineQueue[h].src.replace(this.rules.other.listReplaceTask, "");
            break;
          }
          let c = this.rules.other.listTaskCheckbox.exec(a.raw);
          if (c) {
            let h = { type: "checkbox", raw: c[0] + " ", checked: c[0] !== "[ ]" };
            a.checked = h.checked, r.loose ? a.tokens[0] && ["paragraph", "text"].includes(a.tokens[0].type) && "tokens" in a.tokens[0] && a.tokens[0].tokens ? (a.tokens[0].raw = h.raw + a.tokens[0].raw, a.tokens[0].text = h.raw + a.tokens[0].text, a.tokens[0].tokens.unshift(h)) : a.tokens.unshift({ type: "paragraph", raw: h.raw, text: h.raw, tokens: [h] }) : a.tokens.unshift(h);
          }
        } else a.task && (a.task = false);
      }
      if (r.loose) for (let a of r.items) {
        a.loose = true;
        for (let p of a.tokens) p.type === "text" && (p.type = "paragraph");
      }
      return r;
    }
  }
  html(e) {
    let t2 = this.rules.block.html.exec(e);
    if (t2) {
      let n = ne(t2[0]);
      return { type: "html", block: true, raw: n, pre: t2[1] === "pre" || t2[1] === "script" || t2[1] === "style", text: n };
    }
  }
  def(e) {
    let t2 = this.rules.block.def.exec(e);
    if (t2) {
      let n = D(t2[1]).replace(this.rules.other.multipleSpaceGlobal, " "), i = t2[2] ? t2[2].replace(this.rules.other.hrefBrackets, "$1").replace(this.rules.inline.anyPunctuation, "$1") : "", r = t2[3] ? t2[3].substring(1, t2[3].length - 1).replace(this.rules.inline.anyPunctuation, "$1") : t2[3];
      return { type: "def", tag: n, raw: $(t2[0], `
`), href: i, title: r };
    }
  }
  table(e) {
    let t2 = this.rules.block.table.exec(e);
    if (!t2 || !this.rules.other.tableDelimiter.test(t2[2])) return;
    let n = te(t2[1]), i = t2[2].replace(this.rules.other.tableAlignChars, "").split("|"), r = t2[3]?.trim() ? t2[3].replace(this.rules.other.tableRowBlankLine, "").split(`
`) : [], o = { type: "table", raw: $(t2[0], `
`), header: [], align: [], rows: [] };
    if (n.length === i.length) {
      for (let s of i) this.rules.other.tableAlignRight.test(s) ? o.align.push("right") : this.rules.other.tableAlignCenter.test(s) ? o.align.push("center") : this.rules.other.tableAlignLeft.test(s) ? o.align.push("left") : o.align.push(null);
      for (let s = 0; s < n.length; s++) o.header.push({ text: n[s], tokens: this.lexer.inline(n[s]), header: true, align: o.align[s] });
      for (let s of r) o.rows.push(te(s, o.header.length).map((u, a) => ({ text: u, tokens: this.lexer.inline(u), header: false, align: o.align[a] })));
      return o;
    }
  }
  lheading(e) {
    let t2 = this.rules.block.lheading.exec(e);
    if (t2) {
      let n = t2[1].trim();
      return { type: "heading", raw: $(t2[0], `
`), depth: t2[2].charAt(0) === "=" ? 1 : 2, text: n, tokens: this.lexer.inline(n) };
    }
  }
  paragraph(e) {
    let t2 = this.rules.block.paragraph.exec(e);
    if (t2) {
      let n = t2[1].charAt(t2[1].length - 1) === `
` ? t2[1].slice(0, -1) : t2[1];
      return { type: "paragraph", raw: t2[0], text: n, tokens: this.lexer.inline(n) };
    }
  }
  text(e) {
    let t2 = this.rules.block.text.exec(e);
    if (t2) return { type: "text", raw: t2[0], text: t2[0], tokens: this.lexer.inline(t2[0]) };
  }
  escape(e) {
    let t2 = this.rules.inline.escape.exec(e);
    if (t2) return { type: "escape", raw: t2[0], text: t2[1] };
  }
  tag(e) {
    let t2 = this.rules.inline.tag.exec(e);
    if (t2) return !this.lexer.state.inLink && this.rules.other.startATag.test(t2[0]) ? this.lexer.state.inLink = true : this.lexer.state.inLink && this.rules.other.endATag.test(t2[0]) && (this.lexer.state.inLink = false), !this.lexer.state.inRawBlock && this.rules.other.startPreScriptTag.test(t2[0]) ? this.lexer.state.inRawBlock = true : this.lexer.state.inRawBlock && this.rules.other.endPreScriptTag.test(t2[0]) && (this.lexer.state.inRawBlock = false), { type: "html", raw: t2[0], inLink: this.lexer.state.inLink, inRawBlock: this.lexer.state.inRawBlock, block: false, text: t2[0] };
  }
  link(e) {
    let t2 = this.rules.inline.link.exec(e);
    if (t2) {
      let n = t2[0].charAt(0) === "!" ? 2 : 1;
      if (!this.options.pedantic && Re(e, t2[1], n, this.rules)) return;
      let i = t2[2].trim();
      if (!this.options.pedantic && this.rules.other.startAngleBracket.test(i)) {
        if (!this.rules.other.endAngleBracket.test(i)) return;
        let s = $(i.slice(0, -1), "\\");
        if ((i.length - s.length) % 2 === 0) return;
      } else {
        let s = me(t2[2], "()");
        if (s === -2) return;
        if (s > -1) {
          let a = (t2[0].indexOf("!") === 0 ? 5 : 4) + t2[1].length + s;
          t2[2] = t2[2].substring(0, s), t2[0] = t2[0].substring(0, a).trim(), t2[3] = "";
        }
      }
      let r = t2[2], o = "";
      if (this.options.pedantic) {
        let s = this.rules.other.pedanticHrefTitle.exec(r);
        s && (r = s[1], o = s[3]);
      } else o = t2[3] ? t2[3].slice(1, -1) : "";
      return r = r.trim(), this.rules.other.startAngleBracket.test(r) && (this.options.pedantic && !this.rules.other.endAngleBracket.test(i) ? r = r.slice(1) : r = r.slice(1, -1)), be(t2, { href: r && r.replace(this.rules.inline.anyPunctuation, "$1"), title: o && o.replace(this.rules.inline.anyPunctuation, "$1") }, t2[0], this.lexer, this.rules);
    }
  }
  reflink(e, t2) {
    let n;
    if ((n = this.rules.inline.reflink.exec(e)) || (n = this.rules.inline.nolink.exec(e))) {
      let i = n[0].charAt(0) === "!" ? 2 : 1;
      if (!this.options.pedantic && Re(e, n[1], i, this.rules)) return;
      let r = (n[2] || n[1]).replace(this.rules.other.multipleSpaceGlobal, " "), o = t2[D(r)];
      if (!o) {
        let s = n[0].charAt(0);
        return { type: "text", raw: s, text: s };
      }
      return be(n, o, n[0], this.lexer, this.rules);
    }
  }
  emStrong(e, t2, n = "") {
    let i = this.rules.inline.emStrongLDelim.exec(e);
    if (!i || !i[1] && !i[2] && !i[3] && !i[4] || i[4] && n.match(this.rules.other.unicodeAlphaNumeric)) return;
    if (!(i[1] || i[3] || "") || !n || this.rules.inline.punctuation.exec(n)) {
      let o = [...i[0]].length - 1, s, u, a = o, p = 0, c = i[0][0], h = n === c, k = c === "*" ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
      for (k.lastIndex = 0, t2 = t2.slice(-1 * e.length + o); (i = k.exec(t2)) !== null; ) {
        if (s = i[1] || i[2] || i[3] || i[4] || i[5] || i[6], !s) continue;
        if (u = [...s].length, i[3] || i[4]) {
          a += u;
          continue;
        } else if (i[5] || i[6]) {
          if (o % 3 && !((o + u) % 3)) {
            p += u;
            continue;
          }
          if (h) break;
        }
        if (a -= u, a > 0) continue;
        u = Math.min(u, u + a + p);
        let O = [...i[0]][0].length, g = e.slice(0, o + i.index + O + u);
        if (Math.min(o, u) % 2) {
          let z = g.slice(1, -1);
          return { type: "em", raw: g, text: z, tokens: this.lexer.inlineTokens(z) };
        }
        let w = g.slice(2, -2);
        return { type: "strong", raw: g, text: w, tokens: this.lexer.inlineTokens(w) };
      }
    }
  }
  codespan(e) {
    let t2 = this.rules.inline.code.exec(e);
    if (t2) {
      let n = t2[2].replace(this.rules.other.newLineCharGlobal, " "), i = this.rules.other.nonSpaceChar.test(n), r = this.rules.other.startingSpaceChar.test(n) && this.rules.other.endingSpaceChar.test(n);
      return i && r && (n = n.substring(1, n.length - 1)), { type: "codespan", raw: t2[0], text: n };
    }
  }
  br(e) {
    let t2 = this.rules.inline.br.exec(e);
    if (t2) return { type: "br", raw: t2[0] };
  }
  del(e, t2, n = "") {
    let i = this.rules.inline.delLDelim.exec(e);
    if (!i) return;
    if (!(i[1] || "") || !n || this.rules.inline.punctuation.exec(n)) {
      let o = [...i[0]].length - 1, s, u, a = o, p = this.rules.inline.delRDelim;
      for (p.lastIndex = 0, t2 = t2.slice(-1 * e.length + o); (i = p.exec(t2)) !== null; ) {
        if (s = i[1] || i[2] || i[3] || i[4] || i[5] || i[6], !s || (u = [...s].length, u !== o)) continue;
        if (i[3] || i[4]) {
          a += u;
          continue;
        }
        if (a -= u, a > 0) continue;
        u = Math.min(u, u + a);
        let c = [...i[0]][0].length, h = e.slice(0, o + i.index + c + u), k = h.slice(o, -o);
        return { type: "del", raw: h, text: k, tokens: this.lexer.inlineTokens(k) };
      }
    }
  }
  autolink(e) {
    let t2 = this.rules.inline.autolink.exec(e);
    if (t2) {
      let n, i;
      return t2[2] === "@" ? (n = t2[1], i = "mailto:" + n) : (n = t2[1], i = n), { type: "link", raw: t2[0], text: n, href: i, autolink: true, tokens: [{ type: "text", raw: n, text: n }] };
    }
  }
  url(e) {
    let t2;
    if (t2 = this.rules.inline.url.exec(e)) {
      let n, i;
      if (t2[2] === "@") n = t2[0], i = "mailto:" + n;
      else {
        let r;
        do
          r = t2[0], t2[0] = this.rules.inline._backpedal.exec(t2[0])?.[0] ?? "";
        while (r !== t2[0]);
        n = t2[0], t2[1] === "www." ? i = "http://" + t2[0] : i = t2[0];
      }
      return { type: "link", raw: t2[0], text: n, href: i, autolink: true, tokens: [{ type: "text", raw: n, text: n }] };
    }
  }
  inlineText(e) {
    let t2 = this.rules.inline.text.exec(e);
    if (t2) {
      let n = this.lexer.state.inRawBlock;
      return { type: "text", raw: t2[0], text: t2[0], escaped: n };
    }
  }
};
var x = class l {
  tokens;
  options;
  state;
  inlineQueue;
  tokenizer;
  constructor(e) {
    this.tokens = [], this.tokens.links = /* @__PURE__ */ Object.create(null), this.options = e || T, this.options.tokenizer = this.options.tokenizer || new y(), this.tokenizer = this.options.tokenizer, this.tokenizer.options = this.options, this.tokenizer.lexer = this, this.inlineQueue = [], this.state = { inLink: false, inRawBlock: false, linkEmitted: false, top: true };
    let t2 = { other: m, block: G.normal, inline: B.normal };
    this.options.pedantic ? (t2.block = G.pedantic, t2.inline = B.pedantic) : this.options.gfm && (t2.block = G.gfm, this.options.breaks ? t2.inline = B.breaks : t2.inline = B.gfm), this.tokenizer.rules = t2;
  }
  static get rules() {
    return { block: G, inline: B };
  }
  static lex(e, t2) {
    return new l(t2).lex(e);
  }
  static lexInline(e, t2) {
    return new l(t2).inlineTokens(e);
  }
  lex(e) {
    e = e.replace(m.carriageReturn, `
`), this.blockTokens(e, this.tokens);
    for (let t2 = 0; t2 < this.inlineQueue.length; t2++) {
      let n = this.inlineQueue[t2];
      this.inlineTokens(n.src, n.tokens);
    }
    return this.inlineQueue = [], this.tokens;
  }
  blockTokens(e, t2 = [], n = false) {
    this.tokenizer.lexer = this, this.options.pedantic && (e = e.replace(m.tabCharGlobal, "    ").replace(m.spaceLine, ""));
    let i = 1 / 0;
    for (; e; ) {
      if (e.length < i) i = e.length;
      else {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
      let r;
      if (this.options.extensions?.block?.some((s) => (r = s.call({ lexer: this }, e, t2)) ? (e = e.substring(r.raw.length), t2.push(r), true) : false)) continue;
      if (r = this.tokenizer.space(e)) {
        e = e.substring(r.raw.length);
        let s = t2.at(-1);
        r.raw.length === 1 && s !== void 0 ? s.raw += `
` : t2.push(r);
        continue;
      }
      if (r = this.tokenizer.code(e)) {
        e = e.substring(r.raw.length);
        let s = t2.at(-1);
        s?.type === "paragraph" || s?.type === "text" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.text, this.inlineQueue.at(-1).src = s.text) : t2.push(r);
        continue;
      }
      if (r = this.tokenizer.fences(e)) {
        e = e.substring(r.raw.length), t2.push(r);
        continue;
      }
      if (r = this.tokenizer.heading(e)) {
        e = e.substring(r.raw.length), t2.push(r);
        continue;
      }
      if (r = this.tokenizer.hr(e)) {
        e = e.substring(r.raw.length), t2.push(r);
        continue;
      }
      if (r = this.tokenizer.blockquote(e)) {
        e = e.substring(r.raw.length), t2.push(r);
        continue;
      }
      if (r = this.tokenizer.list(e)) {
        e = e.substring(r.raw.length), t2.push(r);
        continue;
      }
      if (r = this.tokenizer.html(e)) {
        e = e.substring(r.raw.length), t2.push(r);
        continue;
      }
      if (r = this.tokenizer.def(e)) {
        e = e.substring(r.raw.length);
        let s = t2.at(-1);
        s?.type === "paragraph" || s?.type === "text" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.raw, this.inlineQueue.at(-1).src = s.text) : this.tokens.links[r.tag] || (this.tokens.links[r.tag] = { href: r.href, title: r.title }, t2.push(r));
        continue;
      }
      if (r = this.tokenizer.table(e)) {
        e = e.substring(r.raw.length), t2.push(r);
        continue;
      }
      if (r = this.tokenizer.lheading(e)) {
        e = e.substring(r.raw.length), t2.push(r);
        continue;
      }
      let o = e;
      if (this.options.extensions?.startBlock) {
        let s = 1 / 0, u = e.slice(1), a;
        this.options.extensions.startBlock.forEach((p) => {
          a = p.call({ lexer: this }, u), typeof a == "number" && a >= 0 && (s = Math.min(s, a));
        }), s < 1 / 0 && s >= 0 && (o = e.substring(0, s + 1));
      }
      if (this.state.top && (r = this.tokenizer.paragraph(o))) {
        let s = t2.at(-1);
        n && s?.type === "paragraph" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = s.text) : t2.push(r), n = o.length !== e.length, e = e.substring(r.raw.length);
        continue;
      }
      if (r = this.tokenizer.text(e)) {
        e = e.substring(r.raw.length);
        let s = t2.at(-1);
        s?.type === "text" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = s.text) : t2.push(r);
        continue;
      }
      if (e) {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
    }
    return this.state.top = true, t2;
  }
  inline(e, t2 = []) {
    return this.inlineQueue.push({ src: e, tokens: t2 }), t2;
  }
  linkInText(e) {
    if (!e.includes("[")) return false;
    let t2 = this.tokenizer.rules.inline.link;
    for (let n of e.matchAll(this.tokenizer.rules.inline.blockSkip)) if (t2.test(n[0]) && e.charAt(n.index - 1) !== "!") return true;
    for (let n of e.matchAll(this.tokenizer.rules.inline.reflinkSearch)) {
      let i = n[0], r = i.lastIndexOf("[");
      if (!(i.charAt(0) === "!" || !Object.hasOwn(this.tokens.links, D(i.slice(r + 1, -1)))) && !(r > 1 && this.linkInText(i.slice(1, r - 1)))) return true;
    }
    return false;
  }
  inlineTokens(e, t2 = []) {
    this.tokenizer.lexer = this;
    let n = e;
    if (this.tokens.links && e.includes("[")) {
      let s = this.tokenizer.rules.inline.reflinkSearch, u = (a) => {
        let p = a.lastIndexOf("[");
        if (!Object.hasOwn(this.tokens.links, D(a.slice(p + 1, -1)))) return a;
        if (p > 1 && a.charAt(0) !== "!") {
          let c = a.slice(1, p - 1);
          if (this.linkInText(c)) return "[" + c.replace(s, u) + "][" + "a".repeat(a.length - p - 2) + "]";
        }
        return "[" + "a".repeat(a.length - 2) + "]";
      };
      n = n.replace(s, u);
    }
    n = n.replace(this.tokenizer.rules.inline.anyPunctuation, (s) => "+".repeat(s.length)), n = n.replace(this.tokenizer.rules.inline.blockSkip, (s, u, a) => {
      let p = a ? a.length : 0;
      return s.slice(0, p) + "[" + "a".repeat(s.length - p - 2) + "]";
    }), n = this.options.hooks?.emStrongMask?.call({ lexer: this }, n) ?? n;
    let i = false, r = "", o = 1 / 0;
    for (; e; ) {
      if (e.length < o) o = e.length;
      else {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
      i || (r = ""), i = false;
      let s;
      if (this.options.extensions?.inline?.some((a) => (s = a.call({ lexer: this }, e, t2)) ? (e = e.substring(s.raw.length), t2.push(s), true) : false)) continue;
      if (s = this.tokenizer.escape(e)) {
        e = e.substring(s.raw.length), t2.push(s);
        continue;
      }
      if (s = this.tokenizer.tag(e)) {
        e = e.substring(s.raw.length), t2.push(s);
        continue;
      }
      if (s = this.tokenizer.link(e)) {
        e = e.substring(s.raw.length), t2.push(s);
        continue;
      }
      if (s = this.tokenizer.reflink(e, this.tokens.links)) {
        e = e.substring(s.raw.length);
        let a = t2.at(-1);
        s.type === "text" && a?.type === "text" ? (a.raw += s.raw, a.text += s.text) : t2.push(s);
        continue;
      }
      if (s = this.tokenizer.emStrong(e, n, r)) {
        e = e.substring(s.raw.length), t2.push(s);
        continue;
      }
      if (s = this.tokenizer.codespan(e)) {
        e = e.substring(s.raw.length), t2.push(s);
        continue;
      }
      if (s = this.tokenizer.br(e)) {
        e = e.substring(s.raw.length), t2.push(s);
        continue;
      }
      if (s = this.tokenizer.del(e, n, r)) {
        e = e.substring(s.raw.length), t2.push(s);
        continue;
      }
      if (s = this.tokenizer.autolink(e)) {
        e = e.substring(s.raw.length), t2.push(s);
        continue;
      }
      if (!this.state.inLink && (s = this.tokenizer.url(e))) {
        e = e.substring(s.raw.length), t2.push(s);
        continue;
      }
      let u = e;
      if (this.options.extensions?.startInline) {
        let a = 1 / 0, p = e.slice(1), c;
        this.options.extensions.startInline.forEach((h) => {
          c = h.call({ lexer: this }, p), typeof c == "number" && c >= 0 && (a = Math.min(a, c));
        }), a < 1 / 0 && a >= 0 && (u = e.substring(0, a + 1));
      }
      if (s = this.tokenizer.inlineText(u)) {
        e = e.substring(s.raw.length), s.raw.slice(-1) !== "_" && (r = s.raw.slice(-1)), i = true;
        let a = t2.at(-1);
        a?.type === "text" ? (a.raw += s.raw, a.text += s.text) : t2.push(s);
        continue;
      }
      if (e) {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
    }
    return t2;
  }
  infiniteLoopError(e) {
    let t2 = "Infinite loop on byte: " + e;
    if (this.options.silent) console.error(t2);
    else throw new Error(t2);
  }
};
var P = class {
  options;
  parser;
  constructor(e) {
    this.options = e || T;
  }
  space(e) {
    return "";
  }
  code({ text: e, lang: t2, escaped: n }) {
    let i = (t2 || "").match(m.notSpaceStart)?.[0], r = e ? e.replace(m.endingNewline, "") + `
` : "";
    return i ? '<pre><code class="language-' + R(i) + '">' + (n ? r : R(r, true)) + `</code></pre>
` : "<pre><code>" + (n ? r : R(r, true)) + `</code></pre>
`;
  }
  blockquote({ tokens: e }) {
    return `<blockquote>
${this.parser.parse(e)}</blockquote>
`;
  }
  html({ text: e }) {
    return e;
  }
  def(e) {
    return "";
  }
  heading({ tokens: e, depth: t2 }) {
    return `<h${t2}>${this.parser.parseInline(e)}</h${t2}>
`;
  }
  hr(e) {
    return `<hr>
`;
  }
  list(e) {
    let t2 = e.ordered, n = e.start, i = "";
    for (let s = 0; s < e.items.length; s++) {
      let u = e.items[s];
      i += this.listitem(u);
    }
    let r = t2 ? "ol" : "ul", o = t2 && n !== 1 ? ' start="' + n + '"' : "";
    return "<" + r + o + `>
` + i + "</" + r + `>
`;
  }
  listitem(e) {
    return `<li>${this.parser.parse(e.tokens)}</li>
`;
  }
  checkbox({ checked: e }) {
    return "<input " + (e ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
  }
  paragraph({ tokens: e }) {
    return `<p>${this.parser.parseInline(e)}</p>
`;
  }
  table(e) {
    let t2 = "", n = "";
    for (let r = 0; r < e.header.length; r++) n += this.tablecell(e.header[r]);
    t2 += this.tablerow({ text: n });
    let i = "";
    for (let r = 0; r < e.rows.length; r++) {
      let o = e.rows[r];
      n = "";
      for (let s = 0; s < o.length; s++) n += this.tablecell(o[s]);
      i += this.tablerow({ text: n });
    }
    return i && (i = `<tbody>${i}</tbody>`), `<table>
<thead>
` + t2 + `</thead>
` + i + `</table>
`;
  }
  tablerow({ text: e }) {
    return `<tr>
${e}</tr>
`;
  }
  tablecell(e) {
    let t2 = this.parser.parseInline(e.tokens), n = e.header ? "th" : "td";
    return (e.align ? `<${n} align="${e.align}">` : `<${n}>`) + t2 + `</${n}>
`;
  }
  strong({ tokens: e }) {
    return `<strong>${this.parser.parseInline(e)}</strong>`;
  }
  em({ tokens: e }) {
    return `<em>${this.parser.parseInline(e)}</em>`;
  }
  codespan({ text: e }) {
    return `<code>${R(e, true)}</code>`;
  }
  br(e) {
    return "<br>";
  }
  del({ tokens: e }) {
    return `<del>${this.parser.parseInline(e)}</del>`;
  }
  link({ href: e, title: t2, text: n, tokens: i, autolink: r }) {
    let o = r ? R(n, true) : this.parser.parseInline(i), s = ee(e);
    if (s === null) return o;
    e = R(s, r);
    let u = '<a href="' + e + '"';
    return t2 && (u += ' title="' + R(t2) + '"'), u += ">" + o + "</a>", u;
  }
  image({ href: e, title: t2, text: n, tokens: i }) {
    i && (n = this.parser.parseInline(i, this.parser.textRenderer));
    let r = ee(e);
    if (r === null) return R(n);
    e = r;
    let o = `<img src="${R(e)}" alt="${R(n)}"`;
    return t2 && (o += ` title="${R(t2)}"`), o += ">", o;
  }
  text(e) {
    return "tokens" in e && e.tokens ? this.parser.parseInline(e.tokens) : "escaped" in e && e.escaped ? e.text : R(e.text);
  }
};
var L = class {
  strong({ text: e }) {
    return e;
  }
  em({ text: e }) {
    return e;
  }
  codespan({ text: e }) {
    return e;
  }
  del({ text: e }) {
    return e;
  }
  html({ text: e }) {
    return e;
  }
  text({ text: e }) {
    return e;
  }
  link({ text: e }) {
    return "" + e;
  }
  image({ text: e }) {
    return "" + e;
  }
  br() {
    return "";
  }
  checkbox({ raw: e }) {
    return e;
  }
};
var b = class l2 {
  options;
  renderer;
  textRenderer;
  constructor(e) {
    this.options = e || T, this.options.renderer = this.options.renderer || new P(), this.renderer = this.options.renderer, this.renderer.options = this.options, this.renderer.parser = this, this.textRenderer = new L();
  }
  static parse(e, t2) {
    return new l2(t2).parse(e);
  }
  static parseInline(e, t2) {
    return new l2(t2).parseInline(e);
  }
  parse(e) {
    this.renderer.parser = this;
    let t2 = "";
    for (let n = 0; n < e.length; n++) {
      let i = e[n];
      if (this.options.extensions?.renderers?.[i.type]) {
        let o = i, s = this.options.extensions.renderers[o.type].call({ parser: this }, o);
        if (s !== false || !["space", "hr", "heading", "code", "table", "blockquote", "list", "checkbox", "html", "def", "paragraph", "text"].includes(o.type)) {
          t2 += s || "";
          continue;
        }
      }
      let r = i;
      switch (r.type) {
        case "space": {
          t2 += this.renderer.space(r);
          break;
        }
        case "hr": {
          t2 += this.renderer.hr(r);
          break;
        }
        case "heading": {
          t2 += this.renderer.heading(r);
          break;
        }
        case "code": {
          t2 += this.renderer.code(r);
          break;
        }
        case "table": {
          t2 += this.renderer.table(r);
          break;
        }
        case "blockquote": {
          t2 += this.renderer.blockquote(r);
          break;
        }
        case "list": {
          t2 += this.renderer.list(r);
          break;
        }
        case "checkbox": {
          t2 += this.renderer.checkbox(r);
          break;
        }
        case "html": {
          t2 += this.renderer.html(r);
          break;
        }
        case "def": {
          t2 += this.renderer.def(r);
          break;
        }
        case "paragraph": {
          t2 += this.renderer.paragraph(r);
          break;
        }
        case "text": {
          t2 += this.renderer.text(r);
          break;
        }
        default: {
          let o = 'Token with "' + r.type + '" type was not found.';
          if (this.options.silent) return console.error(o), "";
          throw new Error(o);
        }
      }
    }
    return t2;
  }
  parseInline(e, t2 = this.renderer) {
    this.renderer.parser = this;
    let n = "";
    for (let i = 0; i < e.length; i++) {
      let r = e[i];
      if (this.options.extensions?.renderers?.[r.type]) {
        let s = this.options.extensions.renderers[r.type].call({ parser: this }, r);
        if (s !== false || !["escape", "html", "link", "image", "checkbox", "strong", "em", "codespan", "br", "del", "text"].includes(r.type)) {
          n += s || "";
          continue;
        }
      }
      let o = r;
      switch (o.type) {
        case "escape": {
          n += t2.text(o);
          break;
        }
        case "html": {
          n += t2.html(o);
          break;
        }
        case "link": {
          n += t2.link(o);
          break;
        }
        case "image": {
          n += t2.image(o);
          break;
        }
        case "checkbox": {
          n += t2.checkbox(o);
          break;
        }
        case "strong": {
          n += t2.strong(o);
          break;
        }
        case "em": {
          n += t2.em(o);
          break;
        }
        case "codespan": {
          n += t2.codespan(o);
          break;
        }
        case "br": {
          n += t2.br(o);
          break;
        }
        case "del": {
          n += t2.del(o);
          break;
        }
        case "text": {
          n += t2.text(o);
          break;
        }
        default: {
          let s = 'Token with "' + o.type + '" type was not found.';
          if (this.options.silent) return console.error(s), "";
          throw new Error(s);
        }
      }
    }
    return n;
  }
};
var S = class {
  options;
  block;
  constructor(e) {
    this.options = e || T;
  }
  static passThroughHooks = /* @__PURE__ */ new Set(["preprocess", "postprocess", "processAllTokens", "emStrongMask"]);
  static passThroughHooksRespectAsync = /* @__PURE__ */ new Set(["preprocess", "postprocess", "processAllTokens"]);
  preprocess(e) {
    return e;
  }
  postprocess(e) {
    return e;
  }
  processAllTokens(e) {
    return e;
  }
  emStrongMask(e) {
    return e;
  }
  provideLexer(e = this.block) {
    return e ? x.lex : x.lexInline;
  }
  provideParser(e = this.block) {
    return e ? b.parse : b.parseInline;
  }
};
var Q = class {
  defaults = A();
  options = this.setOptions;
  parse = this.parseMarkdown(true);
  parseInline = this.parseMarkdown(false);
  Parser = b;
  Renderer = P;
  TextRenderer = L;
  Lexer = x;
  Tokenizer = y;
  Hooks = S;
  constructor(...e) {
    this.use(...e);
  }
  walkTokens(e, t2) {
    let n = [];
    for (let i of e) switch (n = n.concat(t2.call(this, i)), i.type) {
      case "table": {
        let r = i;
        for (let o of r.header) n = n.concat(this.walkTokens(o.tokens, t2));
        for (let o of r.rows) for (let s of o) n = n.concat(this.walkTokens(s.tokens, t2));
        break;
      }
      case "list": {
        let r = i;
        n = n.concat(this.walkTokens(r.items, t2));
        break;
      }
      default: {
        let r = i;
        this.defaults.extensions?.childTokens?.[r.type] ? this.defaults.extensions.childTokens[r.type].forEach((o) => {
          let s = r[o].flat(1 / 0);
          n = n.concat(this.walkTokens(s, t2));
        }) : r.tokens && (n = n.concat(this.walkTokens(r.tokens, t2)));
      }
    }
    return n;
  }
  use(...e) {
    let t2 = this.defaults.extensions || { renderers: {}, childTokens: {} };
    return e.forEach((n) => {
      let i = { ...n };
      if (i.async = this.defaults.async || i.async || false, n.extensions && (n.extensions.forEach((r) => {
        if (!r.name) throw new Error("extension name required");
        if ("renderer" in r) {
          let o = t2.renderers[r.name];
          o ? t2.renderers[r.name] = function(...s) {
            let u = r.renderer.apply(this, s);
            return u === false && (u = o.apply(this, s)), u;
          } : t2.renderers[r.name] = r.renderer;
        }
        if ("tokenizer" in r) {
          if (!r.level || r.level !== "block" && r.level !== "inline") throw new Error("extension level must be 'block' or 'inline'");
          let o = t2[r.level];
          o ? o.unshift(r.tokenizer) : t2[r.level] = [r.tokenizer], r.start && (r.level === "block" ? t2.startBlock ? t2.startBlock.push(r.start) : t2.startBlock = [r.start] : r.level === "inline" && (t2.startInline ? t2.startInline.push(r.start) : t2.startInline = [r.start]));
        }
        "childTokens" in r && r.childTokens && (t2.childTokens[r.name] = r.childTokens);
      }), i.extensions = t2), n.renderer) {
        let r = this.defaults.renderer || new P(this.defaults);
        for (let o in n.renderer) {
          if (!(o in r)) throw new Error(`renderer '${o}' does not exist`);
          if (["options", "parser"].includes(o)) continue;
          let s = o, u = n.renderer[s], a = r[s];
          r[s] = (...p) => {
            let c = u.apply(r, p);
            return c === false && (c = a.apply(r, p)), c || "";
          };
        }
        i.renderer = r;
      }
      if (n.tokenizer) {
        let r = this.defaults.tokenizer || new y(this.defaults);
        for (let o in n.tokenizer) {
          if (!(o in r)) throw new Error(`tokenizer '${o}' does not exist`);
          if (["options", "rules", "lexer"].includes(o)) continue;
          let s = o, u = n.tokenizer[s], a = r[s];
          r[s] = (...p) => {
            let c = u.apply(r, p);
            return c === false && (c = a.apply(r, p)), c;
          };
        }
        i.tokenizer = r;
      }
      if (n.hooks) {
        let r = this.defaults.hooks || new S();
        for (let o in n.hooks) {
          if (!(o in r)) throw new Error(`hook '${o}' does not exist`);
          if (["options", "block"].includes(o)) continue;
          let s = o, u = n.hooks[s], a = r[s];
          S.passThroughHooks.has(o) ? r[s] = (p) => {
            if (this.defaults.async && S.passThroughHooksRespectAsync.has(o)) return (async () => {
              let h = await u.call(r, p);
              return a.call(r, h);
            })();
            let c = u.call(r, p);
            return a.call(r, c);
          } : r[s] = (...p) => {
            if (this.defaults.async) return (async () => {
              let h = await u.apply(r, p);
              return h === false && (h = await a.apply(r, p)), h;
            })();
            let c = u.apply(r, p);
            return c === false && (c = a.apply(r, p)), c;
          };
        }
        i.hooks = r;
      }
      if (n.walkTokens) {
        let r = this.defaults.walkTokens, o = n.walkTokens;
        i.walkTokens = function(s) {
          let u = [];
          return u.push(o.call(this, s)), r && (u = u.concat(r.call(this, s))), u;
        };
      }
      this.defaults = { ...this.defaults, ...i };
    }), this;
  }
  setOptions(e) {
    return this.defaults = { ...this.defaults, ...e }, this;
  }
  lexer(e, t2) {
    return x.lex(e, t2 ?? this.defaults);
  }
  parser(e, t2) {
    return b.parse(e, t2 ?? this.defaults);
  }
  parseMarkdown(e) {
    return (n, i) => {
      let r = { ...i }, o = { ...this.defaults, ...r }, s = this.onError(!!o.silent, !!o.async);
      if (this.defaults.async === true && r.async === false) return s(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));
      if (typeof n > "u" || n === null) return s(new Error("marked(): input parameter is undefined or null"));
      if (typeof n != "string") return s(new Error("marked(): input parameter is of type " + Object.prototype.toString.call(n) + ", string expected"));
      if (o.hooks && (o.hooks.options = o, o.hooks.block = e), o.async) return (async () => {
        let u = o.hooks ? await o.hooks.preprocess(n) : n, p = await (o.hooks ? await o.hooks.provideLexer(e) : e ? x.lex : x.lexInline)(u, o), c = o.hooks ? await o.hooks.processAllTokens(p) : p;
        o.walkTokens && await Promise.all(this.walkTokens(c, o.walkTokens));
        let k = await (o.hooks ? await o.hooks.provideParser(e) : e ? b.parse : b.parseInline)(c, o);
        return o.hooks ? await o.hooks.postprocess(k) : k;
      })().catch(s);
      try {
        o.hooks && (n = o.hooks.preprocess(n));
        let a = (o.hooks ? o.hooks.provideLexer(e) : e ? x.lex : x.lexInline)(n, o);
        o.hooks && (a = o.hooks.processAllTokens(a)), o.walkTokens && this.walkTokens(a, o.walkTokens);
        let c = (o.hooks ? o.hooks.provideParser(e) : e ? b.parse : b.parseInline)(a, o);
        return o.hooks && (c = o.hooks.postprocess(c)), c;
      } catch (u) {
        return s(u);
      }
    };
  }
  onError(e, t2) {
    return (n) => {
      if (n.message += `
Please report this to https://github.com/markedjs/marked.`, e) {
        let i = "<p>An error occurred:</p><pre>" + R(n.message + "", true) + "</pre>";
        return t2 ? Promise.resolve(i) : i;
      }
      if (t2) return Promise.reject(n);
      throw n;
    };
  }
};
var M = new Q();
function f(l3, e) {
  return M.parse(l3, e);
}
f.options = f.setOptions = function(l3) {
  return M.setOptions(l3), f.defaults = M.defaults, U(f.defaults), f;
};
f.getDefaults = A;
f.defaults = T;
function bt(...l3) {
  return M.use(...l3), f.defaults = M.defaults, U(f.defaults), f;
}
f.use = bt;
f.walkTokens = function(l3, e) {
  return M.walkTokens(l3, e);
};
f.parseInline = M.parseInline;
f.Parser = b;
f.parser = b.parse;
f.Renderer = P;
f.TextRenderer = L;
f.Lexer = x;
f.lexer = x.lex;
f.Tokenizer = y;
f.Hooks = S;
f.parse = f;
var un = f.options;
var pn = f.setOptions;
var cn = f.walkTokens;
var hn = f.parseInline;
var kn = b.parse;
var gn = x.lex;

// web/readable.mjs
var escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function safeLink(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
var markdown = new Q({ gfm: true, breaks: false, renderer: {
  html({ text }) {
    return escapeHTML(text);
  },
  link({ href, tokens }) {
    const label = this.parser.parseInline(tokens), url = safeLink(href);
    return url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  },
  image({ text, href }) {
    const url = safeLink(href);
    return url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(text || href)}</a>` : escapeHTML(text);
  },
  heading({ tokens, depth }) {
    const level = Math.min(6, depth + 1);
    return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>`;
  }
} });
function readingValue(value) {
  for (let i = 0; i < 2 && typeof value === "string"; i++) {
    const trimmed = value.trim(), fence = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i), text = fence ? fence[1] : trimmed;
    if (!/^[{[]/.test(text)) break;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") value = parsed;
      else break;
    } catch {
      break;
    }
  }
  return value;
}
var names = { executiveSummary: ["\u7ED3\u8BBA\u6458\u8981", "Executive summary"], reviewStatus: ["\u5BA1\u67E5\u72B6\u6001", "Review status"], conclusion: ["\u7ED3\u8BBA", "Conclusion"], summary: ["\u6458\u8981", "Summary"], findings: ["\u53D1\u73B0", "Findings"], coverageLimitations: ["\u8986\u76D6\u9650\u5236", "Coverage limitations"], coverageGaps: ["\u8986\u76D6\u7F3A\u53E3", "Coverage gaps"], limitations: ["\u9650\u5236\u4E0E\u7F3A\u53E3", "Limitations"], prioritizedActions: ["\u5EFA\u8BAE\u884C\u52A8", "Recommended actions"], strengths: ["\u4F18\u70B9", "Strengths"], testAndQualityGaps: ["\u6D4B\u8BD5\u4E0E\u8D28\u91CF\u7F3A\u53E3", "Test and quality gaps"], evidence: ["\u8BC1\u636E", "Evidence"], recommendation: ["\u5EFA\u8BAE", "Recommendation"], severity: ["\u4E25\u91CD\u7A0B\u5EA6", "Severity"], impact: ["\u5F71\u54CD", "Impact"], confidence: ["\u7F6E\u4FE1\u5EA6", "Confidence"], objective: ["\u4EFB\u52A1\u76EE\u6807", "Objective"], inputDescription: ["\u8F93\u5165\u8BF4\u660E", "Input description"], deliverables: ["\u4EA4\u4ED8\u5185\u5BB9", "Deliverables"], projectFound: ["\u9879\u76EE\u5B58\u5728", "Project found"], reviewableFiles: ["\u53EF\u5BA1\u67E5\u6587\u4EF6", "Reviewable files"], excludedFiles: ["\u6392\u9664\u6587\u4EF6", "Excluded files"], techStack: ["\u6280\u672F\u6808", "Technology stack"], entryPoints: ["\u5165\u53E3", "Entry points"], architectureMap: ["\u67B6\u6784\u7ED3\u6784", "Architecture map"], qualityGates: ["\u8D28\u91CF\u68C0\u67E5", "Quality gates"], notes: ["\u8BF4\u660E", "Notes"], status: ["\u72B6\u6001", "Status"], path: ["\u8DEF\u5F84", "Path"], output: ["\u7ED3\u679C", "Output"], error: ["\u9519\u8BEF", "Error"], details: ["\u8BE6\u60C5", "Details"], commandsRun: ["\u5DF2\u6267\u884C\u547D\u4EE4", "Commands run"], confirmedFindings: ["\u5DF2\u786E\u8BA4\u53D1\u73B0", "Confirmed findings"], rejectedFindings: ["\u5DF2\u6392\u9664\u53D1\u73B0", "Rejected findings"], reviewerFailures: ["\u5BA1\u67E5\u5931\u8D25", "Reviewer failures"] };
function fieldLabel(key, language2 = "en") {
  return names[key]?.[language2 === "zh" ? 0 : 1] ?? key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^./, (c) => c.toUpperCase());
}
function rawText(value) {
  return typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
}
function readableHTML(input, { language: language2 = "en", depth = 0 } = {}) {
  const value = readingValue(input), empty = language2 === "zh" ? "\u65E0\u5185\u5BB9" : "No content";
  if (value === null || value === void 0) return `<p class="content-empty">${empty}</p>`;
  if (typeof value === "string") return markdown.parse(value);
  if (typeof value !== "object") return `<p>${escapeHTML(value)}</p>`;
  if (depth >= 8) return `<pre><code>${escapeHTML(rawText(value))}</code></pre>`;
  if (!Object.keys(value).length) return `<p class="content-empty">${Array.isArray(value) ? language2 === "zh" ? "\u65E0\u6761\u76EE" : "No items" : empty}</p>`;
  const render = (v2) => readableHTML(v2, { language: language2, depth: depth + 1 });
  if (Array.isArray(value)) return `<ol class="content-items">${value.map((v2) => `<li>${render(v2)}</li>`).join("")}</ol>`;
  return Object.entries(value).map(([key, v2]) => `<section class="content-field"><h${Math.min(6, depth + 3)}>${escapeHTML(fieldLabel(key, language2))}</h${Math.min(6, depth + 3)}>${render(v2)}</section>`).join("");
}

// web/graph-model.mjs
var finished = /* @__PURE__ */ new Set(["succeeded", "completed_with_gaps", "failed", "cancelled"]);
function workflowGraph(run, { planOnly = false } = {}) {
  if (!run) return { nodes: [], phases: [] };
  const plan = run.topology?.nodes ?? [], actual = (run.steps ?? []).filter((s) => s.kind === "agent"), claimed = /* @__PURE__ */ new Set(), nodes = [], actualIds = /* @__PURE__ */ new Map();
  const emptyStatus = run.status === "pending_review" ? "planned" : finished.has(run.status) ? "not_run" : "awaiting";
  for (const p of plan) {
    const matches = actual.filter((s) => !claimed.has(s.id) && (s.planId ? s.planId === (p.planId ?? p.id) && (p.dynamic || !p.stepId || s.id === p.stepId) : p.stepId === s.id && plan.filter((n) => n.stepId === s.id).length === 1));
    if (planOnly) {
      nodes.push({ ...p, placeholder: true, status: "planned" });
      continue;
    }
    if (!matches.length || p.dynamic && !finished.has(run.status)) nodes.push({ ...p, placeholder: true, status: emptyStatus });
    for (const s of matches) {
      claimed.add(s.id);
      const id = p.dynamic ? `live:${s.id}` : p.id;
      actualIds.set(s.id, id);
      nodes.push({ ...p, ...s, id, actualId: s.id, placeholder: false, plannedDependsOn: p.dependsOn ?? [] });
    }
  }
  if (!planOnly) {
    for (const s of actual) if (!claimed.has(s.id)) {
      const id = `live:${s.id}`;
      actualIds.set(s.id, id);
      nodes.push({ ...s, id, actualId: s.id, placeholder: false });
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    if (!n.placeholder) n.dependsOn = (n.dependsOn ?? []).map((id) => actualIds.get(id)).filter(Boolean);
    if (n.placeholder && !planOnly && !finished.has(run.status) && n.dependsOn?.some((id) => run.topology?.edges?.some((e) => e.from === id && e.to === n.id && e.type === "declared") && ["failed", "interrupted", "blocked"].includes(byId.get(id)?.status))) n.status = "blocked";
  }
  const phases = [];
  for (const p of [...run.topology?.phases ?? [], ...run.phases ?? []]) if (!phases.some((x2) => x2.id === p.id)) phases.push(p);
  for (const n of nodes) if (n.phase && !phases.some((p) => p.id === n.phase)) phases.push({ id: n.phase, label: n.phase });
  return { nodes, phases };
}

// web/i18n.mjs
var messages = {
  "zh": {
    "repairRun": "\u4FEE\u6539\u5E76\u4FEE\u590D",
    "createRepair": "\u751F\u6210\u4FEE\u590D\u9884\u89C8",
    "repairContext": "\u57FA\u4E8E\u539F\u8FD0\u884C\u4FEE\u590D",
    "repairReason": "\u4FEE\u6539\u8BF4\u660E",
    "repairReuseHelp": "\u52FE\u9009\u786E\u8BA4\u4ECD\u7136\u6709\u6548\u7684\u6210\u529F\u7ED3\u679C\u3002\u9ED8\u8BA4\u5168\u90E8\u91CD\u8DD1\uFF1B\u53C2\u6570\u3001\u8F93\u5165\u3001\u5DF2\u767B\u8BB0\u6587\u4EF6\u6216\u4E0A\u6E38\u53D8\u5316\u65F6\uFF0C\u6240\u9009\u8282\u70B9\u4ECD\u4F1A\u91CD\u8DD1\u3002\u5916\u90E8\u8D44\u6599\u3001\u4EE3\u7801\u6216\u4EFB\u52A1\u542B\u4E49\u5DF2\u53D8\u65F6\uFF0C\u8BF7\u52FF\u52FE\u9009\u76F8\u5173\u8282\u70B9\u3002",
    "repairSource": "\u67E5\u770B\u539F\u8FD0\u884C",
    "repairCandidates": "{count} \u4E2A\u5019\u9009\u590D\u7528\u8282\u70B9 \xB7 \u6267\u884C\u65F6\u9010\u9879\u6821\u9A8C",
    "repairNoError": "\u8BF7\u8BF4\u660E\u9700\u8981\u4FEE\u6B63\u7684\u884C\u4E3A\u3002\u539F\u8FD0\u884C\u8BB0\u5F55\u5C06\u5B8C\u6574\u4FDD\u7559\u3002",
    "repairNoCandidates": "\u6CA1\u6709\u53EF\u590D\u7528\u7684\u6210\u529F\u8282\u70B9\u3002",
    "reusedResult": "\u590D\u7528\u5DF2\u6709\u7ED3\u679C",
    "auto": "\u8DDF\u968F\u7CFB\u7EDF",
    "language": "\u754C\u9762\u8BED\u8A00",
    "languageHelp": "\u9996\u6B21\u8DDF\u968F\u7CFB\u7EDF\u8BED\u8A00\uFF1B\u624B\u52A8\u9009\u62E9\u540E\u81EA\u52A8\u4FDD\u5B58",
    "new": "\u65B0\u5EFA\u5DE5\u4F5C\u6D41",
    "history": "\u5DE5\u4F5C\u6D41\u8BB0\u5F55",
    "workspace": "\u672C\u5730\u5DE5\u4F5C\u533A",
    "connecting": "\u6B63\u5728\u8FDE\u63A5",
    "connected": "\u672C\u5730\u670D\u52A1\u5DF2\u8FDE\u63A5",
    "disconnected": "\u8FDE\u63A5\u4E2D\u65AD",
    "notConnected": "\u672A\u8FDE\u63A5",
    "workspaceTag": "\u672C\u5730\u8FD0\u884C",
    "overview": "\u8FD0\u884C\u6982\u89C8",
    "details": "\u8FD0\u884C\u8BE6\u60C5",
    "canvas": "\u5DE5\u4F5C\u6D41\u753B\u5E03",
    "noRun": "\u5C1A\u672A\u9009\u62E9\u8FD0\u884C",
    "pause": "\u6682\u505C",
    "resume": "\u6062\u590D",
    "cancel": "\u53D6\u6D88",
    "emptyTitle": "\u628A\u590D\u6742\u4EFB\u52A1\uFF0C\u7F16\u6392\u5F97\u6E05\u6670\u6709\u5E8F\u3002",
    "emptyBody": "\u62C6\u89E3\u3001\u5E76\u884C\u3001\u590D\u6838\u3001\u6C47\u603B\u3002\u5728\u4E00\u5F20\u753B\u5E03\u91CC\uFF0C\u638C\u63E1\u6BCF\u4E2A Agent \u7684\u8FDB\u5C55\u3002",
    "emptyHint": "\u4E5F\u53EF\u4EE5\u5728 MCode \u5BF9\u8BDD\u4E2D\u4F7F\u7528 dynamic-workflow \u521B\u5EFA\u7F16\u6392\u3002",
    "completed": "\u5B8C\u6210\u8282\u70B9",
    "calls": "Agent \u8C03\u7528",
    "tokens": "\u5DF2\u77E5 Token",
    "saved": "\u8FD0\u884C\u8BB0\u5F55\u4FDD\u5B58\u5728\u672C\u673A",
    "execution": "\u6267\u884C\u72B6\u6001",
    "graphLabel": "\u5DE5\u4F5C\u6D41\u8282\u70B9\u4E0E\u4F9D\u8D56",
    "graphRegion": "\u5DE5\u4F5C\u6D41\u4F9D\u8D56\u56FE",
    "script": "\u67E5\u770B\u811A\u672C",
    "report": "\u6700\u7EC8\u62A5\u544A",
    "waiting": "\u7B49\u5F85\u4EFB\u52A1\u5C55\u5F00\u2026",
    "running": "\u6267\u884C\u4E2D",
    "succeeded": "\u5DF2\u5B8C\u6210",
    "failedLegend": "\u5931\u8D25 / \u4E2D\u65AD",
    "canvasHint": "\u6EDA\u52A8\u6D4F\u89C8 \xB7 \u9009\u62E9\u8282\u70B9\u67E5\u770B\u8BE6\u60C5",
    "fit": "\u5168\u89C8",
    "fitTitle": "\u663E\u793A\u5B8C\u6574\u5DE5\u4F5C\u6D41",
    "zoomOut": "\u7F29\u5C0F",
    "zoomIn": "\u653E\u5927",
    "zoomReset": "\u9002\u5E94\u5BBD\u5EA6",
    "nodeDetails": "\u8282\u70B9\u8BE6\u60C5",
    "noSelection": "\u672A\u9009\u62E9",
    "chooseNode": "\u9009\u62E9\u4E00\u4E2A\u8282\u70B9\uFF0C\u67E5\u770B\u8F93\u5165\u4E0E\u7ED3\u679C\u3002",
    "close": "\u5173\u95ED",
    "closeInspector": "\u5173\u95ED\u8282\u70B9\u8BE6\u60C5",
    "nodeContent": "\u8282\u70B9\u5185\u5BB9",
    "output": "\u7ED3\u679C",
    "input": "\u8F93\u5165",
    "logs": "\u65E5\u5FD7",
    "events": "\u8FD0\u884C\u65E5\u5FD7",
    "eventsHint": "\u5C55\u5F00\u6267\u884C\u8BB0\u5F55",
    "eventsCount": "{count} \u6761",
    "newHeading": "\u521B\u5EFA\u5DE5\u4F5C\u6D41",
    "newSubtitle": "\u751F\u6210\u53EF\u4FEE\u6539\u7684\u7ED3\u6784\u9884\u89C8\uFF0C\u5BA1\u6838\u540E\u518D\u5F00\u59CB\u6267\u884C\u3002",
    "name": "\u5DE5\u4F5C\u6D41\u540D\u79F0",
    "defaultName": "\u4E09\u89C6\u89D2\u4EE3\u7801\u5BA1\u67E5",
    "executor": "\u6267\u884C\u65B9\u5F0F",
    "demoOption": "\u6F14\u793A \xB7 \u4E0D\u8C03\u7528\u6A21\u578B",
    "mcodeOption": "MCode \xB7 \u771F\u5B9E Agent",
    "missingOption": "MCode \xB7 \u672A\u68C0\u6D4B\u5230 CLI",
    "concurrency": "\u5E76\u53D1\u6570",
    "maxCalls": "\u6700\u591A\u8C03\u7528",
    "limits": "\u6267\u884C\u9650\u5236 \xB7 \u6BCF\u8282\u70B9 {steps} \u6B65 / {minutes} \u5206\u949F",
    "limitsHelp": "\u6B65\u6570\u662F\u5355\u4E2A Agent \u7684\u6A21\u578B\u51B3\u7B56\u8F6E\u6570\uFF1B\u8C03\u7528\u6570\u662F\u5DE5\u4F5C\u6D41\u542F\u52A8 Agent \u7684\u6B21\u6570\u3002",
    "maxSteps": "\u6BCF\u8282\u70B9\u6700\u5927\u6B65\u6570",
    "stepMinutes": "\u8282\u70B9\u8D85\u65F6\uFF08\u5206\u949F\uFF09",
    "runMinutes": "\u5DE5\u4F5C\u6D41\u65F6\u9650\uFF08\u5206\u949F\uFF09",
    "demoNote": "\u6F14\u793A\u7528\u4E8E\u4F53\u9A8C\u4F9D\u8D56\u56FE\u3001\u6682\u505C\u548C\u6062\u590D\uFF0C\u4E0D\u4EE3\u8868\u771F\u5B9E\u6A21\u578B\u7ED3\u679C\u3002",
    "mcodeNote": "\u8C03\u7528\u5DF2\u767B\u5F55\u7684 MCode\uFF0C\u4EE5 smart \u6743\u9650\u6267\u884C\u3002Agent \u53EF\u4EE5\u4F7F\u7528\u5BBF\u4E3B\u5DE5\u5177\uFF0C\u53EF\u80FD\u4FEE\u6539\u6587\u4EF6\uFF0C\u5E76\u6D88\u8017\u6A21\u578B\u7528\u91CF\u3002",
    "material": "\u5F85\u5BA1\u67E5\u6750\u6599",
    "editableScript": "\u7F16\u6392\u811A\u672C \xB7 \u53EF\u7F16\u8F91",
    "scriptInput": "JavaScript \u7F16\u6392\u811A\u672C",
    "scriptHelp": "\u811A\u672C\u662F\u5F02\u6B65\u51FD\u6570\u4F53\u3002ctx.agent \u8FD4\u56DE status/output/error\uFF1B\u4F9D\u8D56\u987B\u663E\u5F0F\u58F0\u660E dependsOn\uFF0C\u4E14\u5148 await \u4E0A\u6E38\u7ED3\u679C\u3002",
    "validate": "\u68C0\u67E5\u811A\u672C",
    "start": "\u5F00\u59CB\u8FD0\u884C",
    "valid": "\u811A\u672C\u68C0\u67E5\u901A\u8FC7\u3002\u4FDD\u5B58\u540E\u67E5\u770B\u7ED3\u6784\u62D3\u6251\uFF1B\u5C1A\u672A\u6267\u884C\u3002",
    "resumeHeading": "\u8C03\u6574\u9650\u5236\u5E76\u6062\u590D",
    "totalCalls": "Agent \u603B\u8C03\u7528\u4E0A\u9650\uFF08\u542B\u6B64\u524D\u5C1D\u8BD5\uFF09",
    "resumeHelp": "\u6210\u529F\u8282\u70B9\u590D\u7528\uFF0C\u5931\u8D25\u8282\u70B9\u4ECE\u5934\u91CD\u8DD1\uFF0C\u53EF\u80FD\u518D\u6B21\u6D88\u8017\u6A21\u578B\u7528\u91CF\u3002\u539F\u811A\u672C\u548C\u8F93\u5165\u4FDD\u6301\u4E0D\u53D8\u3002",
    "applyResume": "\u5E94\u7528\u9650\u5236\u5E76\u6062\u590D",
    "resumeNote": "\u5DF2\u4F7F\u7528 {used} / {max} \u6B21 Agent \u8C03\u7528\u3002",
    "legacyNote": "\u8FD9\u662F\u65E7\u7248\u8FD0\u884C\uFF0C\u5DF2\u586B\u5165\u65B0\u7248\u9ED8\u8BA4\u9650\u5236\uFF0C\u8BF7\u68C0\u67E5\u540E\u5E94\u7528\u3002",
    "confirmStopped": "\u4E0A\u6B21\u670D\u52A1\u5F02\u5E38\u7EC8\u6B62\u3002\u53EA\u6709\u786E\u8BA4\u65E7 Agent \u5DF2\u505C\u6B62\u540E\u624D\u53EF\u6062\u590D\u3002\u5DF2\u786E\u8BA4\u505C\u6B62\u5417\uFF1F",
    "rawContent": "\u4EFB\u52A1\u5185\u5BB9\u3001\u6A21\u578B\u8F93\u51FA\u4E0E\u539F\u59CB\u8BCA\u65AD\u4FDD\u7559\u539F\u6587\u3002",
    "frozenScript": "\u672C\u6B21\u8FD0\u884C\u7684\u51BB\u7ED3\u811A\u672C",
    "noReport": "\u5C1A\u65E0\u6700\u7EC8\u62A5\u544A\u3002\u5F53\u524D\u72B6\u6001\uFF1A{status}",
    "demo": "\u6F14\u793A",
    "demoRun": "\u6F14\u793A\u8FD0\u884C \xB7 \u65E0\u6A21\u578B\u8C03\u7528",
    "realRun": "MCode \xB7 \u771F\u5B9E\u6267\u884C",
    "unknown": "\u672A\u77E5",
    "unknownPlus": " + \u672A\u77E5",
    "tasks": "{count} \u4E2A\u4EFB\u52A1",
    "defaultPhase": "\u6267\u884C\u4EFB\u52A1",
    "pending": "\u5F85\u6267\u884C",
    "attemptSuffix": " \xB7 \u7B2C {count} \u6B21",
    "duration": "\u8017\u65F6",
    "notStarted": "\u5C1A\u672A\u5F00\u59CB",
    "attempt": "\u5C1D\u8BD5",
    "stepLimit": "\u6B65\u6570\u4E0A\u9650",
    "nodeTimeout": "\u8282\u70B9\u8D85\u65F6",
    "minutes": "{count} \u5206\u949F",
    "dependencies": "\u4F9D\u8D56",
    "none": "\u65E0",
    "session": "\u4F1A\u8BDD",
    "noOutput": "\u5C1A\u65E0\u7ED3\u679C",
    "noLogs": "\u6682\u65E0\u65E5\u5FD7",
    "noSuccess": "\u8BE5\u8282\u70B9\u5C1A\u65E0\u6210\u529F\u7ED3\u679C\uFF1B\u8BF7\u67E5\u770B\u8F93\u5165\u4E0E\u65E5\u5FD7\u3002",
    "originalReason": "\u539F\u59CB\u8BCA\u65AD\uFF1A{cause}",
    "errorStep": "\u8FBE\u5230\u5355\u4E2A Agent \u7684 {steps} \u6B65\u4E0A\u9650\uFF0C\u672A\u53D6\u5F97\u6210\u529F\u7ED3\u679C\u3002",
    "errorTimeout": "\u5355\u4E2A Agent \u8FBE\u5230 {minutes} \u5206\u949F\u65F6\u9650\uFF0C\u5DF2\u505C\u6B62\u3002",
    "errorWorkflowTimeout": "\u5DE5\u4F5C\u6D41\u8FBE\u5230 {minutes} \u5206\u949F\u6574\u4F53\u65F6\u9650\uFF0C\u5DF2\u505C\u6B62\u5728\u9014\u8282\u70B9\u3002",
    "errorCancelled": "MCode \u8FD4\u56DE\u4EFB\u52A1\u5DF2\u53D6\u6D88\u3002",
    "errorInterrupted": "\u6267\u884C\u5DF2\u6682\u505C\u3001\u53D6\u6D88\u6216\u4E2D\u65AD\u3002",
    "errorStart": "\u65E0\u6CD5\u542F\u52A8 MCode\u3002",
    "errorProtocol": "MCode \u8FD4\u56DE\u4E86\u65E0\u6548\u7684\u5B8C\u6210\u534F\u8BAE\u3002",
    "errorMissing": "MCode \u672A\u8FD4\u56DE\u5B8C\u6210\u534F\u8BAE\uFF08\u9000\u51FA\u7801 {code}\uFF09\u3002",
    "errorExit": "MCode \u8FDB\u7A0B\u5F02\u5E38\u9000\u51FA\uFF08\u9000\u51FA\u7801 {code}\uFF09\uFF0C\u7ED3\u679C\u672A\u91C7\u7EB3\u3002",
    "errorDependency": "\u8282\u70B9 {stepId} \u7684\u4F9D\u8D56\u914D\u7F6E\u65E0\u6548\u3002",
    "errorDependencyReady": "\u8282\u70B9 {stepId} \u65E0\u6CD5\u542F\u52A8\uFF1A\u4F9D\u8D56 {dependency} \u7684\u72B6\u6001\u4E3A {status}\u3002",
    "errorLegacyDependency": "\u65E7\u7248\u62D2\u7EDD\u4E86\u5355\u4E2A\u4F9D\u8D56\u7684\u5B57\u7B26\u4E32\u5199\u6CD5\uFF0C\u5F53\u524D\u7248\u672C\u5DF2\u517C\u5BB9\u3002",
    "adviceDependency": "\u4F7F\u7528\u8282\u70B9 ID \u5B57\u7B26\u4E32\u6216\u6570\u7EC4\uFF0C\u5148\u7B49\u5F85\u4E0A\u6E38\u6210\u529F\uFF0C\u518D\u542F\u52A8\u4F9D\u8D56\u8282\u70B9\u3002",
    "adviceLegacyDependency": "\u70B9\u51FB\u6062\u590D\u7EE7\u7EED\u6267\u884C\uFF0C\u5DF2\u6210\u529F\u7684\u8282\u70B9\u4F1A\u590D\u7528\u3002\u5237\u65B0\u9875\u9762\u4E0D\u4F1A\u81EA\u52A8\u91CD\u8DD1\u3002",
    "previousNode": "\u4E0A\u4E00\u4E2A\u8282\u70B9",
    "nextNode": "\u4E0B\u4E00\u4E2A\u8282\u70B9",
    "viewRaw": "\u67E5\u770B\u539F\u6587",
    "viewReading": "\u9605\u8BFB\u89C6\u56FE",
    "copyContent": "\u590D\u5236\u539F\u6587",
    "copied": "\u5DF2\u590D\u5236",
    "copyFailed": "\u590D\u5236\u5931\u8D25\uFF0C\u8BF7\u9009\u4E2D\u6587\u672C\u590D\u5236",
    "executionDetails": "\u6267\u884C\u53C2\u6570\u4E0E\u4F9D\u8D56",
    "nodePrompt": "\u4EFB\u52A1\u6307\u4EE4",
    "nodeInputData": "\u8F93\u5165\u6750\u6599",
    "runningOutput": "\u8282\u70B9\u6B63\u5728\u6267\u884C\uFF0C\u5B8C\u6210\u540E\u4F1A\u5728\u8FD9\u91CC\u663E\u793A\u7ED3\u679C\u3002\u65E5\u5FD7\u4E2D\u53EF\u67E5\u770B\u5DF2\u6709\u8FDB\u5C55\u3002",
    "reportLoading": "\u6B63\u5728\u6392\u7248\u62A5\u544A\u2026",
    "reportLoadFailed": "\u62A5\u544A\u52A0\u8F7D\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u3002",
    "errorStructured": "\u8282\u70B9 {stepId} \u7684\u7ED3\u6784\u5316\u7ED3\u679C\u4E0D\u7B26\u5408\u8981\u6C42\u3002",
    "adviceStructured": "\u67E5\u770B\u539F\u59CB\u8F93\u51FA\u4E0E\u6821\u9A8C\u9519\u8BEF\uFF0C\u4FEE\u6B63 schema \u6216\u63D0\u793A\u8BCD\uFF1B\u4E0D\u8981\u8BFB\u53D6\u5931\u8D25\u7ED3\u679C\u6216\u81EA\u52A8\u91CD\u8BD5\u3002",
    "errorGeneric": "\u6267\u884C\u672A\u5B8C\u6210\u3002",
    "adviceStep": "\u63D0\u9AD8\u6BCF\u8282\u70B9\u6B65\u6570\u540E\u6062\u590D\uFF0C\u6216\u62C6\u5206\u4EFB\u52A1\uFF1B\u5931\u8D25\u8282\u70B9\u5C06\u4ECE\u5934\u91CD\u8DD1\u3002",
    "adviceTimeout": "\u63D0\u9AD8\u5BF9\u5E94\u65F6\u9650\uFF0C\u6216\u7F29\u5C0F\u4EFB\u52A1\u8303\u56F4\u540E\u6062\u590D\u3002",
    "adviceGeneric": "\u68C0\u67E5\u539F\u59CB\u8BCA\u65AD\u3001\u8282\u70B9\u65E5\u5FD7\u3001\u767B\u5F55\u53CA\u7F51\u7EDC\u914D\u7F6E\uFF0C\u4FEE\u590D\u540E\u518D\u6062\u590D\u3002",
    "serviceError": "\u64CD\u4F5C\u672A\u5B8C\u6210\u3002",
    "authError": "\u8BBF\u95EE\u51ED\u8BC1\u65E0\u6548\u3002\u8BF7\u4ECE workflow_dashboard \u91CD\u65B0\u6253\u5F00\u9762\u677F\u3002",
    "status.queued": "\u6392\u961F\u4E2D",
    "status.running": "\u6267\u884C\u4E2D",
    "status.succeeded": "\u5DF2\u5B8C\u6210",
    "status.completed_with_gaps": "\u5B8C\u6210 \xB7 \u6709\u7F3A\u53E3",
    "status.failed": "\u5931\u8D25",
    "status.cancelled": "\u5DF2\u53D6\u6D88",
    "status.paused": "\u5DF2\u6682\u505C",
    "status.pausing": "\u6B63\u5728\u6682\u505C",
    "status.stopping": "\u6B63\u5728\u505C\u6B62",
    "status.interrupted": "\u5DF2\u4E2D\u65AD",
    "status.needs_attention": "\u9700\u8981\u5904\u7406",
    "event.run.created": "\u521B\u5EFA\u5DE5\u4F5C\u6D41",
    "event.run.started": "\u5F00\u59CB\u6267\u884C",
    "event.phase.created": "\u58F0\u660E\u9636\u6BB5",
    "event.step.queued": "\u8282\u70B9\u5165\u961F",
    "event.step.started": "\u8282\u70B9\u5F00\u59CB\u6267\u884C",
    "event.step.progress": "\u6267\u884C\u8FDB\u5EA6",
    "event.step.finished": "\u8282\u70B9\u7ED3\u675F",
    "event.run.finished": "\u5DE5\u4F5C\u6D41\u7ED3\u675F",
    "event.run.stopping": "\u6B63\u5728\u505C\u6B62",
    "event.log": "\u5DE5\u4F5C\u6D41\u65E5\u5FD7",
    "event.checkpoint": "\u4FDD\u5B58\u68C0\u67E5\u70B9",
    "event.run.limits": "\u8C03\u6574\u6267\u884C\u9650\u5236",
    "status.pending_review": "\u5F85\u5BA1\u6838",
    "status.planned": "\u8BA1\u5212\u8282\u70B9",
    "event.run.updated": "\u5BA1\u6838\u8349\u7A3F\u5DF2\u66F4\u65B0",
    "event.run.approved": "\u7528\u6237\u5DF2\u5F00\u59CB\u6267\u884C",
    "editDraft": "\u4FEE\u6539\u5DE5\u4F5C\u6D41",
    "approve": "\u5F00\u59CB\u6267\u884C",
    "reviewEyebrow": "REVIEW BEFORE RUN",
    "reviewHeading": "\u5148\u770B\u6E05\u8BA1\u5212\uFF0C\u518D\u5F00\u59CB\u6267\u884C\u3002",
    "reviewHelp": "\u811A\u672C\u5DF2\u751F\u6210\uFF0C\u5C1A\u672A\u8C03\u7528\u4EFB\u4F55 Agent\u3002\u67E5\u770B\u4E0B\u65B9\u7ED3\u6784\u62D3\u6251\uFF0C\u6216\u4FEE\u6539\u811A\u672C\u3001\u8F93\u5165\u4E0E\u6267\u884C\u9884\u7B97\u3002",
    "reviewVersion": "\u5BA1\u6838\u7248\u672C v{revision} \xB7 \u4FEE\u6539\u5E76\u4FDD\u5B58\u540E\u4F1A\u91CD\u65B0\u751F\u6210\u62D3\u6251",
    "createDraft": "\u751F\u6210\u5BA1\u6838\u9884\u89C8",
    "saveDraft": "\u4FDD\u5B58\u5E76\u66F4\u65B0\u62D3\u6251",
    "showPlan": "\u7ED3\u6784\u62D3\u6251",
    "showExecution": "\u6267\u884C\u8282\u70B9",
    "queueGlobal": "\u7B49\u5F85\u5171\u4EAB\u6267\u884C\u540D\u989D\uFF1A\u6240\u6709\u5DE5\u4F5C\u6D41\u5DF2\u4F7F\u7528 {active}/{limit} \u4E2A\u540D\u989D\u3002",
    "queueRun": "\u7B49\u5F85\u672C\u5DE5\u4F5C\u6D41\u6267\u884C\u540D\u989D\uFF1A\u5DF2\u4F7F\u7528 {active}/{limit} \u4E2A\u540D\u989D\u3002",
    "queueOwners": "\u6B63\u5728\u5360\u7528\u540D\u989D\uFF1A{owners}",
    "queueDispatch": "\u6B63\u5728\u7B49\u5F85\u8C03\u5EA6\u3002",
    "topologyTitle": "\u811A\u672C\u7ED3\u6784\u9884\u89C8",
    "topology.truncated": "\u9884\u89C8\u4EC5\u663E\u793A\u524D 100 \u5904 Agent \u8C03\u7528\uFF0C\u8BF7\u67E5\u770B\u5B8C\u6574\u811A\u672C\u3002",
    "topology.staticPreview": "\u6B64\u56FE\u4EC5\u9759\u6001\u89E3\u6790\u811A\u672C\uFF0C\u672A\u6267\u884C\u811A\u672C\uFF1B\u8FDE\u7EBF\u8868\u793A\u663E\u5F0F\u4F9D\u8D56\u6216\u63A8\u65AD\u7684\u6570\u636E\u5173\u7CFB\uFF0C\u4E0D\u4EE3\u8868\u5B9E\u9645\u6267\u884C\u987A\u5E8F\u3002",
    "topology.dynamicNodes": "\u52A8\u6001\u4EFB\u52A1\u7EC4\u4F1A\u5728\u8FD0\u884C\u65F6\u6309\u5B9E\u9645\u6570\u636E\u5C55\u5F00\uFF0C\u6570\u91CF\u5C1A\u672A\u786E\u5B9A\u3002",
    "topology.conditionalNodes": "\u6761\u4EF6\u5206\u652F\u4EC5\u5728\u6761\u4EF6\u6EE1\u8DB3\u65F6\u6267\u884C\u3002",
    "topology.dynamicDependencies": "\u90E8\u5206\u4F9D\u8D56\u7531\u8FD0\u884C\u7ED3\u679C\u51B3\u5B9A\u3002",
    "topology.unresolvedDependencies": "\u90E8\u5206\u4F9D\u8D56\u76EE\u6807\u65E0\u6CD5\u9759\u6001\u5B9A\u4F4D\uFF0C\u8BF7\u68C0\u67E5\u811A\u672C\u3002",
    "topology.dynamicPhase": "\u90E8\u5206\u9636\u6BB5\u540D\u79F0\u5728\u8FD0\u884C\u65F6\u786E\u5B9A\u3002",
    "topology.noStaticAgents": "\u672A\u627E\u5230\u76F4\u63A5\u7684 ctx.agent \u8C03\u7528\uFF1B\u8BF7\u9605\u8BFB\u811A\u672C\u786E\u8BA4\u884C\u4E3A\uFF0C\u522B\u540D\u6216\u5C01\u88C5\u8C03\u7528\u53EF\u80FD\u65E0\u6CD5\u663E\u793A\u3002",
    "dynamicGroup": "\u52A8\u6001\u4EFB\u52A1\u7EC4",
    "conditionalNode": "\u6761\u4EF6\u8282\u70B9",
    "plannedNode": "\u8BA1\u5212\u8282\u70B9",
    "sourceLine": "\u811A\u672C\u7B2C {line} \u884C",
    "inputJSON": "\u5DE5\u4F5C\u6D41\u8F93\u5165\uFF08JSON object\uFF09",
    "inputObject": "\u8F93\u5165\u5FC5\u987B\u662F JSON object",
    "structures": "{count} \u4E2A\u8282\u70B9 / \u4EFB\u52A1\u7EC4",
    "schedulerSettings": "\u5E76\u53D1\u8BBE\u7F6E",
    "schedulerBadge": "\u5168\u5C40\u5E76\u53D1 {active}/{limit}",
    "schedulerUsage": "\u6B63\u5728\u8FD0\u884C {active}/{limit} \u4E2A Agent\uFF0C{queued} \u4E2A\u8282\u70B9\u7B49\u5F85\u4E2D\u3002",
    "globalConcurrency": "\u5168\u5C40 Agent \u5E76\u53D1\u4E0A\u9650",
    "schedulerHelp": "\u6240\u6709\u5DE5\u4F5C\u6D41\u5171\u4EAB\u6B64\u4E0A\u9650\uFF0C\u9ED8\u8BA4 8\uFF0C\u652F\u6301 1\u201332\u3002\u5404\u5DE5\u4F5C\u6D41\u8F6E\u6D41\u53D6\u5F97\u7A7A\u95F2\u540D\u989D\uFF0C\u540C\u65F6\u9075\u5B88\u5404\u81EA\u7684\u5E76\u53D1\u4E0A\u9650\u3002\u964D\u4F4E\u4E0A\u9650\u4E0D\u4F1A\u4E2D\u65AD\u6B63\u5728\u8FD0\u884C\u7684 Agent\uFF1B\u8BBE\u7F6E\u4FDD\u5B58\u5728\u672C\u673A\u3002",
    "saveSettings": "\u4FDD\u5B58\u8BBE\u7F6E"
  },
  "en": {
    "repairRun": "Edit & repair",
    "createRepair": "Preview repair",
    "repairContext": "Repair from this run",
    "repairReason": "What changed and why",
    "repairReuseHelp": "Select successful results you know are still valid. All nodes rerun by default. Changed arguments, inputs, tracked files, or rerun dependencies invalidate reuse. Leave results unselected if external evidence, code, or task meaning changed.",
    "repairSource": "View original run",
    "repairCandidates": "{count} reuse candidates \xB7 checked at execution",
    "repairNoError": "Describe the correction. The original run remains intact.",
    "repairNoCandidates": "No successful nodes available to reuse.",
    "reusedResult": "Reused result",
    "auto": "System",
    "language": "Language",
    "languageHelp": "Follows system language by default; your choice is saved",
    "new": "New workflow",
    "history": "Workflows",
    "workspace": "Local workspace",
    "connecting": "Connecting",
    "connected": "Local service connected",
    "disconnected": "Connection lost",
    "notConnected": "Not connected",
    "workspaceTag": "LOCAL WORKSPACE",
    "overview": "Run overview",
    "details": "Run details",
    "canvas": "Workflow canvas",
    "noRun": "No run selected",
    "pause": "Pause",
    "resume": "Resume",
    "cancel": "Cancel",
    "emptyTitle": "Complex work. Clearly orchestrated.",
    "emptyBody": "Plan, run in parallel, verify, and synthesize. Follow every agent on one canvas.",
    "emptyHint": "You can also ask MCode to create a run with dynamic-workflow.",
    "completed": "Completed nodes",
    "calls": "Agent calls",
    "tokens": "Reported tokens",
    "saved": "Run history stays on this device",
    "execution": "Execution",
    "graphLabel": "Workflow nodes and dependencies",
    "graphRegion": "Workflow dependency graph",
    "script": "View script",
    "report": "Final report",
    "waiting": "Waiting for tasks\u2026",
    "running": "Running",
    "succeeded": "Completed",
    "failedLegend": "Failed / interrupted",
    "canvasHint": "Scroll to explore \xB7 Select a node to inspect",
    "fit": "Fit",
    "fitTitle": "Fit the entire workflow",
    "zoomOut": "Zoom out",
    "zoomIn": "Zoom in",
    "zoomReset": "Fit to width",
    "nodeDetails": "Node details",
    "noSelection": "Not selected",
    "chooseNode": "Select a node to inspect its input and results.",
    "close": "Close",
    "closeInspector": "Close node details",
    "nodeContent": "Node content",
    "output": "Output",
    "input": "Input",
    "logs": "Logs",
    "events": "Activity",
    "eventsHint": "Expand activity",
    "eventsCount": "{count} events",
    "newHeading": "Create a workflow",
    "newSubtitle": "Create an editable structure preview, then review it before execution.",
    "name": "Workflow name",
    "defaultName": "Three-perspective code review",
    "executor": "Execution mode",
    "demoOption": "Demo \xB7 no model calls",
    "mcodeOption": "MCode \xB7 real agents",
    "missingOption": "MCode \xB7 CLI not detected",
    "concurrency": "Concurrency",
    "maxCalls": "Maximum calls",
    "limits": "Limits \xB7 {steps} steps / {minutes} min per agent",
    "limitsHelp": "Steps count model decisions within an agent. Calls count agents started by the workflow.",
    "maxSteps": "Maximum steps per agent",
    "stepMinutes": "Agent timeout (minutes)",
    "runMinutes": "Workflow timeout (minutes)",
    "demoNote": "Demo mode lets you explore the graph, pause, and resume. It does not produce real model results.",
    "mcodeNote": "Uses your signed-in MCode with smart permissions. Agents can use host tools, may change files, and consume model usage.",
    "material": "Material to review",
    "editableScript": "Workflow script \xB7 editable",
    "scriptInput": "JavaScript workflow script",
    "scriptHelp": "Use an async function body. ctx.agent returns status/output/error. Declare dependsOn explicitly and await upstream results.",
    "validate": "Validate script",
    "start": "Start workflow",
    "valid": "Script check passed. Save to inspect the structure. Nothing has run.",
    "resumeHeading": "Adjust limits and resume",
    "totalCalls": "Total agent call limit (including previous attempts)",
    "resumeHelp": "Successful nodes are reused. Failed nodes restart and may consume more model usage. The original script and inputs are preserved.",
    "applyResume": "Apply and resume",
    "resumeNote": "Used {used} of {max} agent calls.",
    "legacyNote": "This is a legacy run. Review the current defaults before applying them.",
    "confirmStopped": "The previous service stopped unexpectedly. Resume only after confirming that its old agents have stopped. Have they stopped?",
    "rawContent": "Task content, model output, and original diagnostics stay in their source language.",
    "frozenScript": "Frozen script for this run",
    "noReport": "No final report yet. Current status: {status}",
    "demo": "Demo",
    "demoRun": "Demo run \xB7 no model calls",
    "realRun": "MCode \xB7 real execution",
    "unknown": "Unknown",
    "unknownPlus": " + unknown",
    "tasks": "{count} tasks",
    "defaultPhase": "Tasks",
    "pending": "Pending",
    "attemptSuffix": " \xB7 attempt {count}",
    "duration": "Duration",
    "notStarted": "Not started",
    "attempt": "Attempt",
    "stepLimit": "Step limit",
    "nodeTimeout": "Agent timeout",
    "minutes": "{count} min",
    "dependencies": "Dependencies",
    "none": "None",
    "session": "Session",
    "noOutput": "No output yet",
    "noLogs": "No logs yet",
    "noSuccess": "This node has no successful result. Check its input and logs.",
    "originalReason": "Original diagnostic: {cause}",
    "errorStep": "The agent reached its {steps}-step limit without a successful result.",
    "errorTimeout": "The agent reached its {minutes}-minute timeout and was stopped.",
    "errorWorkflowTimeout": "The workflow reached its {minutes}-minute timeout. In-flight nodes were stopped.",
    "errorCancelled": "MCode reported the task as cancelled.",
    "errorInterrupted": "Execution was paused, cancelled, or interrupted.",
    "errorStart": "MCode could not be started.",
    "errorProtocol": "MCode returned an invalid completion protocol.",
    "errorMissing": "MCode returned no completion protocol (exit code {code}).",
    "errorExit": "MCode exited abnormally (exit code {code}); its result was not accepted.",
    "errorDependency": "Invalid dependsOn configuration for node {stepId}.",
    "errorDependencyReady": "Node {stepId} cannot start: dependency {dependency} has status {status}.",
    "errorLegacyDependency": "The previous version rejected a single dependency string. This version supports it.",
    "adviceDependency": "Use a node ID string or array. Await successful upstream results before dispatching dependent nodes.",
    "adviceLegacyDependency": "Click Resume to continue and reuse successful nodes. Refreshing does not restart the workflow.",
    "previousNode": "Previous node",
    "nextNode": "Next node",
    "viewRaw": "View original",
    "viewReading": "Reading view",
    "copyContent": "Copy original",
    "copied": "Copied",
    "copyFailed": "Copy failed; select the text to copy",
    "executionDetails": "Execution settings & dependencies",
    "nodePrompt": "Task instructions",
    "nodeInputData": "Input data",
    "runningOutput": "This node is running. Its result will appear here when complete. Check Logs for available progress.",
    "reportLoading": "Preparing report\u2026",
    "reportLoadFailed": "Could not load the report. Close and reopen to retry.",
    "errorStructured": "Node {stepId} returned an invalid structured result.",
    "adviceStructured": "Inspect the original output and validation errors. Fix the schema or prompt; do not read failed fields or retry automatically.",
    "errorGeneric": "Execution did not complete.",
    "adviceStep": "Increase the step limit or split the task before resuming. Failed nodes restart from scratch.",
    "adviceTimeout": "Increase the relevant timeout or reduce the scope before resuming.",
    "adviceGeneric": "Review the original diagnostic, node logs, authentication, and network configuration before resuming.",
    "serviceError": "The operation could not be completed.",
    "authError": "Access token is invalid. Reopen the dashboard using workflow_dashboard.",
    "status.queued": "Queued",
    "status.running": "Running",
    "status.succeeded": "Completed",
    "status.completed_with_gaps": "Completed with gaps",
    "status.failed": "Failed",
    "status.cancelled": "Cancelled",
    "status.paused": "Paused",
    "status.pausing": "Pausing",
    "status.stopping": "Stopping",
    "status.interrupted": "Interrupted",
    "status.needs_attention": "Needs attention",
    "event.run.created": "Workflow created",
    "event.run.started": "Run started",
    "event.phase.created": "Phase added",
    "event.step.queued": "Node queued",
    "event.step.started": "Node started",
    "event.step.progress": "Agent progress",
    "event.step.finished": "Node finished",
    "event.run.finished": "Run finished",
    "event.run.stopping": "Stopping run",
    "event.log": "Workflow log",
    "event.checkpoint": "Checkpoint saved",
    "event.run.limits": "Limits updated",
    "status.pending_review": "Pending review",
    "status.planned": "Planned",
    "event.run.updated": "Review draft updated",
    "event.run.approved": "Execution approved",
    "editDraft": "Edit workflow",
    "approve": "Start execution",
    "reviewEyebrow": "REVIEW BEFORE RUN",
    "reviewHeading": "Review the plan. Then let it run.",
    "reviewHelp": "Your script is ready. No agents have started. Inspect the structure below, or edit the script, inputs, and execution budgets.",
    "reviewVersion": "Review version v{revision} \xB7 Saving changes regenerates the topology",
    "createDraft": "Create review preview",
    "saveDraft": "Save and update topology",
    "showPlan": "Structure",
    "showExecution": "Execution nodes",
    "queueGlobal": "Waiting for a shared slot: {active}/{limit} slots are in use across workflows.",
    "queueRun": "Waiting for this workflow: {active}/{limit} slots are in use.",
    "queueOwners": "Active workflows: {owners}",
    "queueDispatch": "Waiting for dispatch.",
    "topologyTitle": "Script structure preview",
    "topology.truncated": "Only the first 100 agent call sites are shown. Review the full script.",
    "topology.staticPreview": "Static analysis only: the script has not run. Edges show declared dependencies or inferred data relationships, not actual execution order.",
    "topology.dynamicNodes": "Dynamic groups expand from live data during execution; their size is not yet known.",
    "topology.conditionalNodes": "Conditional nodes run only when their conditions hold.",
    "topology.dynamicDependencies": "Some dependencies depend on runtime results.",
    "topology.unresolvedDependencies": "Some dependency targets could not be located statically. Check the script.",
    "topology.dynamicPhase": "Some phase names are determined at runtime.",
    "topology.noStaticAgents": "No direct ctx.agent calls found. Read the script; aliases and wrapped calls may not appear.",
    "dynamicGroup": "DYNAMIC GROUP",
    "conditionalNode": "CONDITIONAL NODE",
    "plannedNode": "PLANNED NODE",
    "sourceLine": "Script line {line}",
    "inputJSON": "Workflow input (JSON object)",
    "inputObject": "Input must be a JSON object",
    "structures": "{count} nodes / groups",
    "schedulerSettings": "Concurrency settings",
    "schedulerBadge": "Global concurrency {active}/{limit}",
    "schedulerUsage": "{active}/{limit} agents running; {queued} nodes waiting.",
    "globalConcurrency": "Global agent concurrency",
    "schedulerHelp": "Shared across workflows. Default 8, configurable from 1\u201332. Eligible workflows take turns using free slots, subject to their own limits. Reducing the limit does not interrupt running agents. Settings persist locally.",
    "saveSettings": "Save settings"
  }
};
Object.assign(messages.zh, { "templates": "\u6A21\u677F\u5E93", "saveTemplate": "\u4FDD\u5B58\u4E3A\u6A21\u677F", "latestProgress": "\u6700\u8FD1\u8FDB\u5C55", "taskBrief": "\u4EFB\u52A1\u8BF4\u660E", "objective": "\u4EFB\u52A1\u76EE\u6807", "inputDescription": "\u8F93\u5165\u8BF4\u660E", "deliverables": "\u9884\u671F\u4EA7\u7269", "deliverablesHelp": "\u6BCF\u884C\u4E00\u9879\uFF0C\u6700\u591A 12 \u9879\uFF0C\u6BCF\u9879 300 \u5B57\u7B26\u3002", "downloadHTML": "\u4E0B\u8F7D HTML \u62A5\u544A", "downloadMD": "\u4E0B\u8F7D Markdown \u62A5\u544A", "reportExportHelp": "\u4ECE\u5DF2\u4FDD\u5B58\u7684\u7ED3\u679C\u5BFC\u51FA\uFF0C\u5305\u542B\u8FD0\u884C\u72B6\u6001\u3001\u8282\u70B9\u7ED3\u679C\u4E0E\u5931\u8D25\u4FE1\u606F\u3002\u62A5\u544A\u4E0D\u7B49\u4E8E\u4E8B\u5B9E\u9A8C\u8BC1\u3002", "templatesHelp": "\u6A21\u677F\u4FDD\u5B58\u5728\u672C\u673A\uFF0C\u5305\u542B\u811A\u672C\u3001\u5F53\u524D\u8F93\u5165\u3001\u8BF4\u660E\u548C\u9884\u7B97\uFF0C\u4E0D\u5305\u542B\u8FD0\u884C\u7ED3\u679C\u3002\u4F7F\u7528\u6A21\u677F\u4F1A\u6253\u5F00\u53EF\u7F16\u8F91\u8868\u5355\uFF0C\u4FDD\u5B58\u540E\u4ECD\u9700\u5BA1\u6838\u3002", "templateName": "\u6A21\u677F\u540D\u79F0", "saveCurrentTemplate": "\u4FDD\u5B58\u5F53\u524D\u5DE5\u4F5C\u6D41\u4E3A\u6A21\u677F", "useTemplate": "\u4F7F\u7528\u6A21\u677F", "deleteTemplate": "\u5220\u9664", "emptyTemplates": "\u8FD8\u6CA1\u6709\u6A21\u677F\u3002\u6253\u5F00\u4E00\u4E2A\u5DE5\u4F5C\u6D41\u5373\u53EF\u4FDD\u5B58\u3002", "templateSaved": "\u6A21\u677F\u5DF2\u4FDD\u5B58", "deleteTemplateConfirm": "\u5220\u9664\u8FD9\u4E2A\u672C\u5730\u6A21\u677F\uFF1F\u5386\u53F2\u8FD0\u884C\u4E0D\u53D7\u5F71\u54CD\u3002", "exportUnavailable": "\u7ED3\u675F\u6216\u6682\u505C\u540E\u53EF\u4E0B\u8F7D\u62A5\u544A\u3002", "demoReportNotice": "\u6F14\u793A\u7ED3\u679C\uFF1A\u672A\u8C03\u7528\u6A21\u578B\uFF0C\u4E0D\u4EE3\u8868\u771F\u5B9E\u4EFB\u52A1\u7ED3\u8BBA\u3002", "reportCoverage": "{done}/{total} \u4E2A\u8282\u70B9\u6210\u529F\uFF1B\u5931\u8D25\u6216\u672A\u5B8C\u6210\uFF1A{failed}\u3002", "reportResult": "\u6C47\u603B\u7ED3\u679C", "reportFailures": "\u5931\u8D25\u4E0E\u672A\u5B8C\u6210\u8282\u70B9", "defaultObjective": "\u4ECE\u591A\u4E2A\u89D2\u5EA6\u5BA1\u67E5\u6750\u6599\uFF0C\u9010\u9879\u72EC\u7ACB\u590D\u6838\uFF0C\u518D\u6C47\u603B\u7ED3\u8BBA\u3002", "defaultInputDescription": "\u5728 JSON \u7684 material \u5B57\u6BB5\u4E2D\u63D0\u4F9B\u5F85\u5BA1\u67E5\u4EE3\u7801\u6216\u6750\u6599\u3002", "defaultDeliverables": "\u5BA1\u67E5\u4E0E\u590D\u6838\u7ED3\u679C\n\u5305\u542B\u8986\u76D6\u7F3A\u53E3\u7684\u6C47\u603B\u62A5\u544A" });
Object.assign(messages.en, { "templates": "Templates", "saveTemplate": "Save as template", "latestProgress": "Latest progress", "taskBrief": "Task brief", "objective": "Objective", "inputDescription": "Input description", "deliverables": "Expected deliverables", "deliverablesHelp": "One per line, up to 12 items of 300 characters each.", "downloadHTML": "Download HTML report", "downloadMD": "Download Markdown report", "reportExportHelp": "Export saved results with run status, node outputs, and failures. Execution does not prove factual accuracy.", "templatesHelp": "Local templates include the script, current input, brief, and budgets, but no run results. Using a template opens an editable form; saving still requires review.", "templateName": "Template name", "saveCurrentTemplate": "Save current workflow as template", "useTemplate": "Use template", "deleteTemplate": "Delete", "emptyTemplates": "No templates yet. Open a workflow to save one.", "templateSaved": "Template saved", "deleteTemplateConfirm": "Delete this local template? Run history is unaffected.", "exportUnavailable": "Reports can be downloaded after completion or pause.", "demoReportNotice": "Demo results: no model was called. These are not real task findings.", "reportCoverage": "{done}/{total} agents succeeded; failed or incomplete: {failed}.", "reportResult": "Result", "reportFailures": "Failed or incomplete nodes", "defaultObjective": "Review material from several perspectives, verify each independently, and synthesize findings.", "defaultInputDescription": "Provide the code or material to review in the JSON material field.", "defaultDeliverables": "Review and verification results\nA synthesis report with coverage gaps" });
Object.assign(messages.zh, { "reviewCompact": "\u7B49\u5F85\u5BA1\u6838", "reviewCompactHelp": "\u68C0\u67E5\u4E0B\u65B9\u6D41\u7A0B\uFF0C\u786E\u8BA4\u540E\u5F00\u59CB\u3002", "reviewDetails": "\u4EFB\u52A1\u8BE6\u60C5\u4E0E\u6267\u884C\u8BBE\u7F6E", "reviewBudgets": "\u5E76\u53D1 {concurrency} \xB7 \u6700\u591A {calls} \u6B21\u8C03\u7528 \xB7 \u6BCF\u8282\u70B9 {steps} \u6B65 / {minutes} \u5206\u949F", "status.awaiting": "\u5C1A\u672A\u5F00\u59CB", "status.blocked": "\u4F9D\u8D56\u53D7\u963B", "status.not_run": "\u672A\u6267\u884C", "awaitingHelp": "\u8BE5\u8282\u70B9\u5C1A\u672A\u521B\u5EFA\u6267\u884C\u4EFB\u52A1\u3002\u542F\u52A8\u540E\u4F1A\u5728\u8FD9\u91CC\u66F4\u65B0\u72B6\u6001\u3002", "blockedHelp": "\u5DF2\u58F0\u660E\u7684\u4E0A\u6E38\u8282\u70B9\u672A\u6210\u529F\uFF0C\u5F53\u524D\u8282\u70B9\u5C1A\u672A\u6267\u884C\u3002", "notRunHelp": "\u672C\u6B21\u8FD0\u884C\u5DF2\u7ECF\u7ED3\u675F\uFF0C\u672A\u89E6\u53D1\u8FD9\u4E2A\u8BA1\u5212\u8282\u70B9\u3002", "dynamicHelp": "\u8282\u70B9\u6570\u91CF\u7531\u8FD0\u884C\u7ED3\u679C\u51B3\u5B9A\uFF1B\u5DF2\u521B\u5EFA\u7684\u8282\u70B9\u4F1A\u5728\u6B64\u5206\u7EC4\u4E2D\u5C55\u5F00\u3002" });
Object.assign(messages.en, { "reviewCompact": "Ready for review", "reviewCompactHelp": "Check the flow below, then start.", "reviewDetails": "Task details & execution settings", "reviewBudgets": "Concurrency {concurrency} \xB7 Up to {calls} calls \xB7 {steps} steps / {minutes} min per agent", "status.awaiting": "Not started", "status.blocked": "Dependency blocked", "status.not_run": "Not executed", "awaitingHelp": "This planned node has not been dispatched. Its status will update here when it starts.", "blockedHelp": "A declared upstream node did not succeed; this node has not executed.", "notRunHelp": "This run ended without triggering this planned node.", "dynamicHelp": "The number of nodes depends on runtime results. Created nodes expand within this group." });
var LANGUAGE_KEY = "workflow-language";
function normalizePreference(value) {
  return ["zh", "en"].includes(value) ? value : "auto";
}
function resolveLanguage(preference2, languages = []) {
  if (["zh", "en"].includes(preference2)) return preference2;
  return /^zh(?:-|_|$)/i.test(languages[0] || "") ? "zh" : "en";
}
function readPreference(storage) {
  try {
    return normalizePreference(storage?.getItem(LANGUAGE_KEY));
  } catch {
    return "auto";
  }
}
function savePreference(storage, preference2) {
  try {
    storage?.setItem(LANGUAGE_KEY, normalizePreference(preference2));
  } catch {
  }
}
function translate(language2, key, vars = {}) {
  if (language2 === "en" && vars.count === 1 && ["tasks", "eventsCount"].includes(key)) return key === "tasks" ? "1 task" : "1 event";
  return (messages[language2]?.[key] ?? messages.en[key] ?? key).replace(/\{(\w+)\}/g, (_2, name) => String(vars[name] ?? `{${name}}`));
}
function describeFailure(language2, failure = {}, fallback = "") {
  failure = failure && typeof failure === "object" ? failure : {};
  fallback = typeof fallback === "string" ? fallback : "";
  const t2 = (key, vars) => translate(language2, key, vars);
  const keys = { OUTPUT_SCHEMA_INVALID: "errorStructured", DEPENDENCY_INVALID: "errorDependency", DEPENDENCY_NOT_READY: "errorDependencyReady", LEGACY_DEPENDENCY_STRING: "errorLegacyDependency", AGENT_STEP_LIMIT: "errorStep", AGENT_TIMEOUT: "errorTimeout", WORKFLOW_TIMEOUT: "errorWorkflowTimeout", MCODE_CANCELLED: "errorCancelled", RUN_INTERRUPTED: "errorInterrupted", MCODE_START_FAILED: "errorStart", MCODE_PROTOCOL_ERROR: "errorProtocol", MCODE_MISSING_RESULT: "errorMissing", MCODE_EXIT: "errorExit" };
  const title = t2(keys[failure.code] ?? "errorGeneric", { stepId: failure.stepId ?? "?", dependency: failure.dependency ?? "?", status: failure.dependencyStatus ?? "?", steps: failure.maxSteps ?? "?", minutes: (failure.timeoutMs ?? failure.runTimeoutMs ?? 0) / 6e4, code: failure.exitCode ?? t2("unknown") });
  const advice = t2(failure.code === "OUTPUT_SCHEMA_INVALID" ? "adviceStructured" : failure.code === "LEGACY_DEPENDENCY_STRING" ? "adviceLegacyDependency" : /^DEPENDENCY_/.test(failure.code ?? "") ? "adviceDependency" : failure.code === "AGENT_STEP_LIMIT" ? "adviceStep" : /TIMEOUT/.test(failure.code ?? "") ? "adviceTimeout" : "adviceGeneric");
  return { title: language2 === "zh" ? failure.message || fallback || title : title, advice: language2 === "zh" ? failure.suggestion || advice : advice, original: failure.cause || (language2 === "en" ? failure.message || fallback : "") };
}

// web/app.source.mjs
var $2 = (s) => document.querySelector(s);
var nodeRaw = false;
var nodeSignature = "";
var copyValue = "";
var copyTimer;
var scheduler = { active: 0, limit: 8, queued: 0 };
var showPlan = false;
var readSignature = "";
var selectionVersion = 0;
var runs = [];
var current = null;
var selected = null;
var events = [];
var after = 0;
var zoom = 0;
var zoomAuto = true;
var tab = "output";
var busy = false;
var defaults = { maxSteps: 120, stepTimeoutMs: 18e5, runTimeoutMs: 72e5 };
var ns = "http://www.w3.org/2000/svg";
var labels = new Proxy({}, { get: (_2, key) => {
  const v2 = t("status." + key);
  return v2 === "status." + key ? key : v2;
} });
var eventLabels = new Proxy({}, { get: (_2, key) => {
  const v2 = t("event." + key);
  return v2 === "event." + key ? key : v2;
} });
var preference = readPreference(safeStorage());
var language = resolveLanguage(preference, navigator.languages?.length ? navigator.languages : [navigator.language]);
var connectionKey = "connecting";
var mcodeAvailable = true;
var readMode = null;
var lastAlert = "";
var lastFormMessage = null;
var defaultScripts = { en: "await ctx.phase({id:'scan',label:'Review'});\nawait ctx.phase({id:'verify',label:'Verify'});\nawait ctx.phase({id:'report',label:'Synthesize'});\nconst schema={type:'object',properties:{summary:{type:'string'},findings:{type:'array',items:{type:'string'}}},required:['summary','findings'],additionalProperties:false};\nconst topics=['correctness','boundary cases','maintainability'];\nawait ctx.log(`Starting independent review and verification for ${topics.length} topics.`);\nconst rows=await ctx.map(topics,async (topic,i)=>{\n  const auditId=`audit:${i}`,checkId=`verify:${i}`;\n  await ctx.log(`Reviewing ${topic}`,{stepId:auditId,phase:'scan'});\n  const audit=await ctx.agent({id:auditId,label:topic,phase:'scan',schema,\n    prompt:`Review the input for ${topic} without modifying files. Give evidence-backed findings and verification limits.`,input:{topic,material:input.material}\n  });\n  if(audit.status!=='succeeded'){\n    await ctx.log(`${topic} review failed; skipping its verification: ${audit.error}`,{stepId:auditId,phase:'scan'});\n    return {topic,audit,check:null,checkId};\n  }\n  await ctx.log(`${topic} reviewed; starting independent verification.`,{stepId:checkId,phase:'verify'});\n  const check=await ctx.agent({id:checkId,label:`Verify \xB7 ${topic}`,phase:'verify',dependsOn:[auditId],schema,\n    prompt:'Independently check the earlier findings against the original material. Retain supported findings and state what cannot be verified.',input:{material:input.material,audit:audit.output}\n  });\n  await ctx.log(check.status==='succeeded'?`${topic} verified; ${check.output.findings.length} findings.`:`${topic} verification failed: ${check.error}`,{stepId:checkId,phase:'verify'});\n  return {topic,audit,check,checkId};\n});\nconst verified=rows.filter(row=>row.check?.status==='succeeded');\nconst missing=rows.filter(row=>row.check?.status!=='succeeded').map(row=>row.topic);\nif(!verified.length)throw Error('No verified results; cannot produce a verified report');\nawait ctx.log(`Synthesizing ${verified.length}/${topics.length} verified topics, preserving coverage gaps.`,{stepId:'report',phase:'report'});\nconst report=await ctx.agent({id:'report',label:'Synthesize',phase:'report',dependsOn:verified.map(row=>row.checkId),schema,\n  prompt:'Synthesize verified findings, remove duplicates, and state coverage gaps in summary. Agreement between agents is not factual evidence.',input:{verified:verified.map(row=>row.check.output),missing}\n});\nif(report.status!=='succeeded')throw Error(report.error);\nawait ctx.log('Synthesis complete. Read or download the final report.',{stepId:'report',phase:'report'});\nreturn {coverage:{topics:topics.length,verified:verified.length},report:report.output,limitations:missing};\n", zh: "" };
var t = (key, vars) => translate(language, key, vars);
function safeStorage() {
  try {
    return localStorage;
  } catch {
    return null;
  }
}
function apiMessage(message) {
  return language === "en" && /[\u4e00-\u9fff]/u.test(message) ? message.includes("\u8BBF\u95EE\u51ED\u8BC1\u65E0\u6548") ? t("authError") : t("serviceError") + " " + t("originalReason", { cause: message }) : message;
}
function error(message, localized = false) {
  lastAlert = message;
  $2("#alert").textContent = localized ? message : apiMessage(message);
  $2("#alert").hidden = !message;
}
async function api(path, method = "GET", data) {
  const r = await fetch(`/api${path}`, { method, headers: { "X-Workflow-Client": "1", ...data ? { "Content-Type": "application/json" } : {} }, ...data ? { body: JSON.stringify(data) } : {} });
  const value = await r.json();
  if (!r.ok) throw Error(value.error ?? `HTTP ${r.status}`);
  return value;
}
function el(tag, attrs = {}, text) {
  const e = document.createElement(tag);
  for (const [k, v2] of Object.entries(attrs)) e.setAttribute(k, v2);
  if (text !== void 0) e.textContent = text;
  return e;
}
function svg(tag, attrs = {}, text) {
  const e = document.createElementNS(ns, tag);
  for (const [k, v2] of Object.entries(attrs)) e.setAttribute(k, v2);
  if (text !== void 0) e.textContent = text;
  return e;
}
function short(s, n = 24) {
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}
function renderList() {
  const list = $2("#run-list");
  list.replaceChildren();
  $2("#run-count").textContent = runs.length;
  for (const r of runs) {
    const b2 = el("button", { title: r.name, class: `run-item ${current?.id === r.id ? "active" : ""}`, "aria-current": current?.id === r.id ? "true" : "false" });
    b2.append(el("span", { class: `run-dot ${r.status}` }));
    const title = el("span");
    title.append(el("b", {}, r.name), el("small", {}, `${r.executor === "demo" ? t("demo") : "MCode"} \xB7 ${labels[r.status] ?? r.status}`));
    b2.append(title);
    b2.onclick = () => selectRun(r.id).catch((e) => error(e.message));
    list.append(b2);
  }
}
async function refreshList() {
  [runs, scheduler] = await Promise.all([api("/runs"), api("/scheduler")]);
  renderScheduler();
  renderList();
  if (!current) {
    const id = new URLSearchParams(location.search).get("run") || runs[0]?.id;
    if (id) await selectRun(id);
  }
}
var viewing = (id, version) => current?.id === id && selectionVersion === version;
async function selectRun(id) {
  const version = ++selectionVersion;
  try {
    const next = await api(`/runs/${id}`);
    if (version !== selectionVersion) return;
    current = next;
    history.replaceState(null, "", `${location.pathname}?run=${encodeURIComponent(id)}`);
    showPlan = false;
    selected = null;
    events = [];
    after = 0;
    zoom = 0;
    zoomAuto = true;
    error("");
    renderList();
    renderRun();
    await loadEvents(id, version);
  } catch (e) {
    if (version === selectionVersion) throw e;
  }
}
async function loadEvents(id, version = selectionVersion) {
  try {
    const data = await api(`/runs/${id}/wait?after=${after}`);
    if (!viewing(id, version)) return;
    events.push(...data.events.filter((e) => e.seq > after));
    after = Math.max(after, data.nextSequence);
    events = events.slice(-500);
    renderEvents();
  } catch (e) {
    if (viewing(id, version)) throw e;
  }
}
async function refreshCurrent() {
  const id = current?.id, version = selectionVersion;
  if (!id) return;
  try {
    const next = await api(`/runs/${id}`);
    if (viewing(id, version)) {
      current = next;
      renderRun();
    }
  } catch (e) {
    if (viewing(id, version)) throw e;
  }
}
function renderRun() {
  renderBrief();
  const r = current;
  $2("#repair-run").hidden = !r || !["failed", "paused", "interrupted", "cancelled", "completed_with_gaps", "succeeded"].includes(r.status);
  const lineage = $2("#repair-lineage");
  lineage.hidden = !r?.repair;
  lineage.replaceChildren();
  if (r?.repair) {
    const link = el("a", { href: "?run=" + encodeURIComponent(r.repair.sourceRunId) }, t("repairSource"));
    lineage.append(link, document.createTextNode(" \xB7 " + r.repair.reason + " \xB7 " + t("repairCandidates", { count: r.repair.reuseStepIds.length })));
  }
  const review = r?.status === "pending_review";
  document.querySelector("main").classList.toggle("is-review", review);
  $2(".metrics").hidden = review;
  $2(".timeline").hidden = review;
  $2("#report").hidden = review;
  $2("#save-template").hidden = !r || review;
  $2("#review-budgets").textContent = r ? t("reviewBudgets", { concurrency: r.concurrency, calls: r.maxCalls, steps: r.maxSteps, minutes: r.stepTimeoutMs / 6e4 }) : "";
  $2("#review-banner").hidden = !review;
  $2("#edit-draft").hidden = !review;
  $2("#approve").hidden = !review;
  $2("#review-version").textContent = review ? `v${r.revision}` : "";
  $2("#graph-mode").hidden = !r?.topology || review;
  $2("#graph-mode").textContent = t(showPlan ? "showExecution" : "showPlan");
  $2("#topology-note").hidden = !r?.topology;
  $2("#topology-warnings").textContent = r?.topology?.warnings.map((w) => t("topology." + w)).join(" ") ?? "";
  $2("#empty").hidden = !!r;
  $2("#run-view").hidden = !r;
  if (!r) {
    $2("#run-title").textContent = t("canvas");
    $2("#executor-badge").textContent = t("noRun");
    for (const id of ["pause", "cancel", "resume"]) $2("#" + id).hidden = true;
    return;
  }
  $2("#run-title").textContent = r.name;
  $2("#executor-badge").textContent = r.executor === "demo" ? t("demoRun") : t("realRun");
  $2("#metric-status").textContent = labels[r.status] ?? r.status;
  $2(".status-metric").dataset.status = r.status;
  const tasks = r.steps.filter((s) => s.kind === "agent");
  const visibleNodes = graphSteps(), knownNodes = visibleNodes.filter((n) => !n.placeholder || !n.dynamic).length;
  $2("#metric-nodes").textContent = `${tasks.filter((s) => s.status === "succeeded").length} / ${knownNodes}${visibleNodes.some((n) => n.placeholder && n.dynamic) ? "+" : ""}`;
  $2("#metric-calls").textContent = `${r.attempts} / ${r.maxCalls}`;
  const usage = tasks.flatMap((s) => [...s.usageHistory ?? [], ...s.usage ? [s.usage] : []]);
  $2("#metric-tokens").textContent = r.executor === "demo" ? "\u2014" : usage.length ? usage.reduce((n, s) => n + (s.totalTokens ?? (s.inputTokens ?? 0) + (s.outputTokens ?? 0)), 0).toLocaleString(language === "zh" ? "zh-CN" : "en-US") + (usage.length < r.attempts ? t("unknownPlus") : "") : t("unknown");
  $2("#pause").hidden = r.status !== "running";
  $2("#cancel").hidden = !["running", "queued"].includes(r.status);
  $2("#resume").hidden = !((!r.revision || r.approvedRevision === r.revision) && ["paused", "failed", "interrupted", "cancelled", "needs_attention", "completed_with_gaps"].includes(r.status));
  $2("#canvas-status").textContent = labels[r.status];
  $2("#canvas-status").dataset.status = r.status;
  if (r.error) {
    const f2 = describeFailure(language, r.errorDetails, r.error);
    error(f2.title + (f2.original ? " " + t("originalReason", { cause: f2.original }) : "") + (/DEPENDENCY/.test(r.errorDetails?.code ?? "") ? " " + f2.advice : ""), true);
  }
  renderGraph();
  renderNode();
  renderRead();
}
function graphSteps() {
  return workflowGraph(current, { planOnly: showPlan }).nodes;
}
function renderGraph() {
  const graph = $2("#graph"), focused = document.activeElement?.getAttribute("data-step-id");
  graph.replaceChildren();
  const steps = graphSteps().filter((s) => s.kind === "agent");
  $2("#graph-wait").hidden = steps.length > 0;
  renderLegend(steps);
  const phases = workflowGraph(current, { planOnly: showPlan }).phases;
  if (steps.some((s) => !s.phase)) phases.push({ id: null, label: t("defaultPhase") });
  const positions = /* @__PURE__ */ new Map(), rows = Math.max(1, ...phases.map((p) => steps.filter((s) => s.phase === p.id).length));
  const column = 332, cardWidth = 264, cardHeight = 118, w = Math.max(350, phases.length * column + 14), h = Math.max(280, rows * 144 + 110);
  phases.forEach((p, i) => {
    const tasks = steps.filter((s) => s.phase === p.id);
    tasks.forEach((s, j) => positions.set(s.id, { x: 42 + i * column, y: 86 + j * 144 + (rows > 3 ? 0 : (rows - tasks.length) * 72) }));
  });
  if (zoomAuto) {
    const wrap = $2("#graph-wrap"), wide = window.innerWidth > 620;
    zoom = Math.max(wide ? 0.5 : 0.72, Math.min(1, (wrap.clientWidth - 40) / w, wide ? (wrap.clientHeight - 24) / h : 1));
  }
  $2("#zoom-reset").textContent = Math.round(zoom * 100) + "%";
  graph.setAttribute("viewBox", `0 0 ${w} ${h}`);
  graph.style.width = `${w * zoom}px`;
  graph.style.height = `${h * zoom}px`;
  phases.forEach((p, i) => {
    const x2 = 42 + i * column;
    graph.append(svg("text", { x: x2, y: 37, class: "phase-index" }, String(i + 1).padStart(2, "0")), svg("text", { x: x2 + 25, y: 34, class: "phase-label" }, p.label), svg("text", { x: x2 + 25, y: 51, class: "phase-count" }, t(showPlan || steps.some((s) => s.dynamic) ? "structures" : "tasks", { count: steps.filter((s) => s.phase === p.id).length })), svg("path", { d: `M${x2},63 H${x2 + cardWidth}`, class: "phase-divider" }));
  });
  for (const s of steps) {
    const to = positions.get(s.id);
    for (const dep of s.dependsOn ?? []) {
      const from = positions.get(dep);
      if (!from || !to) continue;
      const x1 = from.x + cardWidth, y1 = from.y + cardHeight / 2, x2 = to.x, y2 = to.y + cardHeight / 2;
      graph.append(svg("path", { d: `M${x1},${y1} C${x1 + 42},${y1} ${x2 - 42},${y2} ${x2},${y2}`, class: `edge ${showPlan || s.placeholder ? "planned" : ""} ${s.status === "running" ? "running" : ""}` }));
    }
  }
  for (const s of steps) {
    const p = positions.get(s.id);
    if (!p) continue;
    const g = svg("g", { class: `node ${s.status} ${selected === s.id ? "selected" : ""}`, transform: `translate(${p.x},${p.y})`, role: "button", tabindex: "0", "data-step-id": s.id, "aria-label": `${s.label}\uFF0C${labels[s.status] ?? s.status}`, "aria-pressed": String(selected === s.id) });
    const duration = s.startedAt ? `${(((s.endedAt ?? Date.now()) - s.startedAt) / 1e3).toFixed(1)}s` : t("pending");
    g.append(svg("rect", { class: "node-card", width: cardWidth, height: cardHeight, rx: 12 }), svg("rect", { class: "node-icon-bg", x: 15, y: 17, width: 30, height: 30, rx: 8 }), svg("path", { class: "node-icon", d: "M25 25l-3 7 3 7 M35 25l3 7-3 7 M32 25l-4 14" }), svg("text", { x: 54, y: 32, class: "node-title" }, short(s.label, language === "zh" ? 12 : 23)), svg("text", { x: 54, y: 50, class: "node-kind" }, s.placeholder ? s.dynamic ? t("dynamicGroup") : s.conditional ? t("conditionalNode") : t("plannedNode") : current.executor === "demo" ? "DEMO AGENT" : "MCODE AGENT"), svg("circle", { class: "node-status-bg", cx: cardWidth - 20, cy: 25, r: 8 }), svg("text", { x: cardWidth - 20, y: 29, class: "node-status-mark", "text-anchor": "middle" }, s.status === "succeeded" ? "\u2713" : s.status === "failed" || s.status === "interrupted" ? "!" : s.status === "running" ? "\u2022" : s.status === "queued" ? "\u25F7" : s.status === "blocked" ? "!" : s.status === "not_run" ? "\u2013" : "\xB7"), svg("path", { d: `M0,76 H${cardWidth}`, class: "node-separator" }), svg("text", { x: 16, y: 101, class: "node-state" }, `${s.reusedFrom ? t("reusedResult") : labels[s.status] ?? s.status}${s.attempt > 1 ? t("attemptSuffix", { count: s.attempt }) : ""}`), svg("text", { x: cardWidth - 16, y: 101, class: "node-time", "text-anchor": "end" }, duration));
    if (s.dependsOn?.length) g.append(svg("circle", { class: "port", cx: 0, cy: cardHeight / 2, r: 3 }));
    if (steps.some((t2) => t2.dependsOn?.includes(s.id))) g.append(svg("circle", { class: "port", cx: cardWidth, cy: cardHeight / 2, r: 3 }));
    g.append(svg("title", {}, `${s.label}
${s.id}
${s.error ? describeFailure(language, s.errorDetails, s.error).title : labels[s.status]}`));
    const choose = () => openNode(s.id);
    g.addEventListener("click", choose);
    g.addEventListener("keydown", (e) => {
      if (["Enter", " "].includes(e.key)) {
        e.preventDefault();
        choose();
      }
    });
    graph.append(g);
  }
  if (focused) graph.querySelector(`[data-step-id="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}
function openNode(id) {
  selected = id;
  tab = "output";
  nodeRaw = false;
  nodeSignature = "";
  $2("#node-technical").open = false;
  renderNode();
  renderGraph();
  $2("#node-scroll").scrollTop = 0;
}
function renderNode() {
  const nodes = graphSteps(), s = nodes.find((n) => n.id === selected), dialog = $2("#node-dialog");
  if (!s) {
    if (dialog.open) dialog.close();
    return;
  }
  const index = nodes.indexOf(s);
  $2("#node-position").textContent = `${index + 1} / ${nodes.length}`;
  $2("#node-prev").disabled = index === 0;
  $2("#node-next").disabled = index === nodes.length - 1;
  $2("#node-title").textContent = s.label;
  $2("#node-status").textContent = labels[s.status];
  $2("#node-status").dataset.status = s.status;
  $2("#node-duration").textContent = s.startedAt ? `${((s.endedAt ?? Date.now()) - s.startedAt) / 1e3}s` : t("notStarted");
  $2("#node-attempt").textContent = s.reusedFrom ? t("reusedResult") : s.attempt ? `${t("attempt")} ${s.attempt}` : "";
  for (const button of document.querySelectorAll("[data-tab]")) {
    const active = button.dataset.tab === tab;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  }
  $2("#node-content").setAttribute("aria-labelledby", "node-tab-" + tab);
  $2("#node-raw").textContent = t(nodeRaw ? "viewReading" : "viewRaw");
  $2("#node-raw").setAttribute("aria-pressed", String(nodeRaw));
  const q = s.queueInfo;
  $2("#node-queue").hidden = s.placeholder || s.status !== "queued";
  $2("#node-queue").textContent = q ? q.reason === "global_capacity" ? t("queueGlobal", { active: q.globalActive, limit: q.globalLimit }) : q.reason === "run_capacity" ? t("queueRun", { active: q.runActive, limit: q.runLimit }) : t("queueDispatch") : "";
  const failure = s.error ? describeFailure(language, s.errorDetails, s.error) : { title: "", original: "", advice: "" };
  $2("#node-failure").hidden = !s.error;
  $2("#failure-title").textContent = failure.title;
  $2("#failure-cause").textContent = failure.original;
  $2("#failure-advice").textContent = failure.advice;
  $2("#failure-code").textContent = s.errorDetails?.code ?? "";
  const logs = events.filter((e) => e.stepId === (s.actualId ?? s.id)), value = tab === "output" ? s.error ? { error: s.error, details: s.errorDetails } : s.output : tab === "input" ? { prompt: s.prompt, input: s.input } : logs;
  const signature = JSON.stringify([selected, tab, nodeRaw, language, s.status, s.placeholder, s.source, value, s.rawOutput]);
  if (signature !== nodeSignature) {
    nodeSignature = signature;
    $2("#node-copy-status").textContent = "";
    copyValue = s.placeholder ? s.source ?? "" : tab === "input" ? `${s.prompt ?? ""}

${rawText(s.input)}` : rawText(tab === "output" && Object.hasOwn(s, "rawOutput") ? s.rawOutput : value);
    const content = $2("#node-content"), scroll = $2("#node-scroll").scrollTop;
    if (s.placeholder) content.innerHTML = `<p class="node-empty-reading">${escapeHTML(t(s.status === "blocked" ? "blockedHelp" : s.status === "not_run" ? "notRunHelp" : s.dynamic ? "dynamicHelp" : "awaitingHelp"))}</p><p class="source-note">${escapeHTML(t("sourceLine", { line: s.line }))}</p><pre><code>${escapeHTML(s.source ?? "")}</code></pre>`;
    else if (nodeRaw) content.innerHTML = `<pre><code>${escapeHTML(copyValue)}</code></pre>`;
    else if (tab === "input") content.innerHTML = `<h3>${escapeHTML(t("nodePrompt"))}</h3>${readableHTML(s.prompt ?? "", { language })}<h3>${escapeHTML(t("nodeInputData"))}</h3>${readableHTML(s.input, { language })}`;
    else if (tab === "logs") {
      content.replaceChildren();
      if (!logs.length) content.append(el("p", { class: "content-empty" }, t("noLogs")));
      for (const e of logs) {
        const item = el("article", { class: "node-log" });
        item.append(el("strong", {}, eventLabels[e.type] ?? e.type), el("p", {}, e.text ?? e.message ?? e.error ?? (e.status ? labels[e.status] : "")));
        content.append(item);
      }
    } else content.innerHTML = s.error ? `<p class="content-empty">${escapeHTML(t("noSuccess"))}</p>${Object.hasOwn(s, "rawOutput") ? `<pre><code>${escapeHTML(rawText(s.rawOutput))}</code></pre>` : ""}` : s.output == null ? `<p class="node-empty-reading">${escapeHTML(t(s.status === "running" ? "runningOutput" : "noOutput"))}</p>` : readableHTML(s.output, { language });
    $2("#node-scroll").scrollTop = scroll;
  }
  const dl = $2("#node-meta");
  dl.replaceChildren();
  for (const [k, v2] of [["ID", s.actualId ?? s.stepId ?? s.id], [t("stepLimit"), s.maxSteps ?? current.maxSteps], [t("nodeTimeout"), t("minutes", { count: (s.timeoutMs ?? current.stepTimeoutMs) / 6e4 })], [t("session"), s.sessionId ?? "\u2014"]]) dl.append(el("dt", {}, k), el("dd", {}, String(v2)));
  if (s.reusedFrom) {
    const link = el("a", { href: "?run=" + encodeURIComponent(s.reusedFrom.runId) }, s.reusedFrom.stepId);
    const dd = el("dd");
    dd.append(link);
    dl.append(el("dt", {}, t("repairSource")), dd);
  }
  const deps = $2("#node-dependencies");
  deps.replaceChildren(el("p", {}, t("dependencies")));
  if (!s.dependsOn?.length) deps.append(el("span", {}, t("none")));
  for (const id of s.dependsOn ?? []) {
    const upstream = nodes.find((n) => n.id === id || n.actualId === id || n.stepId === id);
    const button = el("button", { type: "button" }, upstream?.label ?? id);
    button.disabled = !upstream;
    button.onclick = () => openNode(upstream.id);
    deps.append(button);
  }
  if (!dialog.open) dialog.showModal();
}
function renderEvents() {
  const list = $2("#events"), nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.replaceChildren();
  $2("#event-count").textContent = t("eventsCount", { count: events.length });
  for (const e of events.slice(-100)) {
    const li = el("li");
    li.append(el("time", {}, new Date(e.time).toLocaleTimeString(language === "zh" ? "zh-CN" : "en-US", { hour12: false })), el("span", {}, `${eventLabels[e.type] ?? e.type}${e.message || e.text ? ` \xB7 ${short(e.message ?? e.text, 90)}` : e.status ? ` \xB7 ${labels[e.status] ?? e.status}` : ""}`), el("span", { class: "event-node" }, e.stepId ?? e.label ?? ""));
    list.append(li);
  }
  if (nearBottom) list.scrollTop = list.scrollHeight;
  renderNode();
}
function showCreate() {
  const f2 = $2("#create-form");
  f2.reset();
  delete f2.dataset.repairId;
  delete f2.dataset.sourceUpdatedAt;
  $2("#repair-context").hidden = true;
  f2.elements.repairReason.required = false;
  f2.elements.maxSteps.value = defaults.maxSteps;
  f2.elements.stepTimeoutMinutes.value = defaults.stepTimeoutMs / 6e4;
  f2.elements.runTimeoutMinutes.value = defaults.runTimeoutMs / 6e4;
  delete f2.dataset.runId;
  delete f2.dataset.revision;
  f2.elements.name.value = t("defaultName");
  setMetadataForm({ objective: t("defaultObjective"), inputDescription: t("defaultInputDescription"), deliverables: t("defaultDeliverables").split("\n") });
  delete f2.elements.name.dataset.edited;
  $2("#script-input").value = defaultScripts[language];
  delete $2("#script-input").dataset.edited;
  $2("#create-title").textContent = t("newHeading");
  $2("#save-draft").textContent = t("createDraft");
  $2("#form-error").hidden = true;
  lastFormMessage = null;
  updateLimitSummary();
  renderModeNote();
  $2("#create-dialog").showModal();
}
function editRun(repair = false) {
  if (!current) return;
  const f2 = $2("#create-form");
  delete f2.dataset.repairId;
  delete f2.dataset.sourceUpdatedAt;
  $2("#repair-context").hidden = !repair;
  f2.elements.repairReason.required = repair;
  f2.dataset.runId = current.id;
  f2.dataset.revision = current.revision;
  for (const name of ["name", "executor", "concurrency", "maxCalls", "maxSteps"]) f2.elements[name].value = current[name];
  f2.elements.name.dataset.edited = "true";
  f2.elements.stepTimeoutMinutes.value = current.stepTimeoutMs / 6e4;
  f2.elements.runTimeoutMinutes.value = current.runTimeoutMs / 6e4;
  f2.elements.inputJSON.value = JSON.stringify(current.input, null, 2);
  setMetadataForm(current.metadata);
  $2("#script-input").value = current.script;
  $2("#script-input").dataset.edited = "true";
  $2("#script-editor").open = true;
  $2("#create-title").textContent = t("editDraft");
  $2("#save-draft").textContent = t("saveDraft");
  $2("#form-error").hidden = true;
  lastFormMessage = null;
  updateLimitSummary();
  renderModeNote();
  $2("#create-dialog").showModal();
}
$2("#edit-draft").onclick = () => {
  editRun();
  if (current?.repair) {
    $2("#repair-context").hidden = false;
    const f2 = $2("#create-form");
    f2.elements.repairReason.required = true;
    f2.elements.repairReason.value = current.repair.reason;
    $2("#repair-diagnostic").textContent = [current.repair.sourceError, ...current.repair.failures.map((s) => s.id + ": " + (s.error ?? s.status))].filter(Boolean).join("\n") || t("repairNoError");
    const list = $2("#repair-candidates");
    list.replaceChildren();
    for (const id of current.repair.candidateStepIds ?? current.repair.reuseStepIds) {
      const label = el("label", { class: "repair-candidate" }), checkbox = el("input", { type: "checkbox", name: "reuseStepId", value: id });
      checkbox.checked = current.repair.reuseStepIds.includes(id);
      label.append(checkbox, el("span", {}, id));
      list.append(label);
    }
  }
};
$2("#repair-run").onclick = () => {
  editRun(true);
  const f2 = $2("#create-form");
  delete f2.dataset.runId;
  delete f2.dataset.revision;
  f2.dataset.repairId = current.id;
  f2.dataset.sourceUpdatedAt = current.updatedAt;
  f2.elements.repairReason.value = "";
  $2("#create-title").textContent = t("repairRun");
  $2("#save-draft").textContent = t("createRepair");
  $2("#repair-diagnostic").textContent = [current.error, ...current.steps.filter((s) => s.error).map((s) => s.id + ": " + s.error)].filter(Boolean).join("\n") || t("repairNoError");
  const list = $2("#repair-candidates");
  list.replaceChildren();
  for (const step of current.steps.filter((s) => s.kind === "agent" && s.status === "succeeded" && Array.isArray(s.dependsOn))) {
    const label = el("label", { class: "repair-candidate" }), checkbox = el("input", { type: "checkbox", name: "reuseStepId", value: step.id });
    label.append(checkbox, el("span", {}, step.label + " \xB7 " + step.id));
    list.append(label);
  }
  if (!list.childElementCount) list.append(el("p", { class: "subtle" }, t("repairNoCandidates")));
};
$2("#approve").onclick = async () => {
  if (!current || busy) return;
  const id = current.id, revision = current.revision;
  busy = true;
  $2("#approve").disabled = true;
  try {
    await api(`/runs/${id}/approve`, "POST", { revision });
    await selectRun(id);
    await refreshList();
  } catch (e) {
    error(e.message);
  } finally {
    busy = false;
    $2("#approve").disabled = false;
  }
};
$2("#graph-mode").onclick = () => {
  showPlan = !showPlan;
  selected = null;
  zoomAuto = true;
  renderRun();
};
$2("#new-run").onclick = showCreate;
$2("#empty-start").onclick = showCreate;
$2("#close-create").onclick = () => $2("#create-dialog").close();
$2("#close-read").onclick = () => $2("#read-dialog").close();
$2("#create-form [name=executor]").onchange = renderModeNote;
function renderModeNote() {
  $2("#mode-note").textContent = t($2("#create-form").elements.executor.value === "demo" ? "demoNote" : "mcodeNote");
}
$2("#create-form").onsubmit = async (e) => {
  e.preventDefault();
  const f2 = new FormData(e.currentTarget);
  const submit = e.submitter ?? $2("#save-draft");
  submit.disabled = true;
  try {
    const input = JSON.parse(f2.get("inputJSON"));
    if (!input || Array.isArray(input) || typeof input !== "object") throw Error(t("inputObject"));
    const form = e.currentTarget;
    const r = await api(form.dataset.repairId ? `/runs/${form.dataset.repairId}/repair` : form.dataset.runId ? `/runs/${form.dataset.runId}/edit` : "/runs", "POST", { requestId: crypto.randomUUID(), ...form.dataset.repairId ? { sourceUpdatedAt: Number(form.dataset.sourceUpdatedAt), reason: f2.get("repairReason"), reuseStepIds: f2.getAll("reuseStepId") } : {}, ...form.dataset.runId ? { revision: Number(form.dataset.revision), ...!$2("#repair-context").hidden ? { reason: f2.get("repairReason"), reuseStepIds: f2.getAll("reuseStepId") } : {} } : {}, name: f2.get("name"), executor: f2.get("executor"), concurrency: Number(f2.get("concurrency")), maxCalls: Number(f2.get("maxCalls")), ...readLimits(f2), script: f2.get("script"), input, metadata: { objective: f2.get("objective"), inputDescription: f2.get("inputDescription"), deliverables: String(f2.get("deliverables")).split("\n").map((x2) => x2.trim()).filter(Boolean) } });
    $2("#create-dialog").close();
    await refreshList();
    await selectRun(r.id);
  } catch (e2) {
    $2("#form-error").hidden = false;
    $2("#form-error").textContent = apiMessage(e2.message);
    lastFormMessage = { error: e2.message };
  } finally {
    submit.disabled = false;
  }
};
$2("#validate").onclick = async () => {
  try {
    await api("/validate", "POST", { script: $2("#script-input").value });
    $2("#form-error").hidden = false;
    $2("#form-error").textContent = t("valid");
    lastFormMessage = { key: "valid" };
  } catch (e) {
    $2("#form-error").hidden = false;
    $2("#form-error").textContent = apiMessage(e.message);
    lastFormMessage = { error: e.message };
  }
};
for (const action of ["pause", "cancel"]) $2("#" + action).onclick = async () => {
  if (!current || busy) return;
  const id = current.id, version = selectionVersion;
  busy = true;
  try {
    const next = await api(`/runs/${id}/${action}`, "POST", {});
    if (viewing(id, version)) {
      current = next;
      error("");
      renderRun();
    }
    await refreshList();
  } catch (e) {
    if (viewing(id, version)) error(e.message);
  } finally {
    busy = false;
  }
};
for (const b2 of document.querySelectorAll("[data-tab]")) {
  b2.onclick = () => {
    tab = b2.dataset.tab;
    renderNode();
    $2("#node-scroll").scrollTop = 0;
  };
  b2.onkeydown = (e) => {
    const tabs = [...document.querySelectorAll("[data-tab]")];
    let index = tabs.indexOf(b2);
    if (e.key === "ArrowRight") index = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") index = (index + tabs.length - 1) % tabs.length;
    else if (e.key === "Home") index = 0;
    else if (e.key === "End") index = tabs.length - 1;
    else return;
    e.preventDefault();
    tabs[index].click();
    tabs[index].focus();
  };
}
$2("#node-raw").onclick = () => {
  nodeRaw = !nodeRaw;
  renderNode();
};
$2("#node-copy").onclick = async () => {
  const signature = nodeSignature;
  try {
    await navigator.clipboard.writeText(copyValue);
    if (signature === nodeSignature) $2("#node-copy-status").textContent = t("copied");
  } catch {
    if (signature === nodeSignature) $2("#node-copy-status").textContent = t("copyFailed");
  }
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => $2("#node-copy-status").textContent = "", 2500);
};
for (const [id, offset] of [["node-prev", -1], ["node-next", 1]]) $2("#" + id).onclick = () => {
  const nodes = graphSteps(), index = nodes.findIndex((s) => s.id === selected);
  if (nodes[index + offset]) openNode(nodes[index + offset].id);
};
for (const [id, fn] of [["zoom-out", () => zoom = Math.max(0.5, zoom - 0.15)], ["zoom-in", () => zoom = Math.min(2, zoom + 0.15)], ["zoom-reset", () => zoom = 0]]) $2("#" + id).onclick = () => {
  zoomAuto = id === "zoom-reset";
  fn();
  $2("#zoom-reset").textContent = Math.round(zoom * 100) + "%";
  renderGraph();
};
async function renderRead() {
  if (!current || !readMode) return;
  const signature = [current.id, current.updatedAt, current.status, readMode, language, ...current.steps.map((s) => s.status)].join("|");
  if (signature === readSignature) return;
  readSignature = signature;
  const report = readMode === "report", ready = exportable(current);
  $2("#read-dialog").classList.toggle("report-dialog", report);
  $2("#read-title").textContent = t(report ? "report" : "frozenScript");
  $2("#read-content").hidden = report;
  $2("#report-preview").hidden = !report;
  $2("#report-downloads").hidden = !report || !ready;
  if (!report) {
    $2("#read-content").textContent = current.script;
    return;
  }
  const preview = $2("#report-preview");
  preview.replaceChildren(el("p", {}, t(ready ? "reportLoading" : "exportUnavailable")));
  if (!ready) return;
  try {
    const response = await fetch(`/api/runs/${current.id}/report?format=html&language=${language}`, { headers: { "X-Workflow-Client": "1" } });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const html = await response.text();
    if (signature !== readSignature) return;
    const frame = el("iframe", { title: t("report"), sandbox: "allow-popups allow-popups-to-escape-sandbox" });
    frame.srcdoc = html;
    preview.replaceChildren(frame);
  } catch (e) {
    if (signature === readSignature) {
      preview.replaceChildren(el("p", {}, t("reportLoadFailed") + " " + e.message));
      readSignature = "";
    }
  }
}
for (const mode of ["report", "script"]) $2("#" + mode).onclick = () => {
  if (!current) return;
  readMode = mode;
  renderRead();
  $2("#read-dialog").showModal();
};
async function loop() {
  for (; ; ) {
    try {
      if (current && ["running", "pausing", "stopping", "queued"].includes(current.status)) {
        const id = current.id, version = selectionVersion;
        await loadEvents(id, version);
        if (viewing(id, version)) await refreshCurrent();
        await refreshList();
      } else {
        await new Promise((r) => setTimeout(r, 4e3));
        await refreshList();
        await refreshCurrent();
      }
      setConnection("connected");
    } catch (e) {
      setConnection("disconnected");
      error(e.message);
      await new Promise((r) => setTimeout(r, 4e3));
    }
  }
}
applyLanguage();
try {
  const c = await api("/config");
  mcodeAvailable = c.mcodeAvailable !== false;
  $2("#workspace").textContent = c.workspace;
  defaultScripts.zh = c.example;
  if (!$2("#script-input").dataset.edited) $2("#script-input").value = defaultScripts[language];
  defaults = c.defaults ?? defaults;
  const f2 = $2("#create-form");
  f2.elements.maxSteps.value = defaults.maxSteps;
  f2.elements.stepTimeoutMinutes.value = defaults.stepTimeoutMs / 6e4;
  f2.elements.runTimeoutMinutes.value = defaults.runTimeoutMs / 6e4;
  updateLimitSummary();
  if (c.mcodeAvailable === false) {
    const option = f2.querySelector("option[value=mcode]");
    option.disabled = false;
    option.textContent = t("missingOption");
  }
  setConnection("connected");
  await refreshList();
  void loop();
} catch (e) {
  setConnection("notConnected");
  error(e.message);
}
new ResizeObserver(() => {
  if (current && zoomAuto) renderGraph();
}).observe($2("#graph-wrap"));
function closeInspector() {
  const id = selected;
  selected = null;
  renderNode();
  renderGraph();
  $2("#graph").querySelector(`[data-step-id="${CSS.escape(id ?? "")}"]`)?.focus({ preventScroll: true });
}
$2("#brief-template").onclick = () => $2("#save-template").click();
$2("#brief-cancel").onclick = () => $2("#cancel").click();
$2("#close-inspector").onclick = closeInspector;
$2("#node-dialog").addEventListener("cancel", (e) => {
  e.preventDefault();
  closeInspector();
});
$2("#node-dialog").addEventListener("click", (e) => {
  if (e.target !== e.currentTarget) return;
  const r = e.currentTarget.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeInspector();
});
$2("#zoom-fit").onclick = () => {
  const box = $2("#graph").viewBox.baseVal;
  zoomAuto = false;
  zoom = Math.min(1.12, ($2("#graph-wrap").clientWidth - 40) / box.width, ($2("#graph-wrap").clientHeight - 20) / box.height);
  renderGraph();
};
function readLimits(f2) {
  return { maxSteps: Number(f2.get("maxSteps")), stepTimeoutMs: Number(f2.get("stepTimeoutMinutes")) * 6e4, runTimeoutMs: Number(f2.get("runTimeoutMinutes")) * 6e4 };
}
function updateLimitSummary() {
  const f2 = $2("#create-form");
  $2(".execution-settings summary").textContent = t("limits", { steps: f2.elements.maxSteps.value, minutes: f2.elements.stepTimeoutMinutes.value });
}
for (const name of ["maxSteps", "stepTimeoutMinutes"]) $2("#create-form").elements[name].addEventListener("input", updateLimitSummary);
$2("#close-resume").onclick = () => $2("#resume-dialog").close();
$2("#resume").onclick = () => {
  if (!current || busy) return;
  const f2 = $2("#resume-form"), limits = current.legacyLimits ? defaults : current;
  f2.dataset.runId = current.id;
  f2.elements.maxSteps.value = limits.maxSteps ?? defaults.maxSteps;
  f2.elements.stepTimeoutMinutes.value = (limits.stepTimeoutMs ?? defaults.stepTimeoutMs) / 6e4;
  f2.elements.runTimeoutMinutes.value = (limits.runTimeoutMs ?? defaults.runTimeoutMs) / 6e4;
  f2.elements.maxCalls.value = current.maxCalls;
  $2("#resume-note").textContent = t("resumeNote", { used: current.attempts, max: current.maxCalls }) + (current.legacyLimits ? " " + t("legacyNote") : "");
  $2("#resume-error").hidden = true;
  $2("#resume-dialog").showModal();
};
$2("#resume-form").onsubmit = async (e) => {
  e.preventDefault();
  if (busy) return;
  const id = e.currentTarget.dataset.runId;
  let confirmStopped = false;
  if (current?.id === id && current.status === "needs_attention") {
    confirmStopped = confirm(t("confirmStopped"));
    if (!confirmStopped) return;
  }
  const f2 = new FormData(e.currentTarget), button = e.submitter;
  busy = true;
  button.disabled = true;
  try {
    await api(`/runs/${id}/resume`, "POST", { ...readLimits(f2), maxCalls: Number(f2.get("maxCalls")), confirmStopped });
    $2("#resume-dialog").close();
    await selectRun(id);
    await refreshList();
  } catch (e2) {
    $2("#resume-error").hidden = false;
    $2("#resume-error").textContent = apiMessage(e2.message);
  } finally {
    busy = false;
    button.disabled = false;
  }
};
function setConnection(key) {
  connectionKey = key;
  $2("#connection").textContent = t(key);
  $2(".connection-dot").dataset.connected = String(key === "connected");
}
function applyLanguage() {
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  for (const e of document.querySelectorAll("[data-i18n]")) e.textContent = t(e.dataset.i18n);
  for (const [attr, key] of [["aria-label", "i18nAria"], ["title", "i18nTitle"]]) for (const e of document.querySelectorAll("[data-" + (key === "i18nAria" ? "i18n-aria" : "i18n-title") + "]")) e.setAttribute(attr, t(e.dataset[key]));
  $2("#language-select").value = preference;
  const script = $2("#script-input");
  if (!script.dataset.edited && defaultScripts[language]) script.value = defaultScripts[language];
  const name = $2("#create-form").elements.name;
  if (!name.dataset.edited) name.value = t("defaultName");
  const option = $2("#create-form option[value=mcode]");
  option.disabled = false;
  option.textContent = t(mcodeAvailable ? "mcodeOption" : "missingOption");
  if ($2("#create-dialog").open) {
    $2("#create-title").textContent = t($2("#create-form").dataset.repairId ? "repairRun" : $2("#create-form").dataset.runId ? "editDraft" : "newHeading");
    $2("#save-draft").textContent = t($2("#create-form").dataset.repairId ? "createRepair" : $2("#create-form").dataset.runId ? "saveDraft" : "createDraft");
  }
  setConnection(connectionKey);
  renderScheduler();
  renderModeNote();
  updateLimitSummary();
  renderList();
  renderRun();
  renderEvents();
  renderRead();
  if (!current) error(lastAlert);
  if (lastFormMessage) $2("#form-error").textContent = lastFormMessage.key ? t(lastFormMessage.key) : apiMessage(lastFormMessage.error);
  if ($2("#resume-dialog").open && current) $2("#resume-note").textContent = t("resumeNote", { used: current.attempts, max: current.maxCalls }) + (current.legacyLimits ? " " + t("legacyNote") : "");
}
$2("#script-input").addEventListener("input", (e) => e.target.dataset.edited = "true");
$2("#create-form").elements.name.addEventListener("input", (e) => e.target.dataset.edited = "true");
$2("#language-select").addEventListener("change", (e) => {
  preference = e.target.value;
  savePreference(safeStorage(), preference);
  language = resolveLanguage(preference, navigator.languages?.length ? navigator.languages : [navigator.language]);
  applyLanguage();
});
window.addEventListener("languagechange", () => {
  if (preference === "auto") {
    language = resolveLanguage(preference, navigator.languages?.length ? navigator.languages : [navigator.language]);
    applyLanguage();
  }
});
window.addEventListener("storage", (e) => {
  if (e.key === LANGUAGE_KEY || e.key === null) {
    preference = readPreference(safeStorage());
    language = resolveLanguage(preference, navigator.languages?.length ? navigator.languages : [navigator.language]);
    applyLanguage();
  }
});
function renderScheduler() {
  $2("#scheduler-settings").textContent = t("schedulerBadge", { active: scheduler.active, limit: scheduler.limit });
  $2("#scheduler-usage").textContent = t("schedulerUsage", { active: scheduler.active, limit: scheduler.limit, queued: scheduler.queued });
}
$2("#scheduler-settings").onclick = async () => {
  try {
    scheduler = await api("/scheduler");
    renderScheduler();
    $2("#scheduler-form").elements.globalConcurrency.value = scheduler.limit;
    $2("#scheduler-error").hidden = true;
    $2("#scheduler-dialog").showModal();
  } catch (e) {
    error(e.message);
  }
};
$2("#close-scheduler").onclick = () => $2("#scheduler-dialog").close();
$2("#scheduler-form").onsubmit = async (e) => {
  e.preventDefault();
  const button = e.submitter;
  button.disabled = true;
  try {
    scheduler = await api("/scheduler", "POST", { globalConcurrency: Number(e.currentTarget.elements.globalConcurrency.value) });
    renderScheduler();
    $2("#scheduler-dialog").close();
    await refreshList();
  } catch (e2) {
    $2("#scheduler-error").hidden = false;
    $2("#scheduler-error").textContent = apiMessage(e2.message);
  } finally {
    button.disabled = false;
  }
};
function setMetadataForm(metadata = {}) {
  const f2 = $2("#create-form");
  f2.elements.objective.value = metadata?.objective ?? "";
  f2.elements.inputDescription.value = metadata?.inputDescription ?? "";
  f2.elements.deliverables.value = metadata?.deliverables?.join("\n") ?? "";
}
function renderBrief() {
  $2("#save-template").hidden = !current || current.status === "pending_review";
  $2("#workflow-brief").hidden = !current;
  $2("#brief-objective").hidden = !current?.metadata?.objective;
  $2("#brief-objective").textContent = current?.metadata?.objective ?? "";
  $2(".review-secondary").hidden = current?.status !== "pending_review";
  const box = $2("#definition-summary");
  box.replaceChildren();
  const m2 = current?.metadata;
  box.hidden = !m2 || !(m2.objective || m2.inputDescription || m2.deliverables?.length);
  if (m2) {
    for (const [key, value] of [["inputDescription", m2.inputDescription], ["deliverables", m2.deliverables?.join(" \xB7 ")]]) if (value) {
      const item = el("div");
      item.append(el("b", {}, t(key)), el("p", {}, value));
      box.append(item);
    }
  }
  const latest = current?.latestProgress;
  $2("#latest-progress").hidden = !latest;
  $2("#latest-progress-text").textContent = latest?.message ?? "";
}
function exportable(run) {
  return ["succeeded", "completed_with_gaps", "failed", "cancelled", "paused", "interrupted", "needs_attention"].includes(run.status);
}
for (const button of document.querySelectorAll("[data-report-format]")) button.onclick = async () => {
  if (!current || !exportable(current)) return;
  button.disabled = true;
  try {
    const format = button.dataset.reportFormat, id = current.id;
    const r = await fetch(`/api/runs/${id}/report?format=${format}&language=${language}`, { headers: { "X-Workflow-Client": "1" } });
    if (!r.ok) throw Error((await r.json()).error);
    const url = URL.createObjectURL(await r.blob()), a = el("a", { href: url, download: r.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `workflow-${id}.${format}` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1e4);
  } catch (e) {
    error(e.message);
  } finally {
    button.disabled = false;
  }
};
async function renderTemplates() {
  const list = $2("#template-list");
  list.replaceChildren();
  const templates = await api("/templates");
  if (!templates.length) list.append(el("p", { class: "subtle" }, t("emptyTemplates")));
  for (const template of templates) {
    const row = el("article", { class: "template-card" }), text = el("div");
    text.append(el("h3", {}, template.name), el("p", {}, template.objective));
    const use = el("button", { type: "button" }, t("useTemplate")), remove = el("button", { type: "button", class: "danger" }, t("deleteTemplate"));
    use.onclick = async () => {
      use.disabled = true;
      try {
        const { definition } = await api(`/templates/${template.id}`);
        $2("#templates-dialog").close();
        showCreate();
        const f2 = $2("#create-form");
        for (const key of ["name", "executor", "concurrency", "maxCalls", "maxSteps"]) f2.elements[key].value = definition[key];
        f2.elements.name.dataset.edited = "true";
        f2.elements.stepTimeoutMinutes.value = definition.stepTimeoutMs / 6e4;
        f2.elements.runTimeoutMinutes.value = definition.runTimeoutMs / 6e4;
        f2.elements.inputJSON.value = JSON.stringify(definition.input, null, 2);
        $2("#script-input").value = definition.script;
        $2("#script-input").dataset.edited = "true";
        setMetadataForm(definition.metadata);
        updateLimitSummary();
        renderModeNote();
      } catch (e) {
        error(e.message);
      } finally {
        use.disabled = false;
      }
    };
    remove.onclick = async () => {
      if (!confirm(t("deleteTemplateConfirm"))) return;
      remove.disabled = true;
      try {
        await api(`/templates/${template.id}`, "POST", { action: "delete" });
        await renderTemplates();
      } catch (e) {
        error(e.message);
        remove.disabled = false;
      }
    };
    const actions = el("div", { class: "template-actions" });
    actions.append(use, remove);
    row.append(text, actions);
    list.append(row);
  }
}
async function openTemplates() {
  const f2 = $2("#template-form");
  f2.hidden = !current;
  f2.elements.name.value = current?.name ?? "";
  f2.dataset.runId = current?.id ?? "";
  f2.dataset.revision = current?.revision ?? "";
  $2("#templates-error").hidden = true;
  $2("#templates-dialog").showModal();
  try {
    await renderTemplates();
  } catch (e) {
    $2("#templates-error").hidden = false;
    $2("#templates-error").textContent = apiMessage(e.message);
  }
}
$2("#open-templates").onclick = openTemplates;
$2("#save-template").onclick = openTemplates;
$2("#close-templates").onclick = () => $2("#templates-dialog").close();
$2("#template-form").onsubmit = async (e) => {
  e.preventDefault();
  const f2 = e.currentTarget, button = e.submitter ?? f2.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await api("/templates", "POST", { runId: f2.dataset.runId, name: f2.elements.name.value, ...f2.dataset.revision ? { revision: Number(f2.dataset.revision) } : {} });
    await renderTemplates();
    $2("#templates-error").hidden = false;
    $2("#templates-error").textContent = t("templateSaved");
  } catch (e2) {
    $2("#templates-error").hidden = false;
    $2("#templates-error").textContent = apiMessage(e2.message);
  } finally {
    button.disabled = false;
  }
};
function renderLegend(steps) {
  const box = $2("#graph-legend");
  box.replaceChildren();
  const states = showPlan || current?.status === "pending_review" ? ["planned"] : ["awaiting", "queued", "running", "succeeded", "failed", ...steps.some((s) => ["blocked", "not_run", "interrupted"].includes(s.status)) ? ["not_run"] : []];
  for (const state of states) {
    const item = el("span", { class: `legend-state ${state}` });
    item.append(el("i", { "aria-hidden": "true" }), document.createTextNode(labels[state]));
    box.append(item);
  }
}
