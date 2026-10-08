import { describe, it, expect } from "vitest";
import { saveProject, getProject } from "~/lib/store";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";
import { mutateProject } from "~/lib/useProjectDoc";

describe("mutateProject", () => {
  it("edits the stored deck when no page has it open (jobs after navigating away)", async () => {
    const project = newProject("Away");
    await saveProject(project);

    await mutateProject(project.id, (d) => {
      d.species.push(makeSpecies({ commonName: "Oak", sciName: "Quercus" }));
    });

    const loaded = await getProject(project.id);
    expect(loaded!.species.map((s) => s.commonName)).toEqual(["Oak"]);
  });

  it("does nothing for a deck that no longer exists", async () => {
    await expect(mutateProject("missing-deck", () => {})).resolves.toBeUndefined();
  });
});
