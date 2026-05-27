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
  <dependencies>
    <dependency>
      <groupId>info.cqframework</groupId>
      <artifactId>cql-to-elm-cli</artifactId>
      <version>${VERSION}</version>
    </dependency>
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
java -jar "${DEST_PATH}" --help 2>&1 | head -8 || true
