#!/usr/bin/env python3
"""Rebuild the Works in Progress brain from the Obsidian vault and publish it.

    python publish.py               rebuild docs/graph.json, then commit + push if it changed
    python publish.py --no-push     rebuild only (preview with: python -m http.server -d docs)
    python publish.py --vault PATH  use a vault somewhere other than the default

The vault is only ever read. Only titles, links, issue numbers, domains and each
note's core claim / definition / core problem are written to graph.json.
"""
import argparse
import json
import re
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_VAULT = Path.home() / "Documents" / "Obsidian" / "Works in Progress"
ROOT = Path(__file__).resolve().parent
OUT = ROOT / "docs" / "graph.json"

WIKILINK = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]")
ISSUE_DIR = re.compile(r"^WiP Issue (\d+)$")
URL = re.compile(r"https?://[^\s)>\]]+")
DATE = re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)? ([A-Z][a-z]+),? (\d{4})\b")
AUTHOR = re.compile(r"\s*(.+?),\s*(?:[\"“]|Works in Progress|Issue\b)")
SUMMARY_SECTION = {"source": "Core claim", "mechanism": "Definition", "domain": "Core problem"}
MAX_CLAIM = 520


def clean_name(name):
    # Git-for-Windows stores characters NTFS forbids (e.g. ':') as U+F000 + codepoint.
    return "".join(chr(ord(c) - 0xF000) if 0xF001 <= ord(c) <= 0xF07F else c for c in name)


def plain(md):
    md = WIKILINK.sub(lambda m: (m.group(2) or m.group(1)).strip(), md)
    md = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", md)
    md = re.sub(r"(\*\*|__|\*|_|`)(.+?)\1", r"\2", md)
    return re.sub(r"\s+", " ", md).strip()


def sections(text):
    out, current = {}, None
    for line in text.splitlines():
        if line.startswith("## "):
            current = line[3:].strip()
            out[current] = []
        elif current:
            out[current].append(line)
    return {k: "\n".join(v).strip() for k, v in out.items()}


def first_paragraph(body):
    para = []
    for line in body.splitlines():
        if not line.strip():
            if para:
                break
            continue
        para.append(line.lstrip("-* ").strip())
    return plain(" ".join(para))


def clip(text, limit=MAX_CLAIM):
    if len(text) <= limit:
        return text
    cut = text[:limit]
    stop = max(cut.rfind(". "), cut.rfind("; "))
    return (cut[: stop + 1] if stop > limit * 0.6 else cut.rsplit(" ", 1)[0]) + " …"


def read_notes(vault):
    notes = []
    for path in sorted(vault.rglob("*.md")):
        rel = path.relative_to(vault).parts
        if len(rel) != 2:
            continue
        folder, issue = rel[0], None
        if folder == "Domains":
            kind = "domain"
        elif folder == "Mechanisms":
            kind = "mechanism"
        elif m := ISSUE_DIR.match(folder):
            kind, issue = "source", int(m.group(1))
        else:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        secs = sections(text)
        note = {
            "title": clean_name(path.stem),
            "type": kind,
            "issue": issue,
            "claim": clip(first_paragraph(secs.get(SUMMARY_SECTION[kind]) or next(iter(secs.values()), ""))),
            "_targets": [clean_name(m.group(1)).strip() for m in WIKILINK.finditer(text)],
        }
        if kind == "source":
            cite = secs.get("Source", "")
            if url := URL.search(cite):
                note["url"] = url.group(0).rstrip(".,")
            if author := AUTHOR.match(plain(cite)):
                note["author"] = author.group(1)
            if date := DATE.search(cite):
                note["date"] = " ".join(date.groups())
        notes.append(note)
    return notes


def build_graph(vault):
    notes = read_notes(vault)
    index = {n["title"].casefold(): i for i, n in enumerate(notes)}
    edges, unresolved = set(), Counter()
    for i, n in enumerate(notes):
        for target in n.pop("_targets"):
            j = index.get(target.casefold())
            if j is None:
                unresolved[target] += 1
            elif j != i:
                edges.add((min(i, j), max(i, j)))

    nbrs = defaultdict(set)
    for a, b in edges:
        nbrs[a].add(b)
        nbrs[b].add(a)
    kind = [n["type"] for n in notes]

    # A mechanism's issue is the first issue whose essay touched it; a domain's is its first mechanism's.
    for i, n in enumerate(notes):
        if kind[i] == "mechanism":
            n["issue"] = min((notes[j]["issue"] for j in nbrs[i] if kind[j] == "source"), default=None)
    for i, n in enumerate(notes):
        if kind[i] == "mechanism" and n["issue"] is None:
            n["issue"] = min((notes[j]["issue"] for j in nbrs[i] if notes[j]["issue"]), default=1)
    for i, n in enumerate(notes):
        if kind[i] == "domain":
            n["issue"] = min((notes[j]["issue"] for j in nbrs[i] if kind[j] == "mechanism"), default=1)

    # Domain membership comes from domain notes indexing mechanisms. The primary domain (used
    # for colour) is the one most of the mechanism's related mechanisms also belong to.
    member = {i: sorted(j for j in nbrs[i] if kind[j] == "domain") for i in range(len(notes)) if kind[i] == "mechanism"}
    for i, doms in member.items():
        if doms:
            pull = Counter(d for j in nbrs[i] if kind[j] == "mechanism" for d in member[j])
            notes[i]["domain"] = max(doms, key=lambda d: (pull[d], -len(nbrs[d]), -d))
            notes[i]["domains"] = doms
    for i, n in enumerate(notes):
        if kind[i] == "domain":
            n["domain"] = i
        elif "domain" not in n:
            votes = Counter(notes[j].get("domain") for j in nbrs[i] if kind[j] == "mechanism")
            votes.pop(None, None)
            if votes:
                n["domain"] = votes.most_common(1)[0][0]

    # Order domains so related fields sit next to each other on the colour wheel.
    domains = [i for i in range(len(notes)) if kind[i] == "domain"]
    affinity = Counter()
    for a, b in edges:
        da, db = notes[a].get("domain"), notes[b].get("domain")
        if da is not None and db is not None and da != db:
            affinity[frozenset((da, db))] += 1
    order = [max(domains, key=lambda d: len(nbrs[d]))] if domains else []
    while len(order) < len(domains):
        last = order[-1]
        order.append(max((d for d in domains if d not in order), key=lambda d: (affinity[frozenset((last, d))], -d)))

    nodes = [{"id": i, **{k: v for k, v in n.items() if v not in (None, "", [])}} for i, n in enumerate(notes)]
    counts = Counter(kind)
    return {
        "issues": max((n["issue"] for n in notes if n["type"] == "source"), default=0),
        "counts": {"notes": len(notes), "links": len(edges), **{f"{k}s": v for k, v in counts.items()}},
        "domainOrder": order,
        "nodes": nodes,
        "links": [list(e) for e in sorted(edges)],
    }, unresolved


def git(*args, check=True):
    return subprocess.run(["git", "-C", str(ROOT), *args], check=check, text=True, capture_output=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--vault", type=Path, default=DEFAULT_VAULT)
    ap.add_argument("--no-push", action="store_true", help="rebuild graph.json without committing")
    args = ap.parse_args()

    if not args.vault.is_dir():
        sys.exit(f"Vault not found: {args.vault}")
    graph, unresolved = build_graph(args.vault)
    c = graph["counts"]
    print(f"{c['notes']} notes ({c.get('sources', 0)} sources, {c.get('mechanisms', 0)} mechanisms, "
          f"{c.get('domains', 0)} domains), {c['links']} links, Issues 1-{graph['issues']}")
    if unresolved:
        print(f"{sum(unresolved.values())} links point at notes that don't exist yet (skipped): "
              + ", ".join(f"[[{t}]]" for t, _ in unresolved.most_common(5)))

    try:
        previous = json.loads(OUT.read_text(encoding="utf-8"))
        previous.pop("generated", None)
    except (FileNotFoundError, json.JSONDecodeError):
        previous = None
    if previous == graph:
        print("Graph unchanged; nothing to publish.")
        return

    graph = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), **graph}
    tmp = OUT.with_suffix(".tmp")
    tmp.write_text(json.dumps(graph, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(OUT)
    print(f"Wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1024:.0f} KB)")
    if args.no_push:
        return

    git("add", "docs/graph.json")
    git("commit", "-m", f"Update brain: {c['notes']} notes, {c['links']} links (Issues 1-{graph['issues']})")
    push = git("push", check=False)
    if push.returncode:
        sys.exit(f"Committed, but push failed:\n{push.stderr}")
    print("Pushed. GitHub Pages will redeploy in a minute or two.")


if __name__ == "__main__":
    main()
