#!/usr/bin/env bash
set -euo pipefail

sources=$(mktemp)
trap 'rm -f "$sources"' EXIT
git ls-files -z -- setup.sh bin config scripts tests ui ':!tests/Native*.Tests.cjs' > "$sources"
test -s "$sources"
while IFS= read -r -d '' file; do
  case "$file" in
    *.cjs|*.mjs|*.js) node --check "$file" ;;
    *.sh) sh -n "$file" ;;
  esac
done < "$sources"

for suite in tests/*.Tests.sh; do
  sh "$suite"
done

# These offline registry contracts require no installed npm tree.
for suite in RegistryCore RegistryLegacyBaseline RegistryR2Compatibility RegistryR4ProbeSecurity; do
  node "tests/$suite.Tests.cjs"
done

AIH_TEST_PWSH="$(command -v pwsh)" node tests/ContextRestrictedProductionV2.Tests.cjs

# Standalone CCv2 contracts need neither a host nor the research policy.
node tests/ContextPromptLayoutV2.Tests.cjs
node tests/ContextPageV2.Tests.cjs
