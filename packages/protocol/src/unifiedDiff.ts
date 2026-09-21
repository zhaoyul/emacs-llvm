import { OperatorError } from "./errors.js";

interface HunkLine {
  kind: "context" | "add" | "remove";
  text: string;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunks(diff: string): Hunk[] {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const line of lines) {
    const match = hunkHeader.exec(line);
    if (match) {
      current = {
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        lines: []
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("\\ No newline at end of file")) continue;
    const prefix = line[0];
    if (prefix === " ") current.lines.push({ kind: "context", text: line.slice(1) });
    else if (prefix === "+") current.lines.push({ kind: "add", text: line.slice(1) });
    else if (prefix === "-") current.lines.push({ kind: "remove", text: line.slice(1) });
    else if (line !== "") throw new OperatorError("E_INVALID_ARGUMENT", `Invalid unified diff line: ${line}`);
  }
  if (hunks.length === 0) throw new OperatorError("E_INVALID_ARGUMENT", "Unified diff contains no hunks.");
  return hunks;
}

export function applyUnifiedDiff(original: string, diff: string): string {
  const hasFinalNewline = original.endsWith("\n");
  const originalLines = original.replace(/\r\n/g, "\n").split("\n");
  if (hasFinalNewline) originalLines.pop();
  const output: string[] = [];
  let sourceIndex = 0;
  for (const hunk of parseHunks(diff)) {
    const targetIndex = Math.max(0, hunk.oldStart - 1);
    if (targetIndex < sourceIndex) throw new OperatorError("E_INVALID_ARGUMENT", "Unified diff hunks overlap or are out of order.");
    output.push(...originalLines.slice(sourceIndex, targetIndex));
    sourceIndex = targetIndex;
    let oldSeen = 0;
    let newSeen = 0;
    for (const line of hunk.lines) {
      if (line.kind === "context") {
        if (originalLines[sourceIndex] !== line.text) {
          throw new OperatorError("E_STATE_CONFLICT", "Unified diff context does not match current buffer.", {
            line: sourceIndex + 1,
            expected: line.text,
            actual: originalLines[sourceIndex] ?? null
          });
        }
        output.push(line.text);
        sourceIndex += 1;
        oldSeen += 1;
        newSeen += 1;
      } else if (line.kind === "remove") {
        if (originalLines[sourceIndex] !== line.text) {
          throw new OperatorError("E_STATE_CONFLICT", "Unified diff removal does not match current buffer.", {
            line: sourceIndex + 1,
            expected: line.text,
            actual: originalLines[sourceIndex] ?? null
          });
        }
        sourceIndex += 1;
        oldSeen += 1;
      } else {
        output.push(line.text);
        newSeen += 1;
      }
    }
    if (oldSeen !== hunk.oldCount || newSeen !== hunk.newCount) {
      throw new OperatorError("E_INVALID_ARGUMENT", "Unified diff hunk counts do not match hunk body.", {
        old_seen: oldSeen,
        old_count: hunk.oldCount,
        new_seen: newSeen,
        new_count: hunk.newCount
      });
    }
  }
  output.push(...originalLines.slice(sourceIndex));
  const result = output.join("\n");
  return hasFinalNewline ? `${result}\n` : result;
}
