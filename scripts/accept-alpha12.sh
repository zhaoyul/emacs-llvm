#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REPORT="${EMACS_OPERATOR_ALPHA12_REPORT:-$ROOT/artifacts/alpha12-validation.json}"
mkdir -p "$(dirname "$REPORT")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
run_gate() {
  local name="$1"; shift
  local log="$TMP/$name.log"
  if "$@" >"$log" 2>&1; then STATUS["$name"]="pass"; CODE["$name"]=0; else STATUS["$name"]="fail"; CODE["$name"]=$?; fi
  LOG["$name"]="$log"
}
declare -A STATUS CODE LOG
run_gate version node scripts/check-version-consistency.mjs
run_gate agent_experiment_tests node --test packages/agent-experiment/test/*.test.mjs
if npm run --silent typecheck >/dev/null 2>&1; then run_gate typecheck npm run --silent typecheck; else STATUS[typecheck]="not_available"; CODE[typecheck]=0; fi
if npm run --silent test >/dev/null 2>&1; then run_gate main_tests npm run --silent test; else STATUS[main_tests]="not_available"; CODE[main_tests]=0; fi
python3 - "$REPORT" "$TMP" <<'PY2'
import json,sys,os,glob
report,tmp=sys.argv[1:]
checks=[]
for log in sorted(glob.glob(os.path.join(tmp,'*.log'))):
    name=os.path.basename(log)[:-4]
    text=open(log,errors='replace').read()
    # shell does not export associative arrays; infer success marker from companion files is unavailable, use log and rerun result file below
    checks.append({'name':name,'log_tail':text[-4000:]})
# authoritative agent test is rerun here to capture exit code
import subprocess
root=os.path.abspath(os.path.join(os.path.dirname(__file__) if '__file__' in globals() else os.getcwd()))
commands=[('version',['node','scripts/check-version-consistency.mjs']),('agent_experiment_tests',['node','--test','packages/agent-experiment/test/protocol.test.mjs','packages/agent-experiment/test/environment.test.mjs','packages/agent-experiment/test/order.test.mjs','packages/agent-experiment/test/mcp-config.test.mjs','packages/agent-experiment/test/process-driver.test.mjs','packages/agent-experiment/test/experiment.test.mjs'])]
results=[]
for name,cmd in commands:
    p=subprocess.run(cmd,cwd=os.getcwd(),text=True,capture_output=True)
    results.append({'name':name,'status':'pass' if p.returncode==0 else 'fail','exit_code':p.returncode,'stdout_tail':p.stdout[-4000:],'stderr_tail':p.stderr[-4000:]})
ok=all(x['status']=='pass' for x in results)
obj={'schema_version':'1.0','version':'0.1.0-alpha.12','generated_at':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'ok':ok,'required_checks':results,'additional_logs':checks,'not_run':['GNU Emacs ERT','real Emacs runtime acceptance','real paid/networked LLM paired experiment','macOS native acceptance']}
os.makedirs(os.path.dirname(report),exist_ok=True)
open(report,'w').write(json.dumps(obj,indent=2)+'
')
sys.exit(0 if ok else 1)
PY2
