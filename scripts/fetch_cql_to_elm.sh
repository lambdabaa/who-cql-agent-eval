#!/usr/bin/env bash
# Download a pinned release of the cqframework cql-to-elm translator jar.
#
# We do not commit the jar (license-clean, but large). The harness picks it up
# from tools/cql-to-elm/cql-to-elm.jar by default; override with $CQL_TO_ELM_JAR.
set -euo pipefail

VERSION="${CQL_TO_ELM_VERSION:-3.21.0}"
DEST_DIR="$(cd "$(dirname "$0")/.." && pwd)/tools/cql-to-elm"
DEST_PATH="${DEST_DIR}/cql-to-elm.jar"
URL="https://github.com/cqframework/clinical_quality_language/releases/download/v${VERSION}/translator_cli-${VERSION}.jar"

mkdir -p "${DEST_DIR}"

if [[ -f "${DEST_PATH}" ]]; then
  echo "already present: ${DEST_PATH}"
  exit 0
fi

echo "fetching cql-to-elm v${VERSION} from ${URL}"
curl --fail --location --output "${DEST_PATH}.tmp" "${URL}"
mv "${DEST_PATH}.tmp" "${DEST_PATH}"
echo "downloaded to ${DEST_PATH}"
