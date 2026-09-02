import { describe, expect, it } from "vitest";
import {
  assertTimeZone,
  nextDailyRunAt,
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

describe("daily monitor schedule", () => {
  it("uses today's local clock time when it is still ahead", () => {
    expect(
      nextDailyRunAt({
        after: new Date("2026-09-01T12:00:00.000Z"),
        hour: 9,
        minute: 15,
        timezone: "America/Chicago",
      })
    ).toBe("2026-09-01T14:15:00.000Z");
  });

  it("moves to tomorrow after today's clock time has passed", () => {
    expect(
      nextDailyRunAt({
        after: new Date("2026-09-01T15:00:00.000Z"),
        hour: 9,
        minute: 15,
        timezone: "America/Chicago",
      })
    ).toBe("2026-09-02T14:15:00.000Z");
  });

  it("preserves the local clock time across daylight-saving changes", () => {
    expect(
      nextDailyRunAt({
        after: new Date("2026-10-31T15:00:00.000Z"),
        hour: 8,
        minute: 0,
        timezone: "America/Chicago",
      })
    ).toBe("2026-11-01T14:00:00.000Z");
  });

  it("rejects an invalid clock time", () => {
    expect(() =>
      nextDailyRunAt({
        after: new Date(),
        hour: 24,
        minute: 0,
        timezone: "America/Chicago",
      })
    ).toThrow("local hour");
  });
});
