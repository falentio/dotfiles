---
name: coup-role-prompt
description: Writes role prompts for Coup: Rebellion G54 — image-generation prompts for the game's role characters. Use when the user wants a prompt for a role card or character art, asks to pick a role and prompt it, or wants prompts for several roles or the whole set.
---

# Coup Role Prompts

A **role prompt** is one sentence that renders a Coup: Rebellion G54 role as a single illustrated character. Every role prompt in the set carries the same **house style**, so the finished deck reads as one printed set rather than 25 unrelated pictures.

This skill writes prompts. An image model renders them.

A role prompt is built from three parts, in order:

1. **The brief** — who the character is, what they wear, and the **tell**: the prop or gesture that makes the role's mechanic visible without a caption.
2. **The house style** — the fixed cartoon treatment, copied verbatim.
3. **The negatives** — the fixed list of what to keep out.

[house-style.md](house-style.md) holds the house style and negatives. [roster.md](roster.md) holds the roster: every role's mechanic, tell, palette and mood.

## 1. Pick the role

Read [roster.md](roster.md).

When the user names a role, use it. When the user says "pick", choose an unprompted role and say which one and why — spread the picks across categories (Finance, Communications, Force, Special Interest) so the set stays balanced.

Done when: one role is named, and its tell, palette and mood are in hand.

## 2. Write the brief

Compose the character: era, build, clothing, expression, pose, and the light. The tell is mandatory — a viewer must be able to match the character to the role without a caption. A Banker counts coins; a Guerrilla shoulders a rifle with four coins in hand.

Keep the brief to the character. The house style supplies the rendering, the palette and the mood.

Done when: the brief names the role's tell as a visible prop or gesture, and every clause describes the character rather than the rendering.

## 3. Wrap it in the house style

Copy the scaffold from [house-style.md](house-style.md) and fill its slots: the role name, the brief, the role's palette from [roster.md](roster.md), and the role's mood.

Write the result as **one sentence** — character first, rendering second, negatives last.

Done when: the prompt is a single sentence, the house style and negatives match house-style.md word for word, and the palette and mood match the roster.

## Before you finish

| Mistake | Fix |
| --- | --- |
| The style drifts from house-style.md | Re-copy the scaffold word for word |
| The tell is missing, so the character could be anyone | Put the mechanic's prop or gesture back into the pose |
| Two sentences, or bullets inside the prompt | Merge it into one sentence |
| Palette or mood invented | Take both from the roster |
| A frame, banner or title creeps in | Cut it; the prompt is the character alone |

Emit the prompt in a code block so it copies clean. When the user asks to save the set, tick the role's box in roster.md and write the prompt to the file they name.

When the user asks for several at once, run steps 1–3 per role and keep the house style identical across all of them.
