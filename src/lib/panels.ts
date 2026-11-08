import { useState } from "react";

/** Which side-panel sections are collapsed; remembered per view on this Mac. */
export function useCollapsed<K extends string>(key: string, initial: Record<K, boolean>) {
  const storageKey = `earshot:collapsed:${key}`;
  const [state, setState] = useState<Record<K, boolean>>(() => {
    try {
      return { ...initial, ...JSON.parse(localStorage.getItem(storageKey) ?? "{}") };
    } catch {
      return initial;
    }
  });
  const toggle = (k: K) =>
    setState((s) => {
      const next = { ...s, [k]: !s[k] };
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* layout preference only */
      }
      return next;
    });
  return [state, toggle] as const;
}
