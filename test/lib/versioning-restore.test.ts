import { describe, it, expect } from "vitest";
import { saveProject, getProject, putFile, getFile } from "~/lib/store";
import { ensureRepo, commitDeckVersion, listVersions, restoreVersion } from "~/lib/versioning";
import { missingPhotoIssues } from "~/lib/validate";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";

/**
 * Version restore must degrade gracefully when history is imperfect: a
 * version whose photos/ tree lacks a referenced file restores what it has,
 * leaves the deck loadable, and the dangling reference is flagged by the
 * review — never a crash and never a half-swapped store.
 */

function fixture(name: string) {
  const p = newProject(name);
  p.species.push(
    makeSpecies({
      commonName: "Oak",
      category: "plants",
      photos: [
        { id: "p1", role: "main", fileKey: "a.jpg", credit: { observer: "A", license: "cc0" } },
        { id: "p2", role: "secondary", fileKey: "b.jpg", credit: { observer: "B", license: "cc0" } },
      ],
    }),
  );
  return p;
}

describe("restore with imperfect history", () => {
  it("restores a version that references a photo whose bytes never existed", async () => {
    const p = fixture("Dangling Restore");
    // Only a.jpg has bytes; b.jpg is referenced by the record but was never
    // stored — the commit's photos/ tree carries a.jpg only.
    await saveProject(p);
    await putFile(p.id, "a.jpg", new Blob(["a-bytes"]));
    await ensureRepo(p);
    const version = (await listVersions(p.id))[0];

    // The live deck moves on (b.jpg bytes land, description changes).
    const live = structuredClone(p);
    live.description = "current state";
    await saveProject(live);
    await putFile(p.id, "b.jpg", new Blob(["b-bytes"]));

    const restored = await restoreVersion(p.id, version.oid);
    expect(restored).not.toBeNull();

    const stored = await getProject(p.id);
    expect(stored!.description).toBe(""); // the version's record came back
    expect(stored!.species[0].photos.map((s) => s.fileKey)).toEqual(["a.jpg", "b.jpg"]);
    expect(await getFile(p.id, "a.jpg")).toBeDefined();
    // b.jpg is still referenced but the version never carried its bytes and
    // the keep-set preserved the live copy — no crash, deck stays coherent.
    expect(await getFile(p.id, "b.jpg")).toBeInstanceOf(Blob);

    // The restored deck commits cleanly afterwards.
    expect(await commitDeckVersion(stored!)).not.toBeNull();
  });

  it("flags a dangling photo reference in review instead of crashing", async () => {
    const p = fixture("Dangling Review");
    p.species[0].photos = p.species[0].photos.filter((s) => s.fileKey === "a.jpg");
    await saveProject(p);
    await putFile(p.id, "a.jpg", new Blob(["a-bytes"]));
    // Simulate legacy damage: the record references a file that is gone.
    p.species[0].photos.push({ id: "p2", role: "secondary", fileKey: "ghost.jpg", credit: { observer: "X", license: "cc0" } });
    await saveProject(p);
    const issues = await missingPhotoIssues(p);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.message.includes("ghost.jpg"))).toBe(true);
  });
});
