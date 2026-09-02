import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DroppedThreadMonitorOnboarding,
  droppedThreadMonitorSmsHref,
} from "@/app/(authenticated)/(manager)/_components/dropped-thread-monitor-onboarding";

describe("dropped-thread monitor onboarding", () => {
  it("opens a prefilled iMessage setup request", () => {
    expect(droppedThreadMonitorSmsHref("+12025550123")).toBe(
      "sms:+12025550123&body=Help%20me%20turn%20on%20my%20dropped-email%20monitor."
    );

    const html = renderToStaticMarkup(
      createElement(DroppedThreadMonitorOnboarding, {
        linqPhoneNumber: "+12025550123",
      })
    );

    expect(html).toContain("Never lose track of an email");
    expect(html).toContain("Set up in iMessage");
    expect(html).toContain("Not now");
    expect(html).toContain("sms:+12025550123&amp;body=");
  });
});
