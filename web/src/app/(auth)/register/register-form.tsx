"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormAlert, FormField } from "@/components/auth/form-field";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { authErrorMessage } from "@/lib/auth/error-messages";

const schema = z
  .object({
    name: z.string().trim().min(1, "Enter your name").max(80),
    email: z.email("Enter a valid email address"),
    password: z.string().min(10, "Use at least 10 characters").max(128, "Use at most 128 characters"),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords don't match" });
type Values = z.infer<typeof schema>;

export function RegisterForm() {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const [checkEmail, setCheckEmail] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  async function onSubmit(values: Values) {
    setFormError(null);
    const { data, error } = await authClient.signUp.email({ name: values.name, email: values.email, password: values.password });
    if (error) {
      setFormError(authErrorMessage(error, "Couldn't create your account. Please try again."));
      return;
    }
    // When email verification is required, Better Auth creates no session.
    if (!data?.token) {
      setCheckEmail(true);
      return;
    }
    router.replace("/dashboard");
    router.refresh();
  }

  if (checkEmail) {
    return (
      <p role="status" className="text-sm">
        Check your inbox for a verification link, then{" "}
        <Link href="/login" className="font-medium underline-offset-4 hover:underline">
          sign in
        </Link>
        .
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="grid gap-4">
      <FormAlert message={formError} />
      <FormField id="name" label="Name" autoComplete="name" error={errors.name?.message} {...register("name")} />
      <FormField id="email" label="Email" type="email" autoComplete="email" error={errors.email?.message} {...register("email")} />
      <FormField
        id="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        hint="At least 10 characters."
        error={errors.password?.message}
        {...register("password")}
      />
      <FormField
        id="confirm"
        label="Confirm password"
        type="password"
        autoComplete="new-password"
        error={errors.confirm?.message}
        {...register("confirm")}
      />
      <Button type="submit" size="lg" className="h-10" disabled={isSubmitting}>
        {isSubmitting ? "Creating account…" : "Create account"}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
