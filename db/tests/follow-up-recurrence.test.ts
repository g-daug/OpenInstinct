import { describe, expect, it } from "vitest";
import {
  assertTimeZone,
  nextFollowUpRun,
} from "../services/follow-up-recurrence";

describe("follow-up recurrence", () => {
  it("preserves local time across daylight-saving changes", () => {
    expect(
      nextFollowUpRun({
        after: new Date("2026-11-01T13:00:00.000Z"),
        currentRunAt: "2026-10-31T13:00:00.000Z",
        recurrence: "daily",
        timezone: "America/Chicago",
      })
    ).toBe("2026-11-01T14:00:00.000Z");
  });

  it("skips weekends", () => {
    expect(
      nextFollowUpRun({
        after: new Date("2026-09-04T14:00:00.000Z"),
        currentRunAt: "2026-09-04T14:00:00.000Z",
        recurrence: "weekdays",
        timezone: "America/Chicago",
      })
    ).toBe("2026-09-07T14:00:00.000Z");
  });

  it("rejects unknown time zones", () => {
    expect(() => {
      assertTimeZone("Mars/Olympus_Mons");
    }).toThrow("Invalid IANA time zone");
  });
});
