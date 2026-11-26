#!/usr/bin/env node
// Builds `latest.json` for tauri-plugin-updater from the signed installers of a release.
//
//   node scripts/make-latest-json.mjs <dist-dir> <tag> [out-file]
//
// <dist-dir> holds the downloaded build artifacts (searched recursively). Each updater
// bundle must have a matching `.sig` next to it; `signature` is the *content* of that file.
// Exits non-zero when any platform is missing, so a release never ships a partial latest.json.
//
// The macOS `.app.tar.gz` has no version in its name, so it (in place) to `Termindo_<version>_universal.app.tar.gz` (+ `.sig`) before upload.
//
// Env: GITHUB_REPOSITORY (default bionyxxx/termindo), RELEASE_NOTES (optional).

import { readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const [distDir, tag, outFile = join(distDir ?? ".", "latest.json")] = process.argv.slice(2);
if (!distDir || !tag) {
  console.error("usage: make-latest-json.mjs <dist-dir> <tag> [out-file]");
  process.exit(2);
}
const version = tag.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`tag ${tag} is not a version`);
  process.exit(2);
}
const repo = process.env.GITHUB_REPOSITORY || "bionyxxx/termindo";
const downloadBase = `https://github.com/${repo}/releases/download/${tag}`;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(distDir);

const errors = [];

/** Finds exactly one bundle matching `test` that has a `.sig`. */
function bundle(label, test) {
  const found = files.filter((f) => test(basename(f)));
  if (found.length !== 1) {
    errors.push(`${label}: expected 1 file, found ${found.length}${found.length ? ` (${found.map((f) => basename(f)).join(", ")})` : ""}`);
    return null;
  }
  const file = found[0];
  const sig = `${file}.sig`;
  if (!files.includes(sig)) {
    errors.push(`${label}: missing signature ${basename(sig)}`);
    return null;
  }
  const signature = readFileSync(sig, "utf8").trim();
  if (!signature) {
    errors.push(`${label}: empty signature ${basename(sig)}`);
    return null;
  }
  return { file, signature };
}

function entry(b, name = basename(b.file)) {
  return { signature: b.signature, url: `${downloadBase}/${encodeURIComponent(name)}` };
}

const appImage = bundle("linux AppImage", (n) => n.endsWith(".AppImage") && n.includes(version));
const nsis = bundle("windows NSIS", (n) => n.endsWith("-setup.exe") && n.includes(version));
const msi = bundle("windows MSI", (n) => n.endsWith(".msi") && n.includes(version));
const mac = bundle("macOS app", (n) => n.endsWith(".app.tar.gz"));

if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}

const macName = `Termindo_${version}_universal.app.tar.gz`;
if (basename(mac.file) !== macName) {
  const target = join(dirname(mac.file), macName);
  renameSync(mac.file, target);
  renameSync(`${mac.file}.sig`, `${target}.sig`);
  console.error(`renamed ${basename(mac.file)} -> ${macName}`);
}
const macEntry = entry(mac, macName);

const manifest = {
  version,
  notes: process.env.RELEASE_NOTES || `See https://github.com/${repo}/releases/tag/${tag}`,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    // Bundle-specific keys are tried first (`{os}-{arch}-{installer}`), then `{os}-{arch}`.
    "linux-x86_64": entry(appImage),
    "linux-x86_64-appimage": entry(appImage),
    "darwin-aarch64": macEntry,
    "darwin-x86_64": macEntry,
    "windows-x86_64": entry(nsis),
    "windows-x86_64-nsis": entry(nsis),
    // Without this an MSI install would fall back to the NSIS installer.
    "windows-x86_64-msi": entry(msi),
  },
};

writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.error(`wrote ${outFile}`);
