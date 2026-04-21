import { ReactNode, useEffect, useState } from "react";

/**
 * A component that only renders its children on the client-side.
 * This is useful for wrapping Shopify Web Components to prevent hydration errors.
 */
export function ClientOnly({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  return <>{children}</>;
}
