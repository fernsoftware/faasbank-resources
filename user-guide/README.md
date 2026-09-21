# FaaSBank User Guide

Last updated: 2026-09-21

This is the user guide for FaaSBank, Fern Software's SME loan and grant
management system. It is maintained here as markdown, and the Google Doc is
regenerated from these files.

## Contents

- [Introduction](00-introduction.md)
- [Bite-sized Videos](01-bite-sized-videos.md)
- [Navigating the Software](02-navigating-the-software.md)
- [Client Relationship Management](03-client-relationship-management.md)
- [Loan Origination](04-loan-origination.md)
- [Transactions](05-transactions.md)
- [Loan Management](06-loan-management.md)
- [Grant Management](07-grant-management.md)
- [Projects](08-projects.md)
- [Reports](09-reports.md)
- [Settings](10-settings.md)

## Rebuilding the Word document

Run this from the repository root:

```
node scripts/build-user-guide.js
```

That single command rebuilds the Word document from the chapter files in this
folder.

### Requirements

[pandoc](https://pandoc.org/) must be installed. Install it with:

```
winget install --id JohnMacFarlane.Pandoc
```

The script uses `pandoc` from `PATH` if it is there, and otherwise falls back to
the default per-user install location, `%LOCALAPPDATA%\Pandoc\pandoc.exe`. If
neither is found it stops and prints the winget command above. Nothing else is
needed: the script uses only Node's built-in modules, so there is no `npm
install` step.

### Outputs

Everything is written to the `build/` folder at the repository root, which is
git-ignored (so the generated files are never committed):

| File | What it is |
| --- | --- |
| `build/FaaSBank User Guide.docx` | The Word document, with all screenshots embedded and a navigable table of contents. |
| `build/FaaSBank User Guide.html` | The whole guide as a single self-contained HTML file, handy for a quick preview in a browser. |
| `build/user-guide.md` | The concatenated markdown that was fed to pandoc, kept for troubleshooting. |

The script prints a summary at the end and exits non-zero if the Word document
does not contain the same number of chapter headings and screenshots as the
markdown, so a silently truncated document will not slip through.

### The one manual step: updating the Google Doc

The script cannot write to Google Docs, so after a successful build, upload the
new Word document over the existing Google Doc:

1. Open the existing FaaSBank User Guide Google Doc.
2. Choose **File > Open**, switch to the **Upload** tab, and upload
   `build/FaaSBank User Guide.docx`.

Alternatively, in Google Drive, right-click the existing file and use **Manage
versions > Upload new version** to replace it in place, which keeps the Doc's
existing link and sharing settings.
