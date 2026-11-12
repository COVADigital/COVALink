// Real sharp operations that exercise libvips and each LGPL library built into
// it (glib, libheif, librsvg, pango, fribidi, proxy-libintl, libexif). Run
// inside a COVALink image: `node /tmp/sharp-ops.cjs`. Prints JSON, including
// the path and SHA-256 of the libvips library actually loaded; exits 0 only if
// every operation succeeds.
const fs = require("fs");
const crypto = require("crypto");
const sharp = require("/app/node_modules/sharp");
const out = {};
const ok = (k, v) => { out[k] = v; };
(async () => {
  const map = fs.readFileSync("/proc/self/maps", "utf8").split("\n").find((l) => l.includes("libvips-cpp.so"));
  const loaded = map.trim().split(/\s+/).pop();
  ok("loaded", loaded);
  ok("loadedSha256", crypto.createHash("sha256").update(fs.readFileSync(loaded)).digest("hex"));
  ok("libvipsVersion", sharp.versions.vips);
  const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#3366cc" } }).resize(320, 240).blur(2).png().toBuffer();
  ok("resize", (await sharp(png).metadata()).width === 320);
  for (const f of ["jpeg", "webp", "gif", "tiff"]) ok(`encode_${f}`, (await sharp(png).toFormat(f).toBuffer()).length > 0);
  const avif = await sharp(png).avif({ quality: 50 }).toBuffer();
  ok("heif_roundtrip", (await sharp(avif).metadata()).format === "heif");
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="red"/><circle cx="25" cy="25" r="20" fill="blue"/></svg>');
  const s = await sharp(svg).png().raw().toBuffer({ resolveWithObject: true });
  ok("svg", s.info.width === 100 && s.data[0] > 200);
  const t = await sharp({ text: { text: "COVALink שלום مرحبا", dpi: 150, rgba: true } }).png().toBuffer({ resolveWithObject: true });
  ok("bidi_text", t.info.width > 50 && t.info.height > 10);
  const ex = await sharp(png).withExif({ IFD0: { Copyright: "COVALink test", Software: "COVALink swap test" } }).jpeg().toBuffer();
  const md = await sharp(ex).metadata();
  ok("exif_roundtrip", !!md.exif && md.exif.includes("COVALink swap test"));
  out.allPassed = Object.entries(out).filter(([k]) => !["loaded", "loadedSha256", "libvipsVersion"].includes(k)).every(([, v]) => v === true);
  console.log(JSON.stringify(out));
  process.exit(out.allPassed ? 0 : 1);
})().catch((e) => { console.log(JSON.stringify({ ...out, error: String(e && e.message) })); process.exit(1); });
