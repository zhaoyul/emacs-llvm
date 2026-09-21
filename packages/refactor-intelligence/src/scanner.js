import {createHash} from "node:crypto";

const DELIMITERS = new Set(["(", ")", "[", "]", "{", "}", "'", "`", ",", "\"", ";"]);

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function validateLispSymbol(name, label = "symbol") {
  if (typeof name !== "string" || name.length === 0 || name.length > 256) {
    throw new TypeError(`${label} must be a non-empty string of at most 256 characters`);
  }
  if (/\s/u.test(name) || /[()\[\]{}";'`,]/u.test(name)) {
    throw new TypeError(`${label} contains Lisp delimiter or whitespace characters`);
  }
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(name)) {
    throw new TypeError(`${label} must not be numeric`);
  }
  return name;
}

function positionFor(text, offset) {
  let line = 1;
  let column = 0;
  for (let i = 0; i < offset; i += 1) {
    if (text[i] === "\n") { line += 1; column = 0; }
    else { column += 1; }
  }
  return {line, column};
}

function skipBlockComment(text, start) {
  let depth = 1;
  let i = start + 2;
  while (i < text.length && depth > 0) {
    if (text.startsWith("#|", i)) { depth += 1; i += 2; continue; }
    if (text.startsWith("|#", i)) { depth -= 1; i += 2; continue; }
    i += 1;
  }
  return {end: i, closed: depth === 0};
}

export function scanLisp(source, options = {}) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  const includeTrivia = options.includeTrivia === true;
  const tokens = [];
  const diagnostics = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/u.test(ch)) { i += 1; continue; }
    if (ch === ";") {
      const start = i;
      while (i < source.length && source[i] !== "\n") i += 1;
      if (includeTrivia) tokens.push({type:"comment", value:source.slice(start,i), start, end:i});
      continue;
    }
    if (source.startsWith("#|", i)) {
      const start = i;
      const block = skipBlockComment(source, i);
      i = block.end;
      if (!block.closed) diagnostics.push({code:"unterminated_block_comment", offset:start});
      if (includeTrivia) tokens.push({type:"comment", value:source.slice(start,i), start, end:i});
      continue;
    }
    if (ch === "\"") {
      const start = i++;
      let closed = false;
      while (i < source.length) {
        if (source[i] === "\\") { i += Math.min(2, source.length - i); continue; }
        if (source[i] === "\"") { i += 1; closed = true; break; }
        i += 1;
      }
      if (!closed) diagnostics.push({code:"unterminated_string", offset:start});
      if (includeTrivia) tokens.push({type:"string", value:source.slice(start,i), start, end:i});
      continue;
    }
    if (source.startsWith("#_", i)) {
      tokens.push({type:"reader_discard", value:"#_", start:i, end:i+2});
      diagnostics.push({code:"reader_discard_requires_conservative_analysis", offset:i});
      i += 2;
      continue;
    }
    if (source.startsWith(",@", i)) { tokens.push({type:"reader",value:",@",start:i,end:i+2}); i+=2; continue; }
    if (source.startsWith("#'", i)) { tokens.push({type:"reader",value:"#'",start:i,end:i+2}); i+=2; continue; }
    if ("()[]{}'`,".includes(ch)) {
      tokens.push({type:"delimiter", value:ch, start:i, end:i+1}); i += 1; continue;
    }
    const start = i;
    while (i < source.length && !/\s/u.test(source[i]) && !DELIMITERS.has(source[i])) {
      if (source.startsWith("#|", i)) break;
      i += 1;
    }
    if (i === start) { i += 1; continue; }
    const value = source.slice(start, i);
    const type = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value) ? "number" : "symbol";
    tokens.push({type, value, start, end:i, ...positionFor(source,start)});
  }
  return {tokens, diagnostics};
}

export function checkLispBalance(source) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  const scanned = scanLisp(source);
  const stack = [];
  const diagnostics = [...scanned.diagnostics];
  const pairs = { ")": "(", "]": "[", "}": "{" };
  for (const token of scanned.tokens) {
    if (token.type !== "delimiter") continue;
    if (["(", "[", "{"].includes(token.value)) {
      stack.push(token);
      continue;
    }
    if (![ ")", "]", "}" ].includes(token.value)) continue;
    const expected = pairs[token.value];
    const top = stack.at(-1);
    if (!top) {
      diagnostics.push({ code: "unmatched_closing_delimiter", offset: token.start, actual: token.value, expected_opening: expected });
      continue;
    }
    if (top.value !== expected) {
      diagnostics.push({ code: "mismatched_closing_delimiter", offset: token.start, actual: token.value, expected: ({"(":")","[":"]","{":"}"})[top.value], opening_offset: top.start });
      stack.pop();
      continue;
    }
    stack.pop();
  }
  for (const token of stack.reverse()) {
    diagnostics.push({ code: "unclosed_opening_delimiter", offset: token.start, opening: token.value, expected: ({"(":")","[":"]","{":"}"})[token.value] });
  }
  return { balanced: diagnostics.length === 0, diagnostics };
}

export function symbolOccurrences(source, symbol) {
  validateLispSymbol(symbol);
  const {tokens, diagnostics} = scanLisp(source);
  return {
    occurrences: tokens.filter((token) => token.type === "symbol" && token.value === symbol),
    diagnostics
  };
}
