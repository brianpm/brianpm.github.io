#!/usr/bin/env python3
"""Merge a downloaded codes.json into data/codes.json.

    python3 scripts/merge_codes.py ~/Downloads/codes.json

The label generator already does this for you: paste the current data/codes.json
into its "codes already issued" box and the file it hands back is the whole
history, ready to replace this one. This script is for the time you forget, and
end up with a download that holds only the newest batch.

Batches are unioned by id, so running it twice is a no-op and merging a file that
was already complete changes nothing.

It refuses to write if a code would land in two batches. That is not a tidiness
check: two physical stickers carrying the same code cannot be told apart later,
and no edit to this file can undo it once they are on bottles.
"""

import datetime
import json
import pathlib
import sys

TARGET = pathlib.Path("data/codes.json")
ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

# Field order and sort must match model.canonical('codes') in cellar-model.js,
# so a merge produces the same bytes the app would and does not show up as a
# spurious rewrite on the next sync.
FIELDS = ["id", "printedAt", "stock", "codes"]


def load(path):
    if not path.exists():
        return {"schemaVersion": 1, "alphabet": ALPHABET, "length": 6, "batches": []}
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        sys.exit(f"{path}: invalid JSON -- {e}")
    if not isinstance(doc.get("batches"), list):
        sys.exit(f"{path}: no 'batches' list -- is this a codes.json?")
    return doc


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__.strip().splitlines()[2].strip())

    incoming_path = pathlib.Path(sys.argv[1]).expanduser()
    if not incoming_path.exists():
        sys.exit(f"no such file: {incoming_path}")
    if not TARGET.parent.exists():
        sys.exit("run this from the root of the cellar-data repo (no data/ here)")

    base = load(TARGET)
    incoming = load(incoming_path)

    merged, by_id = [], {}
    for batch in base["batches"] + incoming["batches"]:
        bid = batch.get("id")
        if bid in by_id:
            if by_id[bid] != batch:
                sys.exit(f"batch {bid} differs between the two files -- merge it by hand")
            continue
        by_id[bid] = batch
        merged.append(batch)

    owner, clashes = {}, []
    for batch in merged:
        for code in batch.get("codes", []):
            if code in owner and owner[code] != batch["id"]:
                clashes.append(f"{code}: issued in both {owner[code]} and {batch['id']}")
            owner[code] = batch["id"]
    if clashes:
        sys.exit("STOP -- the same code appears in two batches, so two stickers "
                 "are identical:\n  " + "\n  ".join(clashes) +
                 f"\n\n{TARGET} was not written.")

    merged.sort(key=lambda b: (b.get("printedAt", ""), b.get("id", "")))

    now = (datetime.datetime.now(datetime.timezone.utc)
           .isoformat(timespec="milliseconds").replace("+00:00", "Z"))
    out = {
        "schemaVersion": 1,
        "updatedAt": now,
        "alphabet": base.get("alphabet") or incoming.get("alphabet") or ALPHABET,
        "length": base.get("length") or incoming.get("length") or 6,
        "batches": [{k: b[k] for k in FIELDS if k in b} for b in merged],
    }
    TARGET.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"{TARGET}: {len(merged)} batch(es), {len(owner)} codes issued in total")
    for batch in merged:
        print(f"  {batch['id']}  {len(batch.get('codes', [])):>4} codes  "
              f"{batch.get('printedAt', '')}  {batch.get('stock', '')}")


main()
