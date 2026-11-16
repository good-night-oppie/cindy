#!/usr/bin/env bash
# agy-sandbox.sh - run agy (or a stand-in) so it can only write the task dir.
#
#   agy-sandbox.sh --task-dir DIR --state-dir DIR [--agy BIN] [--no-landlock]
#                  [--no-net] [--extra-ro PATH]... -- [agy args...]
#
# Layer 1 (bubblewrap): new mount/pid/ipc/uts/cgroup/user namespaces. The
#   sandbox root is empty; only /usr, a few /etc files, the agy binary, the
#   task dir (rw, same absolute path) and a private agy state dir (rw, mounted
#   as $HOME/.gemini) are mapped in. $HOME is an empty tmpfs, /tmp is private,
#   env is cleared, all capabilities dropped.
# Layer 2 (Landlock, optional but on by default): kernel path rules applied
#   inside, so even a mount mistake in layer 1 does not open the host FS.
# Network is shared by default (agy must reach its API). See README for what
#   that leaves open.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
TASK= STATE= AGY="${AGY_BIN:-$HOME/.local/bin/agy}" LANDLOCK=1 NET=1
EXTRA_RO=()
die() { echo "agy-sandbox: $*" >&2; exit 125; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task-dir)  TASK=$2; shift 2 ;;
    --state-dir) STATE=$2; shift 2 ;;
    --agy)       AGY=$2; shift 2 ;;
    --no-landlock) LANDLOCK=0; shift ;;
    --no-net)    NET=0; shift ;;
    --extra-ro)  EXTRA_RO+=("$2"); shift 2 ;;
    --) shift; break ;;
    *) die "unknown option $1" ;;
  esac
done
[[ -n $TASK && -n $STATE ]] || die "--task-dir and --state-dir are required"
command -v bwrap >/dev/null || die "bubblewrap not installed - refusing to run unconfined"

TASK=$(realpath -e -- "$TASK") || die "task dir missing"
STATE=$(realpath -e -- "$STATE") || die "state dir missing"
AGY=$(realpath -e -- "$AGY") || die "agy binary missing"
H=$(realpath -e -- "$HOME")

# --- refuse task dirs that would expose too much -------------------------
case "$TASK" in
  /|/home|/root|/etc|/etc/*|/usr|/usr/*|/proc*|/sys*|/dev*|/run*|/var|/boot*|/tmp)
    die "refusing system path as task dir: $TASK" ;;
esac
[[ "$TASK" == "$H" ]] && die "refusing \$HOME as task dir"
[[ "$H/" == "$TASK/"* ]] && die "task dir contains \$HOME"
[[ "$STATE/" == "$TASK/"* || "$TASK/" == "$STATE/"* ]] && die "task dir and state dir must not overlap"
# A hard link inside the task dir shares the inode with a file outside it;
# writes through it would change the outside file. Refuse instead of guessing.
if hl=$(find "$TASK" -xdev -type f -links +1 -print -quit 2>/dev/null) && [[ -n $hl ]]; then
  die "task dir contains hard-linked file(s), e.g. $hl"
fi

# --- build bwrap argv ---------------------------------------------------
A=(--unshare-all --die-with-parent --new-session --cap-drop ALL
   --hostname agy-sandbox --clearenv)
[[ $NET == 1 ]] && A+=(--share-net)

A+=(--ro-bind /usr /usr --proc /proc --dev /dev --tmpfs /tmp --tmpfs /run)
for l in bin sbin lib lib64 lib32 libx32; do
  if [[ -L /$l ]]; then A+=(--symlink "$(readlink /$l)" /$l)
  elif [[ -d /$l ]]; then A+=(--ro-bind /$l /$l); fi
done
for f in hosts host.conf nsswitch.conf gai.conf passwd group localtime \
         ld.so.cache ld.so.conf ld.so.conf.d ssl ca-certificates \
         protocols services mime.types alternatives resolv.conf; do
  [[ -e /etc/$f ]] && A+=(--ro-bind "$(realpath /etc/$f)" /etc/$f)
done

# empty home with only the private agy state dir
A+=(--tmpfs /home)
[[ $H == /home/* ]] || A+=(--tmpfs "$(dirname "$H")")
A+=(--dir "$H" --bind "$STATE" "$H/.gemini")
A+=(--ro-bind "$AGY" "$AGY")
for p in "${EXTRA_RO[@]}"; do p=$(realpath -e -- "$p"); A+=(--ro-bind "$p" "$p"); done
A+=(--bind "$TASK" "$TASK" --chdir "$TASK")

A+=(--setenv HOME "$H" --setenv USER "$(id -un)" --setenv LOGNAME "$(id -un)"
    --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv TMPDIR /tmp
    --setenv LANG C.UTF-8 --setenv TERM "${TERM:-dumb}"
    --setenv AGY_SANDBOX_TASK_DIR "$TASK")

CMD=("$AGY" "$@")
if [[ $LANDLOCK == 1 ]]; then
  LL=/opt/agy-sandbox/landlock_exec.py
  A+=(--ro-bind "$HERE/landlock_exec.py" "$LL")
  RO=(/usr /etc /bin /sbin /lib /lib64 /proc "$AGY")
  for p in "${EXTRA_RO[@]}"; do RO+=("$(realpath -e -- "$p")"); done
  LLARGS=()
  for p in "${RO[@]}"; do LLARGS+=(--ro "$p"); done
  for p in "$TASK" "$H/.gemini" /tmp /dev; do LLARGS+=(--rw "$p"); done
  CMD=(/usr/bin/python3 -I "$LL" "${LLARGS[@]}" -- "${CMD[@]}")
fi

exec bwrap "${A[@]}" -- "${CMD[@]}"
