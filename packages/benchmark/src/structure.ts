export interface LispDiagnostic {
  code: string;
  message: string;
  line: number;
  column: number;
  position: number;
}

export interface LispBalanceResult {
  balanced: boolean;
  diagnostics: LispDiagnostic[];
  forms_depth: number;
}

function locationAt(text: string, position: number): { line: number; column: number } {
  let line = 1;
  let column = 0;
  for (let index = 0; index < position; index += 1) {
    if (text[index] === "\n") { line += 1; column = 0; } else column += 1;
  }
  return { line, column };
}

export function checkLispBalance(text: string): LispBalanceResult {
  const diagnostics: LispDiagnostic[] = [];
  const stack: Array<{ char: string; position: number }> = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockCommentDepth = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (char === "#" && next === "|") { blockCommentDepth += 1; index += 1; continue; }
      if (char === "|" && next === "#") { blockCommentDepth -= 1; index += 1; continue; }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === ";") { lineComment = true; continue; }
    if (char === "#" && next === "|") { blockCommentDepth = 1; index += 1; continue; }
    if (char === '"') { inString = true; continue; }

    // Emacs Lisp character literals, including escaped forms such as ?\( and ?\\C-a.
    if (char === "?") {
      if (next === "\\") {
        // Consume both the escape marker and the escaped character. Modifier
        // forms remain conservative, but a delimiter character must never be
        // fed back into the structural stack.
        index = Math.min(text.length - 1, index + 2);
      } else if (next !== undefined) index += 1;
      continue;
    }
    // Common Lisp #\x character syntax. A delimiter can itself be the
    // character name, so consume at least one character after #\.
    if (char === "#" && next === "\\") {
      index = Math.min(text.length - 1, index + 2);
      if (!/[()[\]{}]/u.test(text[index]!)) {
        while (index + 1 < text.length && !/[\s()[\]{}]/u.test(text[index + 1]!)) index += 1;
      }
      continue;
    }
    // Clojure character literals such as \(, \newline and \u03bb.
    if (char === "\\" && (index === 0 || /[\s([{"']/u.test(text[index - 1]!))) {
      index = Math.min(text.length - 1, index + 1);
      if (!/[()[\]{}]/u.test(text[index]!)) {
        while (index + 1 < text.length && !/[\s()[\]{}]/u.test(text[index + 1]!)) index += 1;
      }
      continue;
    }

    if (char === "(" || char === "[" || char === "{") stack.push({ char, position: index });
    else if (char === ")" || char === "]" || char === "}") {
      const open = stack.pop();
      if (!open || open.char !== pairs[char]) {
        const { line, column } = locationAt(text, index);
        diagnostics.push({ code: "unexpected_closer", message: `Unexpected closing delimiter ${char}.`, line, column, position: index });
        if (open) stack.push(open);
      }
    }
  }

  if (inString) {
    const position = Math.max(0, text.length - 1);
    const { line, column } = locationAt(text, position);
    diagnostics.push({ code: "unterminated_string", message: "Unterminated string literal.", line, column, position });
  }
  if (blockCommentDepth > 0) {
    const position = Math.max(0, text.lastIndexOf("#|"));
    const { line, column } = locationAt(text, position);
    diagnostics.push({ code: "unterminated_block_comment", message: "Unterminated block comment.", line, column, position });
  }
  for (const open of stack.reverse()) {
    const { line, column } = locationAt(text, open.position);
    diagnostics.push({ code: "unclosed_delimiter", message: `Unclosed delimiter ${open.char}.`, line, column, position: open.position });
  }
  return { balanced: diagnostics.length === 0, diagnostics, forms_depth: stack.length };
}

export interface ParsedOrgHeading { level: number; title: string; todo: string | null; tags: string[]; }
export interface ParsedOrgStructure {
  headings: ParsedOrgHeading[];
  tables: number;
  src_blocks: number;
  source_languages: string[];
  properties: Record<string, string[]>;
  diagnostics: Array<{ code: string; line: number; message: string }>;
}

const TODO_WORDS = new Set(["TODO", "DONE", "NEXT", "WAITING", "CANCELLED", "HOLD"]);

export function parseOrgStructure(text: string): ParsedOrgStructure {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const headings: ParsedOrgHeading[] = [];
  const sourceLanguages: string[] = [];
  const properties: Record<string, string[]> = {};
  const diagnostics: Array<{ code: string; line: number; message: string }> = [];
  let tables = 0;
  let inTable = false;
  let openSource: { language: string; line: number } | null = null;

  for (let offset = 0; offset < lines.length; offset += 1) {
    const line = lines[offset]!;
    const lineNumber = offset + 1;
    const begin = /^\s*#\+begin_src\s+([^\s]+)(?:\s|$)/iu.exec(line);
    const end = /^\s*#\+end_src\s*$/iu.test(line);
    if (begin) {
      if (openSource) diagnostics.push({ code: "nested_src_block", line: lineNumber, message: "A source block began before the previous block ended." });
      openSource = { language: begin[1]!.toLowerCase(), line: lineNumber };
      sourceLanguages.push(openSource.language);
    } else if (end) {
      if (!openSource) diagnostics.push({ code: "orphan_end_src", line: lineNumber, message: "Found #+end_src without a matching #+begin_src." });
      openSource = null;
    }

    if (!openSource || begin) {
      const match = /^(\*+)\s+(.+?)\s*$/u.exec(line);
      if (match) {
        let body = match[2]!.trim();
        const tagMatch = /\s+:([^:\s]+(?::[^:\s]+)*):\s*$/u.exec(body);
        const tags = tagMatch ? tagMatch[1]!.split(":") : [];
        if (tagMatch) body = body.slice(0, tagMatch.index).trim();
        const firstSpace = body.indexOf(" ");
        const firstWord = firstSpace < 0 ? body : body.slice(0, firstSpace);
        const todo = TODO_WORDS.has(firstWord) ? firstWord : null;
        const title = todo ? body.slice(firstWord.length).trim() : body;
        headings.push({ level: match[1]!.length, title, todo, tags });
      }
    }

    const property = /^\s*:([A-Za-z0-9_@#%+-]+):\s*(.*?)\s*$/u.exec(line);
    if (property && !["PROPERTIES", "END"].includes(property[1]!.toUpperCase())) {
      const key = property[1]!.toUpperCase();
      (properties[key] ??= []).push(property[2]!);
    }

    const tableLine = /^\s*\|.*\|\s*$/u.test(line);
    if (tableLine && !inTable) { tables += 1; inTable = true; }
    else if (!tableLine) inTable = false;
  }

  if (openSource) diagnostics.push({ code: "unterminated_src_block", line: openSource.line, message: `Source block ${openSource.language} is not terminated.` });
  return { headings, tables, src_blocks: sourceLanguages.length, source_languages: sourceLanguages, properties, diagnostics };
}
