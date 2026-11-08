# Email delivery

COVALink can run without an email provider, but email delivery is required for password recovery and for registrations that require email verification. COVALink sends account email through standard SMTP.

This guide covers:

- configuring any compatible SMTP provider;
- using a separately hosted useSend installation through its optional SMTP proxy;
- checking registration and password-reset email after deployment.

It doesn't add useSend, Amazon SES, Redis or another database to the COVALink stack.

**What has been tested:** COVALink's SMTP behavior is covered by the application and deployment test suites. The useSend path below follows useSend's documentation, but it hasn't been tested end to end with COVALink. Treat it as a recipe, and run the checks in [Verification after deployment](#verification-after-deployment).

## What's supported

| Capability | Support |
|---|---|
| Password-reset email | Supported through SMTP |
| Registration verification and resending the verification link | Supported through SMTP when `REQUIRE_EMAIL_VERIFICATION=true` |
| Running without email | Supported when `REQUIRE_EMAIL_VERIFICATION=false`; password recovery is then unavailable |
| Sending through useSend's REST API directly | Not implemented |
| Newsletter subscriptions, marketing consent and campaigns | Not implemented |

Verifying an email address proves control of the address. It isn't consent to receive marketing email.

## Standard SMTP configuration

Set these variables in Coolify's Environment Variables page, or in your env file on a plain host. Keep them runtime-only, and mark `SMTP_PASSWORD` as secret.

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=provider-assigned-user
SMTP_PASSWORD=provider-assigned-password
SMTP_FROM="COVALink <no-reply@example.com>"
```

- Ports 587 and 2587 normally use STARTTLS: set `SMTP_SECURE=false`.
- Ports 465 and 2465 normally use implicit TLS: set `SMTP_SECURE=true`.
- A blank `SMTP_PORT` means 587 when `SMTP_SECURE=false`, and 465 when it's `true`.
- `SMTP_FROM` must use a sender your provider accepts. Setting it doesn't create your domain's SPF, DKIM or DMARC records.

Once SMTP works, you can require email verification for new accounts:

```dotenv
REQUIRE_EMAIL_VERIFICATION=true
```

COVALink refuses to start in production with verification required unless `SMTP_HOST` and `SMTP_FROM` are set. Whether people can register at all is a separate choice, controlled by `REGISTRATION_ENABLED` and the administrator settings.

## Optional: useSend with Amazon SES

useSend is an optional, separately operated email platform. Keep its application, PostgreSQL, Redis, AWS credentials, GitHub sign-in credentials, backups and upgrades outside the COVALink Compose stack.

COVALink connects to it like this:

```text
COVALink --SMTP over TLS--> useSend SMTP proxy --HTTPS API--> useSend --Amazon SES--> recipient
```

The main useSend application doesn't accept SMTP itself; useSend provides an optional SMTP proxy for applications that send through SMTP.

### 1. Deploy and configure useSend separately

Use Coolify's useSend service, or follow useSend's [self-hosting guide](https://docs.usesend.com/self-hosting/overview). At a minimum:

1. Give useSend its own public HTTPS hostname.
2. Set the environment variables your useSend Compose definition requires. Names can differ between useSend's guide and a Coolify template, so use the names Coolify actually shows.
3. Configure GitHub sign-in for the useSend administrator.
4. Configure an AWS region, SES and SNS as useSend describes.
5. Add and verify your sending domain. Use the DNS records generated for your installation; never copy DKIM values from another installation.
6. Request [SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) in the same region. SES sandbox status and quotas are per region.
7. Send a test message from useSend, and check the SPF, DKIM and DMARC results and the delivery event.

useSend stores message content. Its self-hosting guide documents `EMAIL_CLEANUP_DAYS`; choose a retention period deliberately rather than keeping account email indefinitely.

AWS access keys, GitHub sign-in secrets and useSend's database credentials belong only to the useSend installation. Don't copy them into COVALink.

### 2. Add the useSend SMTP proxy

Deploy the proxy as a separate Coolify resource, or in useSend's own stack. Don't add it to COVALink's `compose.prod.yaml`.

Follow useSend's [SMTP proxy instructions](https://docs.usesend.com/self-hosting/overview#step-5-smtp-proxy-server-optional). The proxy image is `usesend/smtp-proxy`, and it needs:

- `USESEND_BASE_URL`: the public HTTPS address of your useSend installation;
- `SMTP_AUTH_USERNAME`: the username COVALink will use, commonly `usesend`;
- a useSend API key, which the SMTP client sends as its password.

Pin a specific image version or digest rather than relying on a floating `latest` tag.

Expose only the SMTP port you'll use, require TLS, create a dedicated API key for COVALink, and restrict network access to the COVALink host where you can. useSend lists ports 2587 (STARTTLS) and 2465 (implicit TLS) as alternatives that avoid common port conflicts.

### 3. Connect COVALink

For implicit TLS on port 2465:

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=2465
SMTP_SECURE=true
SMTP_USER=usesend
SMTP_PASSWORD=USESEND_API_KEY_CREATED_FOR_COVALINK
SMTP_FROM="COVALink <no-reply@example.com>"
REQUIRE_EMAIL_VERIFICATION=true
```

For STARTTLS on port 2587, use `SMTP_SECURE=false`. Replace the host, sender and credentials with your own installation's values. Never commit the API key, or paste it into support messages, screenshots or logs.

Variables such as `EMAIL_PROVIDER=usesend`, `USESEND_API_URL` or `USESEND_API_KEY` aren't COVALink settings: COVALink sends only through SMTP.

## Verification after deployment

Use a mailbox you control.

1. Confirm that the COVALink email variables are runtime-only and that the password is secret.
2. Redeploy COVALink and confirm that `/api/ready` returns 200.
3. Request a password reset at `/forgot-password`.
4. Confirm that the message arrives, that its link uses your `APP_URL`, and that the reset works once.
5. With email verification enabled, register a test account.
6. Confirm that sign-in is refused before verification, that resending works, that the verification link works, and that sign-in works afterwards.
7. Check the COVALink log for `Email delivery failed`. The public forms deliberately don't reveal whether an address exists or whether delivery succeeded.
8. If you use useSend, confirm that the messages and their delivery events appear in its dashboard.

If public registration isn't ready, keep it closed and run these checks with accounts you control.

## Troubleshooting

| Symptom | Check |
|---|---|
| COVALink exits with code 78 | With verification enabled, `SMTP_HOST` and `SMTP_FROM` must be set. Also check the other settings named in the start-up log. |
| No reset email, and no SMTP configured | Configure SMTP. Without it, production drops the message and tells the person to contact an administrator. |
| Authentication rejected | Check the SMTP username and password. For useSend's proxy, the password is the dedicated useSend API key. |
| TLS or certificate failure | Match `SMTP_SECURE` to the port, and use a hostname covered by a trusted certificate. |
| Sender rejected | Verify the From domain and address with your provider, and check the SPF, DKIM and DMARC records. |
| useSend shows Sent but no later events | Check its SNS subscription, SES event destination, public callback address and logs. Don't disable signature verification as a permanent fix. |
| SES can send only to verified recipients | Request production access in the AWS region useSend uses. |

For the rest of COVALink's production configuration, see [CONFIGURATION.md](CONFIGURATION.md) and [DEPLOYMENT.md](DEPLOYMENT.md).
