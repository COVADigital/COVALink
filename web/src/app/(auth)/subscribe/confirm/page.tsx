import type { Metadata } from "next";
import { SubscribeToken } from "../subscribe-token";

export const metadata: Metadata = { title: "Confirm your subscription", robots: { index: false, follow: false }, referrer: "no-referrer" };

/** The token arrives in the link fragment and is posted only after a click. Headers: `tokenPageHeaders`. */
export default function SubscribeConfirmPage() {
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Confirm your subscription</h1>
      <SubscribeToken action="confirm" />
    </>
  );
}
