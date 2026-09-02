"use client";

import { BellRingIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";

const dismissalKey = "openinstinct:dropped-thread-monitor-onboarding:v1";
const dismissalEvent =
  "openinstinct:dropped-thread-monitor-onboarding-dismissed";
const setupMessage = "Help me turn on my dropped-email monitor.";

export function DroppedThreadMonitorOnboarding({
  linqPhoneNumber,
}: {
  readonly linqPhoneNumber: string;
}) {
  const dismissed = useSyncExternalStore(
    subscribeToDismissal,
    readDismissal,
    () => false
  );

  if (dismissed) return null;

  return (
    <section
      aria-labelledby="dropped-thread-monitor-heading"
      className="rounded-xl border border-information-border bg-information-subtle p-4 text-information"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-information-border bg-background/50">
          <BellRingIcon />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="type-label" id="dropped-thread-monitor-heading">
            Never lose track of an email
          </h2>
          <p className="type-supporting-body text-balance">
            OpenInstinct can check your sent mail once a day and text you when a
            conversation may need a follow-up. It only reads email and never
            sends or changes anything without your approval.
          </p>
          <p className="type-caption opacity-80">
            Default: review the last 14 days and flag conversations waiting at
            least 48 hours.
          </p>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              nativeButton={false}
              render={<a href={droppedThreadMonitorSmsHref(linqPhoneNumber)} />}
              size="sm"
            >
              Set up in iMessage
            </Button>
            <Button
              onClick={() => {
                window.localStorage.setItem(dismissalKey, "dismissed");
                window.dispatchEvent(new Event(dismissalEvent));
              }}
              size="sm"
              type="button"
              variant="quiet"
            >
              Not now
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

export function droppedThreadMonitorSmsHref(phoneNumber: string) {
  return `sms:${phoneNumber}&body=${encodeURIComponent(setupMessage)}`;
}

function subscribeToDismissal(onStoreChange: () => void) {
  window.addEventListener(dismissalEvent, onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    window.removeEventListener(dismissalEvent, onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

function readDismissal() {
  return window.localStorage.getItem(dismissalKey) === "dismissed";
}
