import { createRoot, type Root } from "react-dom/client";

export interface ProprioReactRootHost {
  __proprioReactRoot?: Root;
}

type CreateRoot = (container: Parameters<typeof createRoot>[0]) => Root;

/**
 * Keep one React root per browser window even if Vite evaluates the entry
 * module more than once during a development reload.
 */
export function getOrCreateProprioReactRoot(
  host: object,
  container: Parameters<typeof createRoot>[0],
  create: CreateRoot = createRoot,
): Root {
  const rootHost = host as ProprioReactRootHost;
  if (rootHost.__proprioReactRoot) return rootHost.__proprioReactRoot;

  const root = create(container);
  rootHost.__proprioReactRoot = root;
  return root;
}
