#!/usr/bin/env python3
"""Second layer inside bwrap: apply a Landlock filesystem ruleset, then exec.

Usage: landlock_exec.py [--ro PATH]... [--rw PATH]... -- CMD [ARGS...]

Everything not listed is denied for every handled access right. Rules are
inherited by all children and cannot be removed (kernel-enforced).
Prototype only: a real integration would do this in the native launcher.
"""
import ctypes, os, sys

SYS_create_ruleset, SYS_add_rule, SYS_restrict_self = 444, 445, 446
PR_SET_NO_NEW_PRIVS = 38
LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_PATH_BENEATH = 1

EXECUTE, WRITE_FILE, READ_FILE, READ_DIR = 1 << 0, 1 << 1, 1 << 2, 1 << 3
REMOVE_DIR, REMOVE_FILE, MAKE_CHAR, MAKE_DIR = 1 << 4, 1 << 5, 1 << 6, 1 << 7
MAKE_REG, MAKE_SOCK, MAKE_FIFO, MAKE_BLOCK = 1 << 8, 1 << 9, 1 << 10, 1 << 11
MAKE_SYM, REFER, TRUNCATE, IOCTL_DEV = 1 << 12, 1 << 13, 1 << 14, 1 << 15

FILE_ONLY = EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE | IOCTL_DEV


class RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64), ("handled_access_net", ctypes.c_uint64)]


class PathBeneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long


def die(msg):
    sys.stderr.write("landlock_exec: %s\n" % msg)
    sys.exit(126)


def main(argv):
    ro, rw, i = [], [], 0
    while i < len(argv) and argv[i] != "--":
        if argv[i] in ("--ro", "--rw"):
            (ro if argv[i] == "--ro" else rw).append(argv[i + 1]); i += 2
        else:
            die("bad arg %r" % argv[i])
    cmd = argv[i + 1:]
    if not cmd:
        die("no command")

    abi = libc.syscall(SYS_create_ruleset, None, 0, LANDLOCK_CREATE_RULESET_VERSION)
    if abi < 1:
        die("landlock unavailable (errno %d) - refusing to run unconfined" % ctypes.get_errno())
    handled = (1 << 13) - 1           # ABI 1
    if abi >= 2: handled |= REFER
    if abi >= 3: handled |= TRUNCATE
    if abi >= 5: handled |= IOCTL_DEV
    attr = RulesetAttr(handled, 0)
    size = ctypes.sizeof(RulesetAttr) if abi >= 4 else 8
    fd = libc.syscall(SYS_create_ruleset, ctypes.byref(attr), size, 0)
    if fd < 0:
        die("create_ruleset errno %d" % ctypes.get_errno())

    ro_mask = (EXECUTE | READ_FILE | READ_DIR) & handled
    for paths, mask in ((ro, ro_mask), (rw, handled)):
        for p in paths:
            try:
                pfd = os.open(p, os.O_PATH | os.O_CLOEXEC)
            except FileNotFoundError:
                continue
            m = mask if os.path.isdir(p) else (mask & FILE_ONLY)
            rule = PathBeneath(m, pfd)
            if libc.syscall(SYS_add_rule, fd, LANDLOCK_RULE_PATH_BENEATH, ctypes.byref(rule), 0) != 0:
                die("add_rule %s errno %d" % (p, ctypes.get_errno()))
            os.close(pfd)

    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        die("no_new_privs failed")
    if libc.syscall(SYS_restrict_self, fd, 0) != 0:
        die("restrict_self errno %d" % ctypes.get_errno())
    os.close(fd)
    os.environ["AGY_SANDBOX_LANDLOCK_ABI"] = str(abi)
    os.execvp(cmd[0], cmd)


if __name__ == "__main__":
    main(sys.argv[1:])
