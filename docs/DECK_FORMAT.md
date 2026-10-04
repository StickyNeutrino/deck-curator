# Curated Deck Archive format (v1)

A **deck archive** is the portable output of Deck Curator. It is a zip file
that can be uploaded into the Flashcard app ("user decks"), and it doubles as
a deck repository layout (`manifest.json` + image directory) so curated decks
can later be committed to the app's `decks/` registry unchanged.

Deck Curator exports three artifacts, each with one job:

| Artifact | Extension | Contents | Job |
|---|---|---|---|
| Project file | `.zip` | manifest + photos + `.git/` | The full backup — history and all |
| Deck file | `.deck` | manifest + photos | What users study |
| Light deck | `.deck.lite` | manifest only | Microscopic; photos fetched at runtime |

The **project file** and **deck file** are the same archive layout; the deck
file simply omits the optional `.git/` directory and wears the `.deck`
extension. The **light deck** is a different beast — see "Light decks" below.

```
<deck-id>.zip / <deck-id>.deck
├── manifest.json
└── photos/
    ├── <slug>-main-<unique>.jpg
    ├── <slug>-secondary-<unique>.jpg
    └── ...
```

The **project file** bundles the deck's **git history as a `.git/` directory**
at the archive root (unzipping then yields a restorable repository). The deck
file omits it: the history holds every past photo too and often dwarfs the
deck itself. Third-party decks never have one. Photo files are named after
the species slug and their role, plus a short unique suffix (uploads may be
replaced or several species can share a slug, so the file name can't be
derived from position alone). Cards reference their photos by `file`, never
by convention.

A deck file export may also **pre-crop and re-encode** photos (the curator's
"Compress photos" option): the shipped file contains only the crop region, and
its manifest entry carries the identity crop `{ "x": 0, "y": 0, "w": 1, "h": 1 }`
— "the whole file is the crop region". Renderers treat that exactly like any
crop window, so pre-cropped photos render identically to crop metadata over
the full original, just with fewer bytes. Full-resolution exports keep the
original pixels and emit crop windows over them as usual. Project files
always ship original bytes — they carry the history those bytes belong to.

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
      "animation": {                           // optional moving media (animated GIF / video clip)
        "file": "photos/dwarf-nettle-anim.mp4",// the clip itself, stored alongside
        "kind": "video",                       // "gif" | "video"
        "durationSec": 6.2                     // optional
      },
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

## Light decks (`.deck.lite`)

A **light deck** is a zip containing only `manifest.json` — no `photos/`
directory. It is microscopic (KBs for a hundred-card deck): the manifest
carries the borders, rarity, crop windows, and credits, while the photos are
**fetched at render time and cropped on the user's device**.

```jsonc
{
  "id": "my-canyon-deck",
  "label": "🌿 My Canyon Deck",
  // …same top-level shape as a full manifest…
  "cardFormat": "data",
  "format": "lite",                    // marks remote-media decks (no bundled files)
  "categories": [
    {
      "id": "plants",
      "label": "🌿 Plants",
      "cards": [
        {
          "name": "Dwarf Nettle",
          "layout": "photo-trio",
          "photos": [
            {
              "url": "https://inaturalist-open-data.s3.amazonaws.com/photos/123/original.jpg",  // instead of `file`
              "role": "main",
              "crop": { "x": 0.1, "y": 0, "w": 0.6, "h": 0.8 },   // applied after fetch, on-device
              "credit": { /* PhotoCredit — REQUIRED, exactly as in full decks */ }
            }
          ]
          // …same card fields as the data format…
        }
      ]
    }
  ]
}
```

Contract and constraints:

- **`format: "lite"`** is the machine-readable marker; a light deck's zip has
  no `photos/` directory. Every photo entry carries `url` where a full deck
  would carry `file`.
- **Size variants derive from one URL**: iNat URLs differ only in the size
  segment (`square|thumb|small|medium|large|original`), so a renderer can
  fetch a small variant for thumbnails and a larger one for card rendering.
- **Cropping is on-device**: the normalized `crop` window (or legacy
  `focus`) applies after fetch, exactly as over bundled bytes. iNaturalist's
  open-data host serves `Access-Control-Allow-Origin: *`, so both CSS-based
  mapping and canvas cropping work cross-origin.
- **Credits ride in the manifest**, so attribution renders even though the
  bytes come from the network — same license rules as full decks.
- **Only remotely sourced photos can ship light.** Uploaded photos have no
  URL to fetch; the curator refuses the export and names them. Animated
  media is also excluded for now (its display still is captured locally and
  has no remote source).
- **They are live-linked, not archived**: photos live on iNaturalist's
  servers, so a light deck needs network at render time and can break if a
  source photo disappears. Use the deck file (or project file) when bytes
  must be guaranteed. Deck Curator cannot import a light deck — import the
  full `.deck` or `.zip` instead.

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
- **Moving media**: when a card uses an animated GIF or video clip, `file`
  is the *still frame* the curator picked (that's what every renderer
  displays), and `animation` carries the clip itself for playback. Cards never
  autoplay clips.
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
