import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { vercelBlob } from "eve/memory/file/vercel";
import {
  resolveProfileMemoryBackend,
  resolveProfileMemoryScope,
} from "../lib/profile-memory";
import { env } from "@/env";

const backend = resolveProfileMemoryBackend(env);
const provider =
  backend.kind === "vercel-blob"
    ? fileMemory({
        backend: vercelBlob({ token: backend.token }),
      })
    : backend.kind === "vercel-blob-oidc"
      ? fileMemory({
          backend: vercelBlob({ storeId: backend.storeId }),
        })
      : fileMemory();

export default defineMemory({
  description: "Remember stable facts and preferences about the current user.",
  provider,
  scope: resolveProfileMemoryScope,
});
