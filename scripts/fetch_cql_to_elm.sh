#!/usr/bin/env bash
# Build a runnable fat jar of `info.cqframework:cql-to-elm-cli`.
#
# Why a build instead of a download:
#   - The Maven Central artifact `info.cqframework:cql-to-elm-cli:<v>:jar` is a
#     *thin* jar (~11 kB) — no Main-Class, no bundled dependencies — so it
#     cannot be run with `java -jar`.
#   - No `-jar-with-dependencies` / shaded artifact is published.
#   - GitHub releases do not attach jar assets.
#
# So we use Maven Shade to produce a runnable fat jar from the published thin
# jar plus its transitive deps. The resulting jar is ~30 MB and is cached at
# `tools/cql-to-elm/cql-to-elm.jar` (gitignored).
#
# Override the translator version with $CQL_TO_ELM_VERSION (default: 3.26.0).
set -euo pipefail

VERSION="${CQL_TO_ELM_VERSION:-3.26.0}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="${REPO_ROOT}/tools/cql-to-elm"
DEST_PATH="${DEST_DIR}/cql-to-elm.jar"

mkdir -p "${DEST_DIR}"

if [[ -f "${DEST_PATH}" ]]; then
  echo "already present: ${DEST_PATH}"
  echo "remove it to rebuild against CQL_TO_ELM_VERSION=${VERSION}"
  exit 0
fi

# Prereq: Java
if ! java -version >/dev/null 2>&1; then
  cat >&2 <<EOM
Java is required to run the CQL→ELM translator. Install OpenJDK 17:

    brew install openjdk@17
    sudo ln -sfn /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk \\
        /Library/Java/JavaVirtualMachines/openjdk-17.jdk

then re-run this script.
EOM
  exit 1
fi

# Prereq: Maven
if ! command -v mvn >/dev/null 2>&1; then
  cat >&2 <<'EOM'
Maven is required to assemble a runnable fat jar. Install it with:

    brew install maven

then re-run this script.
EOM
  exit 1
fi

echo "building cql-to-elm-cli v${VERSION} fat jar..."

BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "${BUILD_DIR}"' EXIT

HAPI_BOM_VERSION="${HAPI_BOM_VERSION:-8.2.0}"

# Why these explicit deps: cqframework 3.x publishes via Gradle and the .pom
# fallback drops dependencies Gradle metadata expresses but Maven cannot
# (constraints, BOM imports, etc.). Resolved against the Gradle module
# metadata for cql-to-elm-cli 3.26.0 at runtime — see scripts/README notes.

cat > "${BUILD_DIR}/pom.xml" <<POM
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>local.who-cql-agent-eval</groupId>
  <artifactId>cql-to-elm-fatjar</artifactId>
  <version>${VERSION}</version>
  <packaging>jar</packaging>
  <properties>
    <maven.compiler.source>11</maven.compiler.source>
    <maven.compiler.target>11</maven.compiler.target>
  </properties>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>ca.uhn.hapi.fhir</groupId>
        <artifactId>hapi-fhir-bom</artifactId>
        <version>${HAPI_BOM_VERSION}</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>info.cqframework</groupId>
      <artifactId>cql-to-elm-cli</artifactId>
      <version>${VERSION}</version>
    </dependency>
    <!-- cqframework deps. The cqframework pom files publish runtime-scope
         transitive deps but also ship Gradle metadata, which causes Maven
         to skip the runtime-scope transitives in practice. -->
    <dependency><groupId>info.cqframework</groupId><artifactId>cql</artifactId><version>${VERSION}</version></dependency>
    <dependency><groupId>info.cqframework</groupId><artifactId>cql-to-elm</artifactId><version>${VERSION}</version></dependency>
    <dependency><groupId>info.cqframework</groupId><artifactId>model</artifactId><version>${VERSION}</version></dependency>
    <dependency><groupId>info.cqframework</groupId><artifactId>model-jaxb</artifactId><version>${VERSION}</version></dependency>
    <dependency><groupId>info.cqframework</groupId><artifactId>elm</artifactId><version>${VERSION}</version></dependency>
    <dependency><groupId>info.cqframework</groupId><artifactId>elm-jaxb</artifactId><version>${VERSION}</version></dependency>
    <!-- Do NOT include model-jackson or elm-jackson here: shipping both jaxb
         and jackson ModelInfoReaderProvider impls puts two services on the
         classpath, and cql-to-elm refuses to pick one. The jaxb pair is
         what the cqframework CLI itself uses. -->
    <dependency><groupId>info.cqframework</groupId><artifactId>elm-fhir</artifactId><version>${VERSION}</version></dependency>
    <dependency><groupId>info.cqframework</groupId><artifactId>cql-parsetree</artifactId><version>${VERSION}</version></dependency>
    <dependency><groupId>info.cqframework</groupId><artifactId>cqf-fhir</artifactId><version>${VERSION}</version></dependency>
    <dependency><groupId>info.cqframework</groupId><artifactId>cqf-fhir-npm</artifactId><version>${VERSION}</version></dependency>
    <dependency><groupId>info.cqframework</groupId><artifactId>quick</artifactId><version>${VERSION}</version></dependency>
    <dependency><groupId>info.cqframework</groupId><artifactId>qdm</artifactId><version>${VERSION}</version></dependency>
    <!-- runtime libs the cqframework CLI relies on -->
    <dependency><groupId>net.sf.jopt-simple</groupId><artifactId>jopt-simple</artifactId><version>4.7</version></dependency>
    <dependency><groupId>org.slf4j</groupId><artifactId>slf4j-simple</artifactId><version>2.0.13</version></dependency>
    <dependency><groupId>org.glassfish.jaxb</groupId><artifactId>jaxb-runtime</artifactId><version>4.0.5</version></dependency>
    <dependency><groupId>org.eclipse.persistence</groupId><artifactId>org.eclipse.persistence.moxy</artifactId><version>4.0.2</version></dependency>
    <dependency><groupId>ca.uhn.hapi.fhir</groupId><artifactId>hapi-fhir-structures-r5</artifactId></dependency>
    <dependency><groupId>ca.uhn.hapi.fhir</groupId><artifactId>hapi-fhir-structures-r4</artifactId></dependency>
  </dependencies>
  <build>
    <finalName>cql-to-elm</finalName>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-shade-plugin</artifactId>
        <version>3.5.3</version>
        <executions>
          <execution>
            <phase>package</phase>
            <goals><goal>shade</goal></goals>
            <configuration>
              <createDependencyReducedPom>false</createDependencyReducedPom>
              <transformers>
                <transformer implementation="org.apache.maven.plugins.shade.resource.ManifestResourceTransformer">
                  <mainClass>org.cqframework.cql.cql2elm.cli.Main</mainClass>
                </transformer>
                <transformer implementation="org.apache.maven.plugins.shade.resource.ServicesResourceTransformer"/>
              </transformers>
              <filters>
                <filter>
                  <artifact>*:*</artifact>
                  <excludes>
                    <exclude>META-INF/*.SF</exclude>
                    <exclude>META-INF/*.DSA</exclude>
                    <exclude>META-INF/*.RSA</exclude>
                  </excludes>
                </filter>
              </filters>
            </configuration>
          </execution>
        </executions>
      </plugin>
    </plugins>
  </build>
</project>
POM

(cd "${BUILD_DIR}" && mvn -B -q package)

cp "${BUILD_DIR}/target/cql-to-elm.jar" "${DEST_PATH}"
echo "built ${DEST_PATH}"

# Smoke-test that the jar is runnable. cql-to-elm-cli has no --help/--version
# flag, so we trigger a "missing required argument" error path: that surfaces
# the joptsimple parser, proving classes link correctly. ClassNotFoundError
# would happen earlier.
if java -jar "${DEST_PATH}" 2>&1 | grep -q 'required option'; then
  echo "smoke test: ok"
else
  echo "smoke test: failed — translator did not produce the expected 'missing --input' error" >&2
  java -jar "${DEST_PATH}" 2>&1 | head -10 >&2
  exit 1
fi
