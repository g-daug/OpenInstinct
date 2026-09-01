import { MailIcon, MessageSquareIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export function ChannelsSection({
  browserReady,
  linqConfigured,
  linqPhoneNumber,
}: {
  readonly browserReady: boolean;
  readonly linqConfigured: boolean;
  readonly linqPhoneNumber?: string;
}) {
  return (
    <section aria-labelledby="channels-heading" className="space-y-3">
      <h2 className="type-section-title" id="channels-heading">
        Channels
      </h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {browserReady ? (
          <Button
            className="h-11 justify-start"
            nativeButton={false}
            render={<Link href="/chat" />}
            variant="outline"
          >
            <MessageSquareIcon />
            WebChat
          </Button>
        ) : (
          <Button className="h-11 justify-start" disabled variant="outline">
            <MessageSquareIcon />
            WebChat
          </Button>
        )}
        {linqConfigured && linqPhoneNumber ? (
          <Button
            className="h-11 justify-start"
            nativeButton={false}
            render={<a href={`sms:${linqPhoneNumber}`} />}
            variant="outline"
          >
            <MailIcon />
            iMessage
          </Button>
        ) : (
          <Button className="h-11 justify-start" disabled variant="outline">
            <MailIcon />
            iMessage
          </Button>
        )}
      </div>
      <p className="type-caption text-muted-foreground">
        {channelAvailabilityMessage({
          browserReady,
          linqConfigured,
          linqPhoneNumber,
        })}
      </p>
    </section>
  );
}

function channelAvailabilityMessage({
  browserReady,
  linqConfigured,
  linqPhoneNumber,
}: {
  readonly browserReady: boolean;
  readonly linqConfigured: boolean;
  readonly linqPhoneNumber?: string;
}) {
  return [
    browserReady
      ? "WebChat is ready."
      : "KERNEL_API_KEY is required to enable WebChat.",
    linqConfigured && linqPhoneNumber
      ? `iMessage opens ${linqPhoneNumber}.`
      : linqConfigured
        ? "Linq is connected. Use its assigned line to start an iMessage."
        : "Set up Linq to enable iMessage.",
  ].join(" ");
}
