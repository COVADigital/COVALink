import { BadgeCheck } from "lucide-react";
import { ProfileBlocks, type ViewBlock } from "@/components/profile/blocks";
import type { ProfileDocument } from "@/features/profiles/document";
import { themeToStyle } from "@/features/themes/css";
import "./theme-fonts";

type HeaderContent = ProfileDocument["header"];

/** A profile document whose blocks may include incomplete editor blocks (preview only). */
export type ViewDocument = Omit<ProfileDocument, "blocks"> & { blocks: readonly ViewBlock[] };

/**
 * Profile header shared by the public page and the editor preview (one
 * rendering path). Pure and client-safe: no server-only imports.
 * External avatars are loaded with `no-referrer` so the visitor's current URL
 * isn't sent to the image host (their IP and user agent still are).
 */
export function ProfileHeader({
  header,
  verified,
  nameAs: NameTag = "h1",
}: {
  header: HeaderContent;
  verified: boolean;
  nameAs?: "h1" | "p";
}) {
  return (
    <header className="pp-header">
      {header.avatarUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- owner-supplied external URL; dimensions unknown
        <img
          className="pp-avatar"
          src={header.avatarUrl}
          alt=""
          width={96}
          height={96}
          referrerPolicy="no-referrer"
          decoding="async"
        />
      )}
      <NameTag className="pp-name" data-testid="profile-name">
        {header.displayName}
        {verified && (
          <BadgeCheck className="pp-verified" role="img" aria-label="Verified" />
        )}
      </NameTag>
      {header.bio && (
        <p className="pp-bio" data-testid="profile-bio">
          {header.bio}
        </p>
      )}
    </header>
  );
}

/**
 * Themed profile page body, shared by `/{handle}` and the editor preview: the
 * header, then the ordered blocks (`ProfileBlocks` renders only visible blocks
 * of reviewed types). `mode="preview"` renders the same markup inside
 * the editor (no page-level <main>, name not an <h1>, links open a new tab,
 * incomplete editor blocks shown as placeholders).
 */
export function ProfileView({
  document,
  verified,
  mode,
  clickTrackingProfileId,
}: {
  document: ViewDocument;
  verified: boolean;
  mode: "public" | "preview";
  /** Public page only: routes link blocks through `/go` (RenderContext). */
  clickTrackingProfileId?: string;
}) {
  const Root = mode === "public" ? "main" : "div";
  return (
    <div className="pp-root" data-mode={mode} style={themeToStyle(document.theme)}>
      <Root className="pp-container">
        <ProfileHeader header={document.header} verified={verified} nameAs={mode === "public" ? "h1" : "p"} />
        <ProfileBlocks
          blocks={document.blocks}
          ctx={{
            mode,
            openLinksInNewTab: document.settings.openLinksInNewTab,
            clickTrackingProfileId,
            socialStyle: document.theme.social.style,
          }}
        />
        {document.settings.showBranding && (
          <footer className="pp-footer">
            <span>Made with COVALink</span>
          </footer>
        )}
      </Root>
    </div>
  );
}
