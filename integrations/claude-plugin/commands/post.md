---
description: Schedule a post you wrote, exactly as written
argument-hint: <text> [channels] [when]
---
Use the Vane tools to schedule a post exactly as the person wrote it, without changing a word.

What the person typed: $ARGUMENTS

The text to post is the main part of that. If they named channels (for example "to telegram and bluesky") use them; if not, call vane_list_channels and ask which ones to use before posting. If they gave a time (for example "tomorrow 9:00") convert it to an ISO-8601 time with a timezone and ask if the timezone is unclear; if not, use the default (in a couple of minutes). Never post anything the person did not ask for. Then confirm in one line what was scheduled and where.
