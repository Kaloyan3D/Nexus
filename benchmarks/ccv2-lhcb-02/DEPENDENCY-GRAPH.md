# Causal phase graph

```mermaid
graph TD
  T00 --> E01
  E01 --> E02
  E01 --> E03
  E02 --> E03
  E01 --> E04
  E03 --> E04
  E03 --> E05
  E04 --> E05
  E02 --> E06
  E04 --> E06
  E05 --> E06
  E03 --> E07
  E02 --> E08
  E07 --> E08
  E01 --> E09
  E05 --> E09
  E02 --> E10
  E06 --> E10
  E04 --> E11
  E09 --> E11
  E01 --> E12
  E03 --> E12
  E09 --> E12
  E08 --> E13
  E10 --> E13
  E12 --> E13
  E02 --> E14
  E04 --> E14
  E06 --> E14
  E05 --> E15
  E09 --> E15
  E02 --> E16
  E08 --> E16
  E10 --> E16
  E02 --> E17
  E07 --> E17
  E12 --> E17
  E11 --> E18
  E15 --> E18
  E17 --> E18
  E08 --> E19
  E16 --> E19
  E17 --> E19
  E03 --> E20
  E05 --> E20
  E15 --> E20
  E13 --> E21
  E14 --> E21
  E20 --> E21
  E06 --> E22
  E10 --> E22
  E16 --> E22
  E04 --> E23
  E12 --> E23
  E21 --> E23
  E18 --> E24
  E19 --> E24
  E22 --> E24
  E23 --> E24
  E01 --> T99
  E02 --> T99
  E04 --> T99
  E05 --> T99
  E06 --> T99
  E08 --> T99
  E12 --> T99
  E15 --> T99
  E16 --> T99
  E19 --> T99
  E22 --> T99
  E24 --> T99
```

The manifest defines proposed dependencies, not verified continuity. Executable consumer probes cover migration → API import and migration/authorization/prior commit → recovery; the complete graph remains a freeze requirement. E07–E24 and T99 are design only. Calibration executes T00 and E01–E06 once each. Far-distance edges include E02 → E14/E16/E17, E03/E05 → E20, E06 → E22. T99 refers to the established contract, without enumerating old facts. Hidden tests will check early/middle/late obligations independently; the official grader is not enabled in this delivery.
