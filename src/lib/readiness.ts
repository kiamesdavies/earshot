// Before a session: can every job's model actually be reached? Catches the
// "no API key" and "CLI not found" cases up front instead of failing mid-call.

import type { Role } from "../core/providers";
import { cliResolve, secretsPresent } from "./backend";
import type { Settings } from "./settings";

const LABEL: Record<Role, string> = { gate: "Nudges", suggest: "Nudges", chat: "Chat", summarize: "Summary" };

export async function modelProblems(settings: Settings): Promise<string[]> {
  const problems = new Map<string, string>();
  // One keychain call for every provider that needs a key.
  const keyed = settings.models.providers.filter((p) => p.secret);
  const present = await secretsPresent(keyed.map((p) => p.secret!)).catch(() => keyed.map(() => false));
  const hasKey = new Map(keyed.map((p, i) => [p.id, present[i]]));
  for (const role of Object.keys(settings.models.roles) as Role[]) {
    const { providerId } = settings.models.roles[role];
    const provider = settings.models.providers.find((p) => p.id === providerId);
    if (!provider) {
      problems.set(providerId, `${LABEL[role]}: provider "${providerId}" no longer exists`);
      continue;
    }
    if (problems.has(provider.id)) continue;
    if (provider.secret && !hasKey.get(provider.id)) {
      problems.set(provider.id, `${provider.name} has no API key (used for ${LABEL[role].toLowerCase()})`);
    } else if (provider.kind === "cli" && !(await cliResolve(provider.command ?? "").catch(() => null))) {
      problems.set(provider.id, `${provider.name}: \`${provider.command}\` not found`);
    }
  }
  return [...problems.values()];
}
