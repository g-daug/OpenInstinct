import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { readVaultItem } from "@/db/services/vault";
import { kernel } from "@/lib/kernel";
import {
  currentKernelPageOrigin,
  fillWithKernelNativeAutofill,
  nativeAutofillTokens,
} from "../lib/autofill/native";
import { vaultAutofillProvider } from "../lib/autofill/provider";
import { materializeAutofillClaims } from "../lib/autofill/service";

const inputSchema = z.object({
  browserSessionId: z.string().trim().min(1).max(500),
  candidateId: z.string().trim().min(1).max(500),
  submit: z.boolean().optional(),
});

const outputSchema = z.object({
  filledClaims: z.number().int().nonnegative(),
  kind: z.enum(["address", "login", "payment"]),
  origin: z.string(),
  submitted: z.boolean(),
  success: z.literal(true),
});

export default defineTool({
  description:
    "Fill a login, card, or address form with an opaque handle returned by list_vault. Focus one control in the intended form first. For a login, set submit true to advance the current sign-in step with a trusted Enter key event in the same secure operation. Never supply vault fields, selectors, origins, or secret values.",
  inputSchema,
  outputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);

    await requireOwnedBrowserSession(scope, input.browserSessionId);
    const item = await readVaultItem(scope, input.candidateId);
    if (!item) throw new Error("The selected vault item was not found.");
    if (
      item.kind !== "address" &&
      item.kind !== "login" &&
      item.kind !== "payment"
    ) {
      throw new Error(
        "Native browser autofill currently supports only logins, cards, and addresses."
      );
    }
    if (input.submit && item.kind !== "login") {
      throw new Error(
        "Automatic form submission is supported only for logins."
      );
    }
    if (item.kind === "login") {
      const browser = await kernel.browsers.retrieve(
        input.browserSessionId,
        {},
        { signal: context.abortSignal }
      );
      if (!browser.profile_save_changes) {
        throw new Error(
          "Login autofill requires a browser created with save_changes: true. Delete this browser, create a writable browser at the same URL, then focus and fill again."
        );
      }
    }

    const origin = await currentKernelPageOrigin({
      browserSessionId: input.browserSessionId,
      signal: context.abortSignal,
    });
    const surfaceKind =
      item.kind === "payment"
        ? "payment-card"
        : item.kind === "login"
          ? "credentials"
          : "postal-address";
    const tokens = nativeAutofillTokens[item.kind];
    const surface = {
      fields: tokens.map((token) => ({ score: 100, token })),
      id: surfaceKind,
      kind: surfaceKind,
    };

    const claims = await materializeAutofillClaims(
      scope,
      input.candidateId,
      {
        availableTokens: new Set(tokens),
        origin,
        surface,
      },
      vaultAutofillProvider
    );
    const result = await fillWithKernelNativeAutofill({
      browserSessionId: input.browserSessionId,
      claims,
      expectedOrigin: origin,
      kind: item.kind,
      signal: context.abortSignal,
      submit: input.submit,
    });

    return {
      filledClaims: result.filledClaims,
      kind: item.kind,
      origin: result.origin,
      submitted: result.submitted,
      success: true as const,
    };
  },
});
