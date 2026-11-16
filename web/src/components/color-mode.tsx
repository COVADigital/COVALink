"use client";

import { createContext, useContext, useLayoutEffect, type ReactNode } from "react";
import type { ColorMode } from "@/features/color-mode/mode";

const ColorModeContext = createContext<ColorMode>("system");

/** The dashboard's current theme choice; "system" outside a scope. */
export const useColorMode = () => useContext(ColorModeContext);

/**
 * Wraps every dashboard and administration route. The attribute on the scope
 * drives the COVALink tokens; the same attribute on <html> (set here, removed
 * on leaving) covers portalled menus, dialogs and toasts rendered in <body>.
 */
export function ColorModeScope({ mode, children }: { mode: ColorMode; children: ReactNode }) {
  useLayoutEffect(() => {
    document.documentElement.dataset.colorMode = mode;
    return () => {
      delete document.documentElement.dataset.colorMode;
    };
  }, [mode]);
  return (
    <ColorModeContext.Provider value={mode}>
      <div className="cl-scope flex min-h-dvh flex-1 flex-col" data-color-mode={mode}>
        {children}
      </div>
    </ColorModeContext.Provider>
  );
}
