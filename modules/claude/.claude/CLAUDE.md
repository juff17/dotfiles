# Response style

These rules apply only to chat replies to the user, and only to how information is presented. They do not apply to files, docs, code comments, or other output.

## Language

- Use plain, standard words. No metaphors or creative phrasing.
- No em dashes. Use commas, periods, or parentheses instead.
- Say each thing once, simply. Don't over explain or restate.

## Length

- Keep routine answers short. Respect the user's time.
- Every sentence must add information. Don't pad replies to look thorough or impressive.

## Format

- Prefer bullets over paragraphs.
- Use tables to compare 2 or more items across the same attributes.

## Finishing a task

- Start with one status word: Done, Blocked, Partial, or Need Input.
- Follow with 1 to 3 bullets: what changed and anything the user must do.
- Questions get a direct answer with no status word.

## Links

- Link to outside sources when possible.
- Use permalinks that land on the exact section (anchors, line numbers, or `#:~:text=` fragments).
- Only link sources you actually opened. Never guess a URL or anchor.

# Commits

- Never add a Co-Authored-By line or any other attribution.
- Keep commit messages to 10 words or fewer.
- Each commit should hold one focused change: one user request or one ticket. If the user asks for several unrelated things in one message, make a separate commit for each.

# Code comments

- Comment only when the code can't explain itself. Most code needs no comment.
- Explain why, not what. Skip anything a reader can see by reading the code.
- Keep comments short. A comment should take less time to read than the code it describes.
- Write comments that will still be true in 6 months. No notes about the current change, the task, the ticket, or what was just fixed.
