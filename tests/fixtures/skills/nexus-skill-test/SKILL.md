---
name: nexus-skill-test
description: >
  Use when testing whether Nexus Agent Skills discovery and loading works.
  This fixture exists to be discovered, cataloged, and loaded by tests; it
  carries a unique marker that proves the body was actually read.
---

# Nexus Skill Test Fixture

This is the deterministic hello skill for Nexus Skills Foundation. It is not
engineering guidance and must not be installed into any real environment
outside tests.

Marker: NEXUS_SKILL_TEST_OK

A test that loads this skill through the native catalog proves: frontmatter
parsing worked, the kebab-case name resolved, the description was exposed
without loading the body, and the body above was returned verbatim by the
loader.
