"use server";

import { z } from "zod";
import { isSettingKey, setSetting, type SettingKey, type SettingValue } from "@/features/settings/service";
import { getCurrentUser } from "@/lib/auth/session";
import { AppError, type ActionResult } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { changeUserRole, setUserBanned, type MutationResult } from "./users";

/**
 * Administrative Server Actions. They are public HTTP
 * endpoints: each re-resolves the session, validates its input strictly, and
 * delegates to a service that re-reads the actor's role from the database and
 * enforces the capability and escalation rules. Refusals are logged with the
 * action name and error code only (no ids of other people, no submitted
 * values).
 */

async function run<T>(name: string, input: unknown, schema: z.ZodType, fn: (actorId: string, data: never) => Promise<T>): Promise<ActionResult<T>> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Your session has expired. Please sign in again." };
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    logger.info({ action: name, code: "VALIDATION" }, "Admin action refused");
    return { ok: false, error: "That request isn't valid.", code: "VALIDATION" };
  }
  try {
    return { ok: true, data: await fn(user.id, parsed.data as never) };
  } catch (err) {
    if (err instanceof AppError) {
      logger.info({ action: name, code: err.code }, "Admin action refused");
      return { ok: false, error: err.message, code: err.code };
    }
    logger.error({ err, action: name }, "Admin action failed");
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}

const userId = z.string().min(1).max(64);

const disableInput = z.object({ userId, disabled: z.boolean() }).strict();
const roleInput = z.object({ userId, role: z.enum(["user", "admin"]) }).strict();
const settingInput = z
  .object({
    key: z.string().refine(isSettingKey),
    value: z.union([z.boolean(), z.number().finite(), z.string().max(200)]),
  })
  .strict();

export async function setUserDisabledAction(input: unknown): Promise<ActionResult<MutationResult>> {
  return run("admin.setUserDisabled", input, disableInput, (actorId, data: z.output<typeof disableInput>) =>
    setUserBanned(actorId, data.userId, data.disabled),
  );
}

export async function changeUserRoleAction(input: unknown): Promise<ActionResult<MutationResult>> {
  return run("admin.changeUserRole", input, roleInput, (actorId, data: z.output<typeof roleInput>) => changeUserRole(actorId, data.userId, data.role));
}

export async function updateSettingAction(input: unknown): Promise<ActionResult<{ changed: boolean }>> {
  return run("admin.updateSetting", input, settingInput, (actorId, data: z.output<typeof settingInput>) =>
    setSetting(data.key as SettingKey, data.value as SettingValue<SettingKey>, actorId),
  );
}
