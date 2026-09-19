# Deck Curator

**Build and curate species flashcard decks — from a spreadsheet, an iNaturalist search, or a typed list — and export them for the [Flashcards app](https://cards.unimpossy.com).**

Deck Curator is a fully client-side web app. Everything — your species lists, photos, and iNaturalist API responses — stays in your browser; nothing is uploaded anywhere. Exporting produces a zip archive that can be studied in the Flashcards app or committed as a deck repository.

## How curation works

1. **Start a deck** — name it (this becomes the deck's id and label).
2. **Bring in species**, three ways:
   - **Type or paste names** — one per line; scientific names are resolved on iNaturalist to fill in common name, family, and taxon id.
   - **iNaturalist search** — a lat/lng circle (radius in km) plus an optional taxon filter lists the most-observed species in the area; add the ones you want, with auto-picked Creative Commons photos.
   - **Spreadsheet** — the [template](#getting-started) or any survey-style workbook; category falls back to the sheet name, unknown columns are ignored.
3. **Edit properties** — common name, scientific name, alternate names, family (common/latin), native status, invasive flag, rarity, category — inline in the table or on the species page.
4. **Choose photos** — per species, browse the top-voted CC-licensed iNaturalist photos, pin specific ones, or upload your own photos. Every photo carries its credit (observer + license), which is exported into the manifest and rendered by the app's credits page.
5. **Review & export** — a validation report (duplicate names, missing photos/licenses/credits) plus the archive build: `manifest.json` + `photos/`.

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
└── photos/         # <slug>-main.jpg, <slug>-secondary-N.jpg
```

It doubles as a deck-repository layout: drop the unzipped directory into the app repo's `decks/` registry to ship a curated deck as a built-in.

## Privacy

No accounts, no analytics, no server. Projects autosave to IndexedDB in your browser; "Save project file" exports a portable `.deckcurator.json` (with photos embedded) you can share or move between machines.

## License

AGPL-3.0-or-later, matching the Flashcards app.
