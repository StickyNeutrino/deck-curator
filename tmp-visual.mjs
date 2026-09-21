// Visual check: upload a curated deck through the real UI, then screenshot
// the card list next to a built-in deck. Run: node /tmp/opencode/visual-check.mjs
import { chromium } from "@playwright/test";
import { zipSync, strToU8 } from "fflate";
import sharp from "sharp";
import fs from "node:fs";

const APP = "http://localhost:5173";
const OUT = "/tmp/opencode";

const credit = {
  observer: "joodles",
  license: "cc-by-nc",
  observationUrl: "https://www.inaturalist.org/observations/38238174",
  observationId: 38238174,
  placeLabel: "San Diego County",
};

async function jpeg(color, width, height) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="${color}"/>
    <circle cx="${width * 0.5}" cy="${width * 0.5}" r="${width * 0.25}" fill="#ffffff"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

const manifest = {
  id: "curated-visual",
  label: "🌱 Curated Visual Deck",
  description: "visual check",
  cardFormat: "data",
  generator: { tool: "deck-curator", version: "1.0.0", exportedAt: "2026-09-21T00:00:00.000Z" },
  categories: [
    {
      id: "plants",
      label: "🌿 Plants",
      cards: [
        {
          name: "Cropped Portrait",
          layout: "photo-trio",
          photos: [
            // Portrait main with a crop window (smaller than the image, both dims)
            { file: "photos/a-main.jpg", role: "main", credit, crop: { x: 0.15, y: 0.05, w: 0.7, h: 0.6 } },
            { file: "photos/a-sec1.jpg", role: "secondary", credit },
            { file: "photos/a-sec2.jpg", role: "secondary", credit: { observer: "susanbar", license: "cc0" } },
          ],
          sciName: "Portraita talla",
          native: "native",
        },
        {
          name: "Uncropped Landscape",
          layout: "photo-single",
          photos: [{ file: "photos/b-main.jpg", role: "main", credit: { observer: "leavenworth", license: "cc0" } }],
          sciName: "Landscapta widea",
          native: "non-native",
          invasive: true,
        },
      ],
    },
  ],
};

const main1 = await jpeg("#2d6a4f", 600, 1200); // tall portrait
const sec1 = await jpeg("#e76f51", 800, 600);
const sec2 = await jpeg("#457b9d", 500, 900);
const wide = await jpeg("#8d5a97", 1200, 600); // wide landscape, single layout

const zip = zipSync({
  "manifest.json": strToU8(JSON.stringify(manifest)),
  "photos/a-main.jpg": new Uint8Array(main1),
  "photos/a-sec1.jpg": new Uint8Array(sec1),
  "photos/a-sec2.jpg": new Uint8Array(sec2),
  "photos/b-main.jpg": new Uint8Array(wide),
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(APP);

// Upload through the hamburger menu.
await page.getByTestId("upload-deck-input").setInputFiles({
  name: "curated-visual.zip",
  mimeType: "application/zip",
  buffer: zip,
});
await page.waitForFunction(() => {
  const el = document.querySelector('[data-testid="upload-status"]');
  return el && /imported|success/i.test(el.textContent ?? "");
}, undefined, { timeout: 15000 });
console.log("upload ok:", await page.getByTestId("upload-status").textContent());

// Card list of the uploaded deck.
await page.goto(`${APP}/card-lists?deck=curated-visual`);
await page.waitForSelector('[data-testid="card-item"]');
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/list-uploaded.png`, fullPage: false });

// Card list of a built-in (image) deck for comparison.
await page.goto(`${APP}/card-lists`);
await page.waitForSelector('[data-testid="card-item"]');
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/list-builtin.png`, fullPage: false });

// Study view of the uploaded deck (checks slot clipping of the crop).
await page.goto(`${APP}/?deck=curated-visual`);
await page.waitForSelector('[data-testid="card"]');
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/study-uploaded.png`, fullPage: false });

await browser.close();
console.log("screenshots written");
