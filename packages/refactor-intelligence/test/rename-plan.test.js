import test from "node:test"; import assert from "node:assert/strict"; import {mkdtemp,writeFile,readFile} from "node:fs/promises"; import os from "node:os"; import path from "node:path";
import {createProjectRenamePlan,applyRenamePlanToMap,applyRenamePlanToFilesystem,validateRenamePlan} from "../src/index.js";
test("plan is immutable and skips strings comments and qualified symbols",()=>{const root='/tmp/project';const content='(foo foo/bar "foo") ; foo\n(foo)';const plan=createProjectRenamePlan({root,files:[{path:'/tmp/project/a.el',content}],oldSymbol:'foo',newSymbol:'bar'});assert.equal(plan.total_edits,2);assert.equal(validateRenamePlan(plan),true);const out=applyRenamePlanToMap(plan,new Map([["a.el",content]])).get('a.el');assert.equal(out,'(bar foo/bar "foo") ; foo\n(bar)');});
test("tampered plan is rejected",()=>{const p=createProjectRenamePlan({root:'/tmp/p',files:[{path:'/tmp/p/a.el',content:'(foo)'}],oldSymbol:'foo',newSymbol:'bar'});p.files[0].edits[0].new_text='zap';assert.throws(()=>validateRenamePlan(p));});
test("stale content is rejected before apply",()=>{const p=createProjectRenamePlan({root:'/tmp/p',files:[{path:'/tmp/p/a.el',content:'(foo)'}],oldSymbol:'foo',newSymbol:'bar'});assert.throws(()=>applyRenamePlanToMap(p,new Map([["a.el",'(foo 1)']])));});
test("filesystem apply preflights and writes",async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'eo-a9-'));const file=path.join(root,'a.el');await writeFile(file,'(foo)');const p=createProjectRenamePlan({root,files:[{path:file,content:'(foo)'}],oldSymbol:'foo',newSymbol:'bar'});const r=await applyRenamePlanToFilesystem(p);assert.equal(r.status,'applied');assert.equal(await readFile(file,'utf8'),'(bar)');});

test("language-aware plan preserves Clojure qualification with leaf-only policy",()=>{
  const root='/tmp/project';
  const content='(app.calc/sum 1 2) :app.calc/sum "app.calc/sum" ; app.calc/sum\n(other/sum 1 2)';
  const plan=createProjectRenamePlan({root,files:[{path:'/tmp/project/core.clj',content}],oldSymbol:'app.calc/sum',newSymbol:'add',language:'clojure',qualificationPolicy:'leaf_only'});
  assert.equal(plan.new_symbol,'app.calc/add');
  assert.equal(plan.total_edits,1);
  const out=applyRenamePlanToMap(plan,new Map([["core.clj",content]])).get('core.clj');
  assert.equal(out,'(app.calc/add 1 2) :app.calc/sum "app.calc/sum" ; app.calc/sum\n(other/sum 1 2)');
});

test("language-aware plan rejects package qualification drift",()=>{
  assert.throws(()=>createProjectRenamePlan({root:'/tmp/p',files:[{path:'/tmp/p/a.lisp',content:'(math:sum 1 2)'}],oldSymbol:'math:sum',newSymbol:'math::add',language:'common_lisp'}),(error)=>error?.code==='E_SYMBOL_QUALIFICATION_CHANGE');
});
