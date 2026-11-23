# Community scripts

Indicators and strategies shared by Wickline users. The desktop app lists them in **Indicators → Community**, where one click adds a script to your chart. The website version lists them too, but you add them in the desktop app (see below).

- `index.json`: the list (name, author, description, tags, likes). The app reads this.
- `scripts/`: the code, one file per script.

The **Official example** scripts come with Wickline. Every other script was published by a GitHub user and is marked **Community**, with the author's GitHub name (like **@octocat**). A user who calls themselves "Wickline" still shows as a community script.

## Publishing a script

1. Write it in Wickline's script editor and check that it works on a chart (**Ctrl+Enter**).
2. Click **Publish**, add a short description, and click **Continue on GitHub**.
3. GitHub opens a form with everything filled in. Press **Submit new issue**. This needs a free GitHub account.

A check then runs the script on test data:
- **If it passes:** the script is added here within a few minutes and the issue is closed.
- **If it doesn't:** the issue gets a comment saying what to fix.

To update a published script, edit its issue; it's republished automatically. To like a script, give its issue a 👍 or ❤️. Like counts update once a day.

Everything here is shared under the [MIT license](../LICENSE).

## Is it safe to add other people's scripts?

In the desktop app (or `npm start`), each script runs in its own background worker. Before any script runs, the worker's network, storage and messaging features are removed. The app also serves that worker with a security policy that blocks all network access.

A script can do these things:
- Read the chart's prices.
- Draw plots and markers.
- Run backtests.

It can't do these things:
- Reach the internet.
- Read your saved data, settings or files, or other scripts.
- Touch the app's window. It only sends back its results, and the app checks those before showing them.

A script that runs too long is stopped. Read a script's code (the **Code** button) before you trade on it: a script can't harm your computer, but its signals can be wrong.

**The website version doesn't run community scripts.** A website can't stop a script from reaching the internet, so there the Community tab only lists scripts and links to their code on GitHub.

## For maintainers

- **Remove a script:** add the `removed` label to its issue. The workflow deletes it from the library. Edits to the issue can't cancel a removal, and the issue can't be republished while it has the label.
- **How the workflow works:** [`.github/workflows/community.yml`](../.github/workflows/community.yml) does the checking, publishing, removing and like counting, using [`scripts/community.mjs`](../scripts/community.mjs).
  - Only the check job runs submitted code. It has read-only access and no secrets, and runs the code in a throwaway Docker container with no network, a read-only file system and memory and time limits; inside that, in a Node process that can't read files or the environment.
  - The check prints one line of results. The workflow treats it as untrusted: it keeps only the expected numbers and makes any error text safe before posting it in a comment.
  - The jobs that write to the repo never run submitted code. They only copy text.
- **Re-add the official examples:** run `node scripts/community.mjs seed`. They're the entries without an issue number; the app shows them as **Official example**.
