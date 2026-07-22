# Google Drive integration — setup

The app can list + import `game_bundle_*.zip` from your Drive folder, and
export `corrections_*.json` back to it, so you never download/re-upload by
hand.

There are two auth methods. **User OAuth is recommended** — it works for
both reading and writing, on a personal Gmail, and is the same pattern a
production multi-user app uses (the app acts as you, so files it creates are
owned by you). A service account can only read; it can't upload to a
personal-account Drive (service accounts have no storage quota there).

---

## Recommended: user OAuth (~10 min, one time)

### 1. Create the OAuth client

1. https://console.cloud.google.com/ → sign in → create/select a project
   (e.g. `balltime`; free, no billing).
2. Enable the Drive API:
   https://console.cloud.google.com/apis/library/drive.googleapis.com → Enable.
3. Configure the consent screen (once):
   https://console.cloud.google.com/apis/credentials/consent → User type
   **External** → fill app name + your email → Save. On "Test users" add
   your own Google address (`christianson.general@gmail.com`). (Leaving the
   app in "testing" is fine — test-user tokens just need a refresh roughly
   every 6 months.)
4. Create the client ID:
   https://console.cloud.google.com/apis/credentials → Create credentials →
   OAuth client ID → application type **Desktop app** → Create. Copy the
   **Client ID** and **Client secret**.

### 2. Point the app at it + authorize

Add to `app/.env.local`:

```
GOOGLE_OAUTH_CLIENT_ID=<client id>
GOOGLE_OAUTH_CLIENT_SECRET=<client secret>
DRIVE_FOLDER_ID=<folder id>
```

The folder id is the last part of the folder's Drive URL
(`https://drive.google.com/drive/folders/<FOLDER_ID>`).

Then, from `app/`:

```
npm run drive-auth
```

It opens a Google consent page, catches the redirect locally, and prints a
`GOOGLE_OAUTH_REFRESH_TOKEN=...` line. Add that to `.env.local` too and
restart the app. Done — both Drive import and "Export → To Google Drive"
now work, owned by your account.

---

## Fallback: service account (read-only)

Only lets the app list/download bundles (imports), NOT upload corrections.
Use this only if you can't do the OAuth step.

1. Create a service account:
   https://console.cloud.google.com/iam-admin/serviceaccounts → Create →
   name it → Done. Then its **Keys** tab → Add key → JSON. Keep the file
   private.
2. Copy the service account's `client_email` from that JSON, and in Drive
   share your `balltime` folder with it as **Viewer**.
3. In `.env.local`:

```
GOOGLE_SA_KEY=C:\Users\chris\.keys\balltime-drive.json
DRIVE_FOLDER_ID=<FOLDER_ID>
```

(`GOOGLE_SA_KEY` may be the JSON content itself instead of a path.) If both
OAuth and a service account are configured, the app uses OAuth.

---

## Notes

- Scope is `drive`; the app lists, downloads, and uploads — it never deletes
  or trashes anything.
- Import lists bundle zips in the folder and its immediate subfolders (so
  `balltime/bundles` is covered) and streams the chosen one straight to disk.
- Imported bundles are intentionally LEFT in Drive: the gen-2 ball-training
  notebook re-detects each game from its bundle, so they must stay in
  `Drive/balltime/bundles`. Clear old ones by hand when done retraining.
- Corrections export writes `corrections_<gamename>.json` into the folder,
  upserting by name (re-exporting replaces, no duplicates).
- If listing/exporting fails with an auth error: Drive API not enabled, wrong
  folder id, or (OAuth) the refresh token expired — re-run `npm run drive-auth`.

## Toward production

This is already the production shape: swap the three `GOOGLE_OAUTH_*` env
vars for a per-user OAuth "Connect Google Drive" button that runs the same
authorization-code flow and stores each user's refresh token in the database.
The Drive code in `lib/drive.js` doesn't change — only where the refresh
token comes from.
