#!/bin/sh
# Run PetClinic for the Lantern trial, and make it fail on purpose.
#
#   sh examples/petclinic/petclinic.sh start  [trialDir]   app on :8080, log → <trialDir>/petclinic.log
#   sh examples/petclinic/petclinic.sh errors [trialDir]   error traffic every 20 s until `stop`
#   sh examples/petclinic/petclinic.sh once   [trialDir]   one burst of error traffic
#   sh examples/petclinic/petclinic.sh stop   [trialDir]   stop the traffic and the app
#   sh examples/petclinic/petclinic.sh ci-demo on|off [trialDir]
#                                     commit (or remove) two deliberately bad tests
#                                     on the checkout's main, for ci.watch
#
# The log is converted line by line into Lantern's plain format (spring-log.ts) —
# the trial agent's log source. Error traffic hits PetClinic's real failure
# paths: /oups (a deliberate RuntimeException), an owner id that does not
# exist (IllegalArgumentException → 500), and a non-numeric id (type mismatch,
# logged as WARN). A few healthy requests run alongside, as real traffic would.
set -eu
CMD="${1:-start}"
TRIAL="${2:-$HOME/lantern-petclinic}"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_MARK="--lantern-trial=$TRIAL"
TRAFFIC_MARK="$TRIAL/.traffic"
URL="http://localhost:8080"

burst() {
  for p in /oups /owners/9999 /owners/abc /owners/12345/pets/new /owners?lastName=Davis /vets.html /; do
    curl -s -o /dev/null -w "%{http_code} $p\n" "$URL$p" || echo "--- $p (app down?)"
  done
}

case "$CMD" in
  start)
    if pgrep -f -- "$APP_MARK" >/dev/null; then echo "petclinic: already running"; exit 0; fi
    . "$HERE/petclinic-env.sh"
    JAR="$(ls "$TRIAL"/petclinic/target/*.jar 2>/dev/null | head -1)"
    [ -n "$JAR" ] || { echo "run examples/petclinic/setup-petclinic.sh first"; exit 2; }
    # The jar runs from the trial dir, not the repo: nothing it writes dirties the tree.
    cd "$TRIAL"
    nohup sh -c "java -jar '$JAR' --server.port=8080 '$APP_MARK' 2>&1 | node '$HERE/spring-log.ts' >> '$TRIAL/petclinic.log' 2>>'$TRIAL/spring-convert.err'" >/dev/null 2>&1 &
    printf 'petclinic: starting on %s ' "$URL"
    for _ in $(seq 1 60); do
      if curl -s -o /dev/null "$URL/"; then echo "— up. log → $TRIAL/petclinic.log"; exit 0; fi
      printf '.'; sleep 1
    done
    echo "— not up after 60 s; see $TRIAL/petclinic.log"; exit 1
    ;;
  once) burst ;;
  errors)
    touch "$TRAFFIC_MARK"
    nohup sh -c "while [ -f '$TRAFFIC_MARK' ]; do sh '$0' once '$TRIAL' >/dev/null 2>&1; sleep 20; done" >/dev/null 2>&1 &
    echo "petclinic: error traffic every 20 s (sh $0 stop to end it)"
    ;;
  stop)
    rm -f "$TRAFFIC_MARK"
    if pkill -f -- "$APP_MARK"; then echo "petclinic: stopped"; else echo "petclinic: not running"; fi
    ;;
  ci-demo)
    # ci.watch's live trial: one test that always fails, one that fails
    # half the time. On the trial checkout's main only — never a real repo.
    MODE="${2:-on}"
    TRIAL="${3:-$HOME/lantern-petclinic}"
    T="$TRIAL/petclinic/src/test/java/org/springframework/samples/petclinic/LanternTrialCiDemoTests.java"
    cd "$TRIAL/petclinic"
    if [ "$MODE" = on ]; then
      cat > "$T" <<'JAVA'
package org.springframework.samples.petclinic;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.concurrent.ThreadLocalRandom;

import org.junit.jupiter.api.Test;

/**
 * Deliberately bad tests for the Lantern trial's ci.watch demo — not part of
 * PetClinic. Remove with `sh examples/petclinic/petclinic.sh ci-demo off`.
 */
class LanternTrialCiDemoTests {

	@Test
	void alwaysFails() {
		assertEquals(404, 500, "deliberately failing (Lantern ci.watch demo)");
	}

	@Test
	void failsHalfTheTime() {
		assertTrue(ThreadLocalRandom.current().nextBoolean(), "deliberately flaky (Lantern ci.watch demo)");
	}

}
JAVA
      git add "$T" && git -c user.name=lantern-trial -c user.email=lantern-trial@example.invalid commit -qm "Lantern trial: deliberately failing and flaky tests (ci.watch demo)"
      echo "petclinic: ci-demo on — committed $(git rev-parse --short HEAD) with a failing and a flaky test"
    else
      [ -f "$T" ] || { echo "petclinic: ci-demo is already off"; exit 0; }
      git rm -q "$T" && git -c user.name=lantern-trial -c user.email=lantern-trial@example.invalid commit -qm "Lantern trial: remove the ci.watch demo tests"
      echo "petclinic: ci-demo off — removed in $(git rev-parse --short HEAD)"
    fi
    ;;
  *) echo "usage: petclinic.sh start|errors|once|stop|ci-demo on|off [trialDir]"; exit 2 ;;
esac
