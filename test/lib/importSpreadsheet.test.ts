import { describe, it, expect } from "vitest";
import { parseSpreadsheet, templateWorkbook } from "~/lib/importSpreadsheet";
import { makeId, parseAltNames } from "~/lib/ids";
import * as XLSX from "xlsx";

function sheetToBuffer(rows: Array<Record<string, string | number>>): ArrayBuffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Species");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

describe("spreadsheet import", () => {
  it("parses the documented columns", () => {
    const buf = sheetToBuffer([
      {
        "Common Name": "Coast Live Oak",
        "Scientific Name": "Quercus agrifolia",
        "Alternate Common Names": "",
        "Family (Common)": "Oak Family",
        "Family (Latin)": "Fagaceae",
        Category: "Plants",
        "Native Status": "native",
        Invasive: "",
        Rarity: "CNPS 1B.1",
        Notes: "test",
      },
      {
        "Common Name": "Black Mustard",
        "Scientific Name": "Brassica nigra",
        "Alternate Common Names": "Shortpod Mustard; Sahara Mustard",
        "Family (Common)": "",
        "Family (Latin)": "Brassicaceae",
        Category: "Plants",
        "Native Status": "non-native",
        Invasive: "yes",
        Rarity: "",
        Notes: "",
      },
    ]);
    const result = parseSpreadsheet(buf, "test.xlsx");
    expect(result.species).toHaveLength(2);
    expect(result.categories.map((c) => c.label)).toEqual(["Plants"]);
    const oak = result.species[0];
    expect(oak.sciName).toBe("Quercus agrifolia");
    expect(oak.commonName).toBe("Coast Live Oak");
    expect(oak.familyLatin).toBe("Fagaceae");
    expect(oak.native).toBe("native");
    expect(oak.invasive).toBe(false);
    expect(oak.rarity).toBe("CNPS 1B.2".replace("1B.2", "1B.1"));
    const mustard = result.species[1];
    expect(mustard.native).toBe("non-native");
    expect(mustard.invasive).toBe(true);
    expect(mustard.altNames).toEqual(["Shortpod Mustard", "Sahara Mustard"]);
    // Default category assignment comes from the Category column.
    expect(result.species.every((s) => s.category === result.categories[0].id)).toBe(true);
  });

  it("uses the sheet name as the category fallback (survey-style workbooks)", () => {
    const ws = XLSX.utils.json_to_sheet([
      { Species: "Junco hyemalis", "Common Name": "Dark-eyed Junco" },
      { Species: "Quercus dumosa", "Common Name": "Scrub Oak" },
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Birds");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const result = parseSpreadsheet(buf, "survey.xlsx");
    expect(result.species).toHaveLength(2);
    expect(result.categories[0].label).toBe("Birds");
  });

  it("handles the Healthy Canyons 'Species (Common)' header style", () => {
    const buf = sheetToBuffer([
      { "Species (Common)": "Dudleya", "Species (Scientific)": "Dudleya edulis" },
    ]);
    const result = parseSpreadsheet(buf, "hc.xlsx");
    expect(result.species[0].commonName).toBe("Dudleya");
    expect(result.species[0].sciName).toBe("Dudleya edulis");
  });

  it("throws a helpful error when no species rows exist", () => {
    const buf = sheetToBuffer([{ Foo: "Bar" }]);
    expect(() => parseSpreadsheet(buf, "empty.xlsx")).toThrow(/No species rows/);
  });

  it("template workbook parses back into example species", () => {
    const buf = templateWorkbook();
    const result = parseSpreadsheet(buf, "template.xlsx");
    const names = result.species.map((s) => s.sciName);
    expect(names).toContain("Quercus agrifolia");
    expect(names).toContain("Brassica nigra");
    const mustard = result.species.find((s) => s.sciName === "Brassica nigra")!;
    expect(mustard.invasive).toBe(true);
  });
});

describe("helpers", () => {
  it("makeId slugs labels", () => {
    expect(makeId("Mission Trails Plants!")).toBe("mission-trails-plants");
    expect(makeId("   ")).toMatch(/^deck-/);
  });

  it("parses alt-name cells", () => {
    expect(parseAltNames("A; B · C")).toEqual(["A", "B", "C"]);
    expect(parseAltNames("")).toEqual([]);
  });
});