import Link from "next/link";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center bg-muted/40 px-4 py-12">
      <Link href="/" className="mb-6 text-sm font-semibold tracking-tight focus-visible:underline focus-visible:outline-none">
        COVALink
      </Link>
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm sm:p-8">{children}</div>
    </main>
  );
}
