import { describe, it, expect } from "vitest";
import { validateProject, missingPhotoIssues } from "~/lib/validate";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";
import { putFile } from "~/lib/store";
import type { Project } from "~/lib/types";

function fixture(): Project {
  const project = newProject("Validation Fixture");
  const entry = makeSpecies({
    commonName: "Oak",
    sciName: "Quercus",
    category: "plants",
    layout: "photo-single",
  });
  entry.photos.push({
    id: "upload:1",
    role: "main",
    credit: { observer: "joodles", license: "cc0" },
    fileKey: "oak-main-abc123.jpg",
  });
  project.species.push(entry);
  return project;
}

describe("validateProject", () => {
  it("passes a complete species", () => {
    expect(validateProject(fixture())).toHaveLength(0);
  });

  it("flags missing names, licenses, and categories", () => {
    const project = fixture();
    const entry = makeSpecies({ commonName: "", sciName: "", category: "nope" });
    entry.photos.push({
      id: "upload:2",
      role: "main",
      credit: { observer: "You", license: "" },
      fileKey: "x.jpg",
    });
    project.species.push(entry);
    const issues = validateProject(project);
    const messages = issues.map((i) => i.message).join("\n");
    expect(messages).toMatch(/neither a common nor a scientific name/);
    expect(messages).toMatch(/no license/);
    expect(messages).toMatch(/not assigned to a category/);
  });
});

describe("missingPhotoIssues", () => {
  it("reports photo files that are missing from the store", async () => {
    const project = fixture();
    // The photo's blob was never stored (or was lost) — the manifest would
    // reference a file the zip doesn't contain.
    const issues = await missingPhotoIssues(project);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].message).toMatch(/oak-main-abc123\.jpg/);
  });

  it("passes when every referenced file exists", async () => {
    const project = fixture();
    await putFile(project.id, "oak-main-abc123.jpg", new Blob(["jpeg"]));
    expect(await missingPhotoIssues(project)).toHaveLength(0);
  });
});
