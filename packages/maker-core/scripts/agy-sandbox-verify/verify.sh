#!/usr/bin/env bash
# verify.sh MODE   MODE = baseline | landlock-only | bwrap | full | module
#
# Decoy check (cindy#1, QQ pre-review 6908837891). Decoys outside the task dir
# carry one-time canaries; sha256/size/mode/mtime/ctime/atime are recorded
# before and after; output, task dir and state dir are searched for canaries;
# fake_agy.py logs one JSON line per escape attempt. No model, no account,
# no real agy.
#
#   baseline       no sandbox (shows the checks catch leaks)
#   landlock-only  landlock_exec.py alone          (prototype)
#   bwrap          agy-sandbox.sh --no-landlock    (prototype, host network)
#   full           agy-sandbox.sh                  (prototype, host network)
#   module         system-sandbox.ts via run-module.ts: pasta + bwrap, the
#                  implementation in packages/maker-core/src/agents/agy
#
# Env: AGY_VERIFY_ROOT (default: a new dir under $TMPDIR)
#      AGY_SANDBOX_TEST_PASTA (pasta binary for module mode if not in /usr/bin)
#      CINDY_PORTS (space-separated host-loopback ports that must be unreachable;
#                   default: ports owned by a process named "Cindy" per `ss -ltnp`)
set -uo pipefail
MODE=${1:?mode}
P=$(cd "$(dirname "$0")" && pwd)
ROOT=${AGY_VERIFY_ROOT:-$(mktemp -d "${TMPDIR:-/tmp}/agy-verify-XXXXXX")}
R=$ROOT/runs/$MODE
rm -rf "$R"; mkdir -p "$R"/{task,state,outside/secrets,outside/other-task}
cd "$R"
if [[ -z "${CINDY_PORTS+x}" ]]; then
  CINDY_PORTS="$(ss -ltnp 2>/dev/null | awk '/"Cindy"/{n=split($4,a,":"); print a[n]}' | head -3 | tr '\n' ' ')"
fi
export CINDY_PORTS

can() { echo "CANARY-$MODE-$1-$(head -c6 /dev/urandom | od -An -tx1 | tr -d ' \n')"; }
printf '[default]\naws_access_key_id = AKIAFAKE%s\naws_secret_access_key = %s\n' "$RANDOM" "$(can aws)" > outside/secrets/fake_aws_credentials
printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\n%s\n-----END OPENSSH PRIVATE KEY-----\n' "$(can ssh)" > outside/secrets/id_ed25519_fake
printf '# other task notes\n%s\n' "$(can doc)" > outside/other-task/notes.md
printf 'link target %s\n' "$(can link)" > outside/link-decoy.txt
chmod 600 outside/secrets/*
grep -rhoE 'CANARY-[A-Za-z0-9-]+' outside > canaries.txt
sleep 1   # make any later atime/mtime update visible

PORT=47123
python3 -m http.server --bind 127.0.0.1 $PORT >/dev/null 2>&1 & LP=$!
sleep 0.5

O=$R/outside
python3 - "$R" "$O" "$$" "$PORT" "$HOME" <<'EOF'
import json, os, sys
r, o, pid, port, h = sys.argv[1:]
json.dump({
 "decoys": [o + "/secrets/fake_aws_credentials", o + "/secrets/id_ed25519_fake", o + "/other-task/notes.md"],
 "link_decoy": o + "/link-decoy.txt",
 "outside_write": [o + "/new-file.txt", o + "/other-task/planted.md", r + "/new-dir-sibling-of-task.txt"],
 "real_sensitive": [h + "/.ssh", h + "/.gemini/antigravity-cli/conversations", h + "/.cindy",
   h + "/.agentdex-arena-oauth-app", h + "/.bash_history", h + "/.config/gh", h + "/build",
   h + "/.local/bin/claude", "/run/user/1000/bus", "/var/run/docker.sock", "/etc/ssh", "/etc/shadow"],
 "host_pid": int(pid), "probe_port": int(port),
 "cindy_ports": [int(x) for x in os.environ.get("CINDY_PORTS", "").split()]}, open(r + "/task/probe-plan.json", "w"), indent=1)
EOF

manifest() {
  python3 - "$O" <<'EOF'
import hashlib, json, os, sys
out = {}
for d, _, fs in os.walk(sys.argv[1]):
    for f in fs:
        p = os.path.join(d, f); s = os.lstat(p)
        out[p] = {"sha256": hashlib.sha256(open(p, "rb").read()).hexdigest() if os.path.isfile(p) else None,
                  "size": s.st_size, "mode": oct(s.st_mode), "mtime_ns": s.st_mtime_ns,
                  "ctime_ns": s.st_ctime_ns, "atime_ns": s.st_atime_ns}
print(json.dumps(out, indent=1, sort_keys=True))
EOF
}
manifest > manifest-before.json
SIBLING=$R/new-dir-sibling-of-task.txt; rm -f "$SIBLING"

STUB=$P/fake_agy.py
MAKER_CORE=$(cd "$P/../.." && pwd)
T0=$(date +%s%N)
case $MODE in
  baseline)      (cd task && "$STUB") ;;
  landlock-only) (cd task && python3 -I "$P/landlock_exec.py" --ro /usr --ro /etc --ro /bin --ro /lib --ro /lib64 \
                    --ro /proc --ro "$STUB" --rw "$R/task" --rw /tmp --rw /dev/null -- "$STUB") ;;
  bwrap)         "$P/agy-sandbox.sh" --no-landlock --task-dir task --state-dir state --agy "$STUB" ;;
  full)          "$P/agy-sandbox.sh" --task-dir task --state-dir state --agy "$STUB" ;;
  module)        (cd "$MAKER_CORE" && npx tsx "$P/run-module.ts" "$R/task" "$R/state" "$STUB") ;;
  *) echo "unknown mode $MODE" >&2; exit 2 ;;
esac > stdout.jsonl 2> stderr.txt
RC=$?
T1=$(date +%s%N)
kill $LP 2>/dev/null
manifest > manifest-after.json

python3 - "$R" "$MODE" "$RC" "$(( (T1-T0)/1000000 ))" "$SIBLING" <<'EOF'
import json, os, subprocess, sys
r, mode, rc, ms, sibling = sys.argv[1:]
b = json.load(open(r + "/manifest-before.json")); a = json.load(open(r + "/manifest-after.json"))
diff = []
for p in sorted(set(b) | set(a)):
    if p not in a: diff.append({"path": p, "change": "missing"}); continue
    if p not in b: diff.append({"path": p, "change": "new"}); continue
    ch = [k for k in ("sha256", "size", "mode", "mtime_ns", "ctime_ns", "atime_ns") if a[p][k] != b[p][k]]
    if ch: diff.append({"path": p, "change": ",".join(ch)})
canaries = open(r + "/canaries.txt").read().split()
leak = {}
for where in ("stdout.jsonl", "stderr.txt"):
    txt = open(os.path.join(r, where), errors="replace").read()
    leak[where] = [c for c in canaries if c in txt]
for where in ("task", "state"):
    hits = subprocess.run(["grep", "-rlF", "-e", "\n".join(canaries), os.path.join(r, where)],
                          capture_output=True, text=True).stdout.split()
    leak[where + "/"] = hits
res = [json.loads(l) for l in open(r + "/stdout.jsonl") if l.startswith("{")]
summary = {"mode": mode, "exit": int(rc), "wall_ms": int(ms),
           "attempts": len(res), "succeeded": [x["id"] for x in res if x["ok"]],
           "outside_changes": diff, "canary_leaks": leak,
           "sibling_write_created": os.path.exists(sibling)}
if os.path.exists(sibling): os.unlink(sibling)
json.dump(summary, open(r + "/summary.json", "w"), indent=1, ensure_ascii=False)
print(json.dumps(summary, ensure_ascii=False, indent=1))
EOF
