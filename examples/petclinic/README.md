# Example: Lantern on Spring PetClinic

A safe way to watch Lantern work on a real application before pointing it at
your own. [Spring PetClinic](https://github.com/spring-projects/spring-petclinic)
is a small Java web app; these scripts run it, make it fail on demand, and give
Lantern an agent that watches it.

Everything lives in `~/lantern-petclinic/` (or a directory you pass as the
first argument), including Maven's downloads, so `rm -rf ~/lantern-petclinic`
removes all of it. The app's `origin` is a local bare repository: nothing
Lantern does can reach GitHub. Lantern itself uses
`LANTERN_DIR=~/lantern-petclinic/lantern-home`, never your `~/.lantern`.

Needs JDK 17+ (`brew install openjdk@17`; the scripts find it, or set
`JAVA_HOME`) and `curl`. Run the commands from the root of the Lantern clone.

## Set up (once)

```sh
sh examples/petclinic/setup-petclinic.sh   # fetch a pinned commit, make the local remote, build the jar
sh examples/petclinic/init-petclinic.sh    # Lantern home, a small bug inbox, the "PetClinic" agent
```

## Run

```sh
sh examples/petclinic/petclinic.sh start    # app on http://localhost:8080, log → ~/lantern-petclinic/petclinic.log
sh examples/petclinic/petclinic.sh errors   # error traffic every 20 s (or `once` for one burst)
LANTERN_DIR=~/lantern-petclinic/lantern-home lantern ui   # open the printed URL, press Start on the PetClinic card
```

The traffic hits PetClinic's real failure paths:

| Request | What happens | Log |
|---|---|---|
| `/oups` | `CrashController` throws on purpose (the navbar's Error link) | ERROR — expected; the agent is told so |
| `/owners/9999`, `/owners/12345/pets/new` | "Owner not found" → HTTP 500 instead of 404 | ERROR — a real defect |
| `/owners/abc` | type mismatch, handled → 400 | WARN |

The inbox holds five user reports dated at init time: the two owner-not-found
bugs, the `/oups` "bug" (which isn't one), a feature request and a question.

**To see a fix carried end to end:** after the first pulse files the tickets,
accept the owner-not-found bug in Triage (or `lantern triage accept <id>`) and
press Pulse now. The agent staffs it `read_only`; the child's transcript
streams on its session page and its diagnosis lands on the ticket. Comment
"fix it" on the ticket and pulse again: a `write_branch` child applies the
fix on its own branch, runs PetClinic's tests, and Lantern pushes the branch
to the local remote for review.

## Failing and flaky tests (ci.watch)

The agent's `ci_watch` block runs PetClinic's tests on `main` every 30
minutes, in a scratch worktree, and files failing, flaky and broken-build
tickets for triage. It spends no Claude tokens; only staffing a fix does.

To see it work, commit two deliberately bad tests to the example checkout:

```sh
sh examples/petclinic/petclinic.sh ci-demo on    # one test that always fails, one that fails half the time
# …let a few runs happen…
sh examples/petclinic/petclinic.sh ci-demo off   # remove them again
```

Expect one `[ci] Failing` ticket after the second run, and one `[ci] Flaky`
ticket once the random test has both passed and failed on the same commit.

## Stop and clean up

Stop the agent from its card, then:

```sh
sh examples/petclinic/petclinic.sh stop
rm -rf ~/lantern-petclinic
```
