import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { ContentLengthParser, encodeContentLengthFrame } from "../../bridge-client/src/framing.js";

export interface FakeEmacsBridgeOptions {
  nativePid?: number;
  nativeWindowIdentifier?: string;
  frameTitle?: string;
  externalCommandFile?: string;
}

export class FakeEmacsBridge {
  constructor(private readonly options: FakeEmacsBridgeOptions = {}) {}

  private get instancePid(): number { return this.options.nativePid ?? process.pid; }
  readonly runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-operator-fake-"));
  readonly instanceId = `emacs-fake-${Math.random().toString(16).slice(2)}`;
  readonly token = "b".repeat(64);
  readonly tokenFile = path.join(this.runtimeDir, `token-${this.instanceId}`);
  readonly instanceFile = path.join(this.runtimeDir, `instance-${this.instanceId}.json`);
  private server: any;
  private text = "(alpha beta)\n";
  private tick = 1;
  private stateSeq = 1;
  private point = 1;
  private checkpoint: string | undefined;
  private selectedFile = path.join(this.runtimeDir, "fake.el");
  private majorMode = "emacs-lisp-mode";
  private renamePlans = new Map<string, { oldSymbol: string; newSymbol: string; requestedNewSymbol: string; language: string; qualificationPolicy: string; symbolSemantics: Record<string, unknown>; original: string }>();
  private renameJournals = new Map<string, { original: string; applied: string }>();

  async start(): Promise<void> {
    fs.writeFileSync(this.tokenFile, `${this.token}\n`, { mode: 0o600 });
    this.server = net.createServer((socket: any) => {
      const parser = new ContentLengthParser();
      let authorized = false;
      socket.on("data", (chunk: Buffer) => {
        for (const frame of parser.push(chunk)) {
          const request = JSON.parse(frame) as any;
          const respond = (result: unknown) => socket.write(encodeContentLengthFrame({ jsonrpc: "2.0", id: request.id, result }));
          const fail = (code: string, message: string, details: Record<string, unknown> = {}) =>
            socket.write(encodeContentLengthFrame({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message, data: { code, details } } }));
          if (request.method === "initialize") {
            if (request.params?.token !== this.token) {
              fail("E_AUTH_FAILED", "bad token");
              continue;
            }
            authorized = true;
            respond(this.describe());
            continue;
          }
          if (!authorized) {
            fail("E_AUTH_FAILED", "not initialized");
            continue;
          }
          try {
            switch (request.method) {
              case "ping":
                respond({ pong: true, state_seq: this.stateSeq });
                break;
              case "instance.describe":
                respond(this.describe());
                break;
              case "session.target.resolve": {
                const selected = request.params?.selector?.file;
                if (typeof selected === "string" && selected.length > 0) {
                  this.selectedFile = selected;
                  if (selected.endsWith(".org")) this.majorMode = "org-mode";
                  else if (/\.clj[sc]?$/.test(selected)) this.majorMode = selected.endsWith(".cljs") ? "clojurescript-mode" : selected.endsWith(".cljc") ? "clojurec-mode" : "clojure-mode";
                  else if (/\.(lisp|cl|asd)$/.test(selected)) this.majorMode = "lisp-mode";
                  else this.majorMode = "emacs-lisp-mode";
                }
                respond(this.target());
                break;
              }
              case "state.observe":
                respond(this.observe());
                break;
              case "capabilities.query":
                respond(this.capabilities(request.params));
                break;
              case "resource.read": {
                const start = typeof request.params?.start === "number" ? request.params.start : 1;
                const end = typeof request.params?.end === "number" ? request.params.end : this.text.length + 1;
                if (start < 1 || end < start || end > this.text.length + 1) {
                  fail("E_INVALID_ARGUMENT", "invalid resource range", { start, end });
                  break;
                }
                respond({ buffer_id: "buf_fake", buffer_tick: this.tick, start, end, text: this.text.slice(start - 1, end - 1) });
                break;
              }
              case "navigation.execute": {
                const operation = request.params?.operation;
                const before = this.point;
                if (operation === "buffer_start") this.point = 1;
                else if (operation === "buffer_end") this.point = this.text.length + 1;
                else if (operation === "goto_position") this.point = request.params?.position;
                else if (operation === "line_start") {
                  const index = Math.max(0, this.point - 1);
                  const previous = this.text.lastIndexOf("\n", Math.max(0, index - 1));
                  this.point = previous < 0 ? 1 : previous + 2;
                } else if (operation === "line_end") {
                  const index = Math.max(0, this.point - 1);
                  const next = this.text.indexOf("\n", index);
                  this.point = next < 0 ? this.text.length + 1 : next + 1;
                }
                else if (operation === "goto_line") {
                  const line = request.params?.line ?? 1;
                  const lines = this.text.split("\n");
                  if (line < 1 || line > lines.length) { fail("E_TARGET_NOT_FOUND", "line missing"); break; }
                  this.point = 1 + lines.slice(0, line - 1).reduce((n, value) => n + value.length + 1, 0);
                } else if (operation === "search_forward" || operation === "search_backward") {
                  const query = String(request.params?.query ?? "");
                  const index = operation === "search_forward"
                    ? this.text.indexOf(query, Math.max(0, this.point - 1))
                    : this.text.lastIndexOf(query, Math.max(0, this.point - 2));
                  if (index < 0) { fail("E_TARGET_NOT_FOUND", "search missing", { query }); break; }
                  this.point = operation === "search_forward" ? index + query.length + 1 : index + 1;
                } else if (operation === "forward_sexp") this.point = Math.min(this.text.length + 1, this.point + 1);
                else if (operation === "backward_sexp") this.point = Math.max(1, this.point - 1);
                else { fail("E_INVALID_ARGUMENT", `unsupported fake navigation ${operation}`); break; }
                respond({ operation, buffer_id: "buf_fake", buffer_tick: this.tick, point_before: before, point_after: this.point, line: 1, column: this.point - 1 });
                break;
              }
              case "edit.apply":
                this.checkPrecondition(request.params?.precondition, fail);
                if (request.params?.operation === "insert") {
                  const position = request.params.position ?? 1;
                  const index = position - 1;
                  this.text = this.text.slice(0, index) + (request.params.text ?? "") + this.text.slice(index);
                } else if (request.params?.operation === "replace_range") {
                  const start = request.params.start - 1;
                  const end = request.params.end - 1;
                  this.text = this.text.slice(0, start) + (request.params.text ?? "") + this.text.slice(end);
                } else if (request.params?.operation === "delete_range") {
                  const start = request.params.start - 1;
                  const end = request.params.end - 1;
                  this.text = this.text.slice(0, start) + this.text.slice(end);
                }
                this.bump();
                respond({ buffer_tick_after: this.tick });
                break;
              case "keys.execute":
                this.checkPrecondition(request.params?.precondition, fail);
                this.text += ";internal-key\n";
                this.bump();
                respond({ executed: true, last_command: "fake-command", target: this.target() });
                break;
              case "command.execute": {
                this.checkPrecondition(request.params?.precondition, fail);
                const command = request.params?.command;
                const args = Array.isArray(request.params?.arguments) ? request.params.arguments : [];
                let returnValue: unknown = request.params?.interactive === false
                  ? { operation: args[0] ?? null, provider: "fake" }
                  : null;
                let mutated = false;
                if (this.majorMode !== "org-mode" && command === "emacs-operator-lisp-rename-symbol") {
                  const oldSymbol = String(args[0] ?? "");
                  const newSymbol = String(args[1] ?? "");
                  const escaped = oldSymbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                  const tokenClass = "A-Za-z0-9_+*/<>=!?$%&~^:.@#-";
                  const pattern = new RegExp(`(?<![${tokenClass}])${escaped}(?![${tokenClass}])`, "g");
                  let replacements = 0;
                  this.text = this.text.replace(pattern, () => { replacements += 1; return newSymbol; });
                  returnValue = { old_symbol: oldSymbol, new_symbol: newSymbol, scope: String(args[2] ?? "current_defun"), replacements, balanced: true };
                  mutated = replacements > 0;
                } else if (this.majorMode !== "org-mode" && command === "emacs-operator-lisp-extract-function") {
                  const start = Number(args[0]);
                  const end = Number(args[1]);
                  const name = String(args[2] ?? "extracted");
                  const parameters = Array.isArray(args[3]) ? args[3].map(String) : [];
                  const body = this.text.slice(start - 1, end - 1);
                  const call = `(${name}${parameters.length ? ` ${parameters.join(" ")}` : ""})`;
                  const definition = `(defun ${name} (${parameters.join(" ")})\n${body})\n\n`;
                  const replaced = this.text.slice(0, start - 1) + call + this.text.slice(end - 1);
                  this.text = definition + replaced;
                  this.point = 1;
                  returnValue = {
                    name, parameters, source_bounds_before: [start, end],
                    new_definition_bounds: [1, definition.length + 1],
                    enclosing_definition_bounds: [definition.length + 1, this.text.length + 1],
                    call_bounds: [definition.length + start, definition.length + start + call.length],
                    call, balanced: true
                  };
                  mutated = true;
                } else if (this.majorMode !== "org-mode" && command === "emacs-operator-lisp-move-top-level-form") {
                  const direction = String(args[0] ?? "down");
                  const lines = this.text.split("\n");
                  const forms = lines.map((line, index) => ({ line, index })).filter((item) => item.line.trim().startsWith("("));
                  let current = forms.findIndex((item) => {
                    const before = lines.slice(0, item.index).reduce((n, line) => n + line.length + 1, 1);
                    return this.point >= before && this.point <= before + item.line.length;
                  });
                  if (current < 0) current = 0;
                  const target = direction === "up" || direction === "backward" ? current - 1 : current + 1;
                  if (target < 0 || target >= forms.length) throw new Error("no adjacent fake form");
                  const a = forms[current]!.index;
                  const b = forms[target]!.index;
                  const lineA = lines[a]!;
                  const lineB = lines[b]!;
                  lines[a] = lineB;
                  lines[b] = lineA;
                  this.text = lines.join("\n");
                  this.point = 1 + lines.slice(0, b).reduce((n, line) => n + line.length + 1, 0);
                  returnValue = { direction, from_index: current, to_index: target, balanced: true };
                  mutated = true;
                } else if (this.majorMode === "org-mode" && command === "emacs-operator-org-create-heading") {
                  const title = String(args[0] ?? "Section");
                  const level = typeof args[1] === "number" ? args[1] : 1;
                  const prefix = this.point > 1 && this.text[this.point - 2] !== "\n" ? "\n" : "";
                  const value = `${prefix}${"*".repeat(level)} ${title}\n`;
                  const start = this.point + prefix.length;
                  this.insertAtPoint(value);
                  this.point = start;
                  returnValue = { heading: { title, level }, start };
                  mutated = true;
                } else if (this.majorMode === "org-mode" && command === "emacs-operator-org-set-title") {
                  const heading = this.currentOrgHeading();
                  const title = String(args[0] ?? "");
                  if (!heading) throw new Error("no fake Org heading");
                  const replacement = `${"*".repeat(heading.level)} ${title}${heading.tags ? ` ${heading.tags}` : ""}`;
                  this.text = this.text.slice(0, heading.start) + replacement + this.text.slice(heading.lineEnd);
                  returnValue = { heading: { title, level: heading.level } };
                  mutated = true;
                } else if (this.majorMode === "org-mode" && command === "emacs-operator-org-set-tags") {
                  const heading = this.currentOrgHeading();
                  if (!heading) throw new Error("no fake Org heading");
                  const tags = Array.isArray(args[0]) ? args[0].map(String) : [];
                  const suffix = tags.length ? ` :${tags.join(":")}:` : "";
                  const replacement = `${"*".repeat(heading.level)} ${heading.title}${suffix}`;
                  this.text = this.text.slice(0, heading.start) + replacement + this.text.slice(heading.lineEnd);
                  returnValue = { tags, heading: { title: heading.title, level: heading.level } };
                  mutated = true;
                } else if (this.majorMode === "org-mode" && command === "emacs-operator-org-rewrite-section-body") {
                  const heading = this.currentOrgHeading();
                  if (!heading) throw new Error("no fake Org heading");
                  const body = String(args[0] ?? "");
                  const bodyStart = heading.lineEnd < this.text.length && this.text[heading.lineEnd] === "\n" ? heading.lineEnd + 1 : heading.lineEnd;
                  const rest = this.text.slice(bodyStart);
                  const nextHeading = rest.search(/^\*+ /m);
                  const bodyEnd = nextHeading < 0 ? this.text.length : bodyStart + nextHeading;
                  const normalized = body.length === 0 ? "" : `${body.replace(/\n$/, "")}\n`;
                  this.text = this.text.slice(0, bodyStart) + normalized + this.text.slice(bodyEnd);
                  returnValue = { content_bounds_before: [bodyStart + 1, bodyEnd + 1], content_bounds_after: [bodyStart + 1, bodyStart + normalized.length + 1], body_bytes: Buffer.byteLength(body) };
                  mutated = true;
                } else if (this.majorMode === "org-mode" && command === "emacs-operator-org-set-property") {
                  returnValue = { property: String(args[0] ?? ""), value: String(args[1] ?? "") };
                } else if (this.majorMode === "org-mode" && command === "emacs-operator-org-insert-table") {
                  const headers = Array.isArray(args[0]) ? args[0].map(String) : [];
                  const rows = Array.isArray(args[1]) ? args[1] as unknown[][] : [];
                  const prefix = this.point > 1 && this.text[this.point - 2] !== "\n" ? "\n" : "";
                  const lines = [
                    `| ${headers.join(" | ")} |`,
                    `|${headers.map(() => "---").join("+")}|`,
                    ...rows.map((row) => `| ${(Array.isArray(row) ? row : []).map(String).join(" | ")} |`)
                  ];
                  const value = `${prefix}${lines.join("\n")}\n`;
                  const start = this.point + prefix.length;
                  this.insertAtPoint(value);
                  const end = start + value.length - prefix.length;
                  this.point = start;
                  returnValue = { start, table: { bounds: [start, end], dimensions: [rows.length + 1, headers.length] } };
                  mutated = true;
                } else if (this.majorMode === "org-mode" && command === "emacs-operator-org-insert-src-block") {
                  const language = String(args[0] ?? "emacs-lisp");
                  const body = String(args[1] ?? "");
                  const headers = String(args[2] ?? "");
                  const prefix = this.point > 1 && this.text[this.point - 2] !== "\n" ? "\n" : "";
                  const header = `#+begin_src ${language}${headers ? ` ${headers}` : ""}\n`;
                  const value = `${prefix}${header}${body}${body.endsWith("\n") || body.length === 0 ? "" : "\n"}#+end_src\n`;
                  const start = this.point + prefix.length;
                  this.insertAtPoint(value);
                  const end = start + value.length - prefix.length;
                  this.point = start + header.length;
                  returnValue = { bounds: [start, end], babel: { language } };
                  mutated = true;
                }
                this.bump(mutated);
                respond({
                  executed: true,
                  command,
                  return_value: returnValue,
                  target: this.target(),
                  adapter_verification: this.majorMode === "org-mode" ? { org: { parse_valid: true } } : { lisp: { balanced: true } }
                });
                break;
              }
              case "refactor.project_rename": {
                const action = request.params?.action;
                if (action === "plan") {
                  const oldSymbol = String(request.params?.old_symbol ?? "");
                  const newSymbol = String(request.params?.new_symbol ?? "");
                  const requestedNewSymbol = String(request.params?.requested_new_symbol ?? newSymbol);
                  const language = String(request.params?.language ?? "generic");
                  const qualificationPolicy = String(request.params?.qualification_policy ?? "exact");
                  const symbolSemantics = request.params?.symbol_semantics && typeof request.params.symbol_semantics === "object" ? request.params.symbol_semantics : {};
                  const matches = [...this.text.matchAll(new RegExp(`\\b${oldSymbol.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "g"))];
                  const planId = `plan_fake_${this.renamePlans.size + 1}`;
                  this.renamePlans.set(planId, { oldSymbol, newSymbol, requestedNewSymbol, language, qualificationPolicy, symbolSemantics, original: this.text });
                  respond({ plan_id: planId, old_symbol: oldSymbol, requested_new_symbol: requestedNewSymbol, new_symbol: newSymbol, language, qualification_policy: qualificationPolicy, symbol_semantics: symbolSemantics, total_edits: matches.length, files: [{ path: path.basename(this.selectedFile), edits: matches.map((m) => ({ start: (m.index ?? 0) + 1, end: (m.index ?? 0) + 1 + oldSymbol.length, old_text: oldSymbol, new_text: newSymbol })) }] });
                } else if (action === "preview") {
                  const plan = this.renamePlans.get(String(request.params?.plan_id ?? ""));
                  if (!plan) { fail("E_COMMAND_FAILED", "unknown fake rename plan"); break; }
                  respond({ plan_id: request.params?.plan_id, old_symbol: plan.oldSymbol, requested_new_symbol: plan.requestedNewSymbol, new_symbol: plan.newSymbol, language: plan.language, qualification_policy: plan.qualificationPolicy, symbol_semantics: plan.symbolSemantics, total_edits: (plan.original.match(new RegExp(`\\b${plan.oldSymbol}\\b`, "g")) ?? []).length, returned_edits: 1, truncated: false, files: [{ path: path.basename(this.selectedFile), edits: [{ line: 1, column: 1, before: plan.original.trimEnd(), after: plan.original.replace(plan.oldSymbol, plan.newSymbol).trimEnd(), old_text: plan.oldSymbol, new_text: plan.newSymbol }] }] });
                } else if (action === "apply") {
                  const planId = String(request.params?.plan_id ?? "");
                  const plan = this.renamePlans.get(planId);
                  if (!plan) { fail("E_COMMAND_FAILED", "unknown fake rename plan"); break; }
                  if (this.text !== plan.original) { fail("E_STATE_CONFLICT", "stale fake rename plan"); break; }
                  const applied = this.text.split(plan.oldSymbol).join(plan.newSymbol);
                  const journalId = `rj_fake_${this.renameJournals.size + 1}`;
                  this.renameJournals.set(journalId, { original: this.text, applied });
                  this.text = applied; this.renamePlans.delete(planId); this.bump();
                  respond({ status: "applied_to_buffers", plan_id: planId, journal_id: journalId, saved: false, total_edits: 1, changed_buffers: [path.basename(this.selectedFile)] });
                } else if (action === "status") {
                  const journalId = String(request.params?.journal_id ?? "");
                  const journal = this.renameJournals.get(journalId);
                  if (!journal) { fail("E_TRANSACTION_NOT_FOUND", "unknown fake rename journal"); break; }
                  respond({ status: "open", journal_id: journalId, saved: false, entries: [{ file: this.selectedFile, original_sha256: "fake-original", applied_sha256: `fake-source-${this.tick}` }] });
                } else if (action === "rollback") {
                  const journalId = String(request.params?.journal_id ?? "");
                  const journal = this.renameJournals.get(journalId);
                  if (!journal) { fail("E_TRANSACTION_NOT_FOUND", "unknown fake rename journal"); break; }
                  if (this.text !== journal.applied) { fail("E_STATE_CONFLICT", "fake rollback conflict"); break; }
                  this.text = journal.original; this.renameJournals.delete(journalId); this.bump();
                  respond({ status: "rolled_back", journal_id: journalId, saved: false, changed_buffers: [path.basename(this.selectedFile)] });
                } else if (action === "commit") {
                  const journalId = String(request.params?.journal_id ?? "");
                  if (!this.renameJournals.delete(journalId)) { fail("E_TRANSACTION_NOT_FOUND", "unknown fake rename journal"); break; }
                  respond({ status: "committed", journal_id: journalId });
                } else {
                  fail("E_INVALID_ARGUMENT", "unsupported fake project rename action");
                }
                break;
              }
              case "adapter.analyze": {
                const adapter = request.params?.adapter ?? (this.majorMode === "org-mode" ? "org" : "lisp");
                const operation = request.params?.operation;
                if (adapter !== "lisp") {
                  fail("E_COMMAND_NOT_FOUND", `unsupported fake analysis ${String(adapter)}:${String(operation)}`);
                  break;
                }
                if (operation === "infer_extract_parameters") {
                  const bounds = Array.isArray(request.params?.params?.bounds) ? request.params.params.bounds : [1, this.text.length + 1];
                  const unresolved = this.text.includes("UNRESOLVED_ANALYSIS") ? ["mystery"] : [];
                  respond({
                    operation,
                    analysis: { adapter: "lisp", analysis: { parameters: ["x"], unresolved, confidence: unresolved.length ? "medium" : "high", bounds, source_sha256: `fake-source-${this.tick}` } },
                    buffer_id: "buf_fake", buffer_tick: this.tick
                  });
                } else if (operation === "evaluation_source_fingerprint") {
                  const evaluationOperation = String(request.params?.params?.evaluation_operation ?? "");
                  const sourceStart = evaluationOperation === "eval_defun" ? 1 : this.point;
                  respond({
                    operation,
                    analysis: { adapter: "lisp", analysis: {
                      operation: evaluationOperation, source_start: sourceStart, source_bounds: [sourceStart, Math.max(sourceStart + 1, this.text.length + 1)],
                      source_sha256: `fake-source-${this.tick}`, source_bytes: Buffer.byteLength(this.text, "utf8")
                    } },
                    buffer_id: "buf_fake", buffer_tick: this.tick
                  });
                } else {
                  fail("E_COMMAND_NOT_FOUND", `unsupported fake analysis ${String(adapter)}:${String(operation)}`);
                }
                break;
              }
              case "adapter.validate": {
                const adapter = request.params?.adapter ?? (this.majorMode === "org-mode" ? "org" : "lisp");
                const validation = adapter === "org"
                  ? { valid: true, parse_valid: true, diagnostics: [], document_summary: { counts: { headings: (this.text.match(/^\*+ /gm) ?? []).length, tables: this.text.includes("| ---") || this.text.includes("|---") ? 1 : 0, src_blocks: (this.text.match(/^#\+begin_src /gmi) ?? []).length } } }
                  : { valid: true, balanced: true, diagnostics: [] };
                respond({
                  valid: true, adapter, validations: { [adapter]: validation },
                  buffer_id: "buf_fake", buffer_tick: this.tick
                });
                break;
              }
              case "adapter.eval":
                this.checkPrecondition(request.params?.precondition, fail);
                if (request.params?.code) {
                  fail("E_POLICY_DENIED", "source-string eval disabled");
                } else {
                  const failing = this.text.includes("(/ x 0)") || this.text.includes("FAIL_EVAL");
                  respond({
                    executed: true,
                    operation: request.params?.operation,
                    evaluation: {
                      adapter: request.params?.operation === "execute_babel" ? "org" : "lisp",
                      result: {
                        value: failing ? null : (request.params?.operation === "execute_babel" ? "42" : "3"),
                        stdout: "", stderr: failing ? "arithmetic error" : "", condition: failing ? "arith-error" : null, completed: !failing,
                        metadata: request.params?.operation === "execute_babel"
                          ? { language: "emacs-lisp", source_sha256: `fake-source-${this.tick}` }
                          : {
                              source_start: request.params?.operation === "eval_defun" ? 1 : this.point,
                              source_bounds: [request.params?.operation === "eval_defun" ? 1 : this.point, Math.max((request.params?.operation === "eval_defun" ? 1 : this.point) + 1, this.text.length + 1)],
                              source_sha256: `fake-source-${this.tick}`, source_bytes: Buffer.byteLength(this.text, "utf8")
                            }
                      }
                    }
                  });
                }
                break;
              case "checkpoint.create":
                this.checkpoint = this.text;
                respond({ checkpoint_id: "chk_fake", buffer_tick: this.tick });
                break;
              case "checkpoint.commit":
                this.checkpoint = undefined;
                respond({ checkpoint_id: "chk_fake", committed: true });
                break;
              case "checkpoint.rollback":
                if (this.checkpoint === undefined) {
                  fail("E_TRANSACTION_NOT_FOUND", "missing checkpoint");
                } else {
                  this.text = this.checkpoint;
                  this.checkpoint = undefined;
                  this.bump();
                  respond({ checkpoint_id: "chk_fake", rolled_back: true });
                }
                break;
              case "wait.condition":
                respond({ satisfied: true, state_seq: this.stateSeq });
                break;
              default:
                fail("E_COMMAND_NOT_FOUND", `unknown method ${request.method}`);
            }
          } catch (error) {
            fail("E_INTERNAL", error instanceof Error ? error.message : String(error));
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const record = {
      protocol_version: "1.0",
      instance_id: this.instanceId,
      pid: this.instancePid,
      host: "127.0.0.1",
      port,
      token_file: this.tokenFile,
      emacs_version: "fake-31.0",
      system_type: process.platform,
      window_system: this.options.nativePid ? "x" : null,
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      daemon: !this.options.nativePid,
      gui_frame_count: this.options.nativePid ? 1 : 0,
      available_adapters: ["generic"]
    };
    fs.writeFileSync(this.instanceFile, JSON.stringify(record), { mode: 0o600 });
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server.close(() => resolve()));
    fs.rmSync(this.runtimeDir, { recursive: true, force: true });
  }

  currentText(): string { return this.text; }
  currentTick(): number { return this.tick; }

  private describe(): Record<string, unknown> {
    return {
      protocol_version: "1.0",
      channels: { semantic: true, internal_keys: true, native_keys: false },
      features: { transactions: "single_buffer_snapshot", adapter_registry: true, structured_eval: true, org_adapter: false, paredit: false },
      instance: { instance_id: this.instanceId, pid: this.instancePid }
    };
  }

  private target(): Record<string, unknown> {
    return {
      frame_id: "frm_fake",
      frame_title: this.options.frameTitle ?? "fake.el - GNU Emacs",
      native_window_identifier: this.options.nativeWindowIdentifier ?? "4242",
      window_id: "win_fake",
      buffer_id: "buf_fake",
      buffer_name: path.basename(this.selectedFile),
      file: this.selectedFile,
      project_root: this.runtimeDir,
      major_mode: this.majorMode
    };
  }

  private observe(): Record<string, unknown> {
    return {
      state_seq: this.stateSeq,
      buffer: {
        id: "buf_fake",
        name: path.basename(this.selectedFile),
        file: this.selectedFile,
        project_root: this.runtimeDir,
        size: this.text.length,
        point_min: 1,
        point_max: this.text.length + 1,
        major_mode: this.majorMode,
        buffer_tick: this.tick,
        modified: true
      },
      cursor: { point: this.point, line: 1, column: this.point - 1 },
      context: { before: "", after: this.text.slice(0, 256) },
      interaction: {
        minibuffer_active: false,
        ...(this.externalCommand() ? { last_command: this.externalCommand() } : {})
      },
      ...(this.externalCommand() ? { recent_commands: [{ command: this.externalCommand() }] } : {})
    };
  }

  private externalCommand(): string | undefined {
    const file = this.options.externalCommandFile;
    if (!file) return undefined;
    try {
      const value = fs.readFileSync(file, "utf8").trim();
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private capabilities(params: any): Record<string, unknown> {
    if (params?.operation === "resolve_key") return { key: params.key, bound: true, command: "fake-command", interactive: true };
    if (params?.operation === "check_feature") return { feature: params.feature, loaded: false };
    if (params?.operation === "list_adapters") return { adapters: [this.majorMode === "org-mode" ? "org" : "lisp", "generic"] };
    if (params?.operation === "adapter_capabilities") return { adapters: [{ name: this.majorMode === "org-mode" ? "org" : "lisp", capabilities: { operations: [] } }, { name: "generic", capabilities: { operations: [] } }] };
    if (params?.operation === "adapter_observe") return this.majorMode === "org-mode"
      ? { adapters: { org: { parse_valid: true, heading: this.currentOrgHeading() ? { title: this.currentOrgHeading()!.title, level: this.currentOrgHeading()!.level } : null }, generic: { major_mode: this.majorMode } } }
      : { adapters: { lisp: { balanced: true, defun_bounds: [1, this.text.length + 1], defun_name: "fake-defun" }, generic: { major_mode: this.majorMode } } };
    return { major_mode: this.majorMode };
  }

  private currentOrgHeading(): { start: number; lineEnd: number; level: number; title: string; tags: string } | null {
    const upto = this.text.slice(0, Math.max(0, this.point - 1));
    const regex = /^(\*+)\s+(.+)$/gm;
    let match: RegExpExecArray | null;
    let found: RegExpExecArray | null = null;
    while ((match = regex.exec(upto)) !== null) found = match;
    if (!found) {
      regex.lastIndex = 0;
      found = regex.exec(this.text);
    }
    if (!found || found.index === undefined) return null;
    const raw = found[2]!;
    const tagMatch = raw.match(/\s+(:[^:\s]+(?::[^:\s]+)*:)\s*$/);
    const tags = tagMatch ? tagMatch[1]! : "";
    const title = tagMatch && tagMatch.index !== undefined ? raw.slice(0, tagMatch.index).trim() : raw.trim();
    return { start: found.index, lineEnd: found.index + found[0]!.length, level: found[1]!.length, title, tags };
  }

  private insertAtPoint(value: string): void {
    const index = Math.max(0, Math.min(this.text.length, this.point - 1));
    this.text = this.text.slice(0, index) + value + this.text.slice(index);
    this.point = index + value.length + 1;
  }

  private checkPrecondition(precondition: any, fail: (code: string, message: string, details?: Record<string, unknown>) => void): void {
    if (precondition?.expected_buffer_tick !== undefined && precondition.expected_buffer_tick !== this.tick) {
      fail("E_STATE_CONFLICT", "tick changed", { expected_buffer_tick: precondition.expected_buffer_tick, actual_buffer_tick: this.tick });
      throw new Error("__already_replied__");
    }
  }

  private bump(mutate = true): void {
    this.stateSeq += 1;
    if (mutate) this.tick += 1;
  }
}
