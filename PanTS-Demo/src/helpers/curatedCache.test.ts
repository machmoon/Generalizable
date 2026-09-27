import { describe, expect, it } from "vitest";
import { prioritizeKnownDemographics } from "./curatedCache";

describe("prioritizeKnownDemographics", () => {
  it("moves complete age and sex records ahead of unknown records", () => {
    const unknown = { case_id: "PanTS_00005162", age: "—", sex: "—" };
    const known = { case_id: "PanTS_00008854", age: 72, sex: "F" };
    const knownWithStringAge = { case_id: "PanTS_00008205", age: "39", sex: "M" };

    expect(prioritizeKnownDemographics([unknown, known, knownWithStringAge])).toEqual([
      known,
      knownWithStringAge,
      unknown,
    ]);
  });

  it("keeps the original order when records have the same completeness", () => {
    const items = [
      { case_id: "known-1", age: 40, sex: "F" },
      { case_id: "unknown-1", age: null, sex: "M" },
      { case_id: "known-2", age: 41, sex: "M" },
      { case_id: "unknown-2", age: 42, sex: "—" },
    ];

    expect(prioritizeKnownDemographics(items).map((item) => item.case_id)).toEqual([
      "known-1",
      "known-2",
      "unknown-1",
      "unknown-2",
    ]);
  });
});
