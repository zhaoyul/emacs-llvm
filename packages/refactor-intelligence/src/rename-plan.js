import {promises as fs} from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {scanLisp, sha256} from "./scanner.js";
import {prepareSymbolRename} from "./symbol-semantics.js";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k)=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function normalizedRelative(root,filePath) {
  const abs=path.resolve(root,filePath);
  const rel=path.relative(path.resolve(root),abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`file is outside project root: ${filePath}`);
  return rel.split(path.sep).join("/");
}
function editsFor(content,oldSymbol,newSymbol) {
  const {tokens,diagnostics}=scanLisp(content);
  const edits=tokens.filter((t)=>t.type==="symbol" && t.value===oldSymbol).map((t)=>({
    start:t.start,end:t.end,line:t.line,column:t.column,old_text:oldSymbol,new_text:newSymbol
  }));
  return {edits,diagnostics};
}
export function createProjectRenamePlan({root,files,oldSymbol,newSymbol,language="generic",qualificationPolicy,limits={}}={}) {
  const semantics=prepareSymbolRename({oldSymbol,newSymbol,language,qualificationPolicy});
  const effectiveNewSymbol=semantics.effective_new_symbol;
  if (typeof root!=="string" || !path.isAbsolute(root)) throw new TypeError("root must be an absolute path");
  if (!Array.isArray(files)) throw new TypeError("files must be an array");
  const maxFiles=limits.maxFiles ?? 500; const maxBytes=limits.maxBytes ?? 16*1024*1024; const maxEdits=limits.maxEdits ?? 10000;
  if (files.length>maxFiles) throw new Error(`rename plan exceeds maxFiles=${maxFiles}`);
  let totalBytes=0,totalEdits=0;
  const planned=[];
  for (const file of files) {
    if (!file || typeof file.path!=="string" || typeof file.content!=="string") throw new TypeError("each file requires path and content");
    const rel=normalizedRelative(root,file.path); totalBytes+=Buffer.byteLength(file.content,"utf8");
    if (totalBytes>maxBytes) throw new Error(`rename plan exceeds maxBytes=${maxBytes}`);
    const {edits,diagnostics}=editsFor(file.content,oldSymbol,effectiveNewSymbol); totalEdits+=edits.length;
    if (totalEdits>maxEdits) throw new Error(`rename plan exceeds maxEdits=${maxEdits}`);
    if (edits.length>0) planned.push({path:rel,sha256:sha256(file.content),bytes:Buffer.byteLength(file.content,"utf8"),edits,diagnostics});
  }
  planned.sort((a,b)=>a.path.localeCompare(b.path));
  const body={
    version:1,kind:"lisp_project_rename",root:path.resolve(root),
    language:semantics.language,qualification_policy:semantics.qualification_policy,
    old_symbol:oldSymbol,requested_new_symbol:newSymbol,new_symbol:effectiveNewSymbol,
    symbol_semantics:{old:semantics.old,new:semantics.new},
    files:planned,total_edits:totalEdits,
    limits:{max_files:maxFiles,max_bytes:maxBytes,max_edits:maxEdits}
  };
  return {...body,plan_id:sha256(canonical(body))};
}
export function validateRenamePlan(plan) {
  if (!plan || plan.version!==1 || plan.kind!=="lisp_project_rename") throw new Error("unsupported rename plan");
  const {plan_id,...body}=plan;
  if (sha256(canonical(body))!==plan_id) throw new Error("rename plan integrity check failed");
  for (const file of plan.files) {
    let previous=-1;
    for (const edit of file.edits) {
      if (!Number.isInteger(edit.start)||!Number.isInteger(edit.end)||edit.start<0||edit.end<=edit.start) throw new Error("invalid edit bounds");
      if (edit.start<previous) throw new Error("edits must be sorted and non-overlapping");
      previous=edit.end;
      if (edit.old_text!==plan.old_symbol||edit.new_text!==plan.new_symbol) throw new Error("edit does not match plan symbols");
    }
  }
  return true;
}
function applyEdits(content,file) {
  if (sha256(content)!==file.sha256) throw new Error(`stale file: ${file.path}`);
  let result=content;
  for (const edit of [...file.edits].sort((a,b)=>b.start-a.start)) {
    if (result.slice(edit.start,edit.end)!==edit.old_text) throw new Error(`stale edit at ${file.path}:${edit.line}:${edit.column}`);
    result=result.slice(0,edit.start)+edit.new_text+result.slice(edit.end);
  }
  return result;
}
export function applyRenamePlanToMap(plan,contents) {
  validateRenamePlan(plan);
  const output=new Map(contents instanceof Map ? contents : Object.entries(contents ?? {}));
  for (const file of plan.files) {
    if (!output.has(file.path)) throw new Error(`missing file content: ${file.path}`);
    output.set(file.path,applyEdits(output.get(file.path),file));
  }
  return output;
}
export async function applyRenamePlanToFilesystem(plan,{save=true}={}) {
  validateRenamePlan(plan);
  const root=await fs.realpath(plan.root);
  const originals=new Map(); const replacements=new Map();
  for (const file of plan.files) {
    const abs=path.resolve(root,file.path); const rel=path.relative(root,abs);
    if (rel.startsWith("..")||path.isAbsolute(rel)) throw new Error(`file escaped project root: ${file.path}`);
    const stat=await fs.lstat(abs); if (stat.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${file.path}`);
    const content=await fs.readFile(abs,"utf8"); originals.set(abs,content); replacements.set(abs,applyEdits(content,file));
  }
  if (!save) return {status:"preflight_ok",plan_id:plan.plan_id,files:[...replacements.keys()]};
  const written=[];
  try {
    for (const [abs,content] of replacements) {
      const temp=`${abs}.emacs-operator-${randomUUID()}.tmp`;
      await fs.writeFile(temp,content,{encoding:"utf8",mode:(await fs.stat(abs)).mode});
      await fs.rename(temp,abs); written.push(abs);
    }
  } catch (error) {
    for (const abs of written.reverse()) await fs.writeFile(abs,originals.get(abs),"utf8").catch(()=>{});
    throw error;
  }
  return {status:"applied",plan_id:plan.plan_id,files:written,total_edits:plan.total_edits};
}
