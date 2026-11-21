import type { Metadata } from "next";
import { SubscribeToken } from "../subscribe-token";

export const metadata: Metadata = { title: "Remove your email", robots: { index: false, follow: false }, referrer: "no-referrer" };

/** The token arrives in the link fragment and is posted only after a click. Headers: `tokenPageHeaders`. */
export default function SubscribeRemovePage() {
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Remove your email</h1>
      <SubscribeToken action="remove" />
    </>
  );
}
