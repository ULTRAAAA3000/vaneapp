# Vane for Make

A custom Make app for the Vane public API (`/api/v1`). It signs in with an API key and has five modules:

| Module | Type | Calls |
|---|---|---|
| Schedule a Post | Action | `POST /posts` |
| Get a Post | Action | `GET /posts/:id` |
| Cancel a Post | Action | `DELETE /posts/:id` |
| List Posts | Search | `GET /posts?view=` |
| List Channels | Search | `GET /channels` |

The *Channels* field of Schedule a Post is a dropdown filled from `GET /channels`, so users pick channels by name instead of pasting ids.

## Install

1. In Make: *Create a new app*, or use the **Make Apps Editor** extension for VS Code and open this folder.
2. Import the folder (`makecomapp.json` lists the parts). The connection test is `GET /me`.
3. In a scenario add the *Vane* app, create a connection and paste a `cpost_test_…` key first: requests are validated and answered like real ones, but nothing is posted or counted. Switch to a `cpost_live_…` key when it works.

Errors show as `[402] message (quota_exceeded)`, so a scenario can route on the code.

## Keep in sync

The modules mirror `public/vane-openapi.json`. After changing an endpoint run `npm run check:integrations`: it fails when a module calls a path or method the spec does not have.

Triggers (post published / failed) are not here yet: they need webhooks on the Vane side.
