import { BotIcon, CloudIcon, ImageIcon, MailIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  getTokenResponse,
  NoValidTokenError,
  UserAuthorizationRequiredError,
} from "@vercel/connect";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getGatewayModel } from "@/db/services/settings";
import { readDroppedThreadMonitor } from "@/db/services/dropped-thread-monitors";
import { listGoogleEmailSendAuditEvents } from "@/db/services/google-email-send-audit";
import { env } from "@/env";
import {
  type GoogleAccountMode,
  googleWorkspaceTokenParams,
  sharedGoogleWorkspaceAccess,
} from "@/lib/google-workspace";
import { requireRequestScope } from "@/lib/request-scope";
import { GoogleWorkspaceAction } from "./_components/google-workspace-action";
import { ChannelsSection } from "./_components/channels-section";
import { DroppedThreadMonitorOnboarding } from "./_components/dropped-thread-monitor-onboarding";
import { ModelSelector } from "./_components/model-selector";

export default async function Page({ searchParams }: PageProps<"/">) {
  const google = (await searchParams).google;
  const scope = await requireRequestScope();
  const sharedGoogleAccess = sharedGoogleWorkspaceAccess(scope.userId);
  const [
    dedicatedGoogle,
    personalGoogle,
    gatewayModel,
    droppedThreadMonitor,
    emailAuditEvents,
  ] = await Promise.all([
    readGoogleWorkspaceConnection(scope.userId, "dedicated"),
    readGoogleWorkspaceConnection(scope.userId, "personal"),
    getGatewayModel(scope),
    readDroppedThreadMonitor(scope),
    sharedGoogleAccess === "admin"
      ? listGoogleEmailSendAuditEvents(scope.userId)
      : Promise.resolve([]),
  ]);
  const browserReady = true;
  const imageStorageReady = Boolean(
    env.BLOB_STORE_ID ?? env.BLOB_READ_WRITE_TOKEN
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="sr-only">Workspace</h1>

      {google === "unavailable" ? (
        <Alert>
          <MailIcon />
          <AlertTitle>Google Workspace unavailable</AlertTitle>
          <AlertDescription>
            This deployment does not have a working Google OAuth connector yet.
          </AlertDescription>
        </Alert>
      ) : null}

      <ChannelsSection
        browserReady={browserReady}
        linqConfigured={env.LINQ_CONNECTOR !== undefined}
        linqPhoneNumber={env.LINQ_PHONE_NUMBER}
      />
      <GoogleWorkspaceSection
        access={sharedGoogleAccess}
        dedicatedConnection={dedicatedGoogle}
        personalConnection={personalGoogle}
      />
      {sharedGoogleAccess === "admin" ? (
        <GoogleEmailAuditSection events={emailAuditEvents} />
      ) : null}
      {dedicatedGoogle.state === "connected" &&
      droppedThreadMonitor === undefined &&
      env.LINQ_CONNECTOR !== undefined &&
      env.LINQ_PHONE_NUMBER ? (
        <DroppedThreadMonitorOnboarding
          linqPhoneNumber={env.LINQ_PHONE_NUMBER}
        />
      ) : null}

      <WorkspaceSection headingId="connectors-heading" title="Infrastructure">
        <div className="divide-y divide-border/50 border-y border-border/50">
          <ConnectorRow
            action={
              <span className="type-caption text-muted-foreground">
                {browserReady ? "Connected" : "Unavailable"}
              </span>
            }
            description="Run isolated browsers in your Kernel account."
            icon={<CloudIcon />}
            label="Kernel browser"
          />
          <ConnectorRow
            action={
              <span className="type-caption text-muted-foreground">
                {imageStorageReady ? "Connected" : "Unavailable"}
              </span>
            }
            description={
              imageStorageReady
                ? "Store browser images in a private Vercel Blob store."
                : "Connect a private Vercel Blob store to share browser images."
            }
            icon={<ImageIcon />}
            label="Vercel Blob"
          />
          <ConnectorRow
            action={<ModelSelector modelId={gatewayModel} />}
            description={gatewayModel}
            icon={<BotIcon />}
            label="AI Gateway model"
          />
        </div>
      </WorkspaceSection>
    </div>
  );
}

function GoogleEmailAuditSection({
  events,
}: {
  readonly events: Awaited<ReturnType<typeof listGoogleEmailSendAuditEvents>>;
}) {
  return (
    <WorkspaceSection headingId="email-audit-heading" title="Email audit">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Requested by</TableHead>
            <TableHead>Sender</TableHead>
            <TableHead>Recipients</TableHead>
            <TableHead>Subject</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Requested</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.length ? (
            events.map((event) => (
              <TableRow key={event.id}>
                <TableCell>
                  {event.requesterName ??
                    event.requesterEmail ??
                    event.requestedByUserId}
                </TableCell>
                <TableCell>{event.googleAccount}</TableCell>
                <TableCell>{auditRecipientLabel(event.recipients)}</TableCell>
                <TableCell>{event.emailSubject}</TableCell>
                <TableCell>{event.status}</TableCell>
                <TableCell>
                  {new Date(event.createdAt).toLocaleString()}
                </TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={6} variant="empty">
                No email sends recorded yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </WorkspaceSection>
  );
}

function auditRecipientLabel(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return "Unavailable";
  }
  const recipients = z
    .object({
      bcc: z.array(z.string()),
      cc: z.array(z.string()),
      to: z.array(z.string()),
    })
    .safeParse(parsed);
  if (!recipients.success) return "Unavailable";
  return [
    ...recipients.data.to,
    ...recipients.data.cc,
    ...recipients.data.bcc,
  ].join(", ");
}

function GoogleWorkspaceSection({
  access,
  dedicatedConnection,
  personalConnection,
}: {
  readonly access: "admin" | "denied" | "member";
  readonly dedicatedConnection?: GoogleWorkspaceConnection;
  readonly personalConnection?: GoogleWorkspaceConnection;
}) {
  const dedicatedDescription = connectionDescription(
    dedicatedConnection,
    access === "denied"
      ? "Your account is not allowed to use Lever's dedicated mailbox."
      : "Lever's default sender for approved users."
  );
  const personalDescription = connectionDescription(
    personalConnection,
    "Used only when you explicitly ask Lever to send from your account."
  );

  return (
    <WorkspaceSection headingId="connections-heading" title="Connections">
      <div className="divide-y divide-border/50 border-y border-border/50">
        <ConnectorRow
          action={
            access === "denied" ? (
              <span className="type-caption text-muted-foreground">
                Not allowed
              </span>
            ) : (
              <GoogleWorkspaceAction
                account="dedicated"
                canManage={access === "admin"}
                state={dedicatedConnection?.state}
              />
            )
          }
          description={dedicatedDescription}
          icon={<MailIcon />}
          label="Dedicated Lever mailbox"
        />
        <ConnectorRow
          action={
            <GoogleWorkspaceAction
              account="personal"
              state={personalConnection?.state}
            />
          }
          description={personalDescription}
          icon={<MailIcon />}
          label="Personal Google account"
        />
      </div>
    </WorkspaceSection>
  );
}

type GoogleWorkspaceConnection = {
  readonly accountLabel: string | null;
  readonly state: "connected" | "disconnected" | "unavailable";
};

async function readGoogleWorkspaceConnection(
  userId: string,
  account: GoogleAccountMode
): Promise<GoogleWorkspaceConnection> {
  try {
    const response = await getTokenResponse(
      env.GOOGLE_CONNECTOR_UID,
      googleWorkspaceTokenParams(userId, account),
      { forceRefresh: true }
    );
    const claims = z
      .object({ email: z.string().optional() })
      .safeParse(response.claims);
    return {
      accountLabel:
        response.name ?? (claims.success ? (claims.data.email ?? null) : null),
      state: "connected",
    };
  } catch (error) {
    if (
      error instanceof UserAuthorizationRequiredError ||
      error instanceof NoValidTokenError
    ) {
      return { accountLabel: null, state: "disconnected" };
    }
    return { accountLabel: null, state: "unavailable" };
  }
}

function connectionDescription(
  connection: GoogleWorkspaceConnection | undefined,
  disconnectedDescription: string
) {
  if (connection?.state === "connected") {
    return (
      connection.accountLabel ?? "Gmail, Calendar, and Contacts connected."
    );
  }
  if (connection?.state === "unavailable") {
    return "Attach a Vercel Connect Google OAuth connector to enable this.";
  }
  return disconnectedDescription;
}

function WorkspaceSection({
  children,
  headingId,
  title,
}: {
  readonly children: ReactNode;
  readonly headingId: string;
  readonly title: string;
}) {
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 className="type-section-title" id={headingId}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function ConnectorRow({
  action,
  description,
  icon,
  label,
}: {
  readonly action: ReactNode;
  readonly description: string;
  readonly icon: ReactNode;
  readonly label: string;
}) {
  return (
    <div className="flex items-center gap-3 py-4">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50 text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="type-label">{label}</p>
        <p className="truncate type-caption text-muted-foreground">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}
