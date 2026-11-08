"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormAlert, FormField } from "@/components/auth/form-field";
import { Button } from "@/components/ui/button";
import { bootstrapAction } from "@/features/setup/actions";

const schema = z
  .object({
    token: z.string().min(1, "Enter the setup token"),
    name: z.string().trim().min(1, "Enter your name").max(80),
    email: z.email("Enter a valid email address"),
    password: z.string().min(10, "Use at least 10 characters").max(128),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords don't match" });
type Values = z.infer<typeof schema>;

export function SetupForm() {
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  async function onSubmit(values: Values) {
    setFormError(null);
    const { token, name, email, password } = values;
    const result = await bootstrapAction({ token, name, email, password });
    if (!result.ok) {
      setFormError(result.error);
      for (const [field, messages] of Object.entries(result.fieldErrors ?? {})) {
        if (messages?.[0]) setError(field as keyof Values, { message: messages[0] });
      }
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <div role="status" className="grid gap-3 text-sm">
        <p>Your administrator account is ready. Initial setup is now permanently closed.</p>
        <Link href="/login" className="font-medium underline-offset-4 hover:underline">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="grid gap-4">
      <FormAlert message={formError} />
      <FormField
        id="token"
        label="Setup token"
        type="password"
        autoComplete="off"
        hint="The setup token configured by your operator (in Coolify: SERVICE_BASE64_64_SETUPTOKEN)."
        error={errors.token?.message}
        {...register("token")}
      />
      <FormField id="name" label="Your name" autoComplete="name" error={errors.name?.message} {...register("name")} />
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
      <FormField id="confirm" label="Confirm password" type="password" autoComplete="new-password" error={errors.confirm?.message} {...register("confirm")} />
      <Button type="submit" size="lg" className="h-10" disabled={isSubmitting}>
        {isSubmitting ? "Creating administrator…" : "Create administrator"}
      </Button>
    </form>
  );
}
