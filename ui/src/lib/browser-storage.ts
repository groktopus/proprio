export function browserStorage(area: "localStorage" | "sessionStorage" = "localStorage"): Storage | null {
  try {
    return typeof window === "undefined" ? null : window[area] ?? null;
  } catch {
    // Browser policy can deny the storage object itself.
    return null;
  }
}
