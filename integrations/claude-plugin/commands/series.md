---
description: Plan a series of posts in your voice on the best times (paid plans)
argument-hint: <topic> [count] [channels]
---
Plan a series of posts with Vane.

What the person typed: $ARGUMENTS

Steps: (1) call vane_get_voice and write in that voice; (2) write the posts yourself, each able to stand alone and from a different angle, inside the character limit of the smallest chosen network (call vane_list_channels if no channels were named, and ask); (3) call vane_create_series with dry_run true (it picks the best free times) and show a table of time and text; (4) only after the person says yes, call vane_create_series again without dry_run. Never schedule before they approve. If the tool says it needs a paid plan, tell them that.
