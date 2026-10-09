#!/bin/sh
# Lantern real-app trial #2: Spring PetClinic at a pinned commit, as a fixture.
#
#   sh examples/petclinic/setup-petclinic.sh [dir]        (default ~/lantern-petclinic)
#
# Fetches PetClinic at $PETCLINIC_SHA, imports it as one commit with `origin`
# pointed at a local bare repo, so nothing Lantern does can reach GitHub. Then
# builds it once with its Maven wrapper. Maven's downloads stay inside the
# trial dir (m2/), so deleting the trial dir removes everything.
# Needs JDK 17+ (brew install openjdk@17). Re-running rebuilds petclinic/ and
# remote.git/ only.
set -eu
TRIAL="${1:-$HOME/lantern-petclinic}"
PETCLINIC_SHA="${PETCLINIC_SHA:-500158f732419217507c7656904b8e6aa1bcc0d6}"
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/petclinic-env.sh"
mkdir -p "$TRIAL"
cd "$TRIAL"
rm -rf petclinic remote.git

echo "==> fetching spring-petclinic ${PETCLINIC_SHA}"
git init -q petclinic
git -C petclinic fetch -q --depth 1 https://github.com/spring-projects/spring-petclinic.git "$PETCLINIC_SHA"
git -C petclinic -c advice.detachedHead=false checkout -q FETCH_HEAD

echo "==> importing it as one commit; origin is a local bare repo"
rm -rf petclinic/.git
git init -q --bare -b main remote.git
cd petclinic
git init -q -b main
git add -A
git -c user.name=lantern-trial -c user.email=lantern-trial@example.invalid commit -qm "spring-petclinic ${PETCLINIC_SHA} (imported for the Lantern trial)"
git remote add origin "$TRIAL/remote.git"
git push -q origin main
git remote set-head origin main

echo "==> building with the Maven wrapper (first run downloads Maven and dependencies)"
if ./mvnw -q -B -DskipTests -Dmaven.repo.local="$TRIAL/m2/repository" package > "$TRIAL/build.log" 2>&1; then
  echo "    built: $(ls target/*.jar | head -1)"
else
  echo "!! build failed — see $TRIAL/build.log"
  exit 3
fi
[ -z "$(git status --porcelain)" ] || echo "!! working tree is dirty after the build — gate 5 would refuse pulses"
echo "==> done: $TRIAL/petclinic (origin → $TRIAL/remote.git)"
