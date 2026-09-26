# Deck Curator

**Build and curate species flashcard decks — from a spreadsheet, an iNaturalist search, or a typed list — and export them for the [Flashcards app](https://cards.unimpossy.com).**

Deck Curator is a fully client-side web app. Everything — your species lists, photos, and iNaturalist API responses — stays in your browser; nothing is uploaded anywhere. Exporting produces a zip archive that can be studied in the Flashcards app or committed as a deck repository.

## How curation works

1. **Start a deck** — name it (this becomes the deck's id and label).
2. **Bring in species**, three ways:
   - **Type or paste names** — one per line; scientific names are resolved on iNaturalist to fill in common name, family, and taxon id.
   - **iNaturalist search** — pick a place by name (geocoded), on the map, or via coordinates, then list the most-observed species in that radius; add the ones you want, with auto-picked Creative Commons photos. Results carry iNat's native / non-native label from the area's place checklist.
   - **Spreadsheet** — the [template](#getting-started) or any survey-style workbook; category falls back to the sheet name, unknown columns are ignored.
3. **Run deck tools** — the 🛠 Tools menu (also on the species page toolbar) applies batch actions to the whole deck or to checkbox-selected species: fill missing names/families and re-sort categories from iNat's taxonomy, label native vs. introduced from iNat's place checklists (optionally flagging introduced species with the red invasive border), and label conservation status from NatureServe/IUCN listings (optionally flagging threatened species with the blue notable border). Tools only fill empty fields and report anything they'd have changed differently.
4. **Edit properties** — common name, scientific name, alternate names, family (common/latin), native status, border tag, rarity, category, and your own **tags** (phases, class sessions, units) for filtering — inline in the table or on the species page.
5. **Choose photos** — per species, browse the top-voted CC-licensed iNaturalist photos, pin specific ones, or upload your own photos. Every photo carries its credit (observer + license), which is exported into the manifest and rendered by the app's credits page. The crop editor keeps the slot's aspect so photos are never distorted.
6. **Review** — every card laid out front and back; flag cards that need another pass, filter down to them, and click through to edit.
7. **Review & export** — a validation report (duplicate names, missing photos/licenses/credits), the deck's **git version history** (auto-committed; restore any version), and the archive build: `manifest.json` + `photos/` + `.git/`.

## Card layouts

- **photo-trio** — the Healthy Canyons layout: one large habitat photo + up to two detail shots, each credited beneath.
- **photo-single** — one main photo only.

Layout is per-species and set from the species page. Both the curator preview and the Flashcards app render from the same manifest fields — docs/DECK_FORMAT.md is the contract.

## Licensing & attribution

Photos from iNaturalist use the same license policy as the Healthy Canyons pipeline: CC0, CC-BY, CC-BY-SA, CC-BY-NC, CC-BY-NC-SA only — **no ND variants, no all-rights-reserved photos** are ever offered. Every photo's attribution (observer, license, observation link, place) is exported in the manifest's `credits`, shown on card backs and on the app's credits page. Uploaded photos default to `all-rights-reserved`; replace the placeholder credit with the photographer's name before sharing a deck.

## Getting started

Requires Node.js 22+.

```bash
npm install
npm run dev        # http://localhost:5173
```

Other commands:

```bash
npm run build      # Production build (static SPA in build/client)
npm run typecheck
npm run test:run   # Unit/integration tests (Vitest)
npm run test:e2e   # Playwright (chromium)
```

## The archive format

See **docs/DECK_FORMAT.md**. A curated deck archive is:

```
<deck-id>.zip
├── manifest.json   # cardFormat: "data", categories, cards, photos, credits
├── photos/         # <slug>-main.jpg, <slug>-secondary-N.jpg
└── .git/           # the deck's full version history (see below)
```

It doubles as a deck-repository layout: drop the unzipped directory into the
app repo's `decks/` registry to ship a curated deck as a built-in. The archive
carries the deck's **git history**: every deck is its own git repository in
your browser (real git objects, committed automatically as you work), and the
zip includes `.git/` — so unzipped deck folders stay diffable, restorable,
and history-preserving with standard git tooling. You can also re-import any
exported deck archive ("Import deck (.zip)…" on the home page) to keep editing
it.

## Privacy

No accounts, no analytics, no server. Projects autosave to IndexedDB in your browser; nothing leaves it except the requests you can see — iNaturalist API lookups (species, photos, place checklists) and OpenStreetMap geocoding. Decks are shared or moved between machines as exported zip archives (re-importable, photos and history included).

## License

AGPL-3.0-or-later, matching the Flashcards app.
