# Sourced by the PetClinic trial scripts: JDK 17 from Homebrew unless JAVA_HOME
# is already set, and Maven's wrapper downloads kept inside the trial dir.
if [ -z "${JAVA_HOME:-}" ] && command -v brew >/dev/null 2>&1; then
  JAVA_HOME="$(brew --prefix openjdk@17 2>/dev/null)/libexec/openjdk.jdk/Contents/Home"
fi
[ -x "${JAVA_HOME:-}/bin/java" ] || { echo "PetClinic needs JDK 17+: brew install openjdk@17 (or set JAVA_HOME)"; exit 2; }
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"
export MAVEN_USER_HOME="$TRIAL/m2"
