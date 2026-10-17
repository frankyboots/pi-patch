#!/usr/bin/env python3
"""Aggregate `session_baseline.py --json` dumps from several machines into one report.

`session_baseline.py` only sees the sessions on the box it runs on. To widen the corpus,
run it per machine and ship the dump:

    python3 scripts/session_baseline.py --json > desktop.json      # on each machine
    scp server:.../server.json trading:.../trading.json .
    python3 scripts/aggregate_baseline.py desktop.json server.json trading.json

Each dump is tagged with a location (the file stem, or `--tag NAME=PATH`), records are
de-duplicated defensively, and the merged corpus goes through the *same* reporter as a
single-machine run (headline, by model / shape / project / day, categories, attempt
anatomy, paired sessions — including a new "by machine" cut). On top of that, the machine
is a stratification variable, so this also prints per-machine 2x2 tables with a per-stratum
Fisher exact p and a pooled Cochran–Mantel–Haenszel test: the honest question when the two
arms barely share a box, let alone a session.

Still observational: the agent picks the tool, so machine identity, project mix and model
availability are all tangled with the engine. Only the randomized-by-session A/B in
docs/PLAN.md settles causality.

    --markdown   paste-ready tables for docs/BASELINE.md (tables only, no prose report)
    --json       merged, location-tagged per-call records
    --failures   verbatim failure texts across the merged corpus
"""

from __future__ import annotations

import argparse
import collections
import importlib.util
import json
import math
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("session_baseline", os.path.join(_HERE, "session_baseline.py"))
sb = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(sb)

TOOLS = ("edit", "patch")
PROXY_KINDS = ("verify_failed", "staleness", "escape_drift")  # must stay at zero


# ── statistics (exact, no deps) ──────────────────────────────────────────────
def fisher_one_tailed(a: int, n1: int, b: int, n2: int) -> float | None:
	"""Hypergeometric P(X >= a): is arm 1 (`edit`) worse, i.e. `patch` better?

	`a` failures out of `n1` arm-1 calls, `b` out of `n2` arm-2 calls. None when a
	stratum has a single arm (no within-stratum contrast is possible).
	"""
	m1, total = a + b, n1 + n2
	if not n1 or not n2 or not m1 or m1 == total:
		return None
	den = math.comb(total, m1)
	tail = sum(math.comb(n1, k) * math.comb(n2, m1 - k) for k in range(a, min(m1, n1) + 1))
	return min(1.0, tail / den) if den else None


def cmh(strata: list[tuple[int, int, int, int]]) -> tuple[float | None, float | None]:
	"""Cochran–Mantel–Haenszel over 2x2 strata `(a, n1, b, n2)`.

	Continuity-corrected chi-square (1 df) and the pooled Mantel–Haenszel odds ratio.
	Tests for a common association across strata without assuming the strata share a
	baseline failure rate — which is what "different machines, different work" means.
	"""
	num = den = mh_num = mh_den = 0.0
	for a, n1, b, n2 in strata:
		n = n1 + n2
		m1, m0 = a + b, n - a - b
		if n < 2 or not m1 or not m0 or not n1 or not n2:
			continue
		num += a - n1 * m1 / n
		den += n1 * n2 * m1 * m0 / (n * n * (n - 1))
		mh_num += a * n2 / n
		mh_den += b * n1 / n
	if not den:
		return None, None
	chi2 = (abs(num) - 0.5) ** 2 / den
	p = math.erfc(math.sqrt(chi2 / 2.0))  # chi-square(1) survival function
	return p, (mh_num / mh_den) if mh_den and mh_num else 0.0


def rates(rows: list[dict]) -> tuple[int, int]:
	return sum(1 for r in rows if not r["ok"]), len(rows)


def pct(part: int, whole: int) -> str:
	return f"{100.0 * part / whole:5.1f}%" if whole else "    - "


def pc(part: int, whole: int) -> str:
	"""Markdown-friendly percentage without the trailing sign (tables add their own)."""
	return f"{100.0 * part / whole:.1f}" if whole else "n/a"


# ── loading ──────────────────────────────────────────────────────────────────
def load(entries: list[tuple[str, str]]) -> tuple[list[dict], dict[str, list[dict]]]:
	"""Read dumps, tag each record with its location, drop records seen twice."""
	records: list[dict] = []
	by_location: dict[str, list[dict]] = collections.defaultdict(list)
	seen: set[tuple] = set()
	dupes = 0
	for location, path in entries:
		with open(path, encoding="utf-8", errors="replace") as handle:
			for lineno, line in enumerate(handle, 1):
				line = line.strip()
				if not line:
					continue
				try:
					record = json.loads(line)
				except json.JSONDecodeError:
					print(f"  ! {path}:{lineno}: not JSON, skipped", file=sys.stderr)
					continue
				key = (record["session"], record["gidx"], record["tool"])
				if key in seen:  # the same session shipped in two dumps
					dupes += 1
					continue
				seen.add(key)
				record["location"] = location
				records.append(record)
				by_location[location].append(record)
	if dupes:
		print(f"  note: {dupes} duplicate records (same session+index+tool) dropped", file=sys.stderr)
	return records, dict(by_location)


# ── sections ─────────────────────────────────────────────────────────────────
def strata_of(groups: dict[str, list[dict]]) -> list[tuple[str, int, int, int, int]]:
	"""One `(location, edit_fails, edit_calls, patch_fails, patch_calls)` per machine."""
	return [
		(location,
		 *rates([r for r in rows if r["tool"] == "edit"]),
		 *rates([r for r in rows if r["tool"] == "patch"]))
		for location, rows in sorted(groups.items())
	]


def section(title: str, md: bool) -> None:
	if md:
		print(f"\n### {title}\n")
	else:
		print()
		print(f"--- {title} " + "-" * max(0, 72 - len(title)))


def corpus_table(by_location: dict[str, list[dict]], md: bool) -> None:
	if md:
		print("| machine | sessions | edit-engine calls | real (non-harness) | edit | patch | window |\n|---|" + "---|" * 6)
	for location, rows in sorted(by_location.items()):
		ed = [r for r in rows if r["edit_engine"]]
		real = [r for r in ed if not r["harness"]]
		sessions = len({r["session"] for r in rows})
		stamp = sorted(t for t in (r["ts"] for r in rows) if t)
		window = f"{stamp[0][:10]} .. {stamp[-1][:10]}" if stamp else "?"
		ce, cp = sum(1 for r in ed if r["tool"] == "edit"), sum(1 for r in ed if r["tool"] == "patch")
		print(f"| {location} | {sessions} | {len(ed)} | {len(real)} | {ce} | {cp} | {window} |" if md else
		      f"  {location:12} sessions {sessions:>4}  edits {len(ed):>5}  real {len(real):>5}"
		      f"  edit {ce:>4}  patch {cp:>4}  {window}")


def print_strata(rows: list[tuple[str, int, int, int, int]], md: bool) -> None:
	"""One 2x2 per machine; 'single-arm' where an engine never ran on that box."""
	if md:
		print("| machine | edit calls | edit fail | edit % | patch calls | patch fail | patch % | one-tailed p |")
		print("|---|" + "---|" * 7)
	else:
		print(f"{'machine':22} {'edit':>22}   {'patch':>22}   {'p(1-tail)':>10}")
	for location, ae, ce, bp, cp in rows:
		p = fisher_one_tailed(ae, ce, bp, cp)
		tail = f"{p:.4f}" if p is not None else "single-arm"
		if md:
			print(f"| {location} | {ce} | {ae} | {pc(ae, ce)} | {cp} | {bp} | {pc(bp, cp)} | {tail} |")
		else:
			print(f"{location[:22]:22} {f'{ae}/{ce}':>10} {pct(ae, ce):>7}   "
			      f"{f'{bp}/{cp}':>10} {pct(bp, cp):>7}   {tail:>12}")


def anatomy_table(by_location: dict[str, list[dict]], include_harness: bool, md: bool) -> None:
	if md:
		print("| machine | tool | attempts | landed | abandoned | abandon % | calls/attempt | max streak |\n|---|" + "---|" * 7)
	for location, rows in sorted(by_location.items()):
		sk = sb.anatomy(rows, include_harness)
		for tool in TOOLS:
			b = sk["by_tool"].get(tool)
			if not b or not b["attempts"]:
				continue
			rate = b["abandoned"] / b["attempts"]
			if md:
				print(f"| {location} | {tool} | {b['attempts']} | {b['landed']} | {b['abandoned']} "
				      f"| {100.0 * rate:.1f} | {b['calls'] / b['attempts']:.2f} | {b['max_streak']} |")
			else:
				print(f"  {location[:16]:16} {tool:6} attempts={b['attempts']:>5} landed={b['landed']:>5}"
				      f" abandoned={b['abandoned']:>4} ({100.0 * rate:4.1f}%)"
				      f" calls/attempt={b['calls'] / b['attempts']:.2f} max_streak={b['max_streak']}")


def quality_table(records: list[dict], include_harness: bool, md: bool) -> None:
	"""The three checks that could invalidate a low failure rate."""
	sk = sb.anatomy(records, include_harness)
	edits = [r for r in records if r["edit_engine"] and (include_harness or not r["harness"])]
	rows = []
	for tool in TOOLS:
		b = sk["by_tool"].get(tool, {"calls": 0, "attempts": 0, "abandoned": 0})
		ok = [r for r in edits if r["tool"] == tool and r["ok"]]
		s = sk["suspect"].get(tool, {})
		sus = s.get("identical_anchor_repeat", 0) + s.get("fuzzy_anchor_repeat", 0)
		drift = sum(1 for r in edits if r["tool"] == tool and r["kind"] in PROXY_KINDS)
		switch = sk["switches"].get(("edit", "patch") if tool == "edit" else ("patch", "edit"), 0)
		rows.append((tool, len(ok), sus, b["abandoned"], b["attempts"], drift, int(switch)))
	if md:
		print("| tool | successful calls | wrong-landing proxy | proxy % | abandoned attempts | drift/verify errors | censored to other engine |\n|---|" + "---|" * 6)
		for tool, ok, sus, ab, at, drift, other in rows:
			print(f"| {tool} | {ok} | {sus} | {pc(sus, ok)} | {ab}/{at} | {drift} | {other} |")
		return
	for tool, ok, sus, ab, at, drift, switch in rows:
		fallback = "edit" if tool == "patch" else "patch"
		article = "an" if fallback[0] in "aeiou" else "a"
		print(f"  {tool:6} wrong-landing proxy {sus:>3} of {ok:>4} successes ({pct(sus, ok)})"
		      f" | abandoned {ab}/{at} | drift/verify errors {drift}"
		      f" | failures followed by {article} {fallback}-engine call: {switch}")


# ── main ─────────────────────────────────────────────────────────────────────
def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("dumps", nargs="*", help="JSONL dumps from session_baseline.py --json")
	parser.add_argument("--tag", action="append", default=[], metavar="NAME=PATH",
	                    help="name a dump explicitly instead of its file stem (adds it if "
	                    "not listed); repeatable")
	parser.add_argument("--include-harness", action="store_true", help="count /tmp scratch traffic too")
	parser.add_argument("--markdown", action="store_true", help="paste-ready markdown tables, no prose report")
	parser.add_argument("--json", action="store_true", help="emit merged location-tagged records")
	parser.add_argument("--failures", choices=TOOLS + ("all",), help="verbatim failure texts, merged")
	parser.add_argument("--verbose", action="store_true", help="per-session rows in the paired section")
	args = parser.parse_args()

	tagged = {}
	for item in args.tag:
		name, _, path = item.partition("=")
		if not name or not path:
			parser.error(f"--tag expects NAME=PATH, got {item!r}")
		tagged[path] = name
	# A --tag path does not have to be repeated in `dumps`.
	paths = list(args.dumps) + [path for path in tagged if path not in args.dumps]
	if not paths:
		parser.error("no dumps given — pass JSONL files from session_baseline.py --json")
	for path in paths:
		if not os.path.isfile(path):
			parser.error(f"no such dump: {path}")
	entries = [(tagged.get(path, os.path.splitext(os.path.basename(path))[0]), path) for path in paths]

	records, by_location = load(entries)
	if args.json:
		for record in records:
			print(json.dumps(record))
		return 0
	if args.failures:
		sb.show_failures(records, args.failures, args.include_harness)
		return 0

	if not args.markdown:
		# The standard single-corpus report, run on the merged records (adds a by-machine cut).
		sb.report(records, len({r["session"] for r in records}),
		          argparse.Namespace(project=None, model=None, verbose=args.verbose,
		                             include_harness=args.include_harness))
		print()
		print("=" * 78)
		print("AGGREGATED ACROSS MACHINES")
		print("=" * 78)

	edits = [r for r in records if r["edit_engine"] and (args.include_harness or not r["harness"])]
	edits_by_location: dict[str, list[dict]] = collections.defaultdict(list)
	for record in edits:
		edits_by_location[record["location"]].append(record)

	section("corpus per machine", args.markdown)
	corpus_table(by_location, args.markdown)

	section("failed calls per machine (edit vs patch, real work)", args.markdown)
	strata = strata_of(edits_by_location)
	print_strata(strata, args.markdown)
	e, p = [r for r in edits if r["tool"] == "edit"], [r for r in edits if r["tool"] == "patch"]
	pooled = fisher_one_tailed(*rates(e), *rates(p))
	cmh_p, mh_or = cmh([tuple(rest) for _, *rest in strata])
	if args.markdown:
		print(f"| **pooled (all machines)** | {len(e)} | {rates(e)[0]} | {pc(*rates(e))} "
		      f"| {len(p)} | {rates(p)[0]} | {pc(*rates(p))} | "
		      f"{f'{pooled:.4f}' if pooled is not None else 'n/a'} |")
		if cmh_p is not None:
			print(f"\nCochran–Mantel–Haenszel across machines: p = {cmh_p:.4g}, pooled "
			      f"Mantel–Haenszel odds ratio (edit vs patch) = {mh_or:.2f}.")
		print("\nSingle-arm machines contribute no within-stratum contrast (p = n/a there).")
	else:
		print(f"{'pooled':22} {f'{rates(e)[0]}/{len(e)}':>10} {pct(*rates(e)):>7}   "
		      f"{f'{rates(p)[0]}/{len(p)}':>10} {pct(*rates(p)):>7}   "
		      f"{(f'{pooled:.4f}' if pooled is not None else 'n/a'):>12}")
		if cmh_p is not None:
			print(f"  CMH across machines: p = {cmh_p:.4g} | pooled MH odds ratio (edit vs patch) = {mh_or:.2f}")
		print("  single-arm machines contribute no within-stratum contrast (p = n/a there).")

	section("arm separation (where the engines actually meet)", args.markdown)
	both = [loc for loc, rows in sorted(edits_by_location.items())
	        if any(r["tool"] == "edit" for r in rows) and any(r["tool"] == "patch" for r in rows)]
	if args.markdown:
		print("| machine | sessions with edits | sessions using BOTH engines |\n|---|" + "---|" * 2)
		for loc, rows in sorted(edits_by_location.items()):
			shared = ({r["session"] for r in rows if r["tool"] == "edit"}
			          & {r["session"] for r in rows if r["tool"] == "patch"})
			print(f"| {loc} | {len({r['session'] for r in rows})} | {len(shared)} |")
		print(f"\nMachines with both engines: {', '.join(both) or 'none'}. Every pooled number folds machine "
	      "identity into the comparison; the stratified cut above is what bounds it.")
	else:
		print(f"  machines with BOTH engines: {', '.join(both) or 'none'}")
		for loc, rows in sorted(edits_by_location.items()):
			shared = ({r["session"] for r in rows if r["tool"] == "edit"}
			          & {r["session"] for r in rows if r["tool"] == "patch"})
			print(f"  {loc:12} sessions using both engines: {len(shared):>3} of {len({r['session'] for r in rows})}")
		print("  NOTE: different machines are different work. The stratified cut bounds how much of")
		print("  the pooled gap is machine identity; only the randomized A/B settles causality.")

	section("attempt anatomy per machine", args.markdown)
	anatomy_table(by_location, args.include_harness, args.markdown)

	section("quality proxies on the merged corpus", args.markdown)
	quality_table(records, args.include_harness, args.markdown)

	section("merged failure categories (real work)", args.markdown)
	if args.markdown:
		mixes = {t: collections.Counter(r["kind"] for r in edits if r["tool"] == t and not r["ok"]) for t in TOOLS}
		print("| category | edit | patch |\n|---|---|---|")
		for kind, _ in sum(mixes.values(), collections.Counter()).most_common():
			print(f"| {kind} | {mixes['edit'].get(kind, 0)} | {mixes['patch'].get(kind, 0)} |")
	else:
		for tool in TOOLS:
			fails = [r for r in edits if r["tool"] == tool and not r["ok"]]
			print(f"  {tool}: {len(fails)} failures")
			for kind, count in collections.Counter(r["kind"] for r in fails).most_common():
				print(f"    {kind:20} {count:>5}  {pct(count, len(fails))}")

	if args.markdown:
		print("\nRegenerate: `python3 scripts/aggregate_baseline.py "
		      + " ".join(os.path.basename(path) for _, path in entries) + " --markdown`")
	return 0


if __name__ == "__main__":
	sys.exit(main())
