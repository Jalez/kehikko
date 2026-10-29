---
name: kehikko-jump
description: Take the person to a place in Kehikot — another project, kehikko, epic, parts of an epic, or a step — with the kehikko door's jump tool. Use when the person asks to go somewhere ("take me to the auth epic", "show me part 3", "open the Wide kehikko in project X"), or step by step during a walkthrough the person started.
allowed-tools: mcp__kehikko__jump, mcp__kehikko__read_canvas, mcp__kehikko__my_place, mcp__kehikko__read_inbox
---

The kehikko door (the `kehikko` MCP server, Kehikot's own) has `jump`: it moves the person's view the way their own pickers do, on the Kehikot page on screen, and marks it there with **Go back**, which restores exactly where they were.

## When

- The person asked to be taken somewhere: a project, a kehikko, an epic, parts of an epic, a step.
- You are walking them through something step by step (a plan, a list of steps, a walk-through) and they started that walkthrough: jump to each step as the conversation reaches it.
- Never otherwise. Do not jump the view on your own initiative to show something you find relevant; say it and offer to take them there.

## How

1. Resolve names first. `my_place` says the project, epic, parts and kehikko this conversation belongs to and what the person is looking at; `read_canvas` lists the kehikko's containers, the project's epic and parts. Use the names, keys, slugs and ids those print. When the person's words match more than one thing, or nothing, ask which.
2. Call `jump` with only what should change: `project`, `kehikko`, `epic`, `parts` (ids or names; `[]` picks none) and `step` (the step's 1-based number in the epic). Everything you leave out stays where the person is. A step alone turns the kehikko to that step: every container that follows a walk shows it, and the answer names them.
3. Read the answer. A refusal lists what exists: correct the call or ask the person; never guess a second time. "Ignored" means they are already there. Jumps are a few seconds apart: during a walkthrough, jump only when the conversation reaches a new step.
4. Tell the person where you took them, in one sentence, and that **Go back** on the kehikko undoes it.

## What it does not do

- It changes no data and no arrangement: nothing is added, removed, moved or folded.
- It does not move this conversation's own place. If the conversation is now about where you went, ask the person, then call `set_my_place`.
- With no Kehikot page open, nothing moves; say so instead of retrying.
