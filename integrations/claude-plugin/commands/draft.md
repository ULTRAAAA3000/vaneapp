---
description: Claude writes a post, shows it, and schedules it after you approve
argument-hint: <topic> [channels] [tone]
---
Write a social post for the person, then schedule it with Vane only after they approve.

What the person typed: $ARGUMENTS

Write the post yourself: specific, no invented facts or numbers, fitting the channels they named (call vane_list_channels if they did not name any, and ask). Show the post and ask whether to schedule it, change it, or drop it. Do NOT call vane_create_post until they say yes. When they do, schedule it and confirm in one line.
