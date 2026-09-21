import * as XLSX from "xlsx";
import type { NativeStatus, Project, ProjectCategory, SpeciesEntry } from "./types";
import { makeSpecies } from "./types";
import { makeId, parseAltNames } from "./ids";
import { uuid } from "./uuid";

/**
 * Spreadsheet import: xlsx/csv → species list.
 *
 * Two shapes are accepted:
 *  - The official template (docs/template/, single sheet, documented columns).
 *  - A "Healthy Canyons survey" style workbook: one sheet per category, the
 *    first columns being species naming; extra columns are ignored.
 *
 * Column matching is case/space-insensitive and supports aliases, so real
 * world spreadsheets import without hand-editing.
 */

const COLUMN_ALIASES: Record<string, string[]> = {
  commonName: ["common name", "common names", "species (common)", "name", "english name"],
  sciName: ["scientific name", "sci name", "species (scientific)", "species", "latin name", "taxon"],
  altNames: ["alternate common names", "alt common names", "other common names", "aka", "alternate names"],
  familyLatin: ["family (latin)", "family latin", "family"],
  familyCommon: ["family (common)", "family common", "common family"],
  category: ["category", "group", "taxonomic group", "type", "sheet"],
  native: ["native status", "native", "origin"],
  invasive: ["invasive", "is invasive", "invasive?"],
  rarity: ["rarity", "rare", "ranks", "status"],
  notes: ["notes", "notes / description", "description"],
};

const NATIVE_TRUE = /^(native|yes|y|true)$/i;
const NONNATIVE_TRUE = /^(non-native|nonnative|non native|introduced|exotic|no|n|false)$/i;
const TRUE_WORDS = /^(yes|y|true|1|x)$/i;

export interface ImportResult {
  species: SpeciesEntry[];
  categories: ProjectCategory[];
  warnings: string[];
}

export function parseSpreadsheet(data: ArrayBuffer, filename: string): ImportResult {
  const workbook = XLSX.read(data, { type: "array" });
  const warnings: string[] = [];
  const species: SpeciesEntry[] = [];
  const categories: ProjectCategory[] = [];
  const categoryIds = new Map<string, string>(); // label → id

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    if (!rows.length) continue;

    const headerMap = mapHeaders(Object.keys(rows[0]));
    if (headerMap.size === 0) {
      warnings.push(`Sheet "${sheetName}": no recognizable species columns — skipped.`);
      continue;
    }

    // Category: explicit column, else the sheet name.
    const sheetCategory = sheetName.trim();
    const hasCategoryColumn = rows.some((r) => str(r[findKey(headerMap, "category")]));

    for (const row of rows) {
      const commonName = str(row[findKey(headerMap, "commonName")]);
      const sciNameRaw = str(row[findKey(headerMap, "sciName")]);
      if (!commonName && !sciNameRaw) continue;

      const categoryLabel = hasCategoryColumn && str(row[findKey(headerMap, "category")])
        ? str(row[findKey(headerMap, "category")])
        : sheetCategory;
      let categoryId = categoryIds.get(categoryLabel.toLowerCase());
      if (!categoryId) {
        categoryId = makeId(categoryLabel) || "species";
        categoryIds.set(categoryLabel.toLowerCase(), categoryId);
        categories.push({ id: categoryId, label: categoryLabel });
      }

      const native = parseNative(str(row[findKey(headerMap, "native")]));
      const invasiveField = str(row[findKey(headerMap, "invasive")]);
      const entry: SpeciesEntry = makeSpecies({
        id: uuid(),
        category: categoryId,
        commonName,
        sciName: sciNameRaw.replace(/\s+(ssp|subsp|var|f|forma)\.\s+/i, " "),
        altNames: parseAltNames(str(row[findKey(headerMap, "altNames")])),
        familyLatin: str(row[findKey(headerMap, "familyLatin")]) || undefined,
        familyCommon: str(row[findKey(headerMap, "familyCommon")]) || undefined,
        native,
        border: invasiveField ? (TRUE_WORDS.test(invasiveField) ? "invasive" : "none") : "none",
        rarity: str(row[findKey(headerMap, "rarity")]) || undefined,
        notes: str(row[findKey(headerMap, "notes")]) || undefined,
      });
      species.push(entry);
    }
  }

  if (species.length === 0) {
    throw new Error(
      `No species rows found in "${filename}". Expected a header row with columns like "Common Name" and "Scientific Name" — see the template for the expected shape.`,
    );
  }
  return { species, categories, warnings };
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function parseNative(value: string): NativeStatus {
  if (NATIVE_TRUE.test(value) && !NONNATIVE_TRUE.test(value)) return "native";
  if (NONNATIVE_TRUE.test(value)) return "non-native";
  return "unknown";
}

/** Map sheet headers onto canonical fields (case/space-insensitive aliases). */
function mapHeaders(headers: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const header of headers) {
    const norm = header.toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.includes(norm)) {
        map.set(field, header);
        break;
      }
    }
  }
  return map;
}

function findKey(headerMap: Map<string, string>, field: string): string {
  return headerMap.get(field) ?? `__missing_${field}`;
}

export const TEMPLATE_COLUMNS = [
  "Common Name",
  "Scientific Name",
  "Alternate Common Names",
  "Family (Common)",
  "Family (Latin)",
  "Category",
  "Native Status",
  "Invasive",
  "Rarity",
  "Notes",
] as const;

/** Build the downloadable xlsx template with documented columns + one example row. */
export function templateWorkbook(): ArrayBuffer {
  const rows = [
    {
      "Common Name": "Coast Live Oak",
      "Scientific Name": "Quercus agrifolia",
      "Alternate Common Names": "",
      "Family (Common)": "Oak Family",
      "Family (Latin)": "Fagaceae",
      Category: "Plants",
      "Native Status": "native",
      Invasive: "",
      Rarity: "",
      Notes: "",
    },
    {
      "Common Name": "Black Mustard",
      "Scientific Name": "Brassica nigra",
      "Alternate Common Names": "",
      "Family (Common)": "Mustard Family",
      "Family (Latin)": "Brassicaceae",
      Category: "Plants",
      "Native Status": "non-native",
      Invasive: "yes",
      Rarity: "",
      Notes: "Very common along trail edges",
    },
    {
      "Common Name": "",
      "Scientific Name": "",
      "Alternate Common Names": "",
      "Family (Common)": "",
      "Family (Latin)": "",
      Category: "",
      "Native Status": "native | non-native | (blank)",
      Invasive: "yes / (blank)",
      Rarity: "",
      Notes: "Delete these example rows before importing",
    },
  ];
  const sheet = XLSX.utils.json_to_sheet(rows, { header: [...TEMPLATE_COLUMNS] });
  sheet["!cols"] = TEMPLATE_COLUMNS.map((h) => ({ wch: Math.max(16, h.length + 4) }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Species");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

/** Create a brand-new empty project. */
export function newProject(name: string): Project {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: makeId(name),
    name,
    deckLabel: name,
    description: "",
    categories: [{ id: "plants", label: "Plants" }, { id: "animals", label: "Animals" }],
    species: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Import result → project (used by home and project import UI). */
export function projectFromImport(
  name: string,
  result: ImportResult,
  base?: Project,
): Project {
  const project: Project = base ?? newProject(name);
  project.name = name;
  project.deckLabel = name;
  for (const cat of result.categories) {
    if (!project.categories.some((c) => c.id === cat.id)) {
      project.categories.push(cat);
    }
  }
  project.species = mergeSpecies(project.species, result.species);
  return project;
}

/** Merge imported rows into existing species, keyed by scientific name. */
function mergeSpecies(existing: SpeciesEntry[], incoming: SpeciesEntry[]): SpeciesEntry[] {
  const bySci = new Map(existing.map((s) => [s.sciName.toLowerCase(), s]));
  const merged = [...existing];
  for (const s of incoming) {
    const key = s.sciName.toLowerCase();
    const target = bySci.get(key);
    if (target) {
      // Update fields that the spreadsheet can fill, keep photos.
      Object.assign(target, {
        commonName: s.commonName || target.commonName,
        altNames: s.altNames.length ? s.altNames : target.altNames,
        familyLatin: s.familyLatin ?? target.familyLatin,
        familyCommon: s.familyCommon ?? target.familyCommon,
        native: s.native !== "unknown" ? s.native : target.native,
        border: (s.border && s.border !== "none" ? s.border : target.border) || target.border,
        rarity: s.rarity ?? target.rarity,
        notes: s.notes ?? target.notes,
        category: s.category || target.category,
      });
    } else {
      merged.push(s);
      bySci.set(key, s);
    }
  }
  return merged;
}
