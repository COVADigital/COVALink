# Using COVALink

This guide is for people who use a COVALink installation: profile owners, and the administrators who run it. To install COVALink, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Accounts

- **Signing up:** open `/register`. It's available only when an administrator has enabled public sign-up. If the installation requires email verification, confirm your address with the link sent to you before signing in; `/login` offers to resend it.
- **Signing in and out:** `/login`. Sessions last 30 days. Signing out ends the session on that device.
- **Forgotten password:** `/forgot-password` sends a reset link that works once, within an hour. The page shows the same message whether or not the address has an account. If the installation has no email delivery, it tells you to ask an administrator.
- **Your account page** (`/dashboard/account`): change your display name or password. Changing the password signs out your other devices unless you choose otherwise. You can also delete your account here, which needs your password and a typed confirmation, and removes your profiles and uploaded images. Administrators can't delete their own account until they're demoted.

## Profiles

Each account can have several profiles, up to the limit the administrator sets (five by default). Each profile has a **handle**, and its public page is `https://<domain>/<handle>`.

Open **Profiles** in the dashboard to create a profile and to switch between your profiles.

### Editing and publishing

The editor shows a live preview beside your changes.

- **Save draft** keeps your changes in the profile's **draft**. Visitors never see the draft.
- **Publish** saves the draft and makes it the public page. Publishing is refused if the theme doesn't have enough contrast to be readable.
- **Discard changes** returns the draft to the published version.
- **Unpublish** takes the public page offline without deleting anything.
- If the same profile is open in two places, saving an older copy is refused rather than overwriting newer changes. Reload to get the current version.

**Header and SEO:** the profile's name, bio and avatar, an optional page title and description for search engines and link previews, and an option asking search engines not to index the page.

### Blocks

The page is a list of blocks. Add a block, edit it, then reorder it with drag and drop or the Move up and Move down buttons; you can also duplicate, hide or delete each block. Hidden blocks stay in the draft but aren't shown publicly.

| Block | What it shows |
|---|---|
| Link | A button that links to a web address, with an optional description |
| Heading | A section heading |
| Text | A paragraph, with Markdown links |
| Divider | A horizontal line |
| Spacer | Empty space of a fixed height |
| Social links | Badges linking to your profiles on supported platforms (any https address for Mastodon and Website) |
| Email | A button that opens the visitor's email app, with an optional subject |
| Phone | A button that starts a call |
| Contact card | A downloadable contact card (vCard) with a name or organization, and optionally a job title, email, phone, website and note |
| Image | One of your uploaded images, with alternative text, an optional caption and an optional link |
| Video | A YouTube or Vimeo video |
| Music | A Spotify track, album, playlist, artist, episode or show, or a SoundCloud track or playlist |

**Links** must be `http` or `https` addresses. Addresses without a scheme, such as `example.com`, are saved as `https`.

**Images:** describe each image for people using screen readers, or mark it as decorative. A decorative image has no description and can't be a link.

**Video and music:** paste the link to the video or track from the provider's site; embed codes aren't accepted. Visitors see a box with a **Load** button and an **Open on** link. Nothing is loaded from the provider until the visitor presses Load, and then the provider can collect data about that visitor. The editor preview never loads the player.

### Appearance

Choose one of ten preset themes (Minimal, Midnight, Editorial, Creator, Portfolio, Neon, Soft Gradient, Business, Music and Glass), then adjust colors, the background (a solid color, a gradient or one of your uploaded images, with an overlay), button style and shape, and fonts. Fonts are served from the installation itself, not from a third party.

Publishing is refused if text or buttons would fall below the WCAG AA contrast ratio (4.5:1 for text, 3:1 for outlines and accents). You can save a draft with low contrast while you work on it.

A theme the editor can't reproduce exactly, such as one created by an older version, is shown as locked. It's kept unchanged until you deliberately replace it with a preset.

### Images

Upload avatars, background images and images for image blocks from the editor. You can upload JPEG, PNG and WebP images of up to 5 MiB and 8192 pixels on each side. Every image is converted to WebP and resized, and all metadata, including location data, is removed. The administrator sets how much storage and how many uploads per hour each account gets.

An image can't be deleted while any of your profiles, draft or published, still uses it. Image addresses are hard to guess but not secret: anyone with an image's address can view it.

## Analytics and QR codes

Each profile has an **Analytics** page, visible only to you, with views, clicks and an estimate of visitors over a date range, plus the top links, referring sites and device types.

- COVALink doesn't use cookies for analytics and doesn't store visitors' IP addresses.
- Your own signed-in visits, bots and link-preview requests aren't counted, so the numbers are estimates.
- Whether visitor counts are available depends on how the installation is configured.
- Old analytics are deleted after the retention period the administrator sets.

The analytics page also offers a **QR code** for the profile, as an SVG download. If you change the profile's handle, download a new code: the old one points to the old address.

## Administration

Administrators see **Admin** in the dashboard (`/admin`).

- **Overview:** the installation's status: the version, whether the database and image storage are working, the number of applied migrations, whether email is configured, and the analytics retention.
- **Users:** search and filter accounts and open an account to see its profiles. Administrators can disable or re-enable ordinary users; disabling signs the user out everywhere and takes their profiles offline. Only the super administrator can make a user an administrator or remove administrator rights. Nobody can change their own account here.
- **Settings:** the site name, profiles per account, image storage and upload limits, and analytics retention. Registration settings (public sign-up and invite-only mode) can be changed only by the super administrator. Invite-only mode closes registration completely, because invitations aren't implemented.
- **Audit log:** every administrative and sensitive account change, newest first, with who made it and when.

Email delivery is configured by the installation's operator through environment variables, not in the admin pages ([EMAIL_DELIVERY.md](EMAIL_DELIVERY.md)).
