-- Run ONCE, after schema.sql has created `video_checks` and before the release that requires a passed check goes live:
--   npm run db:migrate:video-checks
-- Videos that already went through the old check (their preview frame was judged: that is the only time `thumb_key` is stored) keep
-- working. Every other ready video has never been looked at, so it stays blocked until its frames are sent (the Vane app does it
-- by itself when the video is uploaded again; the API has POST /api/v1/video/videos/:id/frames).
INSERT OR IGNORE INTO video_checks (video_id, frames, checked_at)
SELECT v.id, 1, unixepoch()
  FROM videos v
  JOIN video_assets a ON a.video_id = v.id
 WHERE v.status = 'ready' AND a.thumb_key IS NOT NULL;
