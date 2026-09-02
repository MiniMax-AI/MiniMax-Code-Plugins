"""acp_inbox.py — goudan-side (OpenClaw main agent) peer client for the ACP inbox.

This is a thin class-style wrapper over ``client._acp_client.inbox_*`` for use
from inside an OpenClaw session (goudan). It does **not** reimplement HTTP,
loopback checking, or no-redirect handling — every token-bearing call goes
through the same hardened opener the mavis-side Skills use.

Why a wrapper, not a re-implementation
--------------------------------------
The v0.1.3 review (round 2 / round 3) pushed back on the Plugin re-deriving
its own HTTP client. The reviewer wanted **one** request path that both the
Skills and the smoke test exercise. So:

- ``scripts/acp_inbox.py`` imports ``client._acp_client`` and delegates.
- The loopback allow-list, no-redirect opener, and token resolution chain
  (``$ACP_TOKEN`` → ``~/.acp_token`` → ``<plugin_root>/.acp_token``) are
  inherited unchanged. A token-bearing request from goudan goes through the
  same ``_OPENER`` and ``_check_loopback`` path that a mavis request does.
- The bundled smoke test (``scripts/smoke.py``) and the no-redirect
  regression (``scripts/test_no_redirect.py``) cover the underlying
  contract; this module's own smoke (``test_inbox_goudan.py``) covers the
  wrapper-level surface (defaults, sender convention, return-type mapping).

Default sender
--------------
The wrapper defaults ``sender="goudan"`` for outbound ``write()`` and
``ask()`` calls. A goudan-side caller should never pass
``sender="mavis"``; that direction is the mavis-side Skill's job.

Usage
-----
    from acp_inbox import ACPInbox

    acp = ACPInbox()  # uses $ACP_BASE_URL / $ACP_TOKEN via _acp_client
    msg_id = acp.write("goudan-mavis-001", "found 1 cron failure")
    msgs = acp.read("goudan-mavis-001", sender="mavis")
    for m in msgs:
        print(m["sender"], m["content"])

CLI:

    python scripts/acp_inbox.py --session test --action ping
    python scripts/acp_inbox.py --session test --action read
    python scripts/acp_inbox.py --session test --action ask --content '1+1?'

Exit code: 0 on success, 1 on any failure.
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any, Optional

# Same plugin-root resolution as the Skills. The script lives in
# `<plugin>/scripts/`, so the bundled client is one directory up and over.
HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN_ROOT = os.path.dirname(HERE)
CLIENT_DIR = os.path.join(PLUGIN_ROOT, "client")
if CLIENT_DIR not in sys.path:
    sys.path.insert(0, CLIENT_DIR)

import _acp_client  # noqa: E402  -- after sys.path adjustment


class ACPInboxError(RuntimeError):
    """Raised on non-2xx responses or transport failures.

    The bundled client's exception type is ``_acp_client.ACPError``;
    we re-export it under a more familiar name for the goudan side.
    """


# Re-export the bundled client's exception under a clearer name.
ACPError = _acp_client.ACPError
ACPTokenMissing = _acp_client.ACPTokenMissing


class ACPInbox:
    """Goudan-side class wrapper over the inbox endpoints.

    All methods delegate to ``_acp_client.inbox_*`` so the underlying
    security properties (loopback allow-list, no-redirect opener, token
    resolution chain) are shared with the mavis-side Skills and the
    bundled smoke test.

    Parameters
    ----------
    default_timeout:
        Used for ``ask()``; other methods have no client-side timeout
        (the server enforces them per request).

        The HTTP base URL is read from ``$ACP_BASE_URL`` (set by the
        caller) or falls back to ``_acp_client.DEFAULT_BASE_URL``. The
        wrapper does NOT accept a per-instance ``base_url``; the
        bundled client's ``inbox_*`` helpers read the env var
        directly, so a constructor parameter would be silently
        ignored. To fail fast on a misconfiguration, set
        ``$ACP_BASE_URL`` before instantiation and call
        ``_acp_client._check_loopback($ACP_BASE_URL)`` explicitly;
        the bundled smoke does this.
    """

    def __init__(
        self,
        default_timeout: float = 30.0,
    ) -> None:
        self.default_timeout = float(default_timeout)

    # --- outbound writes (goudan → mavis) --------------------------------

    def write(
        self,
        session_id: str,
        content: str,
        sender: str = "goudan",
        msg_type: str = "message",
        parent_id: Optional[int] = None,
    ) -> int:
        """Append a message to the inbox. Returns the server's message_id (int).

        ``sender`` defaults to ``"goudan"``; pass ``"mavis"`` only if you are
        forwarding a message on the mavis side from a goudan-issued
        instruction (rare).
        """
        return _acp_client.inbox_write(
            session_id=session_id,
            content=content,
            sender=sender,
            msg_type=msg_type,
            parent_id=parent_id,
        )

    def greet(
        self,
        session_id: str,
        who: str = "goudan",
        note: str = "",
    ) -> int:
        """Convenience: write a ``peer_greet``-shaped message to start a session.

        ``peer_greet`` is also exposed by the bundled client as a top-level
        helper; this method exists so goudan can post a greeting without
        needing to know the exact content format.
        """
        content = f"[from {who}] peer_greet"
        if note:
            content += f" -- {note}"
        return self.write(session_id, content, sender=who, msg_type="message")

    # --- inbound reads (mavis → goudan) ----------------------------------

    def read(
        self,
        session_id: str,
        since_id: int = 0,
        sender: Optional[str] = None,
        msg_type: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> list[dict]:
        """Read messages from the inbox (auto-marked-read by the server).

        Returns a list of message dicts.

        The bundled client's ``inbox_read`` accepts a ``limit`` parameter
        that is forwarded to the server as a ``limit=N`` query param.
        This wrapper exposes the same ``limit`` parameter; pass an
        ``int`` to cap the response size, or ``None`` (default) to let
        the server's default apply.
        """
        return _acp_client.inbox_read(
            session_id=session_id,
            since_id=since_id,
            sender=sender,
            msg_type=msg_type,
            limit=limit,
        )

    # --- ask / answer (blocking) ----------------------------------------

    def ask(
        self,
        session_id: str,
        question: str,
        sender: str = "goudan",
        msg_type: str = "question",
        timeout: Optional[float] = None,
    ) -> dict:
        """Write a question and block for the answer.

        Returns a dict with ``question_id`` and ``answer`` on success, or
        with ``error == "timeout"`` and ``question_id`` on timeout. The
        server's ``/acp/inbox/ask`` endpoint handles the blocking poll;
        the wrapper just delegates.
        """
        return _acp_client.inbox_ask(
            session_id=session_id,
            question=question,
            sender=sender,
            timeout=timeout if timeout is not None else self.default_timeout,
        )

    def answer(
        self,
        question_id: int,
        answer: str,
    ) -> int:
        """Answer a question by id. Returns the new answer's message_id."""
        return _acp_client.inbox_answer(
            question_id=question_id,
            answer=answer,
        )

    # --- sessions -------------------------------------------------------

    def sessions(self) -> list[dict]:
        """List active sessions (server returns a list of session summaries)."""
        return _acp_client.inbox_sessions()


def _main() -> int:
    import argparse
    p = argparse.ArgumentParser(
        description="Goudan-side ACP inbox wrapper (uses bundled client).",
    )
    p.add_argument("--session", required=True, help="session_id")
    p.add_argument(
        "--action",
        choices=["ping", "read", "ask", "answer", "sessions", "greet"],
        default="ping",
    )
    p.add_argument("--content", default="", help="content / question text")
    p.add_argument(
        "--question-id",
        type=int,
        default=None,
        help="question_id (for --action answer)",
    )
    p.add_argument("--timeout", type=float, default=30.0)
    # --base-url intentionally NOT exposed: routing is via $ACP_BASE_URL
    # (the bundled client's inbox_* helpers read env directly). The CLI
    # instead validates the resolved env at ping time so a caller can
    # fail-fast on a misconfiguration without having to instantiate.
    args = p.parse_args()

    acp = ACPInbox(default_timeout=args.timeout)

    if args.action == "ping":
        # Resolve the same env-var chain the bundled client uses, and
        # validate it through the loopback guard. Non-loopback env
        # values are an instant FAIL (no HTTP round-trip).
        try:
            import os as _os
            base = (_os.environ.get("ACP_BASE_URL") or _acp_client.DEFAULT_BASE_URL).rstrip("/")
            _acp_client._check_loopback(base)
        except _acp_client.ACPError as e:
            print(f"FAIL: ACP_BASE_URL={base!r} refused by loopback guard: {e}", file=sys.stderr)
            return 1
        print(f"OK -- ACP_BASE_URL {base} accepted by loopback guard")
        return 0

    if args.action == "read":
        msgs = acp.read(args.session)
        for m in msgs:
            print(f"[{m.get('id')}] {m.get('sender')}/{m.get('msg_type')}: "
                  f"{(m.get('content') or '')[:200]}")
        return 0

    if args.action == "ask":
        result = acp.ask(args.session, args.content, timeout=args.timeout)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if "answer" in result else 2

    if args.action == "answer":
        if args.question_id is None:
            print("--question-id required for --action answer", file=sys.stderr)
            return 2
        ans_id = acp.answer(args.question_id, args.content)
        print(f"OK -- wrote answer_id={ans_id}")
        return 0

    if args.action == "greet":
        msg_id = acp.greet(args.session, note=args.content)
        print(f"OK -- wrote greet message_id={msg_id}")
        return 0

    if args.action == "sessions":
        for s in acp.sessions():
            print(json.dumps(s, ensure_ascii=False))
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(_main())
