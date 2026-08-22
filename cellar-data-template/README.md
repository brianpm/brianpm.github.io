# cellar-data — private repository template

Copy the contents of this folder into a **new private GitHub repository** named
`cellar-data`. That repo is the database for the wine cellar app at
<https://skymath.org/c/>.

This template lives in the public site repo only so it is version-controlled
alongside the app. **It contains no data and no credentials.** Nothing here is
served as part of the website.

---

## One-time setup

### 1. Create the private repo

Create `brianpm/cellar-data` on GitHub, **private**. Copy in this folder's
`.github/` directory. You do not need to create the `data/` JSON files — the app
treats a missing file as an empty one and creates it on first write.

### 2. Create a fine-grained access token

GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens**:

| Setting | Value |
|---|---|
| Resource owner | `brianpm` |
| Repository access | **Only select repositories** → `cellar-data` |
| Repository permissions → **Contents** | **Read and write** |
| Repository permissions → Metadata | Read (added automatically, mandatory) |
| Everything else | No access |
| Expiration | 1 year (not "no expiration") |

Save the token in a password manager. You will paste it into each device once.

### 3. Point the app at it

On each phone/computer, open <https://skymath.org/c/#/settings>, enter owner
`brianpm`, repo `cellar-data`, branch `main`, path `data`, and paste the token.
Press **Verify** — it should report the repo name, confirm it is private, and
show the token's expiry.

Set "This device is called" to something recognizable (`brian-iphone`); it goes
into each commit message so the history says who did what.

---

## What lives here

| File | Contents | Changes |
|---|---|---|
| `data/config.json` | Fridges, shelf counts, defaults | rarely |
| `data/wines.json` | One record per distinct wine (the label information) | occasionally |
| `data/bottles.json` | One record per physical bottle currently in a fridge | constantly |
| `data/archive.json` | Bottles that have been drunk, gifted, broken… plus notes | often |
| `data/codes.json` | Every QR label code ever printed, grouped by print batch | only when printing labels |

They are split this way so that logging a glass of wine rewrites the one small
document that changed, rather than re-uploading everything.

Cost is stored as **integer cents** (`costCents: 8999` = $89.99). Floats drift
visibly once you total a few hundred bottles.

---

## Your backup is the git history

Every change the app makes is a commit. To see what happened:

```bash
git log --oneline                             # every change, with device names
git show <sha>                                # exactly what that change did
git show <sha>:data/bottles.json              # the full file at that point
git revert <sha>                              # undo a change
```

Because the app writes files in a canonical field order with sorted arrays, each
commit diff is a handful of lines rather than a whole reformatted file — so the
history stays readable and the repo stays small. Run `git gc` once in a while.

---

## Validation

`.github/workflows/validate.yml` runs on every push and checks the invariants the
app relies on:

- every file parses as JSON
- no duplicate bottle ids
- no two live bottles share a QR code
- every `bottle.wineId` resolves to a real wine
- no id appears in both `bottles.json` and `archive.json`
- every code in use was actually issued in `codes.json`

If a push breaks one, GitHub emails you within a minute and `git revert` puts it
back. It costs nothing and it is the only thing standing between a client bug and
silently corrupted data.

---

## Printing labels

<https://skymath.org/c/labels.html> generates the QR sheets. **Paste the current
`data/codes.json` into the "codes already issued" box** before generating a new
batch, then commit the downloaded file *before* you print. Codes are never
reused — a retired code still identifies its archive entry forever.
