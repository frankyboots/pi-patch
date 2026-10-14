#!/usr/bin/env python3
"""Generate test/golden/span-map.json from the reference hermes implementation.

Every case records the reference output of the span-mapping helpers from
tools/fuzzy_match.py for a deterministic corpus — hand fixtures taken from
hermes' tests/tools/test_fuzzy_match.py plus seeded fuzz mutations — so the
TypeScript port in src/span-map.ts can be differentially tested against the
real thing (docs/PLAN.md Tier 1 task 1).

Regenerate with:

    python3 scripts/generate_span_map_golden.py > test/golden/span-map.json

The reference checkout defaults to ~/.hermes/hermes-agent; override with
HERMES_HOME. The corpus is BMP-only: for BMP strings Python code-point
indices coincide with JS UTF-16 unit indices, which is what the TS port
maps. Astral pass-through is covered by a dedicated TS unit test instead.
"""

import json
import os
import random
import re
import sys

HERMES_HOME = os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes/hermes-agent"))
sys.path.insert(0, HERMES_HOME)
from tools import fuzzy_match as fm  # noqa: E402


def exact_spans(s, pattern):
    """Non-overlapping matches, hermes `_strategy_exact` (re.finditer semantics)."""
    if not pattern:
        return []
    return [list(m.span()) for m in re.finditer(re.escape(pattern), s)]


HAND_FIXTURES = [
    # (name, content, pattern) — from hermes test_fuzzy_match.py bodies
    ("extra spaces match", "def  foo(  x,  y  ): def  foo(  x,  y  ): x", "def foo( x, y ):"),
    ("boundary space preserved", "foo   bar baz", "foo bar"),
    ("boundary space in code edit", "result = compute(a,  b) + tail", "compute(a, b)"),
    ("trailing ws consumed when match ends in space", "a = foo   + bar", "foo +"),
    ("pattern trailing space absorbs run", "foo   bar baz", "foo "),
    ("indentation flexible", "    def foo():\n        pass", "def foo():\n    pass"),
    ("em dash in content", "return value\u2014fallback", "return value--fallback"),
    ("em dash in pattern", "return value--fallback", "return value\u2014fallback"),
    ("ellipsis expansion", "Wait for it\u2026and done", "Wait for it...and done"),
    ("unicode minus", "offset = value \u2212 1\nprint(offset)", "offset = value - 1"),
    ("ideographic space CJK", "label \u3000 first chapter\nbody text\n", "label  first chapter"),
    ("expansion boundary snap", "value = x\u2014y\n", "value = x--y"),
    ("smart quotes both sides", 'say("hi") and say("hi") again', 'say("hi")'),
    ("self-overlapping pattern", "aaaaaa", "aa"),
    ("no match at all", "one\ntwo\nthree\nfour\n", "completely different"),
    ("multiline repeated block", "a b  c\n d e\na b  c\n d e\n", "a b c\n d e"),
    # line transforms must find BOTH windows (margin/indent/boundary churn only)
    ("repeated strip window", "  x = 1\ny = 2  \n  x = 1\ny = 2  \n", "x = 1\ny = 2"),
    ("repeated lstrip window", "    x = 1\n    y = 2\n\tx = 1\n    y = 2\n", "x = 1\ny = 2"),
    ("repeated boundary window", "  x = 1\ny = 2\n  x = 1\ny = 2\n", "x = 1\ny = 2  "),
    ("tabs collapsed", "x\t=\t1\ny\t=\t2\n", "x = 1\ny = 2"),
    ("trailing newline window", "one\ntwo\nthree\n", "two\n"),
    ("blank lines in window", "top\n\nbottom\n", "\n"),
]

SEEDS = [
    'def apply_v4a(ops):\n    for op in ops:\n        if op.kind == "update":\n            return op.path\n    return None\n',
    "const total = items.reduce((acc, x) => acc + x, 0);\nif (total > 100) {\n\tthrow new Error(`too big: ${total}`);\n}\n",
    "The quick brown fox\u2014quick, we say\u2014jumps over the lazy dog...\nIt didn't wait \u2014 not once.\n",
    "class Calculator:\n    def add(self, a, b):\n        result = a + b\n        return result\n",
    "x = value \u2212 1  # typographic minus\ny = value - 2  # ascii minus\nz = x \u3000 + y\n",
    "if (a === b) { return true; }   // aligned comment\nelse { return false; }\t\t// tabbed comment\n",
]

UNI_CHARS = list(fm.UNICODE_MAP.keys())
WS_INJECTIONS = ["  ", "    ", " \t ", " ", "\t", "\t\t", " \t"]
ASCII_OF = {k: v for k, v in fm.UNICODE_MAP.items()}


def duplicate_block(s, rng):
    """Re-insert a random 1..3-line block, creating multi-match content."""
    lines = s.split("\n")
    if len(lines) < 2:
        return s
    n = rng.randint(1, min(3, len(lines)))
    i = rng.randrange(len(lines) - n + 1)
    block = lines[i:i + n]
    j = rng.randrange(len(lines) + 1)
    return "\n".join(lines[:j] + block + lines[j:])


def mutate_content(s, rng):
    """Make the file drift: inject whitespace runs and typographic chars."""
    if rng.random() < 0.4:
        s = duplicate_block(s, rng)
    out = list(s)
    for _ in range(rng.randint(1, 5)):
        if not out:
            break
        i = rng.randrange(len(out))
        kind = rng.random()
        if kind < 0.55:
            out[i] = rng.choice(WS_INJECTIONS)
        else:
            out[i] = rng.choice(UNI_CHARS)
    return "".join(out)


def derive_pattern(s, rng):
    """Derive a near-miss pattern from the content (light mutation)."""
    lines = s.split("\n")
    if len(lines) > 1 and rng.random() < 0.6:
        n = rng.randint(1, min(4, len(lines)))
        i = rng.randrange(len(lines) - n + 1)
        window = lines[i:i + n]
    else:
        if len(s) < 2:
            return s
        a = rng.randrange(len(s) - 1)
        b = rng.randrange(a + 1, len(s) + 1)
        return s[a:b]
    out = []
    for line in window:
        r = rng.random()
        if r < 0.3:
            line = line.lstrip()  # dropped indentation — the classic miss
        elif r < 0.5:
            line = re.sub(r"[ \t]+", " ", line)  # collapsed runs
        elif r < 0.65:
            for uni, ascii_repl in ASCII_OF.items():
                line = line.replace(ascii_repl, uni)  # model "cleaned up" typography
        elif r < 0.75:
            line = line + " "  # decorative trailing space
        out.append(line)
    return "\n".join(out)


def build_cases():
    # Default seed is stable so the committed golden is reproducible; override
    # with GOLDEN_SEED to differentially re-validate the port on fresh fuzz.
    rng = random.Random(int(os.environ.get("GOLDEN_SEED", "20260214")))
    cases = []
    for name, content, pattern in HAND_FIXTURES:
        cases.append((f"hand: {name}", content, pattern))
    for si, seed in enumerate(SEEDS):
        for k in range(12):
            content = mutate_content(seed, rng) if rng.random() < 0.6 else seed
            pattern = derive_pattern(seed, rng)
            cases.append((f"fuzz: seed{si}#{k}", content, pattern))
    return cases


def case_record(name, content, pattern):
    rec = {"name": name, "content": content, "pattern": pattern}

    # Strategy 7 plumbing: Unicode normalization + norm→orig span mapping.
    norm_content = fm._unicode_normalize(content)
    norm_pattern = fm._unicode_normalize(pattern)
    content_map = fm._build_orig_to_norm_map(content)
    pattern_map = fm._build_orig_to_norm_map(pattern)
    norm_matches = exact_spans(norm_content, norm_pattern)
    rec["unicode"] = {
        "norm_content": norm_content,
        "norm_pattern": norm_pattern,
        "content_map": content_map,
        "pattern_map": pattern_map,
        "norm_matches": norm_matches,
        "mapped": [list(m) for m in fm._map_positions_norm_to_orig(content_map, norm_matches)],
    }

    # Strategy 3 plumbing: whitespace collapse + collapse-aware span mapping.
    collapsed = re.sub(r"[ \t]+", " ", content)
    collapsed_pattern = re.sub(r"[ \t]+", " ", pattern)
    ws_matches = exact_spans(collapsed, collapsed_pattern)
    rec["whitespace"] = {
        "collapsed_content": collapsed,
        "collapsed_pattern": collapsed_pattern,
        "norm_matches": ws_matches,
        "mapped": [list(m) for m in fm._map_normalized_positions(content, collapsed, ws_matches)],
    }

    # Line-window strategies: transformed-line matching via the shared windowing.
    content_lines = content.split("\n")
    rec["lines_strip"] = [list(m) for m in fm._match_transformed_lines(content, pattern, lambda ls: [l.strip() for l in ls])]
    rec["lines_lstrip"] = [list(m) for m in fm._match_transformed_lines(content, pattern, lambda ls: [l.lstrip() for l in ls])]
    rec["lines_strip_boundary"] = [list(m) for m in fm._match_transformed_lines(content, pattern, fm._strip_boundary)]

    # `_calculate_line_positions` over every 1..3-line window (golden for the windowing math).
    positions = []
    for i in range(len(content_lines)):
        for n in (1, 2, 3):
            if i + n <= len(content_lines):
                span = fm._calculate_line_positions(content_lines, i, i + n, len(content))
                positions.append([i, i + n, span[0], span[1]])
    rec["line_positions"] = positions
    return rec


def main():
    cases = build_cases()
    doc = {
        "generator": "scripts/generate_span_map_golden.py",
        "hermes_home": HERMES_HOME,
        "seed": int(os.environ.get("GOLDEN_SEED", "20260214")),
        "note": "BMP-only corpus: Python code-point indices == JS UTF-16 unit indices here.",
        "cases": [case_record(*c) for c in cases],
    }
    json.dump(doc, sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
