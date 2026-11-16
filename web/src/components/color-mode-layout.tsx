import { cookies } from "next/headers";
import { Suspense, type ReactNode } from "react";
import { ColorModeScope } from "@/components/color-mode";
import { COLOR_MODE_COOKIE, parseColorMode } from "@/features/color-mode/mode";

async function Scope({ children }: { children: ReactNode }) {
  const mode = parseColorMode((await cookies()).get(COLOR_MODE_COOKIE)?.value);
  return <ColorModeScope mode={mode}>{children}</ColorModeScope>;
}

/** Reads the cookie below the root layout only, so public and auth routes stay static. */
export function ColorModeLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <Scope>{children}</Scope>
    </Suspense>
  );
}
