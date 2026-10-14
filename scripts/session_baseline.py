#!/usr/bin/env python3
"""Historical edit/patch baseline mined from pi session transcripts.

Reads pi's session JSONL files (~/.pi/agent/sessions/--<path>--/<ts>_<id>.jsonl),
pairs every assistant `toolCall` block with its `toolResult`, and reports how the
two edit engines actually performed: failure rates, failure categories, retry
streaks, recovery vs abandonment, and the per-model / per-session / per-work-shape
breakdowns needed to judge whether the raw comparison is confounded.

It is confounded by construction: the agent CHOOSES which tool to call, so the two
arms are not the same work (docs/PLAN.md — randomized-by-session A/B is the
controlled version). Headline rates therefore exclude *harness* traffic (calls
against /tmp scratch files, which are the agent testing the engine on purpose and
deliberately sending bad anchors).

Usage:
    python3 scripts/session_baseline.py                    # all projects
    python3 scripts/session_baseline.py --project pi-patch
    python3 scripts/session_baseline.py --model GLM-5.3    # substring filter
    python3 scripts/session_baseline.py --failures patch    # verbatim failure texts
    python3 scripts/session_baseline.py --json              # per-call records
    python3 scripts/session_baseline.py --include-harness   # count /tmp traffic too

Read-only: never writes, never mutates sessions. Skips the current session
(PI_SESSION_FILE) by default — it is being appended to while we read it.
"""

from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import re
import signal
import sys
from difflib import SequenceMatcher

EDIT_TOOLS = ("edit", "patch")

# ── failure classification ──────────────────────────────────────────────────
# Ordered (pattern, category); first match wins. pi built-in `edit` texts come from
# dist/core/tools/edit-diff.js; `patch` texts are hermes-verbatim from src/errors.ts.
CATEGORIES: list[tuple[str, str]] = [
	# no-match family (must precede the generic gate patterns: recovery text says
	# "do not re-send this call unchanged" for several categories)
	(r"Could not find the exact text", "no_match"),
	(r"Could not find the old text of edit", "no_match"),
	(r"Could not find edits\[", "no_match"),
	(r"Could not find a match for old_string", "no_match"),
	(r"Could not find [^\n]*old_string", "no_match"),
	(r"Could not apply hunk", "v4a_hunk_miss"),
	# ambiguity family
	(r"Found \d+ occurrences of", "ambiguous"),
	(r"Found \d+ matches for the old text of edit", "ambiguous"),
	(r"Found \d+ matches for old_string", "ambiguous"),
	(r"Found \d+ approximate matches", "ambiguous"),
	(r"overlapping regions", "overlap"),
	(r"overlap in", "overlap"),
	# anchors that can never work / no-op
	(r"No changes made to", "identical_noop"),
	(r"old_string and new_string are exactly the same", "identical_noop"),
	(r"oldText must not be empty", "empty_anchor"),
	(r"old_string is empty", "empty_anchor"),
	(r"old_string is only whitespace", "empty_anchor"),
	# drift / staleness / write integrity
	(r"Escape-drift detected", "escape_drift"),
	(r"literal .{0,10}\\n.{0,30}sequences", "escape_drift"),
	(r"backslash run", "escape_drift"),
	(r"modified since you last read", "staleness"),
	(r"Failed to write changes", "verify_failed"),
	(r"did not persist", "verify_failed"),
	(r"is outside the base content", "range_error"),
	(r"different line count", "range_error"),
	# V4A specifics
	(r"V4A patch header contains '\.\.' traversal", "v4a_traversal"),
	(r"Could not parse|Invalid V4A|invalid patch", "v4a_parse"),
	(r"not available in this build", "gate_closed"),
	# argument gates (specific spellings only — a bare "required" overmatches)
	(r"Validation failed for tool", "schema_validation"),
	(r"edits\[\] is not supported", "arg_gate_edits"),
	(r"Unknown mode", "arg_gate"),
	(r"patch content required", "arg_gate"),
	(r"path required", "arg_gate"),
	(r"new_string required", "arg_gate"),
	(r"must contain at least one replacement", "arg_gate"),
	# everything else
	(r"Could not patch file|ENOENT|EISDIR|EACCES", "file_error"),
	(r"Operation aborted", "aborted"),
	(r"already contains the target text", "already_applied"),
]


def classify(text: str) -> str:
	for pattern, category in CATEGORIES:
		if re.search(pattern, text, re.IGNORECASE | re.DOTALL):
			return category
	return "other"


def result_text(message: dict) -> str:
	content = message.get("content")
	if isinstance(content, str):
		return content
	parts = []
	for block in content or []:
		if isinstance(block, dict) and block.get("type") == "text":
			parts.append(str(block.get("text", "")))
	return "\n".join(parts)


def target_path(tool: str, args: dict) -> str:
	for key in ("path", "file_path", "filePath"):
		value = args.get(key)
		if isinstance(value, str) and value:
			return value
	if tool == "patch" and isinstance(args.get("patch"), str):
		heads = re.findall(r"\*\*\*\s*(?:Update|Add|Delete|Move)\s+File:\s*(.+)", args["patch"])
		if heads:
			return heads[0].strip()
	return "?"


def is_harness(path: str) -> bool:
	"""Scratch-file traffic: the agent probing the engine, not doing work."""
	return path.startswith("/tmp/") or path.startswith("/var/tmp/") or path == "?"


def anchor_of(tool: str, args: dict) -> str:
	if tool == "edit":
		edits = args.get("edits")
		if isinstance(edits, list) and edits and isinstance(edits[0], dict):
			return str(edits[0].get("oldText", ""))
		return str(args.get("oldText") or args.get("old_string") or "")
	return str(args.get("old_string") or args.get("oldText") or args.get("patch") or "")


def shape_of(tool: str, args: dict) -> str:
	"""Work shape per call — the confound that matters most: pi's `edit` takes an
	`edits[]` array (multi-hunk in one call), `patch` is one replacement per call
	unless mode='patch' (V4A)."""
	edits = args.get("edits")
	n = len(edits) if isinstance(edits, list) else (1 if anchor_of(tool, args) else 0)
	if tool == "patch" and str(args.get("mode", "")).lower() == "patch":
		return "patch/v4a"
	if tool == "patch":
		return "patch/multi-edits" if n > 1 else "patch/replace"
	return "edit/edits[]" if n > 1 else "edit/single"


def iter_sessions(root: str, project_filter: str | None, model_filter: str | None, exclude: set[str]):
	for path in sorted(glob.glob(os.path.join(root, "*", "*.jsonl"))):
		if os.path.abspath(path) in exclude:
			continue
		cwd, header, rows = None, None, []
		try:
			with open(path, encoding="utf-8", errors="replace") as handle:
				for line in handle:
					line = line.strip()
					if not line:
						continue
					try:
						entry = json.loads(line)
					except json.JSONDecodeError:
						continue
					if entry.get("type") == "session":
						header, cwd = entry, entry.get("cwd")
					rows.append(entry)
		except OSError:
			continue
		if header is None:
			continue
		if project_filter and project_filter not in (cwd or ""):
			continue
		if model_filter and not any(
			model_filter in str((e.get("message") or e).get("model") or "")
			or model_filter in str(e.get("modelId") or "")
			for e in rows
			if e.get("type") in ("message", "model_change")
		):
			continue
		yield path, cwd, header, rows


def mine(root: str, project_filter: str | None, model_filter: str | None, exclude: set[str]):
	"""One record per tool call (edit-engine calls flagged), plus files scanned."""
	records: list[dict] = []
	scanned = 0
	for path, cwd, header, rows in iter_sessions(root, project_filter, model_filter, exclude):
		scanned += 1
		results: dict[str, dict] = {}
		for entry in rows:
			if entry.get("type") != "message":
				continue
			message = entry.get("message") or {}
			if message.get("role") == "toolResult":
				results[str(message.get("toolCallId"))] = {
					"isError": bool(message.get("isError")),
					"text": result_text(message),
					"ts": entry.get("timestamp"),
				}
		gidx = 0
		model = header.get("model") or "?"
		for entry in rows:
			if entry.get("type") == "model_change":
				model = entry.get("modelId") or model
			if entry.get("type") != "message":
				continue
			message = entry.get("message") or {}
			if message.get("role") == "assistant" and message.get("model"):
				model = message["model"]
			if message.get("role") != "assistant":
				continue
			content = message.get("content")
			if not isinstance(content, list):
				continue
			for block in content:
				if not isinstance(block, dict) or block.get("type") != "toolCall":
					continue
				name = block.get("name") or "?"
				args = block.get("arguments") if isinstance(block.get("arguments"), dict) else {}
				res = results.get(str(block.get("id"))) or {"isError": True, "text": "<no result recorded>", "ts": None}
				gidx += 1
				edited = name in EDIT_TOOLS
				path_str = target_path(name, args) if edited else ""
				kind = "applied"
				if res["isError"]:
					kind = classify(res["text"]) if edited else "not_edit"
				elif re.search(r"already (contains the target text|applied)|appears to be already applied",
				              res["text"], re.IGNORECASE):
					kind = "already_applied"
				records.append(
					{
						"session": os.path.basename(path),
						"cwd": cwd,
						"model": model,
						"tool": name,
						"edit_engine": edited,
						"gidx": gidx,
						"path": path_str,
						"harness": edited and is_harness(path_str),
						"shape": shape_of(name, args) if edited else "",
						"anchor": anchor_of(name, args)[:160] if edited else "",
						"ok": not res["isError"],
						"kind": kind,
						"ts": res["ts"] or entry.get("timestamp"),
						"text": res["text"][:400],
					}
				)
	return records, scanned


def _stats() -> dict:
	return {
		"calls": 0, "attempts": 0, "landed": 0, "abandoned": 0,
		"max_streak": 0, "streak_hist": collections.Counter(),
	}


def anatomy(all_calls: list[dict], include_harness: bool) -> dict:
	"""Retry anatomy over edit-engine calls.

	An 'attempt' is a run of edit-engine calls on ONE path with no intervening call
	to a different path and no intervening non-edit tool call — going to read the
	file or run bash starts a new attempt. An attempt that never lands is abandoned.
	"""
	by_session: dict[str, list[dict]] = collections.defaultdict(list)
	for record in sorted(all_calls, key=lambda r: r["gidx"]):
		if record["edit_engine"] and not (include_harness or not record["harness"]):
			record = {**record, "edit_engine": False}
		by_session[record["session"]].append(record)

	overall, by_tool = _stats(), collections.defaultdict(_stats)
	switches = collections.Counter()
	recovery: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
	suspect: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
	for session, calls_in_session in by_session.items():
		runs: list[list[dict]] = []
		current: list[dict] = []
		for record in calls_in_session:
			if not record["edit_engine"]:
				if current:
					runs.append(current)
					current = []
				continue
			if current and (record["path"] != current[-1]["path"] or record["gidx"] != current[-1]["gidx"] + 1):
				runs.append(current)
				current = []
			current.append(record)
		if current:
			runs.append(current)

		for run in runs:
			for bucket in (overall, by_tool[run[0]["tool"]]):
				bucket["calls"] += len(run)
				bucket["attempts"] += 1
				landed = any(r["ok"] for r in run)
				bucket["landed"] += 1 if landed else 0
				bucket["abandoned"] += 0 if landed else 1
				bucket["max_streak"] = max(bucket["max_streak"], len(run))
				bucket["streak_hist"][len(run)] += 1
			if len(run) > 1 and not run[0]["ok"]:
				switches[(run[0]["tool"], run[1]["tool"])] += 1

		# Wrong-landing proxy: the tool reported success, and the very next call on
		# the same file retargets (nearly) the same text — consistent with the engine
		# having landed the wrong region, or the model not getting what it asked for.
		edits_cs = [c for c in calls_in_session if c["edit_engine"]]
		for i, record in enumerate(edits_cs):
			if not record["ok"] or not record["anchor"].strip():
				continue
			nxt = next((c for c in edits_cs[i + 1:i + 4] if c["path"] == record["path"]), None)
			if not nxt or not nxt["anchor"].strip():
				continue
			ratio = SequenceMatcher(None, record["anchor"], nxt["anchor"]).ratio()
			if ratio >= 0.99:
				suspect[record["tool"]]["identical_anchor_repeat"] += 1
			elif ratio >= 0.7:
				suspect[record["tool"]]["fuzzy_anchor_repeat"] += 1

		edits = edits_cs
		for i, record in enumerate(edits):
			if record["ok"]:
				continue
			later = [c for c in edits[i + 1:] if c["path"] == record["path"] and c["ok"]]
			if not later:
				recovery[record["tool"]]["unrecovered"] += 1
			elif later[0]["tool"] == record["tool"]:
				recovery[record["tool"]]["recovered_same_tool"] += 1
			else:
				recovery[record["tool"]]["recovered_other_tool"] += 1
	return {"overall": overall, "by_tool": dict(by_tool), "switches": switches,
	        "recovery": dict(recovery), "suspect": dict(suspect)}


def pct(part: int, whole: int) -> str:
	return f"{100.0 * part / whole:5.1f}%" if whole else "    - "


def _lines(groups: dict, limit: int):
	for group in sorted(groups, key=lambda k: -sum(len(v) for v in groups[k].values()))[:limit]:
		total = sum(len(v) for v in groups[group].values())
		fails = [r for tool in groups[group] for r in groups[group][tool] if not r["ok"]]
		yield f"  {group[:46]:46} {total:>5} calls  {len(fails):>4} fail ({pct(len(fails), total)})"
		for tool, rows in sorted(groups[group].items(), key=lambda kv: -len(kv[1])):
			tf = [r for r in rows if not r["ok"]]
			amb = sum(1 for r in tf if r["kind"] == "ambiguous")
			nm = sum(1 for r in tf if r["kind"] == "no_match")
			aa = sum(1 for r in rows if r["kind"] == "already_applied")
			sess = len({r["session"] for r in rows})
			yield (f"      {tool:16} {len(rows):>5} calls {len(tf):>4} fail {pct(len(tf), len(rows)):>7}"
			       f"  ambig {amb:>3}  no_match {nm:>3}  noop {aa:>3}  sessions {sess}")


def report(records: list[dict], files: int, args) -> None:
	all_edits = [r for r in records if r["edit_engine"]]
	if not all_edits:
		print("no edit/patch calls found")
		return
	harness = [r for r in all_edits if r["harness"]]
	edits = all_edits if args.include_harness else [r for r in all_edits if not r["harness"]]
	dates = sorted(d for d in (r["ts"] for r in edits) if d)

	print("=" * 78)
	print("pi-patch historical baseline — mined from pi session transcripts")
	print("=" * 78)
	print(f"session files scanned : {files}")
	print(f"sessions with edits   : {len({r['session'] for r in all_edits})}")
	print(f"edit-engine calls     : {len(all_edits)}  (edit {sum(1 for r in all_edits if r['tool'] == 'edit')}"
	      f" / patch {sum(1 for r in all_edits if r['tool'] == 'patch')})")
	print(f"harness traffic       : {len(harness)} calls on /tmp scratch files"
	      f"{'  (INCLUDED)' if args.include_harness else '  (excluded from the tables below)'}")
	if dates:
		print(f"time range            : {dates[0]} .. {dates[-1]}")
	if args.project:
		print(f"project filter        : {args.project}")
	if args.model:
		print(f"model filter          : {args.model}")

	print()
	print("--- headline: failure rate per call " + "-" * 40)
	print(f"{'tool':8} {'calls':>7} {'fail':>6} {'fail%':>7} {'noop':>6} {'sessions':>9} {'files':>7}")
	for tool in ("edit", "patch"):
		rows = [r for r in edits if r["tool"] == tool]
		fails = [r for r in rows if not r["ok"]]
		print(f"{tool:8} {len(rows):>7} {len(fails):>6} {pct(len(fails), len(rows)):>7}"
		      f" {sum(1 for r in rows if r['kind'] == 'already_applied'):>6}"
		      f" {len({r['session'] for r in rows}):>9} {len({r['path'] for r in rows}):>7}")

	for title, group_of, limit in (
		("by model", lambda r: r["model"], 12),
		("by work shape (edit/edits[] is a different capability)", lambda r: r["shape"], 8),
		("by project", lambda r: os.path.basename(r["cwd"] or "?"), 10),
		("by day", lambda r: (r["ts"] or "?")[:10], 14),
	):
		print()
		print(f"--- {title} " + "-" * max(0, 72 - len(title)))
		groups = collections.defaultdict(lambda: collections.defaultdict(list))
		for record in edits:
			key = group_of(record)
			if key is not None:
				groups[str(key)][record["tool"]].append(record)
		for line in _lines(groups, limit):
			print(line)

	print()
	print("--- failure categories " + "-" * 53)
	for tool in ("edit", "patch"):
		fails = [r for r in edits if r["tool"] == tool and not r["ok"]]
		print(f"  {tool}: {len(fails)} failures")
		for kind, count in collections.Counter(r["kind"] for r in fails).most_common():
			print(f"    {kind:20} {count:>5}  {pct(count, len(fails))}")

	print()
	print("--- attempt anatomy (run of calls, same file, no gap) " + "-" * 22)
	sk = anatomy(records, args.include_harness)
	for tool in ("edit", "patch"):
		b = sk["by_tool"].get(tool)
		if not b or not b["attempts"]:
			continue
		hist = " ".join(f"{n}:{c}" for n, c in sorted(b["streak_hist"].items()))
		rec = sk["recovery"].get(tool, {})
		print(f"  {tool:6} attempts={b['attempts']:>5} landed={b['landed']:>5} abandoned={b['abandoned']:>4}"
		      f" calls/attempt={b['calls'] / max(1, b['attempts']):.2f} max_streak={b['max_streak']}")
		print(f"         streak hist (calls:attempts) {hist}")
		print(f"         after a failure: same-tool recovery {rec.get('recovered_same_tool', 0):>3},"
		      f" other-tool recovery {rec.get('recovered_other_tool', 0):>3}, unrecovered {rec.get('unrecovered', 0):>3}")
	if sk["switches"]:
		print("         next call after a failure:",
		      ", ".join(f"{a}->{b}: {c}" for (a, b), c in sk["switches"].most_common()))
	print("         wrong-landing proxy (success, then a near-identical anchor on the same file):")
	for tool in ("edit", "patch"):
		s = sk["suspect"].get(tool, {})
		rows = [r for r in edits if r["tool"] == tool and r["ok"]]
		total = len(rows)
		same, fuzzy = s.get("identical_anchor_repeat", 0), s.get("fuzzy_anchor_repeat", 0)
		print(f"           {tool:6} identical-anchor re-send {same:>3}, near-identical {fuzzy:>3}"
		      f"  ({pct(same + fuzzy, total)} of successful calls)")

	print()
	print("--- paired: sessions that used BOTH engines " + "-" * 31)
	both = sorted({r["session"] for r in edits if r["tool"] == "edit"} & {r["session"] for r in edits if r["tool"] == "patch"})
	pe = pp = ce = cp = 0
	for session in both:
		rows = [r for r in edits if r["session"] == session]
		e = [r for r in rows if r["tool"] == "edit"]
		p = [r for r in rows if r["tool"] == "patch"]
		pe += sum(1 for r in e if not r["ok"])
		pp += sum(1 for r in p if not r["ok"])
		ce += len(e)
		cp += len(p)
		if args.verbose:
			print(f"    {session[:46]:46} edit {sum(1 for r in e if not r['ok']):>3}/{len(e):<4}"
			      f" patch {sum(1 for r in p if not r['ok']):>3}/{len(p):<4}")
	print(f"  {len(both)} of {len({r['session'] for r in edits})} sessions")
	print(f"  pooled: edit {pe}/{ce} fail ({pct(pe, ce)}), patch {pp}/{cp} fail ({pct(pp, cp)})")
	print()
	print("  NOTE: observational, not controlled — the agent picks the tool, so the two")
	print("  arms are different work. docs/PLAN.md: randomized-by-session A/B is the fix.")


def show_failures(records: list[dict], tool: str, include_harness: bool) -> None:
	rows = [
		r for r in records
		if r["edit_engine"] and (tool == "all" or r["tool"] == tool) and not r["ok"]
		and (include_harness or not r["harness"])
	]
	for r in sorted(rows, key=lambda r: (r["tool"], r["kind"])):
		print("-" * 78)
		print(f"[{r['tool']} / {r['kind']}] {r['ts']}  model={r['model']}  shape={r['shape']}")
		print(f"  path: {r['path']}")
		print("  " + r["text"].replace("\n", "\n  ")[:700])


def main() -> int:
	signal.signal(signal.SIGPIPE, signal.SIG_DFL)
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("--root", default=os.path.expanduser("~/.pi/agent/sessions"))
	parser.add_argument("--project", help="substring filter on session cwd")
	parser.add_argument("--model", help="substring filter on model id")
	parser.add_argument("--json", action="store_true", help="dump per-call records as JSONL")
	parser.add_argument("--failures", choices=("edit", "patch", "all"), help="print verbatim failure texts")
	parser.add_argument("--verbose", action="store_true")
	parser.add_argument("--include-harness", action="store_true", help="count /tmp scratch-file traffic too")
	parser.add_argument("--include-current", action="store_true")
	args = parser.parse_args()

	exclude = set()
	if not args.include_current and os.environ.get("PI_SESSION_FILE"):
		exclude.add(os.path.abspath(os.environ["PI_SESSION_FILE"]))

	records, files = mine(args.root, args.project, args.model, exclude)
	if args.json:
		for record in records:
			print(json.dumps(record))
	elif args.failures:
		show_failures(records, args.failures, args.include_harness)
	else:
		report(records, files, args)
	return 0


if __name__ == "__main__":
	sys.exit(main())
