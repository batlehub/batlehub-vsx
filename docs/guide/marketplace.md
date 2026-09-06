# Marketplace mode

RFC 0011 §12 phase 8. Stock VS Code reads its gallery from `product.json`,
updates overwrite that file, and nothing in settings repoints it. So the
extension is the gallery: a **BatleHub** view in the activity bar.

## Browse and search

The view lists what the registry answers — already filtered server-side by
what your credential may see — with each entry's state against the editor:

| Row | Meaning |
| --- | --- |
| `1.2.0` | in the registry, not installed |
| `1.2.0 · installed` | installed at that version |
| `1.1.0 → 1.2.0` | installed from here at 1.1.0, the registry has 1.2.0 |

The search icon asks for a query (empty lists everything), refresh asks the
registry again, and **Check for updates** compares every extension installed
from here with the registry. Clicking a row opens its details: version,
signature state, the supply-chain verdict, the readme in the editor's markdown
preview, and the actions.

## Install

The inline **Install** (or the details' action) does, in order:

1. fetch the extension document, then the package, with the credential;
2. read the package's manifest; for every `extensionDependencies` and
   `extensionPack` entry the editor does not hold, do the same from the
   registry — depth-first, cycle-guarded; one the registry lacks is reported,
   not fatal, and the editor names it at install;
3. refuse a version whose verdict is `denied` or `quarantined`; ask before
   installing a `warned` one;
4. when the entry carries the registry's signature (RFC 0020), fetch the
   archive and the public key and verify the Ed25519 signature over the
   package bytes — a package that does not verify is not installed
   (`batlehub.verifySignatures` turns this off);
5. hand each package, dependencies first, to the editor's own install
   command, so its engine, trust and dependency checks still run;
6. record the id, version and registry in the install ledger.

A signature that is an upstream's — relayed from a marketplace, or provided
by the publisher — has no registry key to verify against; the details say
so, and the editor's own verifier is the one that reads it.

## By id

**BatleHub: Install extension by id…** takes `publisher.name` or
`publisher.name@1.2.3`, for a scripted setup or an extension the search did
not surface.
