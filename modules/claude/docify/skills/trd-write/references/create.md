# Creating a TRD

Use this flow when there's **no existing TRD** — the user gave no page or
document to revise, or explicitly asked to write/spec/plan one. You're making
it from scratch.

1. **Gather intent — ask, don't assume.** Read the PRD or description the user
   gave and get clear on what's being built and why — the product goals and any
   technical direction that's already been decided. A TRD is a plan, so a wrong
   assumption here propagates into every stage and ticket: whenever something
   material is missing, undecided, or ambiguous — scope, a requirement, a
   constraint, a key decision — ask the user rather than inventing scope or
   guessing an answer.
2. **Survey the code.** Look at the repo(s) you've been given access to and work
   out what already exists versus what's net new — an empty repo means
   greenfield, an existing project means the plan has to fit around what's
   already there. This steers how much of the work is new and how the stages
   are shaped.
3. **Draft the TRD** — epic overview → staged plan, with diagrams or an API
   spec where they carry real information. Stay high-level: what stages we go
   through, not how the code will look. One TRD per epic; if the request is
   really several epics, say so rather than forcing them into one document.
4. **Publish the TRD** into the doc store — see [`publish.md`](publish.md): detect
   the provider, resolve the space and parent, then create the page with the
   drafted body.
5. **Report back** the created page's title and link.
