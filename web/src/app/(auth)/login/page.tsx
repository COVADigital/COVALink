import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Sign in</h1>
      <p className="mb-6 text-sm text-muted-foreground">Welcome back.</p>
      {/* useSearchParams (post-login redirect target) needs a Suspense boundary. */}
      <Suspense>
        <LoginForm />
      </Suspense>
    </>
  );
}
