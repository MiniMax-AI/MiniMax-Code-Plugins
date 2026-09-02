#!/usr/bin/env python3
"""Minimal background-run manager for long research tasks.

Pure standard library, cross-platform (Windows and POSIX). A "run" is a
detached background process whose state lives in runs/<name>/: run.json
({id, cmd, cwd, pid, started, status, exit_code} plus optional
{tags, note}), stdout.log, stderr.log.
status: running | exited (code 0) | failed.

Usage: start --name N --cmd "..." [--tag T ...] [--note "..."]
       | status --name N | list | tail --name N
"""

import argparse
import collections
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

RUNS_DIR = Path("runs")
STATE_FILE = "run.json"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
STILL_ACTIVE = 259  # Windows GetExitCodeProcess sentinel


def pid_alive(pid):
    """Return True if a process with this pid exists and has not exited."""
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        # os.kill(pid, 0) is unsupported on Windows; use the Win32 API.
        import ctypes
        k32 = ctypes.windll.kernel32
        handle = k32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        ok = k32.GetExitCodeProcess(handle, ctypes.byref(code))
        k32.CloseHandle(handle)
        return bool(ok) and code.value == STILL_ACTIVE
    try:
        os.kill(pid, 0)  # signal 0: existence check only
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists but owned by another user
    return True


def load_state(name):
    """Read runs/<name>/run.json; exit with an error if missing."""
    state_path = RUNS_DIR / name / STATE_FILE
    if not state_path.is_file():
        print(f"error: no such run: {name!r}", file=sys.stderr)
        sys.exit(2)
    return json.loads(state_path.read_text(encoding="utf-8"))


def refresh(state):
    """Reconcile a recorded 'running' state with actual pid liveness."""
    if state.get("status") == "running" and not pid_alive(state.get("pid")):
        # The helper died without writing its final state (killed/crashed).
        state["status"] = "failed"
        state["exit_code"] = None
    return state


def cmd_start(args):
    """Spawn a detached background run and record its state."""
    if not NAME_RE.match(args.name):
        print(f"error: invalid run name {args.name!r}", file=sys.stderr)
        sys.exit(2)
    run_dir = RUNS_DIR / args.name
    if (run_dir / STATE_FILE).is_file():
        old = refresh(load_state(args.name))
        if old.get("status") == "running":
            print(f"error: run {args.name!r} already running "
                  f"(pid {old['pid']})", file=sys.stderr)
            sys.exit(2)
    run_dir.mkdir(parents=True, exist_ok=True)

    cwd = os.getcwd()
    out = open(run_dir / "stdout.log", "w", encoding="utf-8", errors="replace")
    err = open(run_dir / "stderr.log", "w", encoding="utf-8", errors="replace")
    flags = {}
    if os.name == "nt":
        flags["creationflags"] = (subprocess.DETACHED_PROCESS
                                  | subprocess.CREATE_NEW_PROCESS_GROUP)
    else:
        flags["start_new_session"] = True  # detach from the controlling tty
    helper = [sys.executable, str(Path(__file__).resolve()),
              "_exec", "--name", args.name]
    proc = subprocess.Popen(helper, stdout=out, stderr=err,
                            stdin=subprocess.DEVNULL, cwd=cwd, **flags)
    out.close()
    err.close()

    state = {"id": args.name, "cmd": args.cmd, "cwd": cwd, "pid": proc.pid,
             "started": datetime.now(timezone.utc).astimezone().isoformat(),
             "status": "running", "exit_code": None}
    if args.tag:
        state["tags"] = args.tag
    if args.note:
        state["note"] = args.note
    (run_dir / STATE_FILE).write_text(
        json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"started run {args.name!r} (pid {proc.pid}) -> {run_dir}/")


def cmd_exec(args):
    """Internal helper: execute the command, then record the final state.

    The logs are (re)opened here and passed explicitly to the child: on
    Windows a detached process has no console, so inherited stdio would go
    nowhere; passing file objects makes subprocess duplicate the handles.
    """
    state = load_state(args.name)
    run_dir = RUNS_DIR / args.name
    with open(run_dir / "stdout.log", "a", encoding="utf-8",
              errors="replace") as out, \
            open(run_dir / "stderr.log", "a", encoding="utf-8",
                 errors="replace") as err:
        code = subprocess.call(state["cmd"], shell=True, cwd=state["cwd"],
                               stdout=out, stderr=err)
    state["status"] = "exited" if code == 0 else "failed"
    state["exit_code"] = code
    (run_dir / STATE_FILE).write_text(
        json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    sys.exit(code)


def cmd_status(args):
    """Print the current state of one run."""
    s = refresh(load_state(args.name))
    for key in ("id", "status", "pid", "exit_code", "started", "cmd"):
        print(f"{key + ':':<11}{s[key]}")


def cmd_list(_args):
    """List all runs under runs/."""
    rows = []
    for sp in sorted(RUNS_DIR.glob(f"*/{STATE_FILE}")):
        s = refresh(json.loads(sp.read_text(encoding="utf-8")))
        cmd = s.get("cmd", "")
        tags = ",".join(s.get("tags") or [])
        rows.append((s.get("id", "?"), s.get("status", "?"),
                     str(s.get("pid", "?")), s.get("started", "?")[:19],
                     tags[:24] + ("..." if len(tags) > 24 else ""),
                     cmd[:60] + ("..." if len(cmd) > 60 else "")))
    if not rows:
        print("no runs yet")
        return
    print(f"{'NAME':<20} {'STATUS':<8} {'PID':<8} {'STARTED':<20} {'TAGS':<28} CMD")
    for r in rows:
        print(f"{r[0]:<20} {r[1]:<8} {r[2]:<8} {r[3]:<20} {r[4]:<28} {r[5]}")


def cmd_tail(args):
    """Print the last N lines of a run's stdout/stderr logs."""
    load_state(args.name)  # fail early for unknown runs
    for stream in ("stdout", "stderr"):
        log = RUNS_DIR / args.name / f"{stream}.log"
        print(f"== {stream}.log (last {args.lines} lines) ==")
        if not log.is_file():
            print("(missing)")
            continue
        with open(log, encoding="utf-8", errors="replace") as fh:
            lines = collections.deque(fh, maxlen=args.lines)
        print("".join(lines), end="" if lines else "(empty)\n")


def main():
    # Windows consoles often default to GBK; force UTF-8 to never crash.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(
        description="Manage detached background runs under runs/<name>/.")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("start", help="Start a detached background run.")
    p.add_argument("--name", required=True, help="Run name (directory key).")
    p.add_argument("--cmd", required=True, help="Command line to execute.")
    p.add_argument("--tag", action="append", default=None, metavar="TAG",
                   help="Tag for the run (repeatable); stored as run.json tags.")
    p.add_argument("--note", default=None,
                   help="Free-form note stored as run.json note.")
    p.set_defaults(func=cmd_start)
    p = sub.add_parser("status", help="Show one run's state.")
    p.add_argument("--name", required=True)
    p.set_defaults(func=cmd_status)
    p = sub.add_parser("list", help="List all runs.")
    p.set_defaults(func=cmd_list)
    p = sub.add_parser("tail", help="Show the last lines of a run's logs.")
    p.add_argument("--name", required=True)
    p.add_argument("--lines", type=int, default=20)
    p.set_defaults(func=cmd_tail)
    p = sub.add_parser("_exec", help=argparse.SUPPRESS)  # internal helper
    p.add_argument("--name", required=True)
    p.set_defaults(func=cmd_exec)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
