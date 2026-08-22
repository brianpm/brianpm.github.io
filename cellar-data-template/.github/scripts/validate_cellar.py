#!/usr/bin/env python3
"""Check the invariants the cellar app relies on.

Runs in CI on every push to data/. A missing file is fine — the app creates each
one lazily on first write — but a malformed or self-contradictory one is not.

Exits non-zero with a list of problems, which is what triggers the failure email.
"""

import json
import pathlib
import sys

DATA = pathlib.Path("data")
CODE_CHARS = set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

problems = []


def load(name, empty_key):
    """Return the list under `empty_key`, or [] if the file does not exist yet."""
    path = DATA / f"{name}.json"
    if not path.exists():
        return {}, []
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        problems.append(f"{path}: invalid JSON — {e}")
        return {}, []
    if not isinstance(doc, dict):
        problems.append(f"{path}: top level must be an object")
        return {}, []
    items = doc.get(empty_key, [])
    if not isinstance(items, list):
        problems.append(f"{path}: '{empty_key}' must be a list")
        return doc, []
    return doc, items


def dupes(values):
    seen, out = set(), set()
    for v in values:
        if v in seen:
            out.add(v)
        seen.add(v)
    return out


config, fridges = load("config", "fridges")
_, wines = load("wines", "wines")
_, bottles = load("bottles", "bottles")
_, entries = load("archive", "entries")
codes_doc, batches = load("codes", "batches")

# --- ids are unique within each collection -------------------------------

for label, items in (("wines", wines), ("bottles", bottles),
                     ("archive entries", entries), ("fridges", fridges)):
    d = dupes([x.get("id") for x in items if isinstance(x, dict)])
    if d:
        problems.append(f"duplicate {label} id(s): {sorted(d)}")

# --- a bottle is either live or archived, never both ---------------------

live_ids = {b.get("id") for b in bottles}
archived_bottle_ids = {e.get("bottleId") for e in entries}
both = live_ids & archived_bottle_ids
if both:
    problems.append(
        f"bottle(s) present in BOTH bottles.json and archive.json: {sorted(both)}"
    )

# --- every bottle points at a real wine ----------------------------------

wine_ids = {w.get("id") for w in wines}
for b in bottles:
    if b.get("wineId") not in wine_ids:
        problems.append(f"bottle {b.get('id')} references unknown wineId {b.get('wineId')}")

# --- no two live bottles share a QR code ---------------------------------

live_codes = [b.get("code") for b in bottles if b.get("code")]
d = dupes(live_codes)
if d:
    problems.append(f"QR code(s) on more than one live bottle: {sorted(d)}")

# --- codes are well formed and were actually issued ----------------------

issued = set()
for batch in batches:
    for c in batch.get("codes", []):
        issued.add(c)

batch_dupes = dupes([c for b in batches for c in b.get("codes", [])])
if batch_dupes:
    problems.append(f"code(s) issued in more than one batch: {sorted(batch_dupes)}")

for c in set(live_codes) | {e.get("code") for e in entries if e.get("code")}:
    if len(c) != 6 or not set(c) <= CODE_CHARS:
        problems.append(f"malformed code in use: {c!r}")
    elif issued and c not in issued:
        problems.append(f"code {c} is in use but was never issued in codes.json")

# --- locations resolve ---------------------------------------------------

fridge_ids = {f.get("id") for f in fridges}
for b in bottles:
    fid = b.get("fridgeId")
    if fid and fid not in fridge_ids:
        problems.append(f"bottle {b.get('id')} references unknown fridgeId {fid}")

# --- money is an integer number of cents ---------------------------------

for b in bottles:
    cost = b.get("costCents")
    if cost is not None and not isinstance(cost, int):
        problems.append(f"bottle {b.get('id')} has non-integer costCents {cost!r}")

# --- report --------------------------------------------------------------

if problems:
    print(f"{len(problems)} problem(s) found:\n")
    for p in problems:
        print(f"  - {p}")
    sys.exit(1)

print(
    f"OK — {len(wines)} wines, {len(bottles)} live bottles, "
    f"{len(entries)} archived, {len(issued)} codes issued."
)
