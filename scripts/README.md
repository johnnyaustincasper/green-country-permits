# IST Permit Intel — Scripts

## Overview

| Script | Purpose |
|--------|---------|
| `migrate-permits.js` | One-shot migration of all permits from `lib/permits.js` → Firestore |
| `gmail-poller.js` | IMAP watcher for NOW Report emails → PDF parser → Firestore |

---

## Setup

```bash
cd scripts/
npm install
```

---

## migrate-permits.js

Migrates all 347 permits from the static `lib/permits.js` into Firestore.

```bash
node migrate-permits.js
```

Uses Firebase Admin SDK if `/Users/celeste/.openclaw/workspace/.secrets/firebase-service-account.json` exists, otherwise falls back to the Firebase client SDK.

---

## gmail-poller.js

Polls Gmail for forwarded NOW Report emails, parses permit PDFs, and pushes new permits to Firestore.

### Prerequisites

#### 1. Gmail App Password (REQUIRED)

Gmail does **not** allow IMAP access with your regular password. You need an **App Password**:

1. Go to [https://myaccount.google.com/security](https://myaccount.google.com/security)
2. Enable **2-Step Verification** (required)
3. Go to [https://myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
4. Create a new App Password:
   - App: **Mail** (or Other → name it "IST Poller")
5. Copy the 16-character code (e.g. `abcd efgh ijkl mnop`)

Set it as an environment variable:
```bash
export GMAIL_APP_PASSWORD="abcdefghijklmnop"
```

Or edit the `GMAIL_PASSWORD` constant in the script directly.

#### 2. Mapbox Token

For geocoding permit addresses:
```bash
export NEXT_PUBLIC_MAPBOX_TOKEN="pk.eyJ1..."
```

### Running

```bash
node gmail-poller.js
```

### What it does

1. Connects to Gmail IMAP (`imap.gmail.com:993`)
2. Scans INBOX for **unread** emails
3. For each unread email, finds PDF attachments where:
   - Filename contains "job" or "weekly" (case-insensitive)
   - Filename does **not** contain "lien"
   - File ends with `.pdf`
4. Parses `HOUSE-NEW` permit entries from the PDF
5. Geocodes each address via Mapbox (cached in `geocode-cache.json`)
6. Pushes new permits to Firestore `permits` collection (skips duplicates)
7. Marks emails as read after processing

### PDF Format Expected

The NOW Report PDFs use a tabular format like:

```
HOUSE-NEW  Builder Name  123 Main St, Tulsa  2500  350000  John Smith  (918)555-1234
```

Fields extracted: `builder`, `address`, `city`, `sqft`, `value`, `contact`, `phone`, `week`

### Schedule (optional cron)

To run hourly:
```bash
crontab -e
# Add:
0 * * * * cd /Users/celeste/.openclaw/workspace/ISTpermits/scripts && GMAIL_APP_PASSWORD="..." NEXT_PUBLIC_MAPBOX_TOKEN="..." node gmail-poller.js >> /tmp/ist-poller.log 2>&1
```

---

## Geocode Cache

Results are cached in `scripts/geocode-cache.json`. Delete this file to force re-geocoding all addresses.

---

## Firestore Notes

- Collection: `permits`
- Document ID for migrated permits: string version of the permit's numeric `id`
- Document ID for polled permits: MD5 hash of `address-week`
- Duplicate detection: checks if document already exists before writing
