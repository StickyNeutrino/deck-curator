# Curated Deck Archive format (v1)

A **deck archive** is the portable output of Deck Curator. It is a zip file
that can be uploaded into the Flashcard app ("user decks"), and it doubles as
a deck repository layout (`manifest.json` + image directory) so curated decks
can later be committed to the app's `decks/` registry unchanged.

```
<deck-id>.zip
├── manifest.json
└── photos/
    ├── <slug>-main.jpg
    ├── <slug>-secondary-1.jpg
    └── ...
```

## manifest.json

```jsonc
{
  "id": "my-canyon-deck",              // slug, unique
  "label": "🌿 My Canyon Deck",        // user-facing deck name (emoji allowed)
  "description": "Species of …",
  "location": {                        // optional — where this deck is relevant
    "name": "Mission Trails Regional Park",
    "lat": 32.8282,                    // optional coordinates
    "lng": -117.0522,
    "radiusKm": 10                     // optional scope radius
  },
  "cardFormat": "data",                // marks a data-driven deck (see below)
  "generator": {                       // optional provenance
    "tool": "deck-curator",
    "version": "1.0.0",
    "exportedAt": "2026-09-19T12:00:00.000Z"
  },
  "categories": [
    {
      "id": "plants",                  // slug, used as the mode/category id
      "label": "🌿 Plants",            // user-facing (emoji allowed)
      "cards": [ /* Card, below */ ]
    }
  ]
}
```

`cardFormat: "data"` tells the Flashcard app to render cards as HTML from the
structured fields. Decks **without** `cardFormat` are image decks (the existing
Canyonlands / Healthy Canyons format: each card has `front` and `back` paths to
pre-rendered JPGs) — they keep working exactly as before.

## Card (data format)

```jsonc
{
  "name": "Dwarf Nettle",              // unique across the whole deck; the study key
  "layout": "photo-trio",              // "photo-trio" (1 main + up to 2 secondary) | "photo-single" (1 main)
  "photos": [
    {
      "file": "photos/dwarf-nettle-main.jpg",  // relative to the archive root, URL-encoded when served
      "role": "main",                          // "main" | "secondary"
      "alt": "Flowering stalk, close-up",      // optional alt text
      "crop": { "x": 0.1, "y": 0, "w": 0.6, "h": 0.8 },  // optional crop window (0..1) over the source photo; omitted = automatic cover
      "credit": { /* PhotoCredit, below — REQUIRED for every photo */ }
    }
  ],
  "sciName": "Urtica urens",
  "commonName": "Dwarf Nettle",
  "altNames": ["Burning Nettle"],      // optional
  "familyCommon": "Nettle Family",     // optional
  "familyLatin": "Urticaceae",         // optional
  "native": "non-native",              // "native" | "non-native" | "unknown" (optional)
  "invasive": true,                    // optional; legacy red border flag (border: "invasive" implies it)
  "border": "invasive",                // optional colored border: "invasive" | "caution" | "rare" | "notable"
  "tags": ["phase 1", "class A"],      // optional user tags (phases, classes, units) for filtering
  "rarity": null,                      // optional free text (CNPS/CESA/FESA …)
  "taxonId": 53315,                    // optional iNaturalist taxon id
  "credits": [                         // optional; flattened photo credits for the credits page
    { "observer": "joodles", "license": "cc-by-nc",
      "observationUrl": "https://www.inaturalist.org/observations/38238174",
      "observationId": 38238174, "placeLabel": "San Diego County" }
  ]
}
```

## PhotoCredit

```jsonc
{
  "observer": "joodles",        // copyright holder: iNat username or photographer name (required)
  "license": "cc-by-nc",        // license code (required); see below
  "sourceUrl": "https://www.inaturalist.org/observations/38238174",  // optional link
  "observationId": 38238174,    // optional iNat observation id
  "placeLabel": "San Diego County"  // optional
}
```

License codes follow the iNaturalist `license_code` vocabulary:
`cc0`, `cc-by`, `cc-by-sa`, `cc-by-nc`, `cc-by-nc-sa`, `cc-by-nd`, `cc-by-nc-nd`.
iNat-derived photos must pass the same allowlist as the Healthy Canyons
pipeline (no ND variants, no missing license). User-uploaded photos may declare
`all-rights-reserved` (their own work) — the credit line still renders.

## Rendering rules (shared by Curator preview and Flashcard app)

Card canvas is a 750×1050 portrait card with background `#e4e3df`:

- **Front, `photo-trio`**: main photo spans the full card width minus 50px
  margins, top at 48px, 650×604, rounded corners (14px). Two secondary photos
  side by side below (276×295 and 324×295 at y=702). One photo = main only;
  two photos = main + first secondary. Under each photo: 12px gray (`#6b6b66`)
  credit line `© Observer · CC BY-NC` (truncated with ellipsis to fit).
- **Front, `photo-single`**: the main photo fills the same slot as the trio's
  main slot (650×604 at 50,48) — identical to a trio with no secondaries.
  A deck that uses only single-photo cards renders like a "one big photo" deck.
- **Focal point**: photos are cover-cropped to their slot by default.
  `photos[].crop` ({x, y, w, h} normalized 0..1) selects the exact source
  region that fills the slot — pick bounds smaller than the photo in both
  dimensions when the automatic crop misses the organism. The legacy
  `photos[].focus` ({x, y}) remains supported: it pans the automatic crop.
- **Back**: same text stack as the Healthy Canyons rendered backs — title
  (700 weight, 72px, auto-shrink), `aka` alt-names line, scientific name
  (italic), family common, family latin (italic), native status, rarity —
  centered on the card, plus the white logo chip at top-left and the red
  invasive border applied by the app when `invasive` is true.
- **Border tags**: `border` draws a colored border around the card back —
  `invasive` = red `#b3261e` (the classic invasive marker), `caution` =
  amber `#b45309`, `rare` = purple `#6d28d9`, `notable` = blue `#1d4ed8`.
  `border: "invasive"` is equivalent to (and also emitted as) the legacy
  `invasive: true` flag, which image-based decks continue to use.
- **Card names are unique deck-wide** (the app keys study order and lookup by
  `name`). A species with several cards (same species, different photos) is
  named "Name (2)", "Name (3)"…; render the back title from `commonName`
  (falling back to `name`) so variant cards keep the clean species name.

Both renderers derive everything from the manifest — no baked images.
