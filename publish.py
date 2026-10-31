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
MAX_FIELDS = 6
# Regroup fields only when a fresh clustering beats keeping last build's fields by this much modularity.
REGROUP_MARGIN = 0.03


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


def build_graph(vault, previous_fields=None):
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

    # Group domains into at most MAX_FIELDS "fields" (the brand allows six categorical colours) by
    # greedy modularity merging: join the two groups whose notes link more than their size predicts.
    domains = [i for i in range(len(notes)) if kind[i] == "domain"]
    volume, affinity, internal = Counter(), Counter(), Counter()
    for a, b in edges:
        da, db = notes[a].get("domain"), notes[b].get("domain")
        if da is None or db is None:
            continue
        volume[da] += 1
        volume[db] += 1
        if da == db:
            internal[da] += 1
        else:
            affinity[frozenset((da, db))] += 1

    m = sum(volume.values()) / 2 or 1

    def between(x, y):
        return sum(affinity[frozenset((a, b))] for a in x for b in y)

    def gain(x, y):
        return between(x, y) / m - sum(volume[a] for a in x) * sum(volume[b] for b in y) / (2 * m * m)

    def modularity(groups):
        return sum((sum(internal[d] for d in g) + between(g, g) / 2) / m - (sum(volume[d] for d in g) / (2 * m)) ** 2
                   for g in groups)

    clusters = [[d] for d in domains]
    while len(clusters) > MAX_FIELDS:
        i, j = max(((i, j) for i in range(len(clusters)) for j in range(i + 1, len(clusters))),
                   key=lambda p: gain(clusters[p[0]], clusters[p[1]]))
        clusters[i] += clusters.pop(j)
    members = Counter(n.get("domain") for n in notes if n["type"] == "mechanism")

    # Fields (and so colours) persist between builds: keep last build's grouping, slot new domains
    # into the field they tie to most, and regroup only when that is clearly better. A regroup still
    # hands each new group the number of the old field it overlaps most, so colours move as little as possible.
    previous_fields = previous_fields or {}
    kept = defaultdict(list)
    for d in domains:
        if notes[d]["title"] in previous_fields:
            kept[previous_fields[notes[d]["title"]]].append(d)
    if not kept:
        clusters.sort(key=lambda c: -sum(members[d] for d in c))
        field_of = {d: f for f, c in enumerate(clusters) for d in c}
        fields_note = f"Fields grouped from scratch (modularity {modularity(clusters):.3f})."
    else:
        for d in domains:
            if notes[d]["title"] not in previous_fields:
                kept[max(kept, key=lambda f: gain([d], kept[f]))].append(d)
        q_kept, q_fresh = modularity(kept.values()), modularity(clusters)
        if q_fresh - q_kept < REGROUP_MARGIN:
            field_of = {d: f for f, ds in kept.items() for d in ds}
            fields_note = f"Fields kept from last build (modularity {q_kept:.3f}; regrouping would give {q_fresh:.3f})."
        else:
            overlaps = sorted(((sum(members[d] for d in set(c) & set(ds)), i, f)
                               for i, c in enumerate(clusters) for f, ds in kept.items()), reverse=True)
            label, used = {}, set()
            for overlap, i, f in overlaps:
                if overlap and i not in label and f not in used:
                    label[i] = f
                    used.add(f)
            spare = iter(f for f in range(MAX_FIELDS) if f not in used)
            field_of = {d: label[i] if i in label else label.setdefault(i, next(spare))
                        for i, c in enumerate(clusters) for d in c}
            moved = sum(1 for d in domains if previous_fields.get(notes[d]["title"]) not in (None, field_of[d]))
            fields_note = (f"Fields regrouped: modularity {q_kept:.3f} -> {q_fresh:.3f}; "
                           f"{moved} domain(s) changed field.")
    for d, f in field_of.items():
        notes[d]["field"] = f
    order = sorted(domains, key=lambda d: (field_of[d], -members[d], d))

    nodes = [{"id": i, **{k: v for k, v in n.items() if v not in (None, "", [])}} for i, n in enumerate(notes)]
    counts = Counter(kind)
    return {
        "issues": max((n["issue"] for n in notes if n["type"] == "source"), default=0),
        "counts": {"notes": len(notes), "links": len(edges), **{f"{k}s": v for k, v in counts.items()}},
        "fields": max(field_of.values(), default=-1) + 1,
        "domainOrder": order,
        "nodes": nodes,
        "links": [list(e) for e in sorted(edges)],
    }, unresolved, fields_note


def git(*args, check=True):
    return subprocess.run(["git", "-C", str(ROOT), *args], check=check, text=True, capture_output=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--vault", type=Path, default=DEFAULT_VAULT)
    ap.add_argument("--no-push", action="store_true", help="rebuild graph.json without committing")
    args = ap.parse_args()

    if not args.vault.is_dir():
        sys.exit(f"Vault not found: {args.vault}")
    try:
        previous = json.loads(OUT.read_text(encoding="utf-8"))
        previous.pop("generated", None)
    except (FileNotFoundError, json.JSONDecodeError):
        previous = None
    previous_fields = {n["title"]: n["field"] for n in (previous or {}).get("nodes", [])
                       if n.get("type") == "domain" and "field" in n}

    graph, unresolved, fields_note = build_graph(args.vault, previous_fields)
    c = graph["counts"]
    print(f"{c['notes']} notes ({c.get('sources', 0)} sources, {c.get('mechanisms', 0)} mechanisms, "
          f"{c.get('domains', 0)} domains), {c['links']} links, Issues 1-{graph['issues']}")
    if unresolved:
        print(f"{sum(unresolved.values())} links point at notes that don't exist yet (skipped): "
              + ", ".join(f"[[{t}]]" for t, _ in unresolved.most_common(5)))
    print(fields_note)

    if previous == graph:
        # A --no-push preview may already have written this graph without committing it.
        pending = git("status", "--porcelain", "--", "docs/graph.json").stdout.strip()
        if args.no_push or not pending:
            print("Graph unchanged; nothing to publish.")
            return
        print("Graph matches the last --no-push preview; publishing it.")
    else:
        graph = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), **graph}
        tmp = OUT.with_suffix(".tmp")
        tmp.write_text(json.dumps(graph, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        tmp.replace(OUT)
        print(f"Wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1024:.0f} KB)")
        if args.no_push:
            return

    # Pick up anything pushed from elsewhere (e.g. edits on github.com) so our push fast-forwards.
    pull = git("pull", "--ff-only", "--quiet", check=False)
    if pull.returncode:
        sys.exit(f"Couldn't fast-forward to the remote before committing:\n{pull.stderr}")
    git("add", "docs/graph.json")
    git("commit", "-m", f"Update brain: {c['notes']} notes, {c['links']} links (Issues 1-{graph['issues']})")
    push = git("push", check=False)
    if push.returncode:
        sys.exit(f"Committed, but push failed:\n{push.stderr}")
    print("Pushed. GitHub Pages will redeploy in a minute or two.")


if __name__ == "__main__":
    main()
