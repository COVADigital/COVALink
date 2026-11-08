/** Maps Better Auth client errors to user-facing text without leaking internals. */
export function authErrorMessage(error: { status?: number; message?: string; code?: string } | null | undefined, fallback: string): string {
  if (!error) return fallback;
  switch (error.status) {
    case 401:
      return "Incorrect email or password.";
    case 403:
      // Server-authored policy messages (registration closed, account disabled) are safe to show.
      return error.message || "You don't have permission to do that.";
    case 422:
      return error.code === "USER_ALREADY_EXISTS" || /already exists/i.test(error.message ?? "")
        ? "An account with this email already exists."
        : error.message || fallback;
    case 429:
      return "Too many attempts. Please wait a minute and try again.";
    default:
      return fallback;
  }
}
