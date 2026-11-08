import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-4 py-16 sm:px-6">
      <p className="text-sm font-medium text-muted-foreground">COVALink</p>
      <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        One page for everything you share.
      </h1>
      <p className="max-w-prose text-muted-foreground">
        A self-hosted link-in-bio platform. Sign in to manage your account.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button asChild size="lg">
          <Link href="/login">Sign in</Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href="/register">Create account</Link>
        </Button>
      </div>
    </main>
  );
}
