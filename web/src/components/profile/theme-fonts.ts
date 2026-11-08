/**
 * Self-hosted profile theme fonts, using Fontsource's documented CSS
 * imports. The bundler copies the font files into `/_next/static/media`, so
 * they're served from the app origin (CSP `font-src 'self'`); nothing is
 * fetched from Google at build time or at runtime.
 *
 * Nothing is preloaded: an @font-face file is only downloaded when an element
 * uses that family, and `unicode-range` limits it to the scripts on the page
 * (Latin for Latin text). Variable fonts use the `wght` axis only; DM Serif
 * Display has one weight (400, Latin). Italics are synthesized.
 *
 * Family names must match `FONT_STACKS` (features/themes/css.ts).
 * Licenses: web/public/licenses/fonts/ (all SIL OFL 1.1).
 */
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/manrope/wght.css";
import "@fontsource-variable/space-grotesk/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource/dm-serif-display/latin-400.css";
