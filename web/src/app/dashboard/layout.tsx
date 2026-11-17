import type { ReactNode } from "react";
import { ColorModeLayout } from "@/components/color-mode-layout";

export default function Layout({ children }: { children: ReactNode }) {
  return <ColorModeLayout>{children}</ColorModeLayout>;
}
