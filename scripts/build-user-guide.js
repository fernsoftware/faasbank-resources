#!/usr/bin/env node
/*
 * build-user-guide.js
 *
 * Round-trip build script for the FaaSBank User Guide.
 *
 *   node scripts/build-user-guide.js
 *
 * Reads the numbered chapter files in user-guide/, concatenates them into a
 * single markdown document, and uses pandoc to produce a Word document and a
 * single-file HTML document in build/.
 *
 * No npm dependencies: node built-ins + pandoc only.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const GUIDE_DIR = path.join(REPO_ROOT, 'user-guide');
const IMAGES_DIR = path.join(GUIDE_DIR, 'images');
const BUILD_DIR = path.join(REPO_ROOT, 'build');
const COMBINED_MD = path.join(BUILD_DIR, 'user-guide.md');
const DOCX_OUT = path.join(BUILD_DIR, 'FaaSBank User Guide.docx');
const HTML_OUT = path.join(BUILD_DIR, 'FaaSBank User Guide.html');

const WINGET_CMD = 'winget install --id JohnMacFarlane.Pandoc';

// ---------------------------------------------------------------------------
// pandoc discovery
// ---------------------------------------------------------------------------

/** Returns the pandoc executable to use, or exits with a clear message. */
function findPandoc() {
  // 1. pandoc on PATH.
  const probe = spawnSync('pandoc', ['--version'], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (!probe.error && probe.status === 0) return 'pandoc';

  // 2. The default per-user Windows install location.
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const candidate = path.join(localAppData, 'Pandoc', 'pandoc.exe');
    if (fs.existsSync(candidate)) {
      const probe2 = spawnSync(candidate, ['--version'], {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
      });
      if (!probe2.error && probe2.status === 0) return candidate;
    }
  }

  console.error('ERROR: pandoc was not found.');
  console.error('');
  console.error('This script needs pandoc to convert the markdown chapters into');
  console.error('Word and HTML. Looked for:');
  console.error('  1. "pandoc" on PATH');
  console.error(
    `  2. ${path.join(localAppData || '%LOCALAPPDATA%', 'Pandoc', 'pandoc.exe')}`
  );
  console.error('');
  console.error('Install it with:');
  console.error(`  ${WINGET_CMD}`);
  console.error('');
  console.error('Then open a new terminal and re-run this script.');
  process.exit(1);
}

function pandocVersion(pandocExe) {
  const r = spawnSync(pandocExe, ['--version'], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  const first = (r.stdout || '').split(/\r?\n/)[0] || 'pandoc (unknown version)';
  return first.trim();
}

// ---------------------------------------------------------------------------
// chapter discovery and link rewriting
// ---------------------------------------------------------------------------

/** user-guide/[0-9][0-9]-*.md, sorted by the leading number. README.md excluded. */
function findChapters() {
  if (!fs.existsSync(GUIDE_DIR)) {
    console.error(`ERROR: chapter folder not found: ${GUIDE_DIR}`);
    process.exit(1);
  }
  const files = fs
    .readdirSync(GUIDE_DIR)
    .filter((name) => /^[0-9]{2}-.*\.md$/i.test(name))
    .map((name) => ({ name, num: parseInt(name.slice(0, 2), 10) }))
    .sort((a, b) => a.num - b.num || a.name.localeCompare(b.name))
    .map((entry) => entry.name);

  if (files.length === 0) {
    console.error(`ERROR: no chapter files matching [0-9][0-9]-*.md in ${GUIDE_DIR}`);
    process.exit(1);
  }
  return files;
}

/**
 * GitHub-flavoured auto identifier, matching pandoc's gfm_auto_identifiers:
 * lowercase, drop everything except alphanumerics / '-' / '_' / spaces,
 * then spaces become hyphens.
 */
function gfmSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** The text of the first H1 in a chapter, or null. */
function firstH1(markdown) {
  const m = markdown.match(/^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m);
  return m ? m[1].trim() : null;
}

/** Strip inline markdown emphasis/code/links so the slug matches the rendered text. */
function headingTextToSlugSource(text) {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2');
}

/**
 * Rewrites intra-guide relative links so they resolve inside the single
 * combined document:
 *   NN-slug.md#anchor -> #anchor
 *   NN-slug.md        -> #<slug of that chapter's H1>
 * Everything else (external URLs, image paths, bare #anchors) is untouched.
 */
function rewriteIntraGuideLinks(markdown, chapterAnchors, stats) {
  // Only link destinations: "](" ... ")" with no whitespace/parens inside.
  return markdown.replace(
    /(\]\()([0-9]{2}-[^()\s#]*?\.md)(#[^()\s]*)?(\))/g,
    (whole, open, file, anchor, close) => {
      const key = file.toLowerCase();
      if (!chapterAnchors.has(key)) {
        // Not one of our chapters - leave it exactly as it was.
        stats.unknown.push(file + (anchor || ''));
        return whole;
      }
      if (anchor) {
        stats.withAnchor += 1;
        return `${open}${anchor}${close}`;
      }
      stats.withoutAnchor += 1;
      return `${open}#${chapterAnchors.get(key)}${close}`;
    }
  );
}

// ---------------------------------------------------------------------------
// markdown counting
// ---------------------------------------------------------------------------

/** Counts ATX headings per level, ignoring fenced code blocks. */
function countMarkdownHeadings(markdown) {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  let fence = null;
  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = line.match(/^ {0,3}(#{1,6})[ \t]+\S/);
    if (h) counts[h[1].length] += 1;
  }
  return counts;
}

/** Counts inline image references, ignoring fenced code blocks. */
function countMarkdownImages(markdown) {
  let fence = null;
  let total = 0;
  const missing = [];
  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    for (const m of line.matchAll(/!\[[^\]]*\]\(\s*([^)\s]*)[^)]*\)/g)) {
      total += 1;
      const target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;
      const onDisk = path.join(GUIDE_DIR, decodeURIComponent(target));
      if (!fs.existsSync(onDisk)) missing.push(target);
    }
  }
  return { total, missing };
}

// ---------------------------------------------------------------------------
// minimal zip reader (node built-ins only)
// ---------------------------------------------------------------------------

function readZipCentralDirectory(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('file does not start with a zip local-file header');
  }

  // End of central directory record: scan backwards over the max comment size.
  let eocd = -1;
  const floor = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('end-of-central-directory record not found');

  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // Zip64 end-of-central-directory locator sits immediately before the EOCD.
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      if (buf.readUInt32LE(z64) !== 0x06064b50) {
        throw new Error('zip64 end-of-central-directory record not found');
      }
      count = Number(buf.readBigUInt64LE(z64 + 32));
      cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error(`bad central-directory signature for entry ${i}`);
    }
    const method = buf.readUInt16LE(p + 10);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const headerId = buf.readUInt16LE(e);
        const size = buf.readUInt16LE(e + 2);
        let q = e + 4;
        if (headerId === 0x0001) {
          if (usize === 0xffffffff) { usize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(buf.readBigUInt64LE(q)); q += 8; }
        }
        e += 4 + size;
      }
    }

    entries.set(name, { name, method, csize, usize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return { buf, entries };
}

function extractZipEntry(zip, name) {
  const entry = zip.entries.get(name);
  if (!entry) return null;
  const { buf } = zip;
  if (buf.readUInt32LE(entry.localOffset) !== 0x04034b50) {
    throw new Error(`bad local-file header for ${name}`);
  }
  const nameLen = buf.readUInt16LE(entry.localOffset + 26);
  const extraLen = buf.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.csize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`unsupported zip compression method ${entry.method} for ${name}`);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function countMatches(text, regex) {
  const m = text.match(regex);
  return m ? m.length : 0;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(2)} MB (${bytes.toLocaleString('en-US')} bytes)`;
  return `${(bytes / 1024).toFixed(1)} KB (${bytes.toLocaleString('en-US')} bytes)`;
}

function runPandoc(pandocExe, args, label) {
  const result = spawnSync(pandocExe, args, {
    cwd: GUIDE_DIR, // so relative images/... paths resolve
    encoding: 'utf8',
    shell: false, // args array: file names contain spaces
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    console.error(`ERROR: failed to run pandoc for ${label}: ${result.error.message}`);
    process.exit(1);
  }
  const warnings = [(result.stderr || '').trim(), (result.stdout || '').trim()]
    .filter(Boolean)
    .join('\n');
  if (result.status !== 0) {
    console.error(`ERROR: pandoc exited ${result.status} while building ${label}.`);
    if (warnings) console.error(warnings);
    process.exit(1);
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const pandocExe = findPandoc();
  const version = pandocVersion(pandocExe);

  const chapters = findChapters();

  // Pass 1: read chapters, learn each chapter's H1 anchor.
  const sources = [];
  const chapterAnchors = new Map();
  for (const name of chapters) {
    const text = fs.readFileSync(path.join(GUIDE_DIR, name), 'utf8');
    const h1 = firstH1(text);
    if (!h1) {
      console.error(`ERROR: ${name} has no H1 heading; cannot build a link anchor for it.`);
      process.exit(1);
    }
    chapterAnchors.set(name.toLowerCase(), gfmSlug(headingTextToSlugSource(h1)));
    sources.push({ name, text, h1 });
  }

  // Pass 2: rewrite intra-guide links and concatenate.
  const linkStats = { withAnchor: 0, withoutAnchor: 0, unknown: [] };
  const parts = sources.map((chapter) =>
    rewriteIntraGuideLinks(chapter.text, chapterAnchors, linkStats).replace(/\s+$/, '')
  );
  const combined = parts.join('\n\n') + '\n';

  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.writeFileSync(COMBINED_MD, combined, 'utf8');

  const mdHeadings = countMarkdownHeadings(combined);
  const mdImages = countMarkdownImages(combined);

  // -- pandoc -------------------------------------------------------------
  //
  // Reader: plain `gfm`. GFM/CommonMark already turns two trailing spaces
  // into a hard break, so `gfm+hard_line_breaks` is NOT wanted: it would
  // additionally turn every soft line wrap inside a paragraph into a break.
  //
  // --resource-path is passed so images/... resolves no matter the cwd, in
  // addition to running pandoc with cwd = user-guide/.
  const resourcePath = [GUIDE_DIR, IMAGES_DIR, '.'].join(path.delimiter);
  const commonArgs = [
    '-f', 'gfm',
    '--toc',
    '--toc-depth=3',
    '--resource-path', resourcePath,
    COMBINED_MD,
  ];

  const docxWarnings = runPandoc(
    pandocExe,
    [...commonArgs, '-t', 'docx', '-o', DOCX_OUT],
    'the Word document'
  );
  const htmlWarnings = runPandoc(
    pandocExe,
    [...commonArgs, '-t', 'html', '--standalone', '--embed-resources', '-o', HTML_OUT],
    'the HTML document'
  );

  // -- validate the docx --------------------------------------------------
  let zip;
  try {
    zip = readZipCentralDirectory(DOCX_OUT);
  } catch (err) {
    console.error(`ERROR: ${path.basename(DOCX_OUT)} is not a valid zip: ${err.message}`);
    process.exit(1);
  }
  const documentXmlBuf = extractZipEntry(zip, 'word/document.xml');
  if (!documentXmlBuf) {
    console.error(
      `ERROR: ${path.basename(DOCX_OUT)} is a zip but contains no word/document.xml.`
    );
    process.exit(1);
  }
  const documentXml = documentXmlBuf.toString('utf8');

  // Pandoc writes `<w:pStyle w:val="Heading1" />` (note the space before the
  // slash), so match the opening tag tolerantly rather than the exact literal.
  const docxHeadings = {};
  for (let level = 1; level <= 5; level++) {
    docxHeadings[level] = countMatches(
      documentXml,
      new RegExp(`<w:pStyle w:val="Heading${level}"\\s*/?>`, 'g')
    );
  }
  const docxPicPic = countMatches(documentXml, /<pic:pic[\s>]/g);
  const docxBlip = countMatches(documentXml, /<a:blip[\s>]/g);
  const mediaFiles = [...zip.entries.keys()].filter((n) => n.startsWith('word/media/')).length;

  // The HTML writer renders the --toc inline, so any image that sits inside a
  // heading is emitted twice: once in <nav id="TOC"> and once in the body.
  // (The docx TOC is a Word field, so it never duplicates anything.) Split the
  // HTML on the nav so the body figure is comparable with the markdown.
  const htmlText = fs.readFileSync(HTML_OUT, 'utf8');
  const navStart = htmlText.indexOf('<nav id="TOC"');
  const navEnd = navStart < 0 ? -1 : htmlText.indexOf('</nav>', navStart) + '</nav>'.length;
  const htmlNav = navStart < 0 ? '' : htmlText.slice(navStart, navEnd);
  const htmlBody = navStart < 0 ? htmlText : htmlText.slice(0, navStart) + htmlText.slice(navEnd);
  const htmlImgTags = countMatches(htmlText, /<img\b/g);
  const htmlImgBody = countMatches(htmlBody, /<img\b/g);
  const htmlImgToc = countMatches(htmlNav, /<img\b/g);
  const htmlHeadings = {};
  for (let level = 1; level <= 5; level++) {
    htmlHeadings[level] = countMatches(htmlBody, new RegExp(`<h${level}\\b`, 'g'));
  }

  // -- summary ------------------------------------------------------------
  const line = '-'.repeat(72);
  console.log(line);
  console.log('FaaSBank User Guide build');
  console.log(line);
  console.log(`pandoc          : ${version}`);
  console.log(`pandoc exe      : ${pandocExe}`);
  console.log(`reader          : gfm (two-space hard breaks preserved natively)`);
  console.log(`chapters        : ${chapters.length}`);
  for (const chapter of sources) {
    console.log(`                  ${chapter.name}  ->  #${chapterAnchors.get(chapter.name.toLowerCase())}`);
  }
  console.log(
    `links rewritten : ${linkStats.withAnchor} with anchor, ` +
      `${linkStats.withoutAnchor} chapter-only` +
      (linkStats.unknown.length ? `, ${linkStats.unknown.length} left as-is` : '')
  );
  if (linkStats.unknown.length) {
    for (const target of [...new Set(linkStats.unknown)]) {
      console.log(`                  (untouched, not a known chapter) ${target}`);
    }
  }
  console.log('');
  console.log('Outputs');
  console.log(`  ${COMBINED_MD}`);
  console.log(`      ${formatBytes(fs.statSync(COMBINED_MD).size)}`);
  console.log(`  ${DOCX_OUT}`);
  console.log(`      ${formatBytes(fs.statSync(DOCX_OUT).size)}`);
  console.log(`  ${HTML_OUT}`);
  console.log(`      ${formatBytes(fs.statSync(HTML_OUT).size)}`);
  console.log('');
  console.log('Validation (docx is a valid zip and contains word/document.xml)');
  console.log(`  zip entries              : ${zip.entries.size}`);
  console.log(`  word/document.xml        : ${formatBytes(documentXml.length)}`);
  console.log(`  word/media/* files       : ${mediaFiles} (identical images are de-duplicated)`);
  console.log('');
  console.log('  headings   markdown      docx      html');
  for (let level = 1; level <= 5; level++) {
    const md = mdHeadings[level];
    const dx = docxHeadings[level];
    const ht = htmlHeadings[level];
    const flag = md === dx && md === ht ? '' : '   <-- MISMATCH';
    console.log(
      `  H${level}     ${String(md).padStart(10)}${String(dx).padStart(10)}` +
        `${String(ht).padStart(10)}${flag}`
    );
  }
  console.log('');
  console.log(`  images     markdown ${mdImages.total}` +
    `   docx <pic:pic> ${docxPicPic}   docx <a:blip> ${docxBlip}` +
    `   html <img> ${htmlImgBody}`);
  if (htmlImgToc > 0) {
    console.log(
      `             (html total is ${htmlImgTags}: ${htmlImgToc} extra <img> because ` +
        `${htmlImgToc} heading(s) contain an image and the`
    );
    console.log('              HTML table of contents repeats it; the docx TOC is a Word field, so it does not)');
  }
  if (mdImages.missing.length) {
    console.log(`  WARNING: ${mdImages.missing.length} image target(s) not found on disk:`);
    for (const target of [...new Set(mdImages.missing)].slice(0, 20)) {
      console.log(`    ${target}`);
    }
  }
  console.log('');

  const warnings = [docxWarnings, htmlWarnings].filter(Boolean);
  if (warnings.length) {
    console.log('pandoc warnings');
    for (const w of warnings) {
      for (const l of w.split(/\r?\n/)) console.log(`  ${l}`);
    }
  } else {
    console.log('pandoc warnings : none');
  }
  console.log('');
  console.log('Next step: upload "build/FaaSBank User Guide.docx" over the existing');
  console.log('Google Doc (File > Open > Upload, or replace the file via Drive).');
  console.log(line);

  // -- exit status --------------------------------------------------------
  const failures = [];
  if (mdHeadings[1] !== docxHeadings[1]) {
    failures.push(
      `H1 count differs: markdown ${mdHeadings[1]} vs docx ${docxHeadings[1]}`
    );
  }
  if (mdImages.total !== docxBlip) {
    failures.push(
      `image count differs: markdown ${mdImages.total} vs docx <a:blip> ${docxBlip}`
    );
  }
  if (mdImages.total !== docxPicPic) {
    failures.push(
      `image count differs: markdown ${mdImages.total} vs docx <pic:pic> ${docxPicPic}`
    );
  }
  if (mdImages.total !== htmlImgBody) {
    failures.push(
      `image count differs: markdown ${mdImages.total} vs html body <img> ${htmlImgBody}`
    );
  }
  if (mdHeadings[1] !== htmlHeadings[1]) {
    failures.push(
      `H1 count differs: markdown ${mdHeadings[1]} vs html ${htmlHeadings[1]}`
    );
  }
  for (let level = 2; level <= 5; level++) {
    if (mdHeadings[level] !== docxHeadings[level] || mdHeadings[level] !== htmlHeadings[level]) {
      console.warn(
        `WARNING: H${level} count differs: markdown ${mdHeadings[level]}, ` +
          `docx ${docxHeadings[level]}, html ${htmlHeadings[level]}`
      );
    }
  }
  if (failures.length) {
    console.error('');
    console.error('BUILD VALIDATION FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('OK');
}

main();
