import {scanLisp, sha256} from "./scanner.js";

const SPECIAL = new Set([
  "defun","defmacro","lambda","let","let*","setq","setf","if","when","unless","cond","progn","prog1","prog2",
  "and","or","while","catch","throw","unwind-protect","condition-case","save-excursion","save-restriction","quote","function",
  "fn","defn","defn-","defmacro-","loop","recur","doseq","dotimes","for","binding","with-open","letfn","do","case","try","catch","finally",
  "nil","t","true","false","&optional","&rest","&key","&aux","&body","&environment","_"
]);

function isCandidate(value) {
  return !SPECIAL.has(value) && !value.startsWith(":") && !value.includes("/") && !value.startsWith("#") && !value.startsWith(".");
}

function buildTree(tokens) {
  const root = {kind:"root", children:[], start:0, end:0};
  const stack = [root];
  const openToKind = {"(":"list","[":"vector","{":"map"};
  const closeToOpen = {")":"(", "]":"[", "}":"{"};
  for (const token of tokens) {
    if (token.type === "delimiter" && openToKind[token.value]) {
      const node={kind:openToKind[token.value], opener:token.value, children:[], start:token.start, end:token.end, parent:stack.at(-1)};
      stack.at(-1).children.push(node); stack.push(node); continue;
    }
    if (token.type === "delimiter" && closeToOpen[token.value]) {
      if (stack.length > 1) { const node=stack.pop(); node.end=token.end; node.closer=token.value; }
      continue;
    }
    stack.at(-1).children.push({kind:"atom", token, start:token.start, end:token.end, parent:stack.at(-1)});
  }
  root.end=tokens.at(-1)?.end ?? 0;
  return root;
}

function atomValue(node) { return node?.kind === "atom" && node.token.type === "symbol" ? node.token.value : null; }

function collectPattern(node, out, unresolved) {
  if (!node) return;
  if (node.kind === "atom") {
    const value=atomValue(node);
    if (value && isCandidate(value)) out.add(value);
    return;
  }
  if (node.kind === "vector" || node.kind === "list") {
    for (const child of node.children) collectPattern(child,out,unresolved);
    return;
  }
  if (node.kind === "map") unresolved.add("destructuring-map");
}

function bindingsIntroduced(node) {
  const bound=new Set(); const unresolved=new Set();
  if (node?.kind !== "list" || node.children.length === 0) return {bound,unresolved};
  const head=atomValue(node.children[0]);
  if (["lambda","fn"].includes(head)) collectPattern(node.children[1],bound,unresolved);
  if (["defun","defmacro","defn","defn-","defmacro-"].includes(head)) collectPattern(node.children[2],bound,unresolved);
  if (["let","let*","loop","binding","with-open","doseq","for"].includes(head)) {
    const bindings=node.children[1];
    if (bindings?.kind === "vector") {
      for (let i=0;i<bindings.children.length;i+=2) collectPattern(bindings.children[i],bound,unresolved);
    } else if (bindings?.kind === "list") {
      for (const pair of bindings.children) {
        if (pair.kind === "list") collectPattern(pair.children[0],bound,unresolved);
        else unresolved.add("unrecognized-binding-form");
      }
    }
  }
  return {bound,unresolved};
}

function findContainingPath(node, start, end, path=[]) {
  if (node.start > start || node.end < end) return null;
  const next=[...path,node];
  for (const child of node.children ?? []) {
    if (child.kind !== "atom") {
      const found=findContainingPath(child,start,end,next);
      if (found) return found;
    }
  }
  return next;
}

function bindingsVisibleAtSelection(tree,start,end) {
  const path=findContainingPath(tree,start,end) ?? [tree];
  const bound=new Set(); const unresolved=new Set();
  for (const node of path) {
    const introduced=bindingsIntroduced(node);
    for (const name of introduced.bound) bound.add(name);
    for (const issue of introduced.unresolved) unresolved.add(issue);
  }
  return {bound,unresolved,path};
}

function collectLocallyBound(node, out, unresolved) {
  if (!node || node.kind === "atom") return;
  const introduced=bindingsIntroduced(node);
  for (const name of introduced.bound) out.add(name);
  for (const issue of introduced.unresolved) unresolved.add(issue);
  for (const child of node.children ?? []) collectLocallyBound(child,out,unresolved);
}

function isFunctionHead(node) {
  const parent=node.parent;
  return parent?.kind === "list" && parent.children[0] === node;
}

function isQuoted(node) {
  const siblings=node.parent?.children ?? [];
  const index=siblings.indexOf(node);
  if (index > 0) {
    const previous=siblings[index-1];
    return previous?.kind === "atom" && previous.token.type === "delimiter" && ["'","`"].includes(previous.token.value);
  }
  return false;
}

export function inferExtractParameters({source, selectionStart=0, selectionEnd=source?.length ?? 0, knownBindings=[]}={}) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  if (!Number.isInteger(selectionStart) || !Number.isInteger(selectionEnd) || selectionStart < 0 || selectionEnd < selectionStart || selectionEnd > source.length) {
    throw new RangeError("invalid selection bounds");
  }
  const scanned=scanLisp(source);
  const tree=buildTree(scanned.tokens);
  const visible=bindingsVisibleAtSelection(tree,selectionStart,selectionEnd);
  for (const name of knownBindings) visible.bound.add(name);
  const selectedTokens=scanned.tokens.filter((t)=>t.start>=selectionStart && t.end<=selectionEnd);
  const selectedTree=buildTree(selectedTokens);
  const localBound=new Set(); const structuralUnresolved=new Set(visible.unresolved);
  collectLocallyBound(selectedTree,localBound,structuralUnresolved);
  const parameters=[]; const unresolved=[]; const seenParams=new Set(); const seenUnresolved=new Set();
  const walk=(node)=>{
    if (node.kind === "atom") {
      const value=atomValue(node);
      if (!value || !isCandidate(value) || isFunctionHead(node) || isQuoted(node) || localBound.has(value)) return;
      if (visible.bound.has(value)) {
        if (!seenParams.has(value)) { seenParams.add(value); parameters.push(value); }
      } else if (!seenUnresolved.has(value)) {
        seenUnresolved.add(value); unresolved.push(value);
      }
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(selectedTree);
  for (const issue of structuralUnresolved) if (!seenUnresolved.has(issue)) unresolved.push(issue);
  const conservativeDiagnostics=[...scanned.diagnostics];
  const confidence=unresolved.length===0 && conservativeDiagnostics.length===0 ? "high" : parameters.length>0 ? "medium" : "low";
  return {
    parameters,
    unresolved,
    confidence,
    selection:{start:selectionStart,end:selectionEnd},
    source_sha256:sha256(source.slice(selectionStart,selectionEnd)),
    diagnostics:conservativeDiagnostics
  };
}
